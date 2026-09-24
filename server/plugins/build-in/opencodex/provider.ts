import type {
  ProviderInvokeInput,
  ProviderOutput,
  ProviderResult,
  ProviderSupport,
} from "cursor-byok:provider";
import type { PluginContext } from "cursor-byok:plugin";
import type { ModelSnapshot } from "cursor-byok:model";
import { HttpError, streamOpenAiResponses } from "cursor-byok:protocol/openai-responses";
import {
  defaultReasoningLevel,
  opencodexModels,
  reasoningEfforts,
  supportsFast,
} from "./models.ts";
import { type EndpointData, endpointData, RESOURCE_TYPE } from "./resources.ts";

/**
 * Passes the requested effort through when the catalog axis allows it (or declares none);
 * with no request, falls back to the model's catalog default reasoning level.
 */
export function selectEffort(model: ModelSnapshot, requested: string | null): string | null {
  const efforts = reasoningEfforts(model);
  if (requested !== null) {
    return efforts.length === 0 || efforts.includes(requested) ? requested : null;
  }
  return defaultReasoningLevel(model);
}

/** Clamps "fast" to "standard" when the catalog offers no fast tier for the model. */
export function selectLatency(
  model: ModelSnapshot,
  requested: "fast" | "standard",
): "fast" | "standard" {
  return requested === "fast" && !supportsFast(model) ? "standard" : requested;
}

async function invoke(
  input: ProviderInvokeInput,
  output: ProviderOutput,
  context: PluginContext,
): Promise<ProviderResult> {
  if (!input.resource) {
    return {
      status: "request-error",
      message: "connect an OpenCodex endpoint before calling its models",
    };
  }
  let data: EndpointData;
  try {
    data = endpointData(input.resource);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: "resource-error",
      message,
      patch: { state: { status: "invalid", message } },
    };
  }
  const reasoning = input.request.reasoning;
  const effort = selectEffort(input.model, reasoning.effort);
  const latency = selectLatency(input.model, input.request.latency);
  try {
    await streamOpenAiResponses(
      {
        url: `${data.baseUrl}/responses`,
        model: input.model.id,
        request: {
          ...input.request,
          reasoning: { enabled: reasoning.enabled, effort },
          latency,
        },
        headers: { authorization: `Bearer ${data.apiKey}` },
      },
      output,
      context,
    );
    return { status: "completed" };
  } catch (error) {
    if (error instanceof HttpError) {
      if (error.status === 401 || error.status === 403) {
        return {
          status: "resource-error",
          message: error.message,
          patch: {
            state: { status: "invalid", message: "OpenCodex rejected the API key" },
          },
        };
      }
      if (error.status === 429) {
        return {
          status: "resource-error",
          message: error.message,
          patch: {
            state: {
              status: "cooling",
              retryAtMs: Date.now() + 60_000,
              message: "OpenCodex rate limit",
            },
          },
        };
      }
      return { status: "request-error", message: error.message };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { status: "request-error", message };
  }
}

export const opencodexProvider: ProviderSupport = {
  id: "opencodex",
  displayName: "OpenCodex",
  description: "Any OpenCodex proxy through its OpenAI Responses endpoint.",
  providerType: "openai",
  resourceType: RESOURCE_TYPE,
  models: opencodexModels,
  invoke,
};
