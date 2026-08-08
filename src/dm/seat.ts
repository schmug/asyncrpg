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
 * Assign the seat, or vacate it with `null`. Either way the miss count resets.
 *
 * Resetting is what makes the seat a state rather than a history: "plr_two
 * holds the seat" must mean the same thing however it came to be true, or the
 * reversion rule would fire on a DM who inherited someone else's silence.
 */
export async function setSeat(
  db: D1Database,
  campaignId: string,
  playerId: string | null,
): Promise<void> {
  await db
    .prepare("UPDATE campaigns SET dm_player_id = ?, dm_missed_windows = 0 WHERE id = ?")
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
 */
export function resolveWindowMs(cadence: string, configured: number | null | undefined): number {
  const key: Cadence = isCadence(cadence) ? cadence : "weekly";
  if (configured === null || configured === undefined) return DEFAULT_WINDOW_MS[key];
  if (!Number.isFinite(configured) || configured <= 0) return 0;
  return Math.min(configured, MAX_WINDOW_MS[key]);
}
