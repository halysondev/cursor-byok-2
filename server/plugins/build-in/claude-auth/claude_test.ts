import type {
  JsonValue,
  NetworkEventStream,
  NetworkResponse,
  PluginContext,
} from "cursor-byok:plugin";
import type { LlmRequest, ModelEvent } from "cursor-byok:provider";
import type { ResourceSnapshot } from "cursor-byok:resource";
import {
  betaForModel,
  betaForRequest,
  buildBillingTag,
  buildCCRequest,
  buildForwardToolMap,
  buildReverseLookup,
  CC_VERSION,
  OAUTH_BETA,
  outboundHeaders,
  resolveEffort,
  staticHeaders,
  supportsAdaptiveThinking,
} from "./cc-template.ts";
import { claudeOAuth, normalizeRedirectUri } from "./oauth.ts";
import { longContextEligible, normalizeUpstreamIds, parseModelList } from "./models.ts";
import { claudeProvider } from "./provider.ts";
import {
  billingBucketFromClaim,
  computeHeadroom,
  expireElapsedWindow,
  isNonSubscriptionBilling,
  isWindowRejection,
  parseRateLimits,
} from "./rate-limits.ts";
import { describeGrantAge, grantAge } from "./refresh-grant.ts";
import {
  credentialDraft,
  credentialImport,
  presentAccount,
  RESOURCE_TYPE,
  snapshotState,
} from "./resources.ts";

function assert(condition: unknown, message = "assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown): void {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`expected ${right}, received ${left}`);
}

function assertIncludes(haystack: string, needle: string): void {
  if (!haystack.includes(needle)) throw new Error(`expected to include: ${needle}`);
}

type RequestInit = { body?: string; headers?: Record<string, string> };
type FetchHandler = (url: string, init?: RequestInit) => NetworkResponse;
type StreamHandler = (url: string, init?: RequestInit) => NetworkEventStream;

function context(handlers: { fetch?: FetchHandler; stream?: StreamHandler }): PluginContext {
  return {
    network: {
      fetch: (url, init) => {
        if (!handlers.fetch) throw new Error("fetch was not expected");
        return Promise.resolve(handlers.fetch(url, init));
      },
      stream: (url, init) => {
        if (!handlers.stream) throw new Error("stream was not expected");
        return Promise.resolve(handlers.stream(url, init));
      },
    },
    signal: new AbortController().signal,
  };
}

const ACCOUNT = {
  accessToken: "at-test",
  refreshToken: "rt-test",
  expiresAtMs: Date.now() + 60 * 60 * 1000,
  scopes: ["user:inference"],
  deviceId: "dev-1",
  accountUuid: "acct-1",
  displayName: "user@example.com",
  quota: null,
};

function resource(): ResourceSnapshot {
  return {
    id: "r1",
    type: RESOURCE_TYPE,
    key: "claude:test",
    privateData: ACCOUNT as unknown as JsonValue,
    state: { status: "ready" },
  };
}

function request(overrides: Partial<LlmRequest> = {}): LlmRequest {
  return {
    instructions: "Be helpful.",
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    tools: [],
    reasoning: { enabled: true, effort: "high" },
    latency: "standard",
    maxOutputTokens: null,
    cacheKey: "conv-1",
    ...overrides,
  };
}

function sseStream(events: unknown[]): StreamHandler {
  return () => ({
    status: 200,
    headers: {
      "anthropic-ratelimit-unified-status": "allowed",
      "anthropic-ratelimit-unified-5h-utilization": "0.1",
      "anthropic-ratelimit-unified-7d-utilization": "0.05",
      "anthropic-ratelimit-unified-reset": String(Math.floor(Date.now() / 1000) + 18000),
    },
    lines: (async function* () {
      for (const event of events) yield `data: ${JSON.stringify(event)}`;
    })(),
  });
}

