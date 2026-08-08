/**
 * The DM seat.
 *
 * Exactly one player per campaign holds it, which is enforced structurally by
 * it being a single column rather than a membership role. The host owns the
 * campaign and can always reclaim the seat; the seat itself only confers
 * authority over the story.
 *
 * The window numbers live here and nowhere else. Every caller that needs to
 * know how long to hold a beat goes through `resolveWindowMs`.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** How long publication waits by default, per cadence. */
export const DEFAULT_WINDOW_MS = {
  daily: 2 * HOUR,
  weekly: 24 * HOUR,
  monthly: 72 * HOUR,
} as const;

/**
 * A third of the cycle, in each case. Past that the story stops feeling like it
 * runs on a clock, which is the one thing players are promised about timing.
 */
export const MAX_WINDOW_MS = {
  daily: 8 * HOUR,
  weekly: 56 * HOUR,
  monthly: 10 * DAY,
} as const;

/** Consecutive untouched windows before the seat goes back to the host. */
export const MISSED_WINDOWS_BEFORE_REVERT = 3;

type Cadence = keyof typeof DEFAULT_WINDOW_MS;

const isCadence = (v: string): v is Cadence => v in DEFAULT_WINDOW_MS;

export interface Seat {
  dmPlayerId: string | null;
  /** NULL means "use the cadence default". 0 means publish immediately. */
  reviewWindowMs: number | null;
  missedWindows: number;
}

export async function getSeat(db: D1Database, campaignId: string): Promise<Seat | null> {
  const row = await db
    .prepare(
      "SELECT dm_player_id, review_window_ms, dm_missed_windows FROM campaigns WHERE id = ?",
    )
    .bind(campaignId)
    .first<{
      dm_player_id: string | null;
      review_window_ms: number | null;
      dm_missed_windows: number;
    }>();
  if (!row) return null;
  return {
    dmPlayerId: row.dm_player_id,
    reviewWindowMs: row.review_window_ms,
    missedWindows: row.dm_missed_windows ?? 0,
  };
}

/**
 * Assign the seat, or vacate it with `null`. Either way the seat is reset to a
 * clean slate: no miss count, and no window inherited from whoever sat here
 * before.
 *
 * Resetting is what makes the seat a state rather than a history: "plr_two
 * holds the seat" must mean the same thing however it came to be true, or the
 * reversion rule would fire on a DM who inherited someone else's silence.
 *
 * The window resets for the same reason and one sharper one. `0` means "never
 * hold", and it is the only setting whose inheritance is *invisible*: the
 * incoming DM would get no window, no notice, and no beat to review, with
 * nothing anywhere to tell them why. A group that wants a shorter window sets
 * it again in one call; a DM who silently never gets one has no such recourse.
 * `NULL` is "use the cadence default", so the reset lands on the documented
 * behaviour rather than on a number chosen here.
 */
export async function setSeat(
  db: D1Database,
  campaignId: string,
  playerId: string | null,
): Promise<void> {
  await db
    .prepare(
      "UPDATE campaigns SET dm_player_id = ?, dm_missed_windows = 0, review_window_ms = NULL " +
        "WHERE id = ?",
    )
    .bind(playerId, campaignId)
    .run();
}

/**
 * Turn a stored window into the one actually used.
 *
 * `null` is "unset, use the default" and `0` is "publish immediately" — a
 * meaningful distinction, so this cannot be written with `??` alone.
 *
 * `undefined` is accepted alongside `null` because callers reach this through
 * an optional chain (`seat?.reviewWindowMs`), and an absent seat means the same
 * thing an unset column does.
 *
 * The infinities are not symmetric, and deliberately so. `+Infinity` names a
 * length — the longest one there is — so the cap answers it, exactly as it
 * answers "ten days". Folding it in with the rejects returned `0`, which turned
 * "hold this forever" into "publish it immediately": the most dangerous
 * direction this function has, since it releases an unreviewed beat rather than
 * delaying a reviewed one. `-Infinity` is just a non-positive window, and
 * `NaN` names no length at all, so both keep meaning "publish now".
 */
export function resolveWindowMs(cadence: string, configured: number | null | undefined): number {
  const key: Cadence = isCadence(cadence) ? cadence : "weekly";
  if (configured === null || configured === undefined) return DEFAULT_WINDOW_MS[key];
  if (Number.isNaN(configured) || configured <= 0) return 0;
  return Math.min(configured, MAX_WINDOW_MS[key]);
}
