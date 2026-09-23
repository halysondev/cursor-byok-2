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

function parseReasoningEfforts(model: Record<string, unknown>): string[] {
  const capabilities = object(model.capabilities);
  const source = model.reasoning_efforts ??
    capabilities?.reasoning_effort ??
    model.supported_reasoning_efforts;
  const items = Array.isArray(source) ? source : typeof source === "string" ? [source] : [];
  const values = items.flatMap((item) => {
    if (typeof item === "string") return [item.trim()];
    const entry = object(item);
    const value = text(entry?.value ?? entry?.id ?? entry?.effort ?? entry?.name);
    return value ? [value] : [];
  }).filter(Boolean);
  return [...new Set(values)];
}

export function parseModels(body: unknown): ModelDefinition[] {
  const root = object(body);
  const source = root?.data ?? root?.models ?? body;
  if (!Array.isArray(source)) {
    throw new Error("OpenCodex model discovery response does not contain a model list");
  }
  const seen = new Set<string>();
  const models: ModelDefinition[] = [];
  for (const raw of source) {
    const model = object(raw);
    if (!model) continue;
    const id = text(model.id ?? model.slug ?? model.name);
    if (!id || seen.has(id)) continue;
    // The provider only speaks the OpenAI Responses protocol.
    if (Array.isArray(model.api_types) && !model.api_types.includes("responses")) continue;
    seen.add(id);
    const capabilities = object(model.capabilities);
    const modalities = capabilities?.input_modalities;
    const images = (Array.isArray(modalities) && modalities.includes("image")) ||
      capabilities?.supports_vision === true;
    const maxOutputTokens = positiveInteger(
      model.max_output_tokens ?? model.max_completion_tokens,
    );
    models.push({
      id,
      displayName: text(model.display_name ?? model.displayName ?? model.name) ?? id,
      ...(maxOutputTokens !== null ? { maxOutputTokens } : {}),
      capabilities: { images },
      privateData: { reasoningEfforts: parseReasoningEfforts(model) },
    });
  }
  const defaultModel = text(root?.default_model ?? root?.defaultModel);
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
  const response = await context.network.fetch(`${baseUrl}/models`, {
    method: "GET",
    headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(
      `OpenCodex model discovery failed (HTTP ${response.status}): ${response.body}`,
    );
  }
  let body: unknown;
  try {
    body = JSON.parse(response.body);
  } catch {
    throw new Error("OpenCodex model discovery returned invalid JSON");
  }
  const models = parseModels(body);
  if (models.length === 0) {
    throw new Error("OpenCodex returned no models");
  }
  return models;
}

export function reasoningEfforts(model: ModelSnapshot): string[] {
  const data = object(model.privateData);
  const efforts = data?.reasoningEfforts;
  return Array.isArray(efforts) ? efforts.filter((item) => typeof item === "string") : [];
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
