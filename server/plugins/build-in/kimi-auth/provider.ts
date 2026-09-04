import type { JsonValue, PluginContext } from "cursor-byok:plugin";
import type {
  ProviderInvokeInput,
  ProviderOutput,
  ProviderResult,
  ProviderSupport,
} from "cursor-byok:provider";
import { HttpError, streamOpenAiChat } from "cursor-byok:protocol/openai-chat";
import { kimiModels } from "./models.ts";
import {
  type AccountData,
  accountData,
  quotaExhaustedPatch,
  refreshAccessToken,
  RESOURCE_TYPE,
  tokenExpiring,
  tokenExpiryMs,
} from "./resources.ts";

const CHAT_URL = "https://api.kimi.com/coding/v1/chat/completions";
const EXPIRED_MESSAGE = "Kimi authorization expired; sign in again";

function invalidResult(message: string, stateMessage: string): ProviderResult {
  return {
    status: "resource-error",
    message,
    patch: { state: { status: "invalid", message: stateMessage } },
  };
}

/**
 * Token state resident in the worker process. refresh_token rotates: two
 * concurrent calls on the same account would each refresh, and the loser would
 * be rejected with its now-rotated refresh_token, wrongly marking the freshly
 * refreshed account invalid. Refresh is shared per resource ID and the latest
 * token is remembered, so calls arriving before or after the persistence patch
 * lands both get the new token; a re-login token always wins because its exp is
 * larger.
 */
const latestAccounts = new Map<string, AccountData>();
const pendingRefreshes = new Map<string, Promise<AccountData | null>>();

/** Single-flight refresh: concurrent calls on the same account share one refresh; null means the refresh was rejected. */
async function sharedRefresh(
  id: string,
  data: AccountData,
  context: PluginContext,
): Promise<AccountData | null> {
  const pending = pendingRefreshes.get(id);
  if (pending) return pending;
  const promise = refreshAccessToken(data, context)
    .then((refreshed) => {
      if (refreshed) latestAccounts.set(id, refreshed);
      return refreshed;
    })
    .finally(() => pendingRefreshes.delete(id));
  pendingRefreshes.set(id, promise);
  return promise;
}

async function invoke(
  input: ProviderInvokeInput,
  output: ProviderOutput,
  context: PluginContext,
): Promise<ProviderResult> {
  if (!input.resource) {
    return { status: "request-error", message: "add a Kimi account before calling Kimi" };
  }
  let data: AccountData;
  let storedAccessToken: string;
  try {
    data = accountData(input.resource);
    storedAccessToken = data.accessToken;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return invalidResult(message, message);
  }
  const id = input.resource.id;
  const cached = latestAccounts.get(id);
  if (cached && tokenExpiryMs(cached) > tokenExpiryMs(data)) data = cached;

  // Refresh a soon-expiring token first; if refresh is temporarily unavailable, keep the current token and let the call result decide.
  if (data.refreshToken && tokenExpiring(data)) {
    try {
      const refreshed = await sharedRefresh(id, data, context);
      if (!refreshed) return invalidResult(EXPIRED_MESSAGE, EXPIRED_MESSAGE);
      data = refreshed;
    } catch {
      // A transient failure does not block the call.
    }
  }
  for (let attempt = 0;; attempt++) {
    try {
      await streamOpenAiChat(
        {
          url: CHAT_URL,
          model: input.model.id,
          // Whether the Kimi Code endpoint accepts reasoning_effort and service_tier is unverified; the model itself decides thinking.
          request: {
            ...input.request,
            reasoning: { enabled: false, effort: null },
            latency: "standard",
          },
          headers: { authorization: `Bearer ${data.accessToken}` },
        },
        output,
        context,
      );
      // A refreshed token is persisted via the patch, so the next call and the model sync use it directly.
      return data.accessToken === storedAccessToken
        ? { status: "completed" }
        : { status: "completed", patch: { privateData: data as unknown as JsonValue } };
    } catch (error) {
      // On 401/403 refresh once and retry: the token may have expired or been
      // rotated by another client on the same account. HttpError is only thrown
      // when reading the response status, before any event was emitted, so the
      // retry cannot duplicate output.
      if (
        error instanceof HttpError &&
        (error.status === 401 || error.status === 403) &&
        attempt === 0 &&
        data.refreshToken
      ) {
        try {
          const refreshed = await sharedRefresh(id, data, context);
          if (!refreshed) return invalidResult(error.message, EXPIRED_MESSAGE);
          data = refreshed;
          continue;
        } catch (refreshError) {
          // A transient refresh failure does not invalidate the account; report the cause as-is.
          return {
            status: "request-error",
            message: refreshError instanceof Error ? refreshError.message : String(refreshError),
          };
        }
      }
      if (error instanceof HttpError) {
        if (error.status === 401 || error.status === 403) {
          return invalidResult(error.message, EXPIRED_MESSAGE);
        }
        if (error.status === 429) {
          return {
            status: "resource-error",
            message: error.message,
            patch: quotaExhaustedPatch(data),
          };
        }
        return { status: "request-error", message: error.message };
      }
      return {
        status: "request-error",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

export const kimiProvider: ProviderSupport = {
  id: "kimi",
  displayName: "Moonshot Kimi",
  description: {
    "en-US": "Kimi for Coding subscription access through the official Kimi Code endpoint.",
    "zh-CN": "通过官方 Kimi Code 接口使用 Kimi For Coding 订阅。",
  },
  providerType: "kimi",
  resourceType: RESOURCE_TYPE,
  models: kimiModels,
  invoke,
};
