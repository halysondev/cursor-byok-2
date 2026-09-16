/**
 * Claude subscription account resources.
 *
 * One resource is one Claude OAuth grant (a subscription seat). Holds the
 * tokens, the CC device identity presented in metadata.user_id, the calendar
 * age of the refresh-token grant, and the latest rate-limit snapshot with its
 * billing classification.
 */

import type { JsonValue, PluginContext } from "cursor-byok:plugin";
import type {
  ResourceAction,
  ResourceActionResult,
  ResourceDraft,
  ResourceImportFile,
  ResourceImportResult,
  ResourceImportSupport,
  ResourceMetric,
  ResourcePatch,
  ResourceSnapshot,
  ResourceState,
  ResourceView,
} from "cursor-byok:resource";
import { isTerminalRefreshFailure, type OAuthTokens, refreshTokens } from "./oauth.ts";
import { runAuthorizeProbe } from "./authorize-probe.ts";
import {
  billingBucketFromClaim,
  EMPTY_SNAPSHOT,
  isWindowRejection,
  type RateLimitSnapshot,
  rejectionCooldownUntil,
} from "./rate-limits.ts";
import { describeGrantAge, grantAge } from "./refresh-grant.ts";

export const RESOURCE_TYPE = "claude-account";

/** Shape of a single claude-account resource's privateData. */
export type AccountData = {
  accessToken: string;
  refreshToken: string | null;
  expiresAtMs: number | null;
  scopes: string[];
  /** Epoch ms of the ORIGINAL grant; the refresh-token wall is measured from it. */
  grantedAt: number | null;
  /** Stable device identity for metadata.user_id; generated once per account. */
  deviceId: string;
  accountUuid: string;
  displayName: string;
  /** Latest unified rate-limit snapshot; null before the first response. */
  rateLimit: RateLimitSnapshot | null;
};

export type CredentialCandidate = {
  accessToken: string;
  refreshToken: string | null;
  expiresAtMs?: number | null;
  scopes?: string[];
  /** Epoch ms of the grant this token family descends from. */
  grantedAt?: number | null;
  displayName: string | null;
};

/** Refresh 30 minutes before expiry. */
export const REFRESH_BUFFER_MS = 30 * 60 * 1000;

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const encoded = token.split(".")[1];
  if (!encoded) return null;
  try {
    const normalized = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
    return object(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    return null;
  }
}

function claim(payload: Record<string, unknown> | null, key: string): string | null {
  return payload ? text(payload[key]) : null;
}

/** A Claude access token's email lives under the Anthropic organization claim. */
function profileEmail(payload: Record<string, unknown> | null): string | null {
  const profile = object(
    payload?.["https://anthropic.com/claude-code/profile"] ??
      payload?.["https://anthropic.com/profile"],
  );
  return text(profile?.email);
}

