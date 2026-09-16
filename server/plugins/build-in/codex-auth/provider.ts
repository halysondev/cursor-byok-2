import type {
  ProviderInvokeInput,
  ProviderOutput,
  ProviderResult,
  ProviderSupport,
} from "cursor-byok:provider";
import type { PluginContext } from "cursor-byok:plugin";
import { HttpError, streamOpenAiResponses } from "cursor-byok:protocol/openai-responses";
import { codexModels, reasoningEfforts } from "./models.ts";
import {
  type AccountData,
  accountData,
  chatGptAccountId,
  quotaExhaustedPatch,
  RESOURCE_TYPE,
} from "./resources.ts";

const RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";

/** Only text is available for mid-stream errors; they are classified by quota keywords. */
export function isQuotaError(error: string): boolean {
  const message = error.toLowerCase();
  return message.includes("insufficient_quota") ||
    message.includes("usage_limit_reached") ||
    message.includes("exceeded your current quota") ||
    message.includes("quota_exceeded") ||
    message.includes("5-hour") ||
    message.includes("5 hour") ||
    (message.includes("429") &&
      (message.includes("quota") || message.includes("usage_limit") ||
        message.includes("insufficient")));
}

/** HTTP failures carry a structured status code; for 429 the response-body match is relaxed. */
function isQuotaHttpError(error: HttpError): boolean {
  const body = error.body.toLowerCase();
  return body.includes("insufficient_quota") ||
    body.includes("usage_limit_reached") ||
    body.includes("exceeded your current quota") ||
    body.includes("quota_exceeded") ||
    body.includes("5-hour") ||
    body.includes("5 hour") ||
    (error.status === 429 &&
      (body.includes("quota") || body.includes("usage_limit") || body.includes("insufficient")));
}

function invalidResult(message: string, stateMessage: string): ProviderResult {
  return {
    status: "resource-error",
    message,
    patch: { state: { status: "invalid", message: stateMessage } },
  };
}

function headers(data: AccountData, cacheKey: string | null): Record<string, string> {
  const result: Record<string, string> = {
    authorization: `Bearer ${data.accessToken}`,
    originator: "codex_cli_rs",
  };
  const accountId = chatGptAccountId(data.accessToken);
  if (accountId) result["ChatGPT-Account-Id"] = accountId;
  // Codex backend cache-affinity contract: session-id / thread-id / prompt_cache_key
  // share one source (see codex-rs client.rs); a missing header lands the request on a random shard.
  if (cacheKey !== null) {
    result["session-id"] = cacheKey;
    result["thread-id"] = cacheKey;
    result["x-client-request-id"] = cacheKey;
  }
  return result;
}

async function invoke(
  input: ProviderInvokeInput,
  output: ProviderOutput,
  context: PluginContext,
): Promise<ProviderResult> {
  if (!input.resource) {
    return { status: "request-error", message: "add a ChatGPT account before calling Codex" };
  }
  let data: AccountData;
  try {
    data = accountData(input.resource);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return invalidResult(message, message);
  }
  const efforts = reasoningEfforts(input.model);
  const reasoning = input.request.reasoning;
  const effort = reasoning.effort !== null && efforts.includes(reasoning.effort)
    ? reasoning.effort
    : null;
  try {
    await streamOpenAiResponses(
      {
        url: RESPONSES_URL,
        model: input.model.id,
        // The Codex subscription endpoint rejects max_output_tokens; the fast tier is
        // forwarded after the protocol library maps it to service_tier: "priority".
        request: {
          ...input.request,
          reasoning: { enabled: reasoning.enabled, effort },
          maxOutputTokens: null,
        },
        headers: headers(data, input.request.cacheKey),
        extraBody: { store: false },
      },
      output,
      context,
    );
    return { status: "completed" };
  } catch (error) {
    if (error instanceof HttpError) {
      if (error.status === 401) {
        return invalidResult(error.message, "ChatGPT authorization expired; sign in again");
      }
      if (isQuotaHttpError(error)) {
        return {
          status: "resource-error",
          message: error.message,
          patch: quotaExhaustedPatch(data, error.body),
        };
      }
      return { status: "request-error", message: error.message };
    }
    const message = error instanceof Error ? error.message : String(error);
    if (isQuotaError(message)) {
      return { status: "resource-error", message, patch: quotaExhaustedPatch(data, message) };
    }
    return { status: "request-error", message };
  }
}

export const codexProvider: ProviderSupport = {
  id: "codex",
  displayName: "OpenAI Codex",
  description: "ChatGPT subscription access through the official Codex Responses API.",
  providerType: "openai",
  resourceType: RESOURCE_TYPE,
  models: codexModels,
  invoke,
};