/** Constant head of the billing tag, before the interpolated version. */
const BILLING_TAG_HEAD = "x-anthropic-billing-header: cc_version=";

const MODEL_FABLE = "claude-fable-5";
const MODEL_OPUS5 = "claude-opus-5";
const MODEL_OPUS48 = "claude-opus-4-8";
const MODEL_SONNET5 = "claude-sonnet-5";
const MODEL_SONNET46 = "claude-sonnet-4-6";
const MODEL_HAIKU = "claude-haiku-4-5";

// ---------------------------------------------------------------------------
// Billing tag
// ---------------------------------------------------------------------------

Deno.test("billing tag matches CC's format", () => {
  const tag = buildBillingTag(CC_VERSION);
  assert(tag.startsWith(BILLING_TAG_HEAD + CC_VERSION + "."));
  // Current CC sends no cch token.
  assertEquals(/\bcch=/.test(tag), false);
});

// ---------------------------------------------------------------------------
// Beta flags
// ---------------------------------------------------------------------------

Deno.test("oauth beta is forced into the outbound set", () => {
  const beta = betaForRequest("").split(",");
  assert(beta.includes(OAUTH_BETA));
});

Deno.test("model-conditional betas mirror CC", () => {
  const base =
    "claude-code-20250219,mid-conversation-system-2026-04-07,mid-conversation-tool-changes-2026-07-01,advisor-tool-2026-03-01,effort-2025-11-24,afk-mode-2026-01-31";
  // Haiku drops the mid-conversation/effort/afk flags.
  const haiku = betaForModel(base, MODEL_HAIKU);
  assertEquals(haiku.includes("mid-conversation-system"), false);
  assertEquals(haiku.includes("effort-2025-11-24"), false);
  // The sonnet line drops mid-conversation-tool-changes; sonnet-4 also drops
  // mid-conversation-system.
  const sonnet4 = betaForModel(base, MODEL_SONNET46);
  assertEquals(sonnet4.includes("mid-conversation-system"), false);
  assertEquals(sonnet4.includes("mid-conversation-tool-changes"), false);
  const sonnet5 = betaForModel(base, MODEL_SONNET5);
  assertEquals(sonnet5.includes("mid-conversation-system"), true);
  assertEquals(sonnet5.includes("mid-conversation-tool-changes"), false);
  // Fable / opus-5 carry fallback-credit before afk-mode.
  const fable = betaForModel(base, MODEL_FABLE);
  assertEquals(fable.includes("fallback-credit-2026-06-01,afk-mode-2026-01-31"), true);
  const opus5 = betaForModel(base, MODEL_OPUS5);
  assertEquals(opus5.includes("fallback-credit-2026-06-01,afk-mode-2026-01-31"), true);
  // opus-4-8 keeps the base set unchanged.
  const opus48 = betaForModel(base, MODEL_OPUS48);
  assertEquals(opus48.includes("fallback-credit-2026-06-01"), false);
  // The [1m] label rides context-1m after claude-code.
  const long = betaForModel(base, MODEL_OPUS48 + "[1m]");
  assertEquals(long.includes("claude-code-20250219,context-1m-2025-08-07"), true);
});

// ---------------------------------------------------------------------------
// Body build
// ---------------------------------------------------------------------------

