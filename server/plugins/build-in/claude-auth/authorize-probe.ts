/**
 * Live probe of Anthropic's /oauth/authorize endpoint.
 *
 * Anthropic's policy engine flips scope acceptability without changing what
 * CC ships, so static values can silently rot. The probe sends the pinned
 * scope set the way CC does and classifies the initial response:
 *
 *   accepted     — 3xx redirect to login/consent, OR 2xx without the reject
 *                  marker; the scope set passed validation
 *   rejected     — body contains the specific "Invalid request format" marker
 *   inconclusive — fetch error, Cloudflare challenge, or any other shape;
 *                  not drift, try again
 *
 * Not a real login — the probe only needs the initial response and never
 * completes an authorization.
 */

import { CC_OAUTH_CONFIG } from "./oauth.ts";

/** The specific string Anthropic's authorize endpoint returns for a rejected scope set. */
export const REJECT_MARKER = "Invalid request format";

/** Not a real callback — the probe only needs the initial response. */
const PROBE_REDIRECT_URI = "http://localhost:12345/callback";

const PROBE_TIMEOUT_MS = 15_000;

export interface AuthorizeResponse {
  status: number;
  location: string | null;
  body: string;
  error: string | null;
}

export type ProbeVerdict = "accepted" | "rejected" | "inconclusive";

export interface ClassifiedVerdict {
  verdict: ProbeVerdict;
  reason: string;
}

/** Cloudflare fronts the authorize edge and challenges unrecognized clients. */
function isCloudflareChallenge(
  { status, body }: Pick<AuthorizeResponse, "status" | "body">,
): boolean {
  const bodyText = typeof body === "string" ? body : "";
  if (bodyText.includes("Just a moment...") || bodyText.includes("/cdn-cgi/challenge-platform/")) {
    return true;
  }
  if (status === 403 && bodyText.includes("cdn-cgi")) return true;
  return false;
}

/** Classify a single authorize-endpoint response. */
export function classifyAuthorizeResponse(
  { status, location, body, error }: AuthorizeResponse,
): ClassifiedVerdict {
  if (error) {
    return { verdict: "inconclusive", reason: `fetch error: ${error}` };
  }

  if (isCloudflareChallenge({ status, body })) {
    return {
      verdict: "inconclusive",
      reason:
        `blocked by Cloudflare bot challenge (status=${status}). Try again from a trusted network.`,
    };
  }

  const bodyText = typeof body === "string" ? body : "";
  if (bodyText.includes(REJECT_MARKER)) {
    return { verdict: "rejected", reason: `body contains "${REJECT_MARKER}"` };
  }

  if (status >= 300 && status < 400 && typeof location === "string" && location.length > 0) {
    return { verdict: "accepted", reason: `${status} redirect` };
  }

  if (status >= 200 && status < 300) {
    return { verdict: "accepted", reason: `${status} body rendered, no reject marker` };
  }

  return {
    verdict: "inconclusive",
    reason: `unexpected response: status=${status}, body_len=${bodyText.length}`,
  };
}

export interface ProbeResult extends ClassifiedVerdict {
  /** The exact URL sent — paste into a browser to compare when rejected. */
  probedUrl: string;
  scopeCount: number;
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(
    /=+$/,
    "",
  );
}

/**
 * Build the probe authorize URL: the pinned config, a throwaway PKCE pair,
 * and a 32-byte state (shorter states produce "Invalid request format" from
 * Anthropic's authorize endpoint, which the classifier would mis-attribute
 * to scope drift when it is actually our own request shape).
 */
export function buildProbeAuthorizeUrl(
  cfg: { clientId: string; authorizeUrl: string; scopes: string },
  codeChallenge: string,
  state: string,
): string {
  const params = new URLSearchParams({
    code: "true",
    client_id: cfg.clientId,
    response_type: "code",
    redirect_uri: PROBE_REDIRECT_URI,
    scope: cfg.scopes,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state,
  });
  return `${cfg.authorizeUrl}?${params.toString()}`;
}

const PROBE_HEADERS: Record<string, string> = {
  accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
};

/**
 * Probe the authorize endpoint with the pinned config. Reads only the initial
 * response; follows nothing. Inconclusive on transport errors and challenges.
 */
export async function runAuthorizeProbe(
  context: import("cursor-byok:plugin").PluginContext,
): Promise<ProbeResult> {
  // Throwaway PKCE + state — the probe never completes, so the values only
  // need to be well-formed.
  const verifierBytes = crypto.getRandomValues(new Uint8Array(32));
  const verifier = base64url(verifierBytes);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = base64url(new Uint8Array(digest));
  const state = base64url(crypto.getRandomValues(new Uint8Array(32)));

  const url = buildProbeAuthorizeUrl(CC_OAUTH_CONFIG, challenge, state);
  let response: import("cursor-byok:plugin").NetworkResponse;
  try {
    response = await context.network.fetch(url, { method: "GET", headers: PROBE_HEADERS });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      verdict: "inconclusive",
      reason: `fetch error: ${message}`,
      probedUrl: url,
      scopeCount: CC_OAUTH_CONFIG.scopes.split(" ").length,
    };
  }
  const location = response.headers["location"] ?? response.headers["Location"] ?? null;
  const classified = classifyAuthorizeResponse({
    status: response.status,
    location,
    body: response.body,
    error: null,
  });
  return {
    ...classified,
    probedUrl: url,
    scopeCount: CC_OAUTH_CONFIG.scopes.split(" ").length,
  };
}
