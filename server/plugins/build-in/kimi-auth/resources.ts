import type { NetworkResponse, PluginContext } from "cursor-byok:plugin";
import { refreshBundle } from "./token.ts";
import type {
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

export const RESOURCE_TYPE = "kimi-account";

const MODELS_URL = "https://api.kimi.com/coding/v1/models";
const USAGE_URL = "https://api.kimi.com/coding/v1/usages";
const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;

export type QuotaWindow = {
  usedPercent: number | null;
  remainingPercent: number | null;
  resetAtMs: number | null;
};

/** Kimi For Coding subscription quota: top-level usage is the weekly limit; the 300-minute window in limits is the 5-hour window. */
export type AccountQuota = {
  weekly: QuotaWindow | null;
  fiveHour: QuotaWindow | null;
  updatedAtMs: number;
};

/** Shape of a single kimi-account resource's privateData. */
export type AccountData = {
  accessToken: string;
  refreshToken: string | null;
  displayName: string;
  quota: AccountQuota | null;
};

export type CredentialCandidate = {
  accessToken: string;
  refreshToken: string | null;
  displayName: string | null;
};

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function number(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
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
  const identity = claim(payload, "sub") ??
    claim(payload, "email") ??
    await tokenFingerprint(accessToken);
  const displayName = claim(payload, "email") ??
    claim(payload, "preferred_username") ??
    claim(payload, "name") ??
    "Kimi account";
  return { key: `kimi:${identity}`, displayName };
}

export async function credentialDraft(credential: CredentialCandidate): Promise<ResourceDraft> {
  const identity = await accountIdentity(credential.accessToken);
  const data: AccountData = {
    accessToken: credential.accessToken,
    refreshToken: credential.refreshToken,
    displayName: credential.displayName ?? identity.displayName,
    quota: null,
  };
  return { key: identity.key, privateData: data };
}

export function accountData(resource: ResourceSnapshot): AccountData {
  const data = object(resource.privateData);
  const accessToken = text(data?.accessToken);
  if (!accessToken) throw new Error("Kimi account resource is missing its access token");
  return {
    accessToken,
    refreshToken: text(data?.refreshToken),
    displayName: text(data?.displayName) ?? "Kimi account",
    quota: (data?.quota ?? null) as AccountQuota | null,
  };
}

/** Refresh ahead when the token has less lifetime left than this, so a session does not start with a 401 every time. */
const EXPIRY_SKEW_MS = 60_000;

/** Expiry time of the access token; returns 0 (no known expiry) when the JWT exp claim is missing. */
export function tokenExpiryMs(data: AccountData): number {
  return (number(decodeJwtPayload(data.accessToken)?.exp) ?? 0) * 1000;
}

/** Whether the token is near expiry; a missing exp counts as not expiring, leaving the 401 fallback refresh to handle it. */
export function tokenExpiring(data: AccountData, nowMs = Date.now()): boolean {
  const expiry = tokenExpiryMs(data);
  return expiry !== 0 && expiry <= nowMs + EXPIRY_SKEW_MS;
}

/** Exchanges the refresh_token for a new token; returns null when the refresh was rejected and a re-login is required. */
export async function refreshAccessToken(
  data: AccountData,
  context: PluginContext,
): Promise<AccountData | null> {
  if (!data.refreshToken) return null;
  const bundle = await refreshBundle(data.refreshToken, context);
  if (!bundle) return null;
  return {
    ...data,
    accessToken: bundle.accessToken,
    refreshToken: bundle.refreshToken ?? data.refreshToken,
  };
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

/** Lenient resetTime parsing: ISO string or epoch (seconds/milliseconds). */
function resetAtMs(window: Record<string, unknown>): number | null {
  const value = window.resetTime ?? window.reset_time ?? window.resetAt ?? window.reset_at;
  const numeric = number(value);
  if (numeric !== null) return numeric > 10_000_000_000 ? numeric : numeric * 1000;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/** limit/used/remaining in a Kimi usage window are numeric strings; converted to a remaining percentage. */
function quotaWindow(value: unknown): QuotaWindow | null {
  const window = object(value);
  if (!window) return null;
  const limit = number(window.limit);
  const used = number(window.used);
  const remaining = number(window.remaining);
  let remainingPercent: number | null = null;
  if (limit !== null && limit > 0 && remaining !== null) {
    remainingPercent = clampPercent(Math.round((remaining / limit) * 100));
  } else if (limit !== null && limit > 0 && used !== null) {
    remainingPercent = clampPercent(Math.round((1 - used / limit) * 100));
  }
  return {
    usedPercent: remainingPercent === null ? null : 100 - remainingPercent,
    remainingPercent,
    resetAtMs: resetAtMs(window),
  };
}

export function parseKimiUsage(body: unknown): AccountQuota {
  const root = object(body) ?? {};
  const weekly = quotaWindow(root.usage);
  const limits = Array.isArray(root.limits) ? root.limits : [];
  const fiveHourEntry = limits.map(object).find((entry) => {
    const window = object(entry?.window);
    if (number(window?.duration) !== 300) return false;
    const unit = text(window?.timeUnit ?? window?.time_unit);
    return unit === null || unit.toUpperCase().includes("MINUTE");
  });
  return {
    weekly,
    fiveHour: quotaWindow(fiveHourEntry?.detail ?? null),
    updatedAtMs: Date.now(),
  };
}

/** Cooldown deadline when quota is exhausted: prefer the weekly quota, then the 5-hour window; falls back to 5 hours when no reset time is available. */
export function quotaCoolingUntil(quota: AccountQuota, nowMs = Date.now()): number | null {
  for (const window of [quota.weekly, quota.fiveHour]) {
    if (!window || window.remainingPercent !== 0) continue;
    if (window.resetAtMs !== null && window.resetAtMs <= nowMs) continue;
    return window.resetAtMs ?? nowMs + FIVE_HOURS_MS;
  }
  return null;
}

export function quotaState(quota: AccountQuota | null, nowMs = Date.now()): ResourceState {
  if (!quota) return { status: "ready" };
  const coolingUntil = quotaCoolingUntil(quota, nowMs);
  return coolingUntil === null
    ? { status: "ready" }
    : { status: "cooling", retryAtMs: coolingUntil, message: "Kimi quota is exhausted" };
}

/** Resource patch on 429: marks the 5-hour window as exhausted and cools down until the fallback time. */
export function quotaExhaustedPatch(data: AccountData, nowMs = Date.now()): ResourcePatch {
  const quota: AccountQuota = {
    weekly: data.quota?.weekly ?? null,
    fiveHour: { usedPercent: 100, remainingPercent: 0, resetAtMs: nowMs + FIVE_HOURS_MS },
    updatedAtMs: nowMs,
  };
  return {
    privateData: { ...data, quota },
    state: quotaState(quota, nowMs),
  };
}

export function presentAccount(resource: ResourceSnapshot): ResourceView {
  const data = accountData(resource);
  const metrics: ResourceMetric[] = [];
  const weekly = data.quota?.weekly;
  if (weekly && weekly.remainingPercent !== null) {
    metrics.push({
      id: "weekly",
      label: { "en-US": "Weekly quota", "zh-CN": "周额度" },
      unit: "percent",
      value: weekly.remainingPercent,
      ...(weekly.resetAtMs !== null ? { resetAtMs: weekly.resetAtMs } : {}),
    });
  }
  const fiveHour = data.quota?.fiveHour;
  if (fiveHour && fiveHour.remainingPercent !== null) {
    metrics.push({
      id: "five-hour",
      label: { "en-US": "5-hour window", "zh-CN": "5 小时窗口" },
      unit: "percent",
      value: fiveHour.remainingPercent,
      ...(fiveHour.resetAtMs !== null ? { resetAtMs: fiveHour.resetAtMs } : {}),
    });
  }
  return {
    displayName: data.displayName,
    ...(metrics.length > 0 ? { metrics } : {}),
  };
}

/** Validates the credential (refreshing the token first when rejected), then queries subscription quota; a quota failure does not affect the credential verdict. */
export async function refreshAccount(
  resource: ResourceSnapshot,
  context: PluginContext,
): Promise<ResourcePatch> {
  let data = accountData(resource);
  let rotated = false;
  let response = await checkCredentials(data, context);
  if (isRejected(response.status) && data.refreshToken) {
    const refreshed = await refreshAccessToken(data, context);
    if (!refreshed) {
      return { state: { status: "invalid", message: EXPIRED_MESSAGE } };
    }
    data = refreshed;
    rotated = true;
    response = await checkCredentials(data, context);
  }
  if (isRejected(response.status)) {
    return { state: { status: "invalid", message: EXPIRED_MESSAGE } };
  }
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Kimi credential check failed (HTTP ${response.status}): ${response.body}`);
  }
  let quota: AccountQuota | null = null;
  try {
    const usage = await context.network.fetch(USAGE_URL, {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${data.accessToken}`,
      },
    });
    if (usage.status >= 200 && usage.status < 300) {
      quota = parseKimiUsage(JSON.parse(usage.body));
    }
  } catch {
    // Quota is best-effort: stay ready when the query fails.
  }
  if (!quota) {
    return rotated ? { privateData: data } : { state: { status: "ready" } };
  }
  return {
    privateData: { ...data, quota },
    state: quotaState(quota),
  };
}

