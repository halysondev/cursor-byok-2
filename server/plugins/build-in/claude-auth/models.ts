/**
 * Advertised model catalog — live from Anthropic with a baked fallback.
 *
 * The catalog asks api.anthropic.com /v1/models what actually exists (the
 * same surface real CC sees), TTL-cached in-process, falling back to the
 * baked list whenever upstream is unreachable or no account is available
 * yet. `[1m]` long-context labels are generated, never stored: every family
 * takes a `[1m]` variant except haiku (CC's picker never offers 1M haiku).
 * `[1m]` is a client-side label — the provider strips it and rides the
 * context-1m beta.
 */

import type { JsonValue, PluginContext } from "cursor-byok:plugin";
import type { ModelDefinition, ModelSupport } from "cursor-byok:model";
import type { ResourceSnapshot } from "cursor-byok:resource";
import { accountData, RESOURCE_TYPE } from "./resources.ts";

const MODELS_URL = "https://api.anthropic.com/v1/models?limit=100";
const ANTHROPIC_VERSION = "2023-06-01";

/** Baked fallback — the catalog served when upstream has never answered. */
export const BAKED_BASE_MODELS: readonly string[] = [
  "claude-fable-5",
  "claude-opus-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-sonnet-5",
  "claude-sonnet-4-6",
  "claude-haiku-4-5",
];

/** A base id takes a `[1m]` variant unless it's the haiku family. */
export function longContextEligible(id: string): boolean {
  const m = id.toLowerCase();
  return m.startsWith("claude-") && !m.includes("haiku") && !m.endsWith("[1m]");
}

/** Expand base ids into the advertised list, each eligible base followed by its `[1m]` variant. */
export function withLongContextVariants(bases: readonly string[]): string[] {
  return bases.flatMap((b) => (longContextEligible(b) ? [b, `${b}[1m]`] : [b]));
}

/** Numeric segments of a model id for version ordering. */
export function modelVersionKey(id: string): number[] {
  const nums = id.match(/\d+/g);
  return nums ? nums.map(Number) : [];
}

/** Descending version compare on modelVersionKey output. */
function cmpVersionDesc(a: readonly number[], b: readonly number[]): number {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = (b[i] ?? -1) - (a[i] ?? -1);
    if (d !== 0) return d;
  }
  return 0;
}

// Advertised order: the flagship family first, then the big families.
// Unknown future families rank last (still advertised — a brand-new family
// shows up on the next catalog refresh without a plugin release).
const FAMILY_RANK: Record<string, number> = { fable: 0, opus: 1, sonnet: 2, haiku: 3 };

// Known families older than this generation are dropped from the advertised
// list (claude-3-x etc. — not what a CC-shaped provider should offer). fable is
// exempt: its versioning is its own line (fable-5).
const MIN_GENERATION = 4;

/** Extract the model family from an id; null when it carries none. */
export function modelFamily(modelId: string): string | null {
  const m = modelId.toLowerCase();
  if (m.includes("fable")) return "fable";
  if (m.includes("opus")) return "opus";
  if (m.includes("sonnet")) return "sonnet";
  if (m.includes("haiku")) return "haiku";
  return null;
}

/**
 * Normalize a raw upstream id listing into the advertised base set:
 *  - keep `claude-*` ids only (no [1m] tags — those are ours to generate)
 *  - drop legacy generations of known families (< 4; fable exempt)
 *  - prefer the short id when upstream lists both spellings
 *  - deterministic order: family rank, then version desc, unknown families last
 */
export function normalizeUpstreamIds(ids: readonly string[]): string[] {
  let list = ids.filter(
    (id) => typeof id === "string" && /^claude-/i.test(id) && !id.includes("["),
  );

  list = list.filter((id) => {
    const fam = modelFamily(id);
    if (fam === null || fam === "fable") return true;
    return (modelVersionKey(id)[0] ?? 0) >= MIN_GENERATION;
  });

  const byKey = new Map<string, string>();
  for (const id of list) {
    const key = id.replace(/-\d{8}$/, "").toLowerCase();
    const existing = byKey.get(key);
    if (existing === undefined) {
      byKey.set(key, id);
    } else if (id.toLowerCase() === key && existing.toLowerCase() !== key) {
      byKey.set(key, id); // short form wins over dated duplicate
    }
  }

  return [...byKey.values()].sort((a, b) => {
    const ra = FAMILY_RANK[modelFamily(a) ?? ""] ?? 99;
    const rb = FAMILY_RANK[modelFamily(b) ?? ""] ?? 99;
    if (ra !== rb) return ra - rb;
    return cmpVersionDesc(modelVersionKey(a), modelVersionKey(b));
  });
}