async function tokenFingerprint(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(
    new Uint8Array(digest).slice(0, 8),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function accountIdentity(
  accessToken: string,
): Promise<{ key: string; displayName: string }> {
  const payload = decodeJwtPayload(accessToken);
  const identity = claim(payload, "sub") ?? claim(payload, "email") ??
    await tokenFingerprint(accessToken);
  const displayName = claim(payload, "email") ?? profileEmail(payload) ??
    claim(payload, "preferred_username") ?? claim(payload, "name") ?? identity;
  return { key: `claude:${identity}`, displayName };
}

export async function credentialDraft(credential: CredentialCandidate): Promise<ResourceDraft> {
  const identity = await accountIdentity(credential.accessToken);
  const data: AccountData = {
    accessToken: credential.accessToken,
    refreshToken: credential.refreshToken,
    expiresAtMs: credential.expiresAtMs ?? null,
    scopes: credential.scopes ?? [],
    grantedAt: credential.grantedAt ?? null,
    deviceId: crypto.randomUUID(),
    accountUuid: crypto.randomUUID(),
    displayName: credential.displayName ?? identity.displayName,
    rateLimit: null,
  };
  return { key: identity.key, privateData: data as unknown as JsonValue };
}

export function accountData(resource: ResourceSnapshot): AccountData {
  const data = object(resource.privateData);
  const accessToken = text(data?.accessToken);
  if (!accessToken) throw new Error("Claude account resource is missing its access token");
  return {
    accessToken,
    refreshToken: text(data?.refreshToken),
    expiresAtMs: typeof data?.expiresAtMs === "number" ? data.expiresAtMs : null,
    scopes: Array.isArray(data?.scopes) ? data.scopes.filter((s) => typeof s === "string") : [],
    grantedAt: typeof data?.grantedAt === "number" ? data.grantedAt : null,
    deviceId: text(data?.deviceId) ?? crypto.randomUUID(),
    accountUuid: text(data?.accountUuid) ?? crypto.randomUUID(),
    displayName: text(data?.displayName) ?? "Claude account",
    rateLimit: object(data?.rateLimit) as RateLimitSnapshot | null ?? null,
  };
}

// ---------------------------------------------------------------------------
// Token refresh
// ---------------------------------------------------------------------------

/**
 * Refresh the access token when it is inside the refresh buffer. Returns the
 * updated data, or the original data when no refresh is needed. `grantedAt`
 * is preserved across refreshes — the wall is measured from the ORIGINAL
 * grant, not the last rotation. Throws on refresh failure.
 */
export async function ensureFreshToken(
  data: AccountData,
  context: PluginContext,
): Promise<AccountData> {
  if (!data.refreshToken) return data;
  if (data.expiresAtMs !== null && data.expiresAtMs > Date.now() + REFRESH_BUFFER_MS) return data;
  const tokens: OAuthTokens = await refreshTokens(context, data.refreshToken);
  return {
    ...data,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAtMs: tokens.expiresAtMs,
    scopes: tokens.scopes,
    // The wall is measured from the ORIGINAL grant — a rotation does not
    // extend Anthropic's ~28-day refresh-token lifetime.
    grantedAt: data.grantedAt,
  };
}

/**
 * Refresh patch for the host: refreshes when due and returns the privateData
 * patch. Terminal refresh failures mark the resource invalid instead.
 */
export async function refreshAccount(
  resource: ResourceSnapshot,
  context: PluginContext,
): Promise<ResourcePatch> {
  const data = accountData(resource);
  try {
    const fresh = await ensureFreshToken(data, context);
    return { privateData: fresh as unknown as JsonValue, state: { status: "ready" } };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = Number(message.match(/HTTP (\d{3})/)?.[1] ?? 0);
    if (isTerminalRefreshFailure(status, message)) {
      return {
        state: { status: "invalid", message: "Claude authorization expired; sign in again" },
      };
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Snapshot → resource state / view
// ---------------------------------------------------------------------------

/** Resource state derived from the latest snapshot's billing classification. */
export function snapshotState(snapshot: RateLimitSnapshot | null, now = Date.now()): ResourceState {
  if (!snapshot || snapshot.claim === "unknown") return { status: "ready" };
  if (isWindowRejection(snapshot)) {
    return {
      status: "cooling",
      retryAtMs: rejectionCooldownUntil(snapshot, now),
      message: `subscription window exhausted (${snapshot.claim})`,
    };
  }
  return { status: "ready" };
}

function percent(value: number): number {
  return Math.max(0, Math.round((1 - Math.min(value, 2)) * 100));
}

function snapshotMetrics(snapshot: RateLimitSnapshot): ResourceMetric[] {
  const metrics: ResourceMetric[] = [];
  const resetAtMs = snapshot.reset > 10_000_000_000 ? snapshot.reset : snapshot.reset * 1000;
  metrics.push({
    id: "five-hour",
    label: "5-hour window",
    unit: "percent",
    value: percent(snapshot.util5h),
    ...(resetAtMs > 0 ? { resetAtMs } : {}),
  });
  metrics.push({
    id: "seven-day",
    label: "7-day window",
    unit: "percent",
    value: percent(snapshot.util7d),
  });
  for (const [bucket, util] of Object.entries(snapshot.perModel7d)) {
    metrics.push({
      id: `seven-day-${bucket}`,
      label: `7-day ${bucket}`,
      unit: "percent",
      value: percent(util),
    });
  }
  if (snapshot.overageUtil > 0) {
    metrics.push({
      id: "overage",
      label: "Overage",
      unit: "percent",
      value: percent(snapshot.overageUtil),
    });
  }
  return metrics;
}

function firstText(source: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = text(source[key]);
    if (value) return value;
  }
  return null;
}

function jwtDisplayName(token: string | null): string | null {
  if (!token) return null;
  const payload = decodeJwtPayload(token);
  return claim(payload, "email") ?? profileEmail(payload) ??
    claim(payload, "preferred_username") ?? claim(payload, "name");
}

export function presentAccount(resource: ResourceSnapshot): ResourceView {
  const data = accountData(resource);
  const now = Date.now();
  const metrics: ResourceMetric[] = [];
  let description: string | undefined;

  if (data.rateLimit && data.rateLimit.updatedAt > 0) {
    metrics.push(...snapshotMetrics(data.rateLimit));
    const bucket = billingBucketFromClaim(data.rateLimit.claim);
    if (bucket !== "unknown") description = `Billing: ${bucket} (${data.rateLimit.claim})`;
  }
  const grant = grantAge(data.grantedAt, now);
  if (grant.level !== "ok") {
    // Surface a degrading refresh-token clock prominently.
    description = `${description ? description + " — " : ""}${describeGrantAge(grant)}`;
  }

  return {
    displayName: jwtDisplayName(data.accessToken) ?? data.displayName,
    ...(description ? { description } : {}),
    ...(metrics.length > 0 ? { metrics } : {}),
  };
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

function collectCredentials(value: unknown, output: CredentialCandidate[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectCredentials(item, output);
    return;
  }
  const item = object(value);
  if (!item || item.disabled === true) return;
  for (const key of ["accounts", "credentials", "items"]) {
    if (Array.isArray(item[key])) {
      collectCredentials(item[key], output);
      return;
    }
  }
  // [CC]'s credentials.json / keychain blob shape.
  const oauth = object(item.claudeAiOauth) ?? item;
  const accessToken = firstText(oauth, ["access_token", "accessToken"]) ??
    firstText(item, ["access_token", "accessToken"]);
  if (!accessToken) return;
  const refreshToken = firstText(oauth, ["refresh_token", "refreshToken"]) ??
    firstText(item, ["refresh_token", "refreshToken"]);
  const expiresAtMs = firstText(oauth, ["expiresAt", "expires_at"]) ??
    firstText(item, ["expiresAt", "expires_at"]);
  const scopes = Array.isArray(oauth.scopes)
    ? oauth.scopes.filter((s) => typeof s === "string")
    : [];
  const idToken = firstText(oauth, ["id_token", "idToken"]) ??
    firstText(item, ["id_token", "idToken"]);
  const displayName = firstText(item, ["email", "display_name", "displayName", "name"]) ??
    firstText(oauth, ["email", "display_name", "displayName", "name"]) ??
    jwtDisplayName(idToken);
  output.push({
    accessToken,
    refreshToken,
    ...(expiresAtMs !== null && Number.isFinite(Number(expiresAtMs))
      ? { expiresAtMs: Number(expiresAtMs) }
      : {}),
    ...(scopes.length > 0 ? { scopes } : {}),
    displayName,
  });
}

export function parseCredentialFiles(files: ResourceImportFile[]): {
  credentials: CredentialCandidate[];
  warnings: string[];
} {
  const credentials: CredentialCandidate[] = [];
  const warnings: string[] = [];
  for (const file of files) {
    let content: unknown;
    try {
      content = JSON.parse(file.content);
    } catch {
      warnings.push(`${file.name}: not valid JSON`);
      continue;
    }
    const found: CredentialCandidate[] = [];
    collectCredentials(content, found);
    if (found.length === 0) {
      warnings.push(`${file.name}: no Claude access token found`);
      continue;
    }
    credentials.push(...found);
  }
  return { credentials, warnings };
}

export const credentialImport: ResourceImportSupport = {
  displayName: "Import Claude credentials",
  description: "Import a [CC] credentials JSON file (claudeAiOauth shape).",
  accept: [".json"],
  multiple: true,
  parse: async (files: ResourceImportFile[]): Promise<ResourceImportResult> => {
    const { credentials, warnings } = parseCredentialFiles(files);
    if (credentials.length === 0) {
      throw new Error(warnings.join("; ") || "credential JSON does not contain an access token");
    }
    return {
      resources: await Promise.all(credentials.map(credentialDraft)),
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  },
};

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * Live probe of the authorize endpoint with the pinned scope set. Surfaces
 * upstream policy drift (a scope Anthropic now rejects) before users hit
 * "Invalid request format" on a fresh sign-in.
 */
const checkSignInDrift: ResourceAction = {
  id: "check-sign-in-drift",
  displayName: "Check sign-in drift",
  description: "Probe the authorize endpoint with the pinned scope set and classify the response.",
  target: "resource",
  run: async (
    _resource: ResourceSnapshot,
    _input: JsonValue,
    context: PluginContext,
  ): Promise<ResourceActionResult> => {
    const result = await runAuthorizeProbe(context);
    const title = `Authorize probe: ${result.verdict}`;
    return {
      title,
      description: `${result.reason} (${result.scopeCount} scopes)`,
    };
  },
};

export const CHECK_SIGN_IN_DRIFT_ACTION_ID = "check-sign-in-drift";
export { checkSignInDrift };
