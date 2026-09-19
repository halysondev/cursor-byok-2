/**
 * Claude OAuth — CC's own PKCE flow.
 *
 * Uses the OAuth client registered inside [CC] itself (prod config), so the
 * resulting grant is a genuine [CC] subscription session — the same tokens
 * [CC] mints on `claude login`. This is what keeps traffic on the
 * subscription allocation instead of retail API billing.
 *
 * The host drives the browser, callback server, state, and PKCE; this module
 * only builds the authorize URL and exchanges the code / refresh tokens.
 */

import type { JsonValue, PluginContext } from "cursor-byok:plugin";
import type { OAuth2AuthorizationCodeAddMethod } from "cursor-byok:resource";
import type { CredentialCandidate } from "./resources.ts";
import { credentialDraft } from "./resources.ts";

/**
 * OAuth config of [CC]'s PROD block (the local-oauth flow values CC itself
 * ships). The authorize URL matches CC's runtime behavior — direct, not the
 * legacy URL that 307-redirects and post-redirect validation rejects.
 */
export const CC_OAUTH_CONFIG = {
  clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  authorizeUrl: "https://claude.ai/oauth/authorize",
  tokenUrl: "https://platform.claude.com/v1/oauth/token",
  // FIRST. Fewer or reordered sets have been rejected by the authorize
  // endpoint across CC releases; this is the currently-accepted form.
  scopes:
    "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload",
} as const;

export type OAuthTokens = {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms when the access token expires. */
  expiresAtMs: number;
  scopes: string[];
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

function parseBody(body: string): Record<string, unknown> {
  try {
    return object(JSON.parse(body)) ?? {};
  } catch {
    return {};
  }
}

function errorMessage(body: Record<string, unknown>): string | null {
  const error = object(body.error);
  return text(body.error_description ?? body.message ?? error?.message);
}

export function parseTokenResponse(
  body: Record<string, unknown>,
  fallbackScopes: string[],
): OAuthTokens | null {
  const accessToken = text(body.access_token);
  const refreshToken = text(body.refresh_token);
  if (!accessToken || !refreshToken) return null;
  const expiresIn = number(body.expires_in) ?? 3600;
  const scope = text(body.scope);
  return {
    accessToken,
    refreshToken,
    expiresAtMs: Date.now() + expiresIn * 1000,
    scopes: scope ? scope.split(" ") : fallbackScopes,
  };
}

/** Build the authorization URL the host opens in the browser. */
export function buildAuthorizeUrl(
  redirectUri: string,
  codeChallenge: string,
  state: string,
): string {
  const params = new URLSearchParams({
    code: "true",
    client_id: CC_OAUTH_CONFIG.clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: CC_OAUTH_CONFIG.scopes,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state,
  });
  return `${CC_OAUTH_CONFIG.authorizeUrl}?${params.toString()}`;
}

/** Exchange an authorization code for tokens (JSON body, matching CC). */
export async function exchangeAuthorizationCode(
  context: PluginContext,
  code: string,
  redirectUri: string,
  codeVerifier: string,
  state: string,
): Promise<CredentialCandidate> {
  const response = await context.network.fetch(CC_OAUTH_CONFIG.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: CC_OAUTH_CONFIG.clientId,
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
      state,
    }),
  });
  const body = parseBody(response.body);
  const tokens = parseTokenResponse(body, CC_OAUTH_CONFIG.scopes.split(" "));
  if (!tokens) {
    throw new Error(
      errorMessage(body) ??
        `Failed to exchange Claude authorization code (HTTP ${response.status})`,
    );
  }
  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAtMs: tokens.expiresAtMs,
    scopes: tokens.scopes,
    grantedAt: Date.now(),
    displayName: null,
  };
}

/** Refresh an access token (form-urlencoded, matching CC). */
export async function refreshTokens(
  context: PluginContext,
  refreshToken: string,
): Promise<OAuthTokens> {
  const response = await context.network.fetch(CC_OAUTH_CONFIG.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CC_OAUTH_CONFIG.clientId,
    }).toString(),
  });
  const body = parseBody(response.body);
  const tokens = parseTokenResponse(body, CC_OAUTH_CONFIG.scopes.split(" "));
  if (!tokens) {
    // Include the machine-readable error code (e.g. invalid_grant) so callers
    // can classify terminal failures, plus the human description.
    const code = typeof body.error === "string" ? body.error : "";
    const message = errorMessage(body) ?? response.body.slice(0, 200);
    throw new Error(
      `Claude token refresh failed (HTTP ${response.status}${code ? `, ${code}` : ""}): ${message}`,
    );
  }
  return tokens;
}

/**
 * Whether a refresh failure is terminal: the refresh token is invalid,
 * revoked, or rotated out. Terminal failures must surface as a re-login
 * prompt instead of doomed retries.
 */
export function isTerminalRefreshFailure(status: number, body: string): boolean {
  return status === 401 || status === 403 || /invalid_grant/i.test(body);
}

type BeginSession = { state: string; redirectUri: string };

/**
 * The redirect URI the upstream OAuth client accepts. CC registers
 * `http://localhost:{port}/callback` and nothing else, so the host-provided
 * loopback callback is rewritten to that exact form. The callback server binds
 * the loopback interface, so `localhost` reaches it; `/callback` is declared
 * on the add method so the host serves that path. Both the authorize URL and
 * the token exchange must carry the identical value.
 */
export function normalizeRedirectUri(redirectUri: string): string {
  try {
    const url = new URL(redirectUri);
    const port = url.port || "80";
    return `http://localhost:${port}/callback`;
  } catch {
    return redirectUri;
  }
}

export const claudeOAuth: OAuth2AuthorizationCodeAddMethod = {
  type: "oauth2.authorization-code",
  id: "claude-oauth",
  displayName: "Sign in with Claude",
  description:
    "Authorize with [OI] the same way [CC] does, then add the resulting Claude subscription account.",
  callback: { path: "/callback" },
  begin: async (input): Promise<OAuthBeginResult> => {
    const redirectUri = normalizeRedirectUri(input.redirectUri);
    // The host generates and verifies state + PKCE; echo the state and the
    // normalized redirect URI through the session so `complete` replays the
    // exact value the authorize call carried.
    const session: BeginSession = { state: input.state, redirectUri };
    return {
      session: session as unknown as JsonValue,
      authorizationUrl: buildAuthorizeUrl(redirectUri, input.codeChallenge, input.state),
      expiresAtMs: Date.now() + 10 * 60 * 1000,
    };
  },
  complete: async (sessionValue, input, context) => {
    const session = object(sessionValue);
    const state = text(session?.state) ?? "";
    const redirectUri = text(session?.redirectUri) ?? normalizeRedirectUri(input.redirectUri);
    const credential = await exchangeAuthorizationCode(
      context,
      input.code,
      redirectUri,
      input.codeVerifier,
      state,
    );
    return [await credentialDraft(credential)];
  },
};

type OAuthBeginResult = {
  session: JsonValue;
  authorizationUrl: string;
  expiresAtMs: number;
};