Deno.test("body carries the CC fingerprint", () => {
  const built = buildCCRequest(request(), MODEL_OPUS48 + "[1m]", {
    deviceId: "dev-1",
    accountUuid: "acct-1",
    sessionId: "ses-1",
  });
  const body = built.body;
  // The [1m] label is stripped from the wire model.
  assertEquals(body.model, MODEL_OPUS48);
  // Key order matches CC.
  assertEquals(
    Object.keys(body),
    [
      "model",
      "messages",
      "system",
      "tools",
      "metadata",
      "max_tokens",
      "thinking",
      "context_management",
      "output_config",
      "stream",
    ],
  );
  // system[0] is the billing tag; [1] agent identity; [2] CC prompt + instructions.
  const system = body.system as Array<{ text: string; cache_control?: unknown }>;
  assert(system[0].text.startsWith(BILLING_TAG_HEAD));
  assert(system[1].text.length > 0);
  assertIncludes(system[2].text, "Be helpful.");
  assertIncludes(system[2].text, "OVERRIDE any");
  assertEquals(system[1].cache_control, { type: "ephemeral" });
  assertEquals(system[2].cache_control, { type: "ephemeral" });
  // metadata.user_id JSON identity.
  assertEquals(
    JSON.parse((body.metadata as { user_id: string }).user_id),
    { device_id: "dev-1", account_uuid: "acct-1", session_id: "ses-1" },
  );
  assertEquals(body.max_tokens, 64000);
  assertEquals(body.thinking, { type: "adaptive", display: "omitted" });
  assertEquals(body.output_config, { effort: "high" });
  assertEquals(body.stream, true);
  // Conversation breakpoint stamped on the last user message.
  const messages = body.messages as Array<
    { role: string; content: Array<Record<string, unknown>> }
  >;
  const lastUser = messages[messages.length - 1];
  assertEquals(lastUser.role, "user");
  assertEquals(lastUser.content[0].cache_control, { type: "ephemeral" });
});

Deno.test("haiku skips thinking, context_management, and output_config", () => {
  const built = buildCCRequest(request(), MODEL_HAIKU, {
    deviceId: "d",
    accountUuid: "a",
    sessionId: "s",
  });
  assertEquals("thinking" in built.body, false);
  assertEquals("context_management" in built.body, false);
  assertEquals("output_config" in built.body, false);
});

Deno.test("client tools map onto CC slots and reverse-map back", () => {
  const clientTools = [{ name: "edit_file", description: "Edit a file", parameters: {} }];
  const { toolMap } = buildForwardToolMap(clientTools);
  assertEquals(toolMap.get("edit_file")?.ccTool, "Edit");
  // Reverse lookup maps Edit back to edit_file.
  const reverse = buildReverseLookup(toolMap);
  assertEquals(reverse.get("Edit")?.clientName, "edit_file");
  // The advertised tools array is CC's canonical set.
  const built = buildCCRequest(request({ tools: clientTools }), MODEL_OPUS48, {
    deviceId: "d",
    accountUuid: "a",
    sessionId: "s",
  });
  const tools = built.body.tools as Array<{ name: string }>;
  assert(tools.some((t) => t.name === "Bash"));
  assert(tools.some((t) => t.name === "Read"));
  assert(tools.some((t) => t.name === "Edit"));
});

Deno.test("adaptive thinking gate follows the 4.6 split", () => {
  assertEquals(supportsAdaptiveThinking(MODEL_OPUS5), true);
  assertEquals(supportsAdaptiveThinking(MODEL_SONNET46), true);
  assertEquals(supportsAdaptiveThinking(MODEL_OPUS48), true);
  assertEquals(supportsAdaptiveThinking(MODEL_HAIKU), false);
});

Deno.test("effort resolution forwards the client knob", () => {
  assertEquals(resolveEffort("medium"), "medium");
  assertEquals(resolveEffort(null), "high");
});

// ---------------------------------------------------------------------------
// Headers
// ---------------------------------------------------------------------------

Deno.test("outbound headers match CC's captured set and order", () => {
  const headers = outboundHeaders(staticHeaders(), "at", "beta-set", "ses-1", "req-1");
  assertEquals(headers["authorization"], "Bearer at");
  assertEquals(headers["anthropic-beta"], "beta-set");
  assertEquals(headers["x-claude-code-session-id"], "ses-1");
  assertEquals(headers["x-client-request-id"], "req-1");
  assertEquals(headers["anthropic-version"], "2023-06-01");
  assertEquals(headers["x-app"], "cli");
  assertIncludes(headers["user-agent"], "claude-cli/");
  const keys = Object.keys(headers);
  assertEquals(keys.indexOf("accept") < keys.indexOf("user-agent"), true);
  assertEquals(keys.indexOf("anthropic-beta") < keys.indexOf("anthropic-version"), true);
});

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

