/**
 * Subscription rate-limit snapshot and billing classification.
 *
 * Every Messages response carries Anthropic's unified rate-limit headers.
 * The snapshot is what the account view and the overage guard read:
 *
 *   - `status` / `claim` — which window the request was metered against
 *   - `util5h` / `util7d` — the 5-hour and 7-day windows, 0..1+
 *   - `perModel7d` — per-family weekly buckets (`7d_sonnet`, `7d_oi`, …),
 *     parsed generically so any future `7d_<family>` shape is captured
 *   - `overageUtil` / `fallbackPct` / `retryAfterMs`
 *
 * The billing bucket classifies the representative claim: subscription,
 * subscription fallback, extra usage (overage), or pure API billing. The
 * overage guard fires on anything that is NOT a known subscription claim
 * and NOT the `unknown` sentinel — an allow-list, so a bucket Anthropic
 * introduces later still halts instead of silently bleeding per-token.
 */

export interface RateLimitSnapshot {
  status: string;
  util5h: number;
  util7d: number;
  /** Per-model 7-day utilization buckets, keyed by the wire suffix (lowercase). */
  perModel7d: Record<string, number>;
  overageUtil: number;
  claim: string;
  /** Epoch seconds of the representative window's rollover, as sent. */
  reset: number;
  fallbackPct: number;
  updatedAt: number;
  /** `retry-after` on the response, in ms; null when absent. */
  retryAfterMs: number | null;
}

export const EMPTY_SNAPSHOT: RateLimitSnapshot = {
  status: "unknown",
  util5h: 0,
  util7d: 0,
  perModel7d: {},
  overageUtil: 0,
  claim: "unknown",
  reset: 0,
  fallbackPct: 0,
  updatedAt: 0,
  retryAfterMs: null,
};

/** `…-7d_<bucket>-utilization` — a per-family weekly window. */
const PER_MODEL_7D_HEADER = /^anthropic-ratelimit-unified-7d_([a-z0-9-]+)-utilization$/i;
/** `…-7d_<bucket>-status`: `rejected` names the bucket that refused this request. */
const PER_MODEL_7D_STATUS_HEADER = /^anthropic-ratelimit-unified-7d_([a-z0-9-]+)-status$/i;

/**
 * Which wire buckets bind which model family, when the wire does not say it
 * by name. `7d_sonnet` names its family; `7d_oi` does not — it is the plan's
 * INCLUDED-OVERAGE credit, and it is what Fable's weekly allowance is metered
 * on (a Fable response at 7d 82% with `7d_oi` at 99% still served at $0, and
 * at `7d_oi` ≥ 1.0 Fable answered a hard 429 while Opus kept serving). Other
 * families are learned per account from the wire (see parseRateLimits).
 */
export const WIRE_BUCKET_BINDINGS: Readonly<Record<string, readonly string[]>> = {
  oi: ["fable"],
};

