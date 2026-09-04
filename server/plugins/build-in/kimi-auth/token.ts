import type { PluginContext } from "cursor-byok:plugin";

// Public OAuth client identical to the official Kimi CLI; device authorization and refresh_token share the same endpoint.
export const OAUTH_CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
export const OAUTH_TOKEN_URL = "https://auth.kimi.com/api/oauth/token";

/** Token bundle returned by a successful refresh; carries the new value when the upstream rotates the refresh_token. */
export type TokenBundle = {
  accessToken: string;
  refreshToken: string | null;
};

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Exchanges the refresh_token for a new token. Returns null when the upstream
 * rejects the refresh token and a re-login is required; network and transient
 * server failures throw, so callers must not treat them as a dead account.
 * The official client retries transient failures with backoff; here a single
 * attempt is made and the caller decides whether to retry.
 */
export async function refreshBundle(
  refreshToken: string,
  context: PluginContext,
): Promise<TokenBundle | null> {
  const response = await context.network.fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: OAUTH_CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }).toString(),
  });
  if (response.status === 401 || response.status === 403) return null;
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Kimi token refresh failed (HTTP ${response.status}): ${response.body}`);
  }
  const body = object(JSON.parse(response.body));
  const accessToken = text(body?.access_token);
  if (!accessToken) throw new Error("Kimi token refresh response is missing access_token");
  return { accessToken, refreshToken: text(body?.refresh_token) };
}