Deno.test("model list carries [1m] variants for every family except haiku", () => {
  const models = parseModelList([MODEL_OPUS48, MODEL_HAIKU]);
  const ids = models.map((m) => m.id);
  assert(ids.includes(MODEL_OPUS48));
  assert(ids.includes(MODEL_OPUS48 + "[1m]"));
  assert(ids.includes(MODEL_HAIKU));
  assertEquals(ids.includes(MODEL_HAIKU + "[1m]"), false);
  assertEquals(longContextEligible(MODEL_HAIKU), false);
});

// ---------------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------------

Deno.test("redirect URI is normalized to the form the CC client accepts", () => {
  assertEquals(
    normalizeRedirectUri("http://127.0.0.1:45575/oauth-callback"),
    "http://localhost:45575/callback",
  );
  assertEquals(
    normalizeRedirectUri("http://localhost:9000/anything"),
    "http://localhost:9000/callback",
  );
});

Deno.test("oauth begin builds the CC authorize URL", async () => {
  const begin = await claudeOAuth.begin(
    {
      redirectUri: "http://127.0.0.1:0/callback",
      state: "st-1",
      codeChallenge: "cc-1",
    },
    context({}),
  );
  assertIncludes(begin.authorizationUrl, "https://claude.ai/oauth/authorize");
  assertIncludes(begin.authorizationUrl, "https://claude.ai/oauth/authorize");
  assertIncludes(begin.authorizationUrl, "https://claude.ai/oauth/authorize");
  assertIncludes(begin.authorizationUrl, "https://claude.ai/oauth/authorize");
});

Deno.test("oauth complete exchanges the code", async () => {
  let captured: { url: string; init?: RequestInit } | null = null;
  const drafts = await claudeOAuth.complete(
    { state: "st-1" } as unknown as JsonValue,
    {
      code: "auth-code",
      redirectUri: "http://127.0.0.1:0/callback",
      codeVerifier: "verifier",
    },
    context({
      fetch: (url, init) => {
        captured = { url, init };
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({
            access_token: "at",
            refresh_token: "rt",
            expires_in: 3600,
            scope: "user:inference",
          }),
        };
      },
    }),
  );
  assertIncludes(captured!.url, "https://platform.claude.com/v1/oauth/token");
  assertIncludes(captured!.init?.body ?? "", '"grant_type":"authorization_code"');
  assertIncludes(captured!.init?.body ?? "", '"client_id":"9d1c250a-e61b-44d9-88ed-5944d1962f5e"');
  assertEquals(drafts.length, 1);
  const data = drafts[0].privateData as { accessToken: string; refreshToken: string };
  assertEquals(data.accessToken, "at");
  assertEquals(data.refreshToken, "rt");
});

// ---------------------------------------------------------------------------
// Resource plumbing
// ---------------------------------------------------------------------------

Deno.test("credential import parses CC credentials.json", async () => {
  const result = await credentialImport.parse([{
    name: "credentials.json",
    content: JSON.stringify({
      claudeAiOauth: {
        accessToken: "at-import",
        refreshToken: "rt-import",
        expiresAt: Date.now() + 3600_000,
        scopes: ["user:inference"],
      },
    }),
  }], context({}));
  assertEquals(result.warnings ?? [], []);
  assertEquals(result.resources.length, 1);
  const data = result.resources[0].privateData as { accessToken: string; deviceId: string };
  assertEquals(data.accessToken, "at-import");
  assert(data.deviceId.length > 0);
});