function displayName(id: string): string {
  const longContext = id.endsWith("[1m]");
  const base = longContext ? id.slice(0, -4) : id;
  const words = base.replace(/^claude-/, "").split("-");
  const family = words[0] ?? base;
  const version = words.slice(1).join(".");
  const label = version ? `${family} ${version}` : family;
  return longContext ? `${label} [1M]` : label;
}

export function parseModelList(bases: readonly string[]): ModelDefinition[] {
  return withLongContextVariants(bases).map((id) => ({
    id,
    displayName: displayName(id),
    capabilities: { images: true },
  }));
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

// ---------------------------------------------------------------------------
// Cached live catalog
// ---------------------------------------------------------------------------

interface CatalogCache {
  bases: string[];
  fetchedAt: number;
}

const DEFAULT_TTL_MS = 3_600_000; // 1h — model launches are rare
const DEFAULT_RETRY_MS = 300_000; // failed-fetch backoff: 5 min

let cache: CatalogCache | null = null;
let lastAttempt = 0;
let inflight: Promise<string[]> | null = null;

/** Fetch the live base list with the account's OAuth bearer. */
export async function fetchUpstreamBases(
  accessToken: string,
  context: PluginContext,
): Promise<string[]> {
  const response = await context.network.fetch(MODELS_URL, {
    method: "GET",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${accessToken}`,
      "anthropic-version": ANTHROPIC_VERSION,
      "anthropic-beta": "oauth-2025-04-20",
    },
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`model catalog fetch failed (HTTP ${response.status})`);
  }
  let body: unknown;
  try {
    body = JSON.parse(response.body);
  } catch {
    throw new Error("model catalog response returned invalid JSON");
  }
  const data = object(body)?.data;
  const ids = Array.isArray(data)
    ? data.flatMap((entry) => {
      const id = object(entry)?.id;
      return typeof id === "string" ? [id] : [];
    })
    : [];
  const bases = normalizeUpstreamIds(ids);
  if (bases.length === 0) throw new Error("model catalog returned no usable claude ids");
  return bases;
}

/**
 * The catalog, stale-while-revalidate. A warm cache returns immediately
 * (kicking an async refresh when past TTL); a cold start tries upstream once
 * and falls back to the baked list. Never throws — the model list must always
 * answer.
 */
export async function catalogBases(
  resource: ResourceSnapshot | null,
  context: PluginContext,
): Promise<string[]> {
  const now = Date.now();
  const fresh = cache !== null && now - cache.fetchedAt < DEFAULT_TTL_MS;
  if (cache !== null && fresh) return cache.bases;

  const canFetch = resource !== null && now - lastAttempt >= DEFAULT_RETRY_MS;
  if (canFetch && inflight === null) {
    lastAttempt = now;
    const accessToken = (() => {
      try {
        return accountData(resource).accessToken;
      } catch {
        return null;
      }
    })();
    if (accessToken) {
      inflight = fetchUpstreamBases(accessToken, context)
        .then((bases) => {
          cache = { bases, fetchedAt: Date.now() };
          return bases;
        })
        .finally(() => {
          inflight = null;
        });
      try {
        return await inflight;
      } catch {
        // fall through to whatever we have
      }
    }
  }

  if (cache !== null) return cache.bases;
  return [...BAKED_BASE_MODELS];
}

export const claudeModels: ModelSupport = {
  list: async ({ resource }, context): Promise<ModelDefinition[]> =>
    parseModelList(await catalogBases(resource, context)),
};

/** Test hook: reset the in-process catalog cache. */
export function resetCatalogCacheForTest(): void {
  cache = null;
  lastAttempt = 0;
  inflight = null;
}

export type { JsonValue };
