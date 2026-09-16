/**
 * Refresh-token grant age.
 *
 * Anthropic's OAuth refresh token has a hard lifetime measured from the
 * ORIGINAL grant, not from the last rotation. A seat that refreshed every 8h
 * for four weeks still died with `invalid_grant "Refresh token expired"`
 * 28 days 10 hours after its grant. The token itself is opaque and the token
 * endpoint reports no refresh expiry, so the calendar is the only signal —
 * `grantedAt` is recorded by every code path that performs a grant and
 * preserved across refreshes, and the account view reads the age through here.
 *
 * Levels:
 *   ok      age < warn
 *   warn    warn ≤ age < urgent   — re-grant this week
 *   urgent  urgent ≤ age          — re-grant today; the wall is ~lifetime
 *   unknown no grantedAt          — seat minted before this field existed;
 *                                   re-grant to start the clock
 */

export type GrantLevel = "ok" | "warn" | "urgent" | "unknown";

export interface GrantThresholds {
  lifetimeDays: number;
  warnDays: number;
  urgentDays: number;
}

export interface GrantAge {
  level: GrantLevel;
  /** Whole days since the grant; null when unknown. */
  ageDays: number | null;
  /** Epoch ms of the projected wall (grantedAt + lifetime); null when unknown. */
  wallAt: number | null;
  /** Whole days until the wall (negative once past it); null when unknown. */
  daysToWall: number | null;
}

const DAY_MS = 86_400_000;

/** Documented defaults; ordering enforced (warn ≤ urgent ≤ lifetime). */
export function grantThresholds(): GrantThresholds {
  const lifetimeDays = 28;
  const urgentDays = Math.min(26, lifetimeDays);
  const warnDays = Math.min(21, urgentDays);
  return { lifetimeDays, warnDays, urgentDays };
}

/** Age a single grant. `grantedAt` undefined/null/non-finite → unknown. */
export function grantAge(
  grantedAt: number | null | undefined,
  now: number,
  t: GrantThresholds = grantThresholds(),
): GrantAge {
  if (
    grantedAt === undefined || grantedAt === null || !Number.isFinite(grantedAt) || grantedAt <= 0
  ) {
    return { level: "unknown", ageDays: null, wallAt: null, daysToWall: null };
  }
  const ageDays = Math.floor(Math.max(0, now - grantedAt) / DAY_MS);
  const wallAt = grantedAt + t.lifetimeDays * DAY_MS;
  const daysToWall = Math.floor((wallAt - now) / DAY_MS);
  const level: GrantLevel = ageDays >= t.urgentDays
    ? "urgent"
    : ageDays >= t.warnDays
    ? "warn"
    : "ok";
  return { level, ageDays, wallAt, daysToWall };
}

const LEVEL_RANK: Record<GrantLevel, number> = { ok: 0, unknown: 1, warn: 2, urgent: 3 };

/** The worst level across seats. `unknown` ranks between ok and warn. */
export function worstGrantLevel(levels: readonly GrantLevel[]): GrantLevel {
  let worst: GrantLevel = "ok";
  for (const l of levels) if (LEVEL_RANK[l] > LEVEL_RANK[worst]) worst = l;
  return worst;
}

/** One-line human summary for the account view. */
export function describeGrantAge(a: GrantAge, t: GrantThresholds = grantThresholds()): string {
  if (a.level === "unknown" || a.ageDays === null || a.daysToWall === null) {
    return "grant date unknown — re-grant to start the ~" + t.lifetimeDays +
      "d refresh-token clock";
  }
  const wall = a.daysToWall >= 0
    ? `~${a.daysToWall}d to the ~${t.lifetimeDays}d wall`
    : `${-a.daysToWall}d PAST the ~${t.lifetimeDays}d wall`;
  switch (a.level) {
    case "ok":
      return `grant ${a.ageDays}d old, ${wall}`;
    case "warn":
      return `grant ${a.ageDays}d old, ${wall} — re-grant this week`;
    case "urgent":
      return `grant ${a.ageDays}d old, ${wall} — re-grant TODAY or the seat dies mid-refresh`;
  }
}
