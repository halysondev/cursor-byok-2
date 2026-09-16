/**
 * Claude subscription provider.
 *
 * Sends genuine [CC]-shaped Messages requests to api.anthropic.com with the
 * account's OAuth bearer token: CC headers + betas, billing tag, identity
 * metadata, CC system prompt and tools (see cc-template.ts). Streaming SSE is
 * normalized to the host's unified event set, with tool_use blocks
 * reverse-mapped back to the client's tool names and input shapes.
 */

import type { JsonValue, PluginContext } from "cursor-byok:plugin";
import type {
  ModelEvent,
  ModelUsage,
  ProviderInvokeInput,
  ProviderOutput,
  ProviderResult,
  ProviderSupport,
} from "cursor-byok:provider";
import type { ResourcePatch } from "cursor-byok:resource";
import {
  betaForRequest,
  buildCCRequest,
  type BuiltRequest,
  outboundHeaders,
  primeBillingTag,
  reverseToolInput,
  reverseToolName,
  staticHeaders,
  type ToolMapping,
} from "./cc-template.ts";
import { claudeModels } from "./models.ts";
import {
  type AccountData,
  accountData,
  ensureFreshToken,
  RESOURCE_TYPE,
  snapshotState,
} from "./resources.ts";
import { isTerminalRefreshFailure } from "./oauth.ts";
import {
  EMPTY_SNAPSHOT,
  isWindowRejection,
  OVERAGE_HALT_COOLDOWN_MS,
  overageGuardDecision,
  parseRateLimits,
  type RateLimitSnapshot,
  rejectionCooldownUntil,
} from "./rate-limits.ts";

const MESSAGES_URL = "https://api.anthropic.com/v1/messages?beta=true";

let primed: Promise<void> | null = null;

