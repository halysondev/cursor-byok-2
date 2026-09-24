import type { PluginContext } from "cursor-byok:plugin";
import type { ModelDefinition, ModelSnapshot, ModelSupport } from "cursor-byok:model";
import { endpointData } from "./resources.ts";

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function positiveInteger(value: unknown): number | null {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string"
    ? Number(value)
    : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
}

function finiteNumber(value: unknown): number | null {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string"
    ? Number(value)
    : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

/** Catalog `supported_reasoning_levels` entries are `{ effort, description }` objects; plain strings are tolerated. */
function parseReasoningEfforts(model: Record<string, unknown>): string[] {
  const source = model.supported_reasoning_levels;
  if (!Array.isArray(source)) return [];
  const values = source.flatMap((item) => {
    if (typeof item === "string") return [item.trim()];
    const entry = object(item);
    const value = text(entry?.effort ?? entry?.id ?? entry?.value ?? entry?.name);
    return value ? [value] : [];
  }).filter(Boolean);
  return [...new Set(values)];
}

/** A model supports the fast latency when it lists a "fast" speed tier or a "priority" service tier. */
function parseSupportsFast(model: Record<string, unknown>): boolean {
  const speedTiers = model.additional_speed_tiers;
  if (Array.isArray(speedTiers) && speedTiers.some((tier) => text(tier) === "fast")) {
    return true;
  }
  const serviceTiers = model.service_tiers;
  return Array.isArray(serviceTiers) &&
    serviceTiers.some((tier) => text(object(tier)?.id) === "priority");
}

export function parseModels(body: unknown): ModelDefinition[] {
  const root = object(body);
  const source = root?.models;
  if (!Array.isArray(source)) {
    throw new Error("OpenCodex catalog response does not contain a model list");
  }
  const seen = new Set<string>();
  const entries: { model: ModelDefinition; priority: number }[] = [];
  for (const raw of source) {
    const model = object(raw);
    if (!model || model.supported_in_api === false) continue;
    if (text(model.visibility)?.toLowerCase() === "hidden") continue;
    const id = text(model.slug ?? model.id ?? model.name);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const description = text(model.description);
    const modalities = model.input_modalities;
    const maxOutputTokens = positiveInteger(
      model.max_output_tokens ?? model.max_completion_tokens,
    );
    entries.push({
      model: {
        id,
        displayName: text(model.display_name) ?? id,
        ...(description ? { description } : {}),
        ...(maxOutputTokens !== null ? { maxOutputTokens } : {}),
        capabilities: {
          images: Array.isArray(modalities) && modalities.includes("image"),
        },
        privateData: {
          reasoningEfforts: parseReasoningEfforts(model),
          defaultReasoningLevel: text(model.default_reasoning_level),
          supportsFast: parseSupportsFast(model),
        },
      },
      priority: finiteNumber(model.priority) ?? Infinity,
    });
  }
  // Lower catalog priority wins; Array.sort is stable, so ties keep upstream order.
  entries.sort((left, right) => left.priority - right.priority);
  const models = entries.map((entry) => entry.model);
  const defaultModel = text(root?.default_model ?? root?.default_model_slug);
  // Put the upstream default model first so the host naturally selects it.
  if (defaultModel) {
    models.sort((left, right) =>
      Number(right.id === defaultModel) - Number(left.id === defaultModel)
    );
  }
  return models;
}

export async function fetchModels(
  baseUrl: string,
  apiKey: string,
  context: PluginContext,
): Promise<ModelDefinition[]> {
  const response = await context.network.fetch(`${baseUrl}/catalog`, {
    method: "GET",
    headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(
      `OpenCodex catalog failed (HTTP ${response.status}): ${response.body}`,
    );
  }
  let body: unknown;
  try {
    body = JSON.parse(response.body);
  } catch {
    throw new Error("OpenCodex catalog returned invalid JSON");
  }
  const models = parseModels(body);
  if (models.length === 0) {
    throw new Error("OpenCodex catalog returned no models");
  }
  return models;
}

export function reasoningEfforts(model: ModelSnapshot): string[] {
  const data = object(model.privateData);
  const efforts = data?.reasoningEfforts;
  return Array.isArray(efforts) ? efforts.filter((item) => typeof item === "string") : [];
}

export function defaultReasoningLevel(model: ModelSnapshot): string | null {
  return text(object(model.privateData)?.defaultReasoningLevel);
}

export function supportsFast(model: ModelSnapshot): boolean {
  return object(model.privateData)?.supportsFast === true;
}

export const opencodexModels: ModelSupport = {
  list: async ({ resource }, context): Promise<ModelDefinition[]> => {
    if (!resource) {
      throw new Error("connect an OpenCodex endpoint before syncing models");
    }
    const data = endpointData(resource);
    return fetchModels(data.baseUrl, data.apiKey, context);
  },
};