/** Parse `retry-after`: delta-seconds or an HTTP date; null when absent or unreadable. */
export function parseRetryAfterMs(value: string | null, now: number = Date.now()): number | null {
  if (!value) return null;
  const secs = Number(value);
  if (Number.isFinite(secs) && secs >= 0) return Math.round(secs * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

/** Parse an Anthropic response's rate-limit headers into a snapshot. */
export function parseRateLimits(
  headers: Record<string, string>,
  now: number = Date.now(),
): RateLimitSnapshot {
  const get = (key: string): string => {
    const direct = headers[`anthropic-ratelimit-unified-${key}`];
    return direct ?? headers[`Anthropic-Ratelimit-Unified-${key}`] ?? "";
  };
  const perModel7d: Record<string, number> = {};
  const rejectedBuckets: string[] = [];
  for (const [k, v] of Object.entries(headers)) {
    const m = k.match(PER_MODEL_7D_HEADER);
    if (m && m[1]) {
      perModel7d[m[1].toLowerCase()] = parseFloat(v) || 0;
      continue;
    }
    const st = k.match(PER_MODEL_7D_STATUS_HEADER);
    if (st && st[1] && v.trim().toLowerCase() === "rejected") {
      rejectedBuckets.push(st[1].toLowerCase());
    }
  }
  return {
    status: get("status") || "unknown",
    util5h: parseFloat(get("5h-utilization")) || 0,
    util7d: parseFloat(get("7d-utilization")) || 0,
    perModel7d,
    overageUtil: parseFloat(get("overage-utilization")) || 0,
    claim: get("representative-claim") || "unknown",
    reset: parseInt(get("reset")) || 0,
    fallbackPct: parseFloat(get("fallback-percentage")) || 0,
    updatedAt: now,
    retryAfterMs: parseRetryAfterMs(headers["retry-after"] ?? headers["Retry-After"] ?? null, now),
  };
}

// ---------------------------------------------------------------------------
// Billing buckets
// ---------------------------------------------------------------------------

export type BillingBucket =
  | "subscription"
  | "subscription_fallback"
  | "extra_usage"
  | "api"
  | "unknown";

/**
 * Map the raw `representative-claim` header value to a billing bucket.
 * `*_overage_included` is the plan's INCLUDED overage credit — observed live
 * at $0 out of pocket — so it is subscription billing, not extra usage. Real
 * paid overage arrives as `overage`.
 */
export function billingBucketFromClaim(claim: string | null | undefined): BillingBucket {
  switch (claim) {
    case "five_hour":
    case "seven_day":
    case "five_hour_overage_included":
    case "seven_day_overage_included":
      return "subscription";
    case "five_hour_fallback":
    case "seven_day_fallback":
      return "subscription_fallback";
    case "overage":
      return "extra_usage";
    case "api":
      return "api";
    default:
      return "unknown";
  }
}

/** The claim values that mean "billed against the subscription pool". */
export const SUBSCRIPTION_CLAIMS: ReadonlySet<string> = new Set([
  "five_hour",
  "seven_day",
  "five_hour_fallback",
  "seven_day_fallback",
  "five_hour_overage_included",
  "seven_day_overage_included",
]);

/**
 * The sentinel `claim` when a response carried no rate-limit header at all
 * (non-200s, stream aborts). NOT a billing classification — the overage guard
 * must never fire on it.
 */
export const NO_BILLING_CLAIM = "unknown";

/**
 * True when a claim represents real *non-subscription* billing. Deliberately
 * an allow-list: it fires on anything that is NOT a known subscription claim
 * AND NOT the `unknown` sentinel, so `overage` and `api` are caught as before,
 * and so is any new credit/SDK bucket introduced without notice.
 */
export function isNonSubscriptionBilling(claim: string | null | undefined): boolean {
  if (!claim || claim === NO_BILLING_CLAIM) return false;
  return !SUBSCRIPTION_CLAIMS.has(claim);
}

// ---------------------------------------------------------------------------
// Window semantics
// ---------------------------------------------------------------------------

/** Extract the model family from a request's model id; null when none. */
export function modelFamily(modelId: string | null | undefined): string | null {
  if (!modelId) return null;
  const m = modelId.toLowerCase();
  if (m.includes("fable")) return "fable";
  if (m.includes("opus")) return "opus";
  if (m.includes("sonnet")) return "sonnet";
  if (m.includes("haiku")) return "haiku";
  return null;
}

/** Every bucket name that binds `family` for this reading — by name, by seed, or as learned. */
export function bucketsBindingFamily(
  snapshot: RateLimitSnapshot,
  family: string,
  learned?: Record<string, string[]>,
): string[] {
  const out = [family];
  for (const [bucket, families] of Object.entries(WIRE_BUCKET_BINDINGS)) {
    if (families.includes(family) && !out.includes(bucket)) out.push(bucket);
  }
  for (const bucket of learned?.[family] ?? []) if (!out.includes(bucket)) out.push(bucket);
  return out;
}

/**
 * Drop a utilization reading whose own window has already rolled over. Only
 * the bucket the reading's own `claim` names is dropped — `reset` states the
 * rollover of the representative window and nothing else, so a five-hour
 * rollover must not clear a seven-day reading.
 */
export function expireElapsedWindow(
  snapshot: RateLimitSnapshot,
  now: number = Date.now(),
): RateLimitSnapshot {
  if (!(snapshot.reset > 0 && snapshot.reset * 1000 <= now)) return snapshot;
  if (snapshot.claim === "five_hour") return { ...snapshot, util5h: 0 };
  // `seven_day` plus the overage variants that carry the same weekly window.
  if (snapshot.claim.startsWith("seven_day")) return { ...snapshot, util7d: 0 };
  return snapshot;
}

/**
 * Headroom for a single account: the slack between the most-saturated
 * relevant bucket and full utilization. A bucket counts for a family when it
 * names the family, when WIRE_BUCKET_BINDINGS says it binds the family, or
 * when the account's learned bindings say so.
 */
export function computeHeadroom(
  snapshot: RateLimitSnapshot,
  family?: string | null,
  learned?: Record<string, string[]>,
): number {
  const rl = expireElapsedWindow(snapshot);
  const utils = [rl.util5h, rl.util7d];
  if (family) {
    for (const bucket of bucketsBindingFamily(rl, family, learned)) {
      const util = rl.perModel7d[bucket];
      if (util !== undefined) utils.push(util);
    }
  }
  return 1 - Math.max(...utils);
}

/**
 * Does this 429 say a rate-limit WINDOW is over? True only when the reading
 * itself shows one: a utilization at or past the 1.0 threshold on any window
 * or bucket. A 429 with a claim but 30% used, or with no claim and 0% used,
 * is a refusal of some other kind — concurrency, an account-level lock — and
 * its stated `reset` is not the moment this seat's window rolls.
 */
export function isWindowRejection(rl: RateLimitSnapshot): boolean {
  const utils = [rl.util5h, rl.util7d, ...Object.values(rl.perModel7d)];
  return utils.some((u) => u >= 0.99);
}

/** Cool-down for a 429 that named no exhausted window, when it stated no `retry-after`. */
export const NON_WINDOW_REJECTION_COOLDOWN_MS = 60_000;

/** How long a seat cools after a real window rejection when no reset is stated. */
export const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;

/** Cooldown end for a rejected snapshot: the window's reset, the stated retry-after, or a floor. */
export function rejectionCooldownUntil(rl: RateLimitSnapshot, now: number = Date.now()): number {
  if (rl.retryAfterMs !== null && rl.retryAfterMs > 0) return now + rl.retryAfterMs;
  if (isWindowRejection(rl) && rl.reset > 0) {
    const resetMs = rl.reset > 10_000_000_000 ? rl.reset : rl.reset * 1000;
    if (resetMs > now) return resetMs;
  }
  return now + (isWindowRejection(rl) ? FIVE_HOURS_MS : NON_WINDOW_REJECTION_COOLDOWN_MS);
}

// ---------------------------------------------------------------------------
// Overage guard
// ---------------------------------------------------------------------------

/**
 * How long the account stays halted after a non-subscription billing
 * classification, before it becomes probeable again. Continuing to forward
 * after a billing flip bleeds against per-token billing; the cooldown lets
 * a transient misclassification self-heal without a manual re-auth.
 */
export const OVERAGE_HALT_COOLDOWN_MS = 30 * 60 * 1000;

export interface HaltDecision {
  halt: boolean;
  /** Why the guard fired; null when the response is subscription billing. */
  claim: string | null;
}

/**
 * The overage-guard decision for one completed response. Subscribers should
 * never see a single non-subscription hit during normal operation — one
 * means wire-shape drift, a classifier change, or an account misconfig, and
 * the account must stop receiving traffic before it bleeds.
 *
 * The `unknown` sentinel (no rate-limit header — non-200s, stream aborts,
 * early rejects) is NOT a billing classification and never halts.
 */
export function overageGuardDecision(snapshot: RateLimitSnapshot | null): HaltDecision {
  const claim = snapshot?.claim ?? NO_BILLING_CLAIM;
  if (!isNonSubscriptionBilling(claim)) return { halt: false, claim: null };
  return { halt: true, claim };
}
