import type { ModelDefinition, ModelSupport } from "cursor-byok:model";
import { accountData } from "./resources.ts";

const MODELS_URL = "https://api.kimi.com/coding/v1/models";

/** Falls back to the known Kimi Code coding-plan models when the model list is unavailable. */
export const FALLBACK_MODELS: ModelDefinition[] = [
  {
    id: "kimi-for-coding",
    displayName: "Kimi for Coding",
    capabilities: { images: false },
    privateData: { thinking: true },
  },
];

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

/** Turns a model ID into a readable name; e.g. kimi-for-coding → Kimi for Coding is provided by the upstream display_name. */
function displayName(id: string): string {
  return id
    .split("-")
    .map((part) => (/^\d/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join(" ");
}

/** Parses the data array of /coding/v1/models; fields match the official Kimi CLI. */
export function parseKimiModels(body: unknown): ModelDefinition[] {
  const root = object(body);
  const source = root?.data ?? body;
  if (!Array.isArray(source)) {
    throw new Error("Kimi model discovery response does not contain a model list");
  }
  const seen = new Set<string>();
  const models: ModelDefinition[] = [];
  for (const raw of source) {
    const model = object(raw);
    const id = model ? text(model.id) : null;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const contextWindowTokens = positiveInteger(model?.context_length);
    const thinking = model?.supports_reasoning === true || id.toLowerCase().includes("thinking");
    models.push({
      id,
      displayName: text(model?.display_name) ?? displayName(id),
      capabilities: {
        images: model?.supports_image_in === true,
      },
      // Model metadata beyond the SDK contract goes into privateData and round-trips
      // with the snapshot (same pattern as codex's reasoningEfforts).
      privateData: {
        thinking,
        ...(contextWindowTokens !== null ? { contextWindowTokens } : {}),
      },
    });
  }
  return models;
}

export const kimiModels: ModelSupport = {
  list: async ({ resource }, context): Promise<ModelDefinition[]> => {
    if (!resource) throw new Error("add a Kimi account before syncing models");
    const data = accountData(resource);
    const response = await context.network.fetch(MODELS_URL, {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${data.accessToken}`,
      },
    });
    if (response.status < 200 || response.status >= 300) {
      return FALLBACK_MODELS;
    }
    let body: unknown;
    try {
      body = JSON.parse(response.body);
    } catch {
      throw new Error("Kimi model discovery returned invalid JSON");
    }
    const models = parseKimiModels(body);
    return models.length > 0 ? models : FALLBACK_MODELS;
  },
};