Deno.test("credential draft assigns a stable device identity", async () => {
  const draft = await credentialDraft({
    accessToken: "at-draft",
    refreshToken: "rt-draft",
    expiresAtMs: Date.now() + 3600_000,
    displayName: null,
  });
  const data = draft.privateData as { deviceId: string; accountUuid: string; key?: string };
  assert(data.deviceId.length > 0);
  assert(data.accountUuid.length > 0);
  assertEquals(draft.key.startsWith("claude:"), true);
});

Deno.test("rate-limit snapshot parses the unified headers, including per-model 7d", () => {
  const rl = parseRateLimits({
    "anthropic-ratelimit-unified-status": "allowed",
    "anthropic-ratelimit-unified-representative-claim": "seven_day_overage_included",
    "anthropic-ratelimit-unified-5h-utilization": "0.1",
    "anthropic-ratelimit-unified-7d-utilization": "0.82",
    "anthropic-ratelimit-unified-7d_oi-utilization": "0.99",
    "anthropic-ratelimit-unified-overage-utilization": "0",
    "anthropic-ratelimit-unified-reset": "1700000000",
  });
  assertEquals(rl.claim, "seven_day_overage_included");
  assertEquals(rl.util5h, 0.1);
  assertEquals(rl.util7d, 0.82);
  assertEquals(rl.perModel7d["oi"], 0.99);
  // The oi bucket binds fable (seed) — fable's headroom reads the binding.
  assert(computeHeadroom(rl, "fable") < 0.02);
  // A request for opus ignores the oi bucket.
  assert(computeHeadroom(rl, "opus") > 0.1);
});

Deno.test("billing buckets classify the representative claim", () => {
  assertEquals(billingBucketFromClaim("five_hour"), "subscription");
  assertEquals(billingBucketFromClaim("seven_day_overage_included"), "subscription");
  assertEquals(billingBucketFromClaim("seven_day_fallback"), "subscription_fallback");
  assertEquals(billingBucketFromClaim("overage"), "extra_usage");
  assertEquals(billingBucketFromClaim("api"), "api");
  assertEquals(billingBucketFromClaim("who_knows"), "unknown");
  // The overage guard fires on anything non-subscription except the sentinel.
  assertEquals(isNonSubscriptionBilling("overage"), true);
  assertEquals(isNonSubscriptionBilling("seven_day"), false);
  assertEquals(isNonSubscriptionBilling("unknown"), false);
  assertEquals(isNonSubscriptionBilling(null), false);
});

Deno.test("window rejection requires the reading to show exhaustion", () => {
  const exhausted = parseRateLimits({
    "anthropic-ratelimit-unified-status": "rejected",
    "anthropic-ratelimit-unified-5h-utilization": "1.02",
    "anthropic-ratelimit-unified-representative-claim": "five_hour",
  });
  assert(isWindowRejection(exhausted));
  assertEquals(snapshotState(exhausted).status, "cooling");
  // A 429 reading 30% used is NOT a window rejection.
  const partial = parseRateLimits({
    "anthropic-ratelimit-unified-status": "rejected",
    "anthropic-ratelimit-unified-5h-utilization": "0.3",
    "anthropic-ratelimit-unified-representative-claim": "five_hour",
  });
  assertEquals(isWindowRejection(partial), false);
});

Deno.test("elapsed windows expire only for the claim's own bucket", () => {
  const now = 1_800_000_000_000;
  const headers = {
    "anthropic-ratelimit-unified-representative-claim": "five_hour",
    "anthropic-ratelimit-unified-5h-utilization": "0.95",
    "anthropic-ratelimit-unified-7d-utilization": "0.7",
    "anthropic-ratelimit-unified-reset": String(now / 1000 - 10),
  };
  const snapshot = parseRateLimits(headers, now);
  const expired = expireElapsedWindow(snapshot, now);
  // The five-hour reading (the claim's bucket) is zeroed…
  assertEquals(expired.util5h, 0);
  // …but the weekly reading is untouched — a 5h rollover must not clear 7d.
  assertEquals(expired.util7d, 0.7);
  // An unknown claim expires nothing.
  const unknown = expireElapsedWindow(
    parseRateLimits({
      "anthropic-ratelimit-unified-representative-claim": "unknown",
      "anthropic-ratelimit-unified-5h-utilization": "0.95",
      "anthropic-ratelimit-unified-reset": String(now / 1000 - 10),
    }, now),
    now,
  );
  assertEquals(unknown.util5h, 0.95);
});