const EXPIRED_MESSAGE = "Kimi authorization expired; sign in again";

function isRejected(status: number): boolean {
  return status === 401 || status === 403;
}

function checkCredentials(
  data: AccountData,
  context: PluginContext,
): Promise<NetworkResponse> {
  return context.network.fetch(MODELS_URL, {
    method: "GET",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${data.accessToken}`,
    },
  });
}

function firstText(source: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = text(source[key]);
    if (value) return value;
  }
  return null;
}

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
  const tokens = object(item.tokens) ?? item;
  const accessToken = firstText(tokens, ["access_token", "accessToken", "token", "key"]) ??
    firstText(item, ["access_token", "accessToken", "token", "key", "KIMI_API_KEY"]);
  if (!accessToken) return;
  const refreshToken = firstText(tokens, ["refresh_token", "refreshToken"]) ??
    firstText(item, ["refresh_token", "refreshToken"]);
  const displayName = firstText(item, ["email", "display_name", "displayName", "name"]) ??
    firstText(tokens, ["email", "display_name", "displayName", "name"]);
  output.push({ accessToken, refreshToken, displayName });
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
      warnings.push(`${file.name}: no Kimi access token found`);
      continue;
    }
    credentials.push(...found);
  }
  return { credentials, warnings };
}

export const credentialImport: ResourceImportSupport = {
  displayName: {
    "en-US": "Import Kimi credentials",
    "zh-CN": "导入 Kimi 凭证",
  },
  description: {
    "en-US": "Import one or more Kimi JSON credential files.",
    "zh-CN": "导入一个或多个 Kimi JSON 凭证文件。",
  },
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
