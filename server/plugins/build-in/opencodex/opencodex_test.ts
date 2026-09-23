import type { JsonValue } from "cursor-byok:plugin";
import type { ResourceSnapshot } from "cursor-byok:resource";
import { assert, assertEquals, context } from "../test_helpers.ts";
import { parseModels } from "./models.ts";
import { selectEffort } from "./provider.ts";
import { formAdd, normalizeBaseUrl, presentEndpoint, RESOURCE_TYPE } from "./resources.ts";

function snapshot(privateData: JsonValue): ResourceSnapshot {
  return {
    id: "resource-1",
    type: RESOURCE_TYPE,
    key: "https://proxy.example.com/v1",
    privateData,
    state: { status: "ready" },
  };
}

Deno.test("normalizeBaseUrl enforces https and defaults the path to /v1", () => {
  assertEquals(normalizeBaseUrl("https://x.example.com"), "https://x.example.com/v1");
  assertEquals(normalizeBaseUrl("https://x.example.com/"), "https://x.example.com/v1");
  assertEquals(normalizeBaseUrl("https://x.example.com/v1/"), "https://x.example.com/v1");
  assertEquals(
    normalizeBaseUrl("https://x.example.com/proxy/v1"),
    "https://x.example.com/proxy/v1",
  );
  assertEquals(
    normalizeBaseUrl("  https://x.example.com/v1/?q=1#frag  "),
    "https://x.example.com/v1",
  );
  for (const bad of ["http://x.example.com", "x.example.com", "https://", ""]) {
    let message = "";
    try {
      normalizeBaseUrl(bad);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assert(message.includes("https://"), `expected an https error for '${bad}'`);
  }
});

const MODELS_BODY = {
  default_model: "codex-large",
  data: [
    {
      id: "codex-small",
      display_name: "Codex Small",
      api_types: ["responses"],
      reasoning_efforts: [{ value: "low", default: true }, { value: "high" }],
      max_output_tokens: 64_000,
      capabilities: { input_modalities: ["text", "image"] },
    },
    {
      id: "chat-only",
      api_types: ["chat_completions"],
    },
    {
      id: "codex-large",
      name: "Codex Large",
      api_types: ["responses", "chat_completions"],
      capabilities: { supports_vision: false, reasoning_effort: ["medium"] },
      max_completion_tokens: 128_000,
    },
    { id: "codex-large" },
  ],
};

Deno.test("parseModels filters non-Responses models and dedupes ids", () => {
  const models = parseModels(MODELS_BODY);
  assertEquals(models.map((model) => model.id), ["codex-large", "codex-small"]);
  const [large, small] = models;
  assertEquals(large.displayName, "Codex Large");
  assertEquals(large.maxOutputTokens, 128_000);
  assertEquals(large.capabilities, { images: false });
  assertEquals(large.privateData, { reasoningEfforts: ["medium"] });
  assertEquals(small.displayName, "Codex Small");
  assertEquals(small.maxOutputTokens, 64_000);
  assertEquals(small.capabilities, { images: true });
  assertEquals(small.privateData, { reasoningEfforts: ["low", "high"] });
});

Deno.test("form submit validates the endpoint and drafts key on the base URL", async () => {
  let requestedUrl = "";
  let requestedAuth = "";
  const stub = context({
    fetch: (url, init) => {
      requestedUrl = url;
      requestedAuth = init?.headers?.authorization ?? "";
      return { status: 200, headers: {}, body: JSON.stringify(MODELS_BODY) };
    },
  });
  const drafts = await formAdd.submit(
    { "base-url": "https://proxy.example.com", "api-key": " key-1 ", "name": "" },
    stub,
  );
  assertEquals(requestedUrl, "https://proxy.example.com/v1/models");
  assertEquals(requestedAuth, "Bearer key-1");
  assertEquals(drafts, [{
    key: "https://proxy.example.com/v1",
    privateData: {
      baseUrl: "https://proxy.example.com/v1",
      apiKey: "key-1",
      displayName: "proxy.example.com",
    },
  }]);

  const named = await formAdd.submit(
    { "base-url": "https://proxy.example.com/v1", "api-key": "key-2", "name": "Work" },
    stub,
  );
  assertEquals(
    (named[0].privateData as Record<string, unknown>).displayName,
    "Work",
  );
});

Deno.test("form submit surfaces upstream validation failures", async () => {
  const stub = context({
    fetch: () => ({ status: 401, headers: {}, body: "bad key" }),
  });
  let message = "";
  try {
    await formAdd.submit(
      { "base-url": "https://proxy.example.com/v1", "api-key": "nope" },
      stub,
    );
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assert(message.includes("HTTP 401"), `expected an HTTP 401 error, got: ${message}`);
});

Deno.test("presentEndpoint never exposes the API key", () => {
  const view = presentEndpoint(snapshot({
    baseUrl: "https://proxy.example.com/v1",
    apiKey: "super-secret-key",
    displayName: "Work proxy",
  }));
  assertEquals(view.displayName, "Work proxy");
  assertEquals(view.description, "https://proxy.example.com/v1");
  assert(
    !JSON.stringify(view).includes("super-secret-key"),
    "resource view exposed an API key",
  );
});

Deno.test("selectEffort honors the catalog axis and passes through unknown catalogs", () => {
  const [large, small] = parseModels(MODELS_BODY);
  assertEquals(selectEffort(small, "high"), "high");
  assertEquals(selectEffort(small, "medium"), null);
  assertEquals(selectEffort(small, null), null);
  assertEquals(selectEffort({ ...large, privateData: { reasoningEfforts: [] } }, "xhigh"), "xhigh");
});