Deno.test("upstream model ids normalize to the advertised base set", () => {
  const bases = normalizeUpstreamIds([
    "claude-fable-5",
    "claude-opus-5-20260101",
    "claude-opus-5",
    "claude-opus-4-8",
    "claude-haiku-4-5",
    "gpt-5",
  ]);
  // Legacy generations and non-claude ids are dropped.
  assertEquals(bases.includes("claude-opus-5-20260101"), false);
  assertEquals(bases.includes("gpt-5"), false);
  // Families rank flagship-first; the dated duplicate collapsed to the short id.
  assertEquals(bases[0], "claude-fable-5");
  assertEquals(bases.includes("claude-opus-4-8"), true);
  assertEquals(bases.includes("claude-haiku-4-5"), true);
});
Deno.test("refresh-token grant age surfaces the approaching wall", () => {
  const now = 1_800_000_000_000;
  const fresh = grantAge(now - 5 * 86_400_000, now);
  assertEquals(fresh.level, "ok");
  const warn = grantAge(now - 22 * 86_400_000, now);
  assertEquals(warn.level, "warn");
  const urgent = grantAge(now - 27 * 86_400_000, now);
  assertEquals(urgent.level, "urgent");
  assert(describeGrantAge(urgent).includes("re-grant TODAY"));
  // Preserved-across-refresh semantics: unknown when never recorded.
  assertEquals(grantAge(null, now).level, "unknown");
});

Deno.test("present view hides credentials and shows the account", () => {
  const view = presentAccount(resource());
  assertEquals(view.displayName, "user@example.com");
  assertEquals(JSON.stringify(view).includes("at-test"), false);
});

// ---------------------------------------------------------------------------
// Provider streaming
// ---------------------------------------------------------------------------

Deno.test("invoke emits normalized events and reverse-maps tool calls", async () => {
  const events: ModelEvent[] = [];
  const result = await claudeProvider.invoke(
    {
      model: { id: MODEL_OPUS48, displayName: "x" },
      resource: resource(),
      request: request({
        tools: [{ name: "edit_file", description: "", parameters: {} }],
      }),
    },
    { emit: (event) => events.push(event) },
    context({
      stream: sseStream([
        { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 0 } } },
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "tu_1", name: "Edit" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '{"file_path":"/a"}' },
        },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } },
        { type: "message_stop" },
      ]),
    }),
  );
  assertEquals(result.status, "completed");
  const start = events.find((e) => e.type === "tool-call-start");
  assertEquals(start && "name" in start ? start.name : null, "edit_file");
  const end = events.find((e) => e.type === "done");
  assertEquals(end && "reason" in end ? end.reason : "tool-use", "tool-use");
  const usage = events.find((e) => e.type === "usage");
  assert(usage !== undefined);
});