function ensurePrimed(): Promise<void> {
  primed ??= primeBillingTag();
  return primed;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * Resource patch for a rejected request. The rate-limit headers are not
 * available on an error response, so the account's last learned snapshot
 * (from its previous successful response) decides: a reading that shows a
 * window at or past the threshold parks the seat until the stated reset;
 * anything else cools briefly and stays probeable.
 */
function rateLimitRejectionPatch(data: AccountData): ResourcePatch {
  const current = data.rateLimit ?? EMPTY_SNAPSHOT;
  const windowOver = isWindowRejection(current);
  return {
    privateData: { ...data, rateLimit: current } as unknown as JsonValue,
    state: {
      status: "cooling",
      retryAtMs: rejectionCooldownUntil(current),
      message: windowOver
        ? `subscription window exhausted (${current.claim})`
        : "request rejected — cooling briefly",
    },
  };
}

function invalidResult(message: string, stateMessage: string): ProviderResult {
  return {
    status: "resource-error",
    message,
    patch: { state: { status: "invalid", message: stateMessage } },
  };
}

class HttpError extends Error {
  constructor(readonly status: number, readonly body: string) {
    super(`HTTP ${status}: ${body}`);
  }
}

async function readErrorBody(lines: AsyncIterable<string>): Promise<string> {
  const collected: string[] = [];
  for await (const line of lines) collected.push(line);
  return collected.join("\n");
}

// ---------------------------------------------------------------------------
// Anthropic Messages SSE parsing
// ---------------------------------------------------------------------------

type ToolBlockState = {
  callId: string;
  name: string;
  arguments: string;
  started: boolean;
};

type ReverseMap = Map<string, { clientName: string; mapping: ToolMapping }>;

type StreamState = {
  output: ProviderOutput;
  reverseMap: ReverseMap;
  textOpen: boolean;
  thinkingOpen: boolean;
  thinking: string;
  signature: string;
  tools: Map<number, ToolBlockState>;
  usage: ModelUsage | null;
  finish: "stop" | "length" | "tool-use" | null;
  stopReasonSeen: boolean;
  error: string | null;
};

function closeText(state: StreamState): void {
  if (state.textOpen) {
    state.textOpen = false;
    state.output.emit({ type: "text-end" });
  }
}

function closeThinking(state: StreamState): void {
  if (state.thinkingOpen) {
    state.thinkingOpen = false;
    state.output.emit({ type: "thinking-end" });
  }
}

function handleEvent(state: StreamState, value: Record<string, unknown>): void {
  const type = text(value.type) ?? "";
  switch (type) {
    case "message_start": {
      const message = object(value.message) ?? {};
      const usage = object(message.usage);
      if (usage) {
        state.usage = {
          inputTokens: typeof usage.input_tokens === "number" ? usage.input_tokens : null,
          outputTokens: typeof usage.output_tokens === "number" ? usage.output_tokens : null,
          totalTokens: null,
          cacheReadTokens: typeof usage.cache_read_input_tokens === "number"
            ? usage.cache_read_input_tokens
            : null,
          cacheWriteTokens: typeof usage.cache_creation_input_tokens === "number"
            ? usage.cache_creation_input_tokens
            : null,
          reasoningTokens: null,
        };
      }
      break;
    }
    case "content_block_start": {
      const block = object(value.content_block) ?? {};
      const index = typeof value.index === "number" ? value.index : 0;
      if (block.type === "tool_use") {
        closeThinking(state);
        closeText(state);
        state.tools.set(index, {
          callId: text(block.id) ?? "",
          name: text(block.name) ?? "",
          arguments: "",
          started: false,
        });
      } else if (block.type === "thinking") {
        state.thinking = "";
        state.signature = "";
      }
      break;
    }
    case "content_block_delta": {
      const delta = object(value.delta) ?? {};
      const deltaType = text(delta.type) ?? "";
      const index = typeof value.index === "number" ? value.index : 0;
      if (deltaType === "text_delta") {
        const content = text(delta.text);
        if (content) {
          if (!state.textOpen) {
            closeThinking(state);
            state.textOpen = true;
            state.output.emit({ type: "text-start" });
          }
          state.output.emit({ type: "text-delta", text: content });
        }
      } else if (deltaType === "thinking_delta") {
        const content = text(delta.thinking);
        if (content) {
          if (!state.thinkingOpen) {
            state.thinkingOpen = true;
            state.output.emit({ type: "thinking-start" });
          }
          state.thinking += content;
          state.output.emit({ type: "thinking-delta", text: content });
        }
      } else if (deltaType === "signature_delta") {
        const signature = text(delta.signature);
        if (signature) state.signature += signature;
      } else if (deltaType === "input_json_delta") {
        const tool = state.tools.get(index);
        const partial = text(delta.partial_json);
        if (tool && partial) {
          tool.arguments += partial;
          if (!tool.started && tool.name) {
            tool.started = true;
            const clientName = reverseToolName(tool.name, state.reverseMap) ?? tool.name;
            state.output.emit({
              type: "tool-call-start",
              index,
              callId: tool.callId,
              name: clientName,
            });
          }
          if (tool.started) {
            state.output.emit({ type: "tool-call-arguments-delta", index, delta: partial });
          }
        }
      }
      break;
    }
    case "content_block_stop": {
      const index = typeof value.index === "number" ? value.index : 0;
      const tool = state.tools.get(index);
      if (tool) {
        if (!tool.started) {
          if (!tool.name) throw new Error("Anthropic tool call is missing name");
          tool.started = true;
          const clientName = reverseToolName(tool.name, state.reverseMap) ?? tool.name;
          state.output.emit({
            type: "tool-call-start",
            index,
            callId: tool.callId,
            name: clientName,
          });
        }
        let parsed: Record<string, unknown> = {};
        if (tool.arguments) {
          try {
            parsed = object(JSON.parse(tool.arguments)) ?? {};
          } catch {
            parsed = {};
          }
        }
        const clientInput = reverseToolInput(tool.name, parsed, state.reverseMap);
        if (Object.keys(clientInput).length > 0) {
          state.output.emit({
            type: "tool-call-arguments-delta",
            index,
            delta: JSON.stringify(clientInput),
          });
        }
        state.output.emit({ type: "tool-call-end", index });
      }
      break;
    }
    case "message_delta": {
      const delta = object(value.delta) ?? {};
      const usage = object(value.usage);
      if (usage) {
        state.usage = {
          inputTokens: state.usage?.inputTokens ?? null,
          outputTokens: typeof usage.output_tokens === "number" ? usage.output_tokens : null,
          totalTokens: null,
          cacheReadTokens: state.usage?.cacheReadTokens ?? null,
          cacheWriteTokens: state.usage?.cacheWriteTokens ?? null,
          reasoningTokens: null,
        };
      }
      const reason = text(delta.stop_reason);
      if (reason === "tool_use") state.finish = "tool-use";
      else if (reason === "max_tokens") state.finish = "length";
      else if (reason === "end_turn" || reason === "stop_sequence") state.finish = "stop";
      if (reason !== null) state.stopReasonSeen = true;
      break;
    }
    case "error": {
      const error = object(value.error) ?? {};
      state.error = text(error.message) ?? JSON.stringify(value);
      break;
    }
    default:
      break;
  }
}

/** Replay-state providerKind; carries the thinking text + signature pair. */
export const REPLAY_KIND = "anthropic_messages";

/**
 * Run one Messages streaming call. Emits normalized events; throws HttpError
 * on non-2xx and Error on mid-stream failure. Returns the response headers so
 * callers can parse the unified rate-limit quota.
 */
async function streamMessages(
  body: Record<string, unknown>,
  headers: Record<string, string>,
  reverseMap: ReverseMap,
  output: ProviderOutput,
  context: PluginContext,
): Promise<Record<string, string>> {
  const response = await context.network.stream(MESSAGES_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (response.status < 200 || response.status >= 300) {
    throw new HttpError(response.status, await readErrorBody(response.lines));
  }

  const state: StreamState = {
    output,
    reverseMap,
    textOpen: false,
    thinkingOpen: false,
    thinking: "",
    signature: "",
    tools: new Map(),
    usage: null,
    finish: null,
    stopReasonSeen: false,
    error: null,
  };

  for await (const line of response.lines) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    let value: Record<string, unknown>;
    try {
      value = object(JSON.parse(payload)) ?? {};
    } catch {
      throw new Error("Anthropic Messages SSE returned invalid JSON");
    }
    handleEvent(state, value);
    if (state.error) throw new Error(`Anthropic Messages error: ${state.error}`);
  }

  closeThinking(state);
  closeText(state);

  if (state.thinking) {
    output.emit({
      type: "replay-state",
      providerKind: REPLAY_KIND,
      value: { thinking: state.thinking, signature: state.signature },
    });
  }
  if (state.usage !== null) output.emit({ type: "usage", usage: state.usage });

  if (!state.stopReasonSeen) {
    throw new Error("Anthropic Messages stream ended without stop_reason");
  }
  output.emit({ type: "done", reason: state.finish ?? "stop" });
  return response.headers;
}

// ---------------------------------------------------------------------------
// Invoke
// ---------------------------------------------------------------------------

async function invoke(
  input: ProviderInvokeInput,
  output: ProviderOutput,
  context: PluginContext,
): Promise<ProviderResult> {
  if (!input.resource) {
    return { status: "request-error", message: "add a Claude account before calling Claude" };
  }
  await ensurePrimed();
  let data: AccountData;
  try {
    data = accountData(input.resource);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return invalidResult(message, message);
  }

  // Refresh inside the buffer before spending the round trip.
  let patch: ResourcePatch | undefined;
  try {
    const fresh = await ensureFreshToken(data, context);
    if (fresh !== data) {
      data = fresh;
      patch = { privateData: fresh as unknown as JsonValue };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = Number(message.match(/HTTP (\d{3})/)?.[1] ?? 0);
    if (isTerminalRefreshFailure(status, message)) {
      return invalidResult(message, "Claude authorization expired; sign in again");
    }
    return { status: "request-error", message };
  }

  const model = input.model.id;
  // One session id per conversation (the host's stable cache key); the body's
  // metadata.session_id and the x-claude-code-session-id header agree on it.
  const sessionId = input.request.cacheKey ?? crypto.randomUUID();
  const built: BuiltRequest = buildCCRequest(input.request, model, {
    deviceId: data.deviceId,
    accountUuid: data.accountUuid,
    sessionId,
  });

  const headers = outboundHeaders(
    staticHeaders(),
    data.accessToken,
    betaForRequest(model),
    sessionId,
    crypto.randomUUID(),
  );

  try {
    const responseHeaders = await streamMessages(
      built.body,
      headers,
      built.reverseMap,
      output,
      context,
    );
    // The unified rate-limit snapshot rides the response headers; persist it
    // alongside any token-refresh patch so the account view stays current.
    const snapshot = parseRateLimits(responseHeaders);
    // Overage guard: a completed response billed outside the subscription
    // pool means something is wrong — halt the account before it bleeds.
    const guard = overageGuardDecision(snapshot);
    if (guard.halt) {
      const updated = { ...data, rateLimit: snapshot };
      return {
        status: "resource-error",
        message: `request billed as '${guard.claim}' (non-subscription) — account halted ` +
          `to prevent API-rate bleed; re-check the account or sign in again`,
        patch: {
          privateData: updated as unknown as JsonValue,
          state: {
            status: "cooling",
            retryAtMs: Date.now() + OVERAGE_HALT_COOLDOWN_MS,
            message: `billing flip: ${guard.claim}`,
          },
        },
      };
    }
    if (snapshot.claim !== "unknown" || snapshot.updatedAt !== EMPTY_SNAPSHOT.updatedAt) {
      const updated = { ...data, rateLimit: snapshot };
      patch = {
        ...(patch ?? {}),
        privateData: updated as unknown as JsonValue,
        state: snapshotState(snapshot),
      };
    }
    return { status: "completed", ...(patch ? { patch } : {}) };
  } catch (error) {
    if (error instanceof HttpError) {
      if (error.status === 401 || error.status === 403) {
        return invalidResult(
          error.body.slice(0, 200),
          "Claude authorization expired; sign in again",
        );
      }
      if (error.status === 429) {
        return {
          status: "resource-error",
          message: error.body.slice(0, 200) || "HTTP 429",
          patch: rateLimitRejectionPatch(data),
        };
      }
      return {
        status: "request-error",
        message: error.body.slice(0, 500) || `HTTP ${error.status}`,
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { status: "request-error", message };
  }
}

export const claudeProvider: ProviderSupport = {
  id: "claude",
  displayName: "[CC]",
  description: "Claude subscription access through the official Claude Messages API.",
  providerType: "anthropic",
  resourceType: RESOURCE_TYPE,
  models: claudeModels,
  invoke,
};

export { snapshotState } from "./resources.ts";
export {
  billingBucketFromClaim,
  isNonSubscriptionBilling,
  parseRateLimits,
} from "./rate-limits.ts";
