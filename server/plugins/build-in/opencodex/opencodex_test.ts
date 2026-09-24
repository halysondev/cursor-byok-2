import type { JsonValue } from "cursor-byok:plugin";
import type { ResourceSnapshot } from "cursor-byok:resource";
import { assert, assertEquals, context } from "../test_helpers.ts";
import { defaultReasoningLevel, fetchModels, parseModels, supportsFast } from "./models.ts";
import { selectEffort, selectLatency } from "./provider.ts";
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

const CATALOG_BODY = {
  default_model: "codex-small",
  models: [
    {
      slug: "codex-mid",
      display_name: "Codex Mid",
      supported_reasoning_levels: ["minimal", { effort: "medium" }],
      visibility: "list",
      supported_in_api: true,
      priority: 15,
      input_modalities: ["text"],
    },
    {
      slug: "codex-small",
      display_name: "Codex Small",
      description: "Small and quick.",
      supported_reasoning_levels: [
        { effort: "low", description: "Fast answers" },
        { effort: "high" },
      ],
      default_reasoning_level: "low",
      visibility: "list",
      supported_in_api: true,
      priority: 20,
      additional_speed_tiers: ["fast"],
      input_modalities: ["text", "image"],
      max_output_tokens: 64_000,
    },
    { slug: "codex-hidden", visibility: "Hidden" },
    { slug: "codex-off", supported_in_api: false },
    {
      slug: "codex-large",
      display_name: "Codex Large",
      supported_reasoning_levels: [{ effort: "medium" }, "high"],
      visibility: "list",
      supported_in_api: true,
      priority: 10,
      service_tiers: [{ id: "priority", name: "Priority" }],
      input_modalities: ["text"],
      max_completion_tokens: 128_000,
    },
    { slug: "codex-large" },
    { slug: "codex-noprio", visibility: "list", supported_in_api: true },
    { id: "codex-legacy", visibility: "list", supported_in_api: true },
    { display_name: "no-id" },
    "junk",
    42,
  ],
};

Deno.test("parseModels filters the catalog and puts the default model first", () => {
  const models = parseModels(CATALOG_BODY);
  // codex-small leads as default_model despite its worse priority; the rest follows
  // ascending priority, with priority-less models last in upstream order.
  assertEquals(
    models.map((model) => model.id),
    ["codex-small", "codex-large", "codex-mid", "codex-noprio", "codex-legacy"],
  );
  const [small, large, mid, noprio, legacy] = models;
  assertEquals(small.displayName, "Codex Small");
  assertEquals(small.description, "Small and quick.");
  assertEquals(small.maxOutputTokens, 64_000);
  assertEquals(small.capabilities, { images: true });
  assertEquals(small.privateData, {
    reasoningEfforts: ["low", "high"],
    defaultReasoningLevel: "low",
    supportsFast: true,
  });
  assertEquals(large.displayName, "Codex Large");
  assertEquals(large.maxOutputTokens, 128_000);
  assertEquals(large.capabilities, { images: false });
  assertEquals(large.privateData, {
    reasoningEfforts: ["medium", "high"],
    defaultReasoningLevel: null,
    supportsFast: true,
  });
  assertEquals(mid.privateData, {
    reasoningEfforts: ["minimal", "medium"],
    defaultReasoningLevel: null,
    supportsFast: false,
  });
  assertEquals(noprio.displayName, "codex-noprio");
  assertEquals(noprio.description, undefined);
  assertEquals(legacy.id, "codex-legacy");
});

Deno.test("parseModels orders by priority alone when no default is declared", () => {
  const models = parseModels({ models: CATALOG_BODY.models });
  assertEquals(
    models.map((model) => model.id),
    ["codex-large", "codex-mid", "codex-small", "codex-noprio", "codex-legacy"],
  );
});

Deno.test("parseModels rejects a response without a model list", () => {
  let message = "";
  try {
    parseModels({ data: [] });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assert(message.includes("model list"), `expected a model list error, got: ${message}`);
});

Deno.test("fetchModels rejects an empty catalog", async () => {
  const stub = context({
    fetch: () => ({ status: 200, headers: {}, body: JSON.stringify({ models: [] }) }),
  });
  let message = "";
  try {
    await fetchModels("https://proxy.example.com/v1", "key-1", stub);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assert(message.includes("no models"), `expected an empty catalog error, got: ${message}`);
});

Deno.test("form submit validates the endpoint against the catalog and drafts key on the base URL", async () => {
  let requestedUrl = "";
  let requestedAuth = "";
  const stub = context({
    fetch: (url, init) => {
      requestedUrl = url;
      requestedAuth = init?.headers?.authorization ?? "";
      return { status: 200, headers: {}, body: JSON.stringify(CATALOG_BODY) };
    },
  });
  const drafts = await formAdd.submit(
    { "base-url": "https://proxy.example.com", "api-key": " key-1 ", "name": "" },
    stub,
  );
  assertEquals(requestedUrl, "https://proxy.example.com/v1/catalog");
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

Deno.test("catalog privateData readers expose efforts, default level, and fast support", () => {
  const [small, large, mid] = parseModels(CATALOG_BODY);
  assertEquals(defaultReasoningLevel(small), "low");
  assertEquals(defaultReasoningLevel(large), null);
  assertEquals(supportsFast(small), true);
  assertEquals(supportsFast(large), true);
  assertEquals(supportsFast(mid), false);
});

Deno.test("selectEffort honors the catalog axis and falls back to the default level", () => {
  const [small, large, mid] = parseModels(CATALOG_BODY);
  assertEquals(selectEffort(small, "high"), "high");
  assertEquals(selectEffort(small, "medium"), null);
  assertEquals(selectEffort(small, null), "low");
  assertEquals(selectEffort(large, null), null);
  assertEquals(selectEffort(mid, "minimal"), "minimal");
  assertEquals(
    selectEffort({ ...large, privateData: { reasoningEfforts: [] } }, "xhigh"),
    "xhigh",
  );
});

Deno.test("selectLatency clamps fast to standard when the model lacks a fast tier", () => {
  const [small, large, mid] = parseModels(CATALOG_BODY);
  assertEquals(selectLatency(small, "fast"), "fast");
  assertEquals(selectLatency(large, "fast"), "fast");
  assertEquals(selectLatency(mid, "fast"), "standard");
  assertEquals(selectLatency(mid, "standard"), "standard");
});