Deno.test("overage guard halts the account on a non-subscription claim", async () => {
  const events: ModelEvent[] = [];
  // A 200 whose headers carry a paid-overage claim: the response itself
  // succeeds, but the billing flip must stop the account from serving.
  const result = await claudeProvider.invoke(
    {
      model: { id: MODEL_OPUS48, displayName: "x" },
      resource: resource(),
      request: request(),
    },
    { emit: (event) => events.push(event) },
    context({
      stream: () => ({
        status: 200,
        headers: {
          "anthropic-ratelimit-unified-status": "allowed",
          "anthropic-ratelimit-unified-representative-claim": "overage",
          "anthropic-ratelimit-unified-overage-utilization": "0.1",
        },
        lines: (async function* () {
          yield "data: " + JSON.stringify({
            type: "message_start",
            message: { usage: { input_tokens: 1, output_tokens: 0 } },
          });
          yield "data: " + JSON.stringify({
            type: "content_block_start",
            index: 0,
            content_block: { type: "text" },
          });
          yield "data: " + JSON.stringify({
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "hi" },
          });
          yield "data: " + JSON.stringify({ type: "content_block_stop", index: 0 });
          yield "data: " + JSON.stringify({
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
          });
          yield "data: " + JSON.stringify({ type: "message_stop" });
        })(),
      }),
    }),
  );
  assertEquals(result.status, "resource-error");
  const patch = "patch" in result ? result.patch : undefined;
  assert(patch !== undefined && patch.state?.status === "cooling");
  // The privateData keeps the flip visible to the account view.
  const data = patch.privateData as { rateLimit: { claim: string } };
  assertEquals(data.rateLimit.claim, "overage");
});

Deno.test("invoke streams text and thinking", async () => {
  const events: ModelEvent[] = [];
  const result = await claudeProvider.invoke(
    {
      model: { id: MODEL_OPUS5, displayName: "x" },
      resource: resource(),
      request: request(),
    },
    { emit: (event) => events.push(event) },
    context({
      stream: sseStream([
        { type: "message_start", message: { usage: { input_tokens: 10 } } },
        { type: "content_block_start", index: 0, content_block: { type: "thinking" } },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "hmm" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "signature_delta", signature: "sig" },
        },
        { type: "content_block_stop", index: 0 },
        { type: "content_block_start", index: 1, content_block: { type: "text" } },
        { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "hi" } },
        { type: "content_block_stop", index: 1 },
        { type: "message_delta", delta: { stop_reason: "end_turn" } },
        { type: "message_stop" },
      ]),
    }),
  );
  assertEquals(result.status, "completed");
  assert(events.some((e) => e.type === "thinking-delta"));
  assert(events.some((e) => e.type === "text-delta" && e.text === "hi"));
  const replay = events.find((e) => e.type === "replay-state");
  assert(replay !== undefined);
});

Deno.test("invoke returns invalid on terminal auth failure", async () => {
  const result = await claudeProvider.invoke(
    {
      model: { id: MODEL_OPUS48, displayName: "x" },
      resource: resource(),
      request: request(),
    },
    { emit: () => {} },
    context({
      stream: () => ({
        status: 401,
        headers: {},
        lines: (async function* () {
          yield "data: " + JSON.stringify({ type: "error", error: { message: "bad token" } });
        })(),
      }),
    }),
  );
  assertEquals(result.status, "resource-error");
  const invalidPatch = "patch" in result ? result.patch : undefined;
  assert(invalidPatch !== undefined && invalidPatch.state?.status === "invalid");
});

Deno.test("invoke cools the account on quota exhaustion", async () => {
  const result = await claudeProvider.invoke(
    {
      model: { id: MODEL_OPUS48, displayName: "x" },
      resource: resource(),
      request: request(),
    },
    { emit: () => {} },
    context({
      stream: () => ({
        status: 429,
        headers: {},
        lines: (async function* () {
          yield "data: " + JSON.stringify({
            type: "error",
            error: { message: "rate_limit exceeded" },
          });
        })(),
      }),
    }),
  );
  assertEquals(result.status, "resource-error");
  const coolingPatch = "patch" in result ? result.patch : undefined;
  assert(coolingPatch !== undefined && coolingPatch.state?.status === "cooling");
});

Deno.test("the provider re-exports the billing classification", () => {
  assertEquals(typeof billingBucketFromClaim, "function");
  assertEquals(typeof isNonSubscriptionBilling, "function");
  assertEquals(billingBucketFromClaim("five_hour"), "subscription");
});
