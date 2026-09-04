import type { JsonValue, LocalizedText, PluginContext } from "./plugin.ts";
import type { ModelSnapshot, ModelSupport } from "./model.ts";
import type { ResourcePatch, ResourceSnapshot } from "./resource.ts";

/**
 * The LLM request contract. The host projects its canonical conversation (ProjectedMessage)
 * into this shape; the plugin adapts it to the upstream Provider's protocol.
 */
export type LlmContentPart =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: string; dataBase64: string };

/** Opaque Provider replay state (e.g. encrypted reasoning items); filtered by providerKind on replay. */
export type LlmReplayState = {
  providerKind: string;
  value: JsonValue;
};

export type LlmToolCall = {
  /** Stable sequence number within a single turn. */
  index: number;
  callId: string;
  name: string;
  /** Parsed JSON arguments. */
  arguments: JsonValue;
};

export type LlmMessage =
  | { role: "system" | "user"; content: LlmContentPart[] }
  | {
    role: "assistant";
    text: string;
    thinking: string;
    replayState: LlmReplayState | null;
    toolCalls: LlmToolCall[];
  }
  | {
    role: "tool";
    callId: string;
    name: string;
    content: string;
    isError: boolean;
    /** When non-empty, takes precedence over content and carries rich tool results such as images. */
    parts: LlmContentPart[];
  };

export type LlmTool = {
  name: string;
  description: string;
  /** JSON Schema for the tool arguments. */
  parameters: JsonValue;
};

export type LlmRequest = {
  /** System instructions; an empty string means none. */
  instructions: string;
  messages: LlmMessage[];
  tools: LlmTool[];
  reasoning: { enabled: boolean; effort: string | null };
  latency: "fast" | "standard";
  maxOutputTokens: number | null;
  /** Conversation-level stable cache key, used for routing affinity with upstream prefix caches (e.g. prompt_cache_key). */
  cacheKey: string | null;
};

export type ModelUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
};

/**
 * The normalized output contract, one-to-one with the host's unified stream events. The plugin
 * emits events as upstream data arrives; text, thinking, and each tool call have explicit
 * start/end boundaries, and tool arguments are delivered as deltas.
 * Replay state is emitted once before the stream ends; the host stores it on the assistant
 * message for replay on the next turn.
 */
export type ModelEvent =
  | { type: "text-start" }
  | { type: "text-delta"; text: string }
  | { type: "text-end" }
  | { type: "thinking-start" }
  | { type: "thinking-delta"; text: string }
  | { type: "thinking-end" }
  | { type: "tool-call-start"; index: number; callId: string; name: string }
  | { type: "tool-call-arguments-delta"; index: number; delta: string }
  | { type: "tool-call-end"; index: number }
  | { type: "replay-state"; providerKind: string; value: JsonValue }
  | { type: "usage"; usage: ModelUsage }
  | { type: "done"; reason: "stop" | "length" | "tool-use" };

export type ProviderOutput = {
  emit(event: ModelEvent): void;
};

export type ProviderInvokeInput = {
  model: ModelSnapshot;
  /** The resource the host selected for this call; null for Providers without resources. */
  resource: ResourceSnapshot | null;
  request: LlmRequest;
};

/**
 * `resource-error` attributes the failure to the selected resource; the host updates the
 * resource state accordingly and fails over to the next candidate resource when no events
 * have been emitted yet. `patch` also persists side effects of a successful call,
 * such as a refreshed access token.
 */
export type ProviderResult =
  | { status: "completed"; patch?: ResourcePatch }
  | { status: "auth-error"; message: string }
  | { status: "resource-error"; message: string; patch: ResourcePatch }
  | { status: "request-error"; message: string; patch?: ResourcePatch };

export type ProviderSupport = {
  id: string;
  displayName: LocalizedText;
  description?: LocalizedText;
  /** Product identity used for grouping and icons, e.g. "openai". */
  providerType: string;
  /** Resource type consumed per call; Providers without resources may omit it. */
  resourceType?: string;
  models?: ModelSupport;
  invoke(
    input: ProviderInvokeInput,
    output: ProviderOutput,
    context: PluginContext,
  ): Promise<ProviderResult>;
};
