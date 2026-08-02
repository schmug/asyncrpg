/**
 * One Durable Object per campaign.
 *
 * This object *is* the campaign: its SQLite holds the canonical world, its
 * single-threaded execution is the lock that makes tick resolution safe
 * without any distributed coordination, and its alarm is the clock. There is
 * no cron, no job table, and no leader election, because none of those are
 * needed when the thing that owns the state is also the thing that wakes up.
 */

import { DurableObject } from "cloudflare:workers";
import { joinCharacter, renownLabel } from "./sim/character";
import { generateWorld } from "./sim/genesis";
import { assertWorldInvariants, checkWorldInvariants } from "./sim/invariants";
import { seedFrom } from "./sim/prng";
import { CADENCE_MS, DEFAULT_CAMPAIGN_CONFIG, isQuorumMet, quorumSize, runTick } from "./sim/tick";
import type { CampaignConfig, Cadence } from "./sim/tick";
import { pruneWorld } from "./sim/prune";
import { EventLog } from "./sim/events";
import { isDowntimeKind, resolveDowntime } from "./sim/downtime";
import { narrateBeat } from "./dm/narrate";
import { parseIntent } from "./dm/intent";
import { promptFor } from "./dm/fallback";
import type { Beat, BudgetGuard, DmConfig } from "./dm/narrate";
import { sendBeat } from "./email/outbound";
import type { Env } from "./env";
import type { PlayerAction, WorldEvent, WorldState } from "./sim/types";

interface PendingRow extends Record<string, SqlStorageValue> {
  player_id: string;
  raw_text: string;
  via: string;
  submitted_at: number;
}

export interface CampaignInit {
  campaignId: string;
  slug: string;
  name: string;
  cadence: Cadence;
  quorumFraction?: number;
  historyYears?: number;
}

export interface JoinResult {
  characterId: string;
  characterName: string;
  prompt: string;
}

/**
 * What a tick reports back over RPC.
 *
 * Deliberately small: the full event log and world state stay inside the
 * object rather than crossing the RPC boundary on every tick. Declared as a
 * type alias rather than an interface so it satisfies the serializability
 * constraint on Durable Object return values.
 */
export type TickSummary = {
  tick: number;
  /** "model" or "templated" — surfaced honestly, including to smoke tests. */
  source: string;
  eventCount: number;
  /** Player ids whose action was auto-chosen this tick. */
  drifted: string[];
  reason: "quorum" | "deadline" | "manual";
};

export interface CampaignSnapshot {
  campaignId: string;
  name: string;
  tick: number;
  year: number;
  season: string;
  place: string;
  situation: string;
  tension: number;
  deadlineAt: number | null;
  /** The group's current clock, so the host controls can show what is set. */
  pace: { cadence: string; quorumFraction: number };
  quorum: { need: number; have: number; active: number };
  cast: {
    characterId: string;
    playerId: string;
    name: string;
    concept: string;
    presence: string;
    /** Qualitative standing. The raw number is deliberately not exposed. */
    standing: string;
    conditions: string[];
    hasPending: boolean;
  }[];
  /**
   * Set when the campaign has stopped scheduling ticks because the same tick
   * kept failing its invariants. Recoverable by the host via `resume()`.
   */
  halted: { since: number; consecutiveBlockedTicks: number; violations: string[] } | null;
}

/**
 * How many consecutive invariant-rejected ticks before the campaign stops
 * scheduling and asks for a human.
 *
 * More than one, because clearing the pending queue genuinely does fix the
 * player-input case and it would be rude to halt a campaign over a single bad
 * submission. Small, because every retry past the first is the same
 * computation producing the same failure.
 */
const BLOCKED_TICK_LIMIT = 3;

/**
 * What to do after a tick, given how many consecutive ticks have been rejected.
 *
 * Pulled out as a pure function because the property that matters — a
 * repeating deterministic failure eventually stops rescheduling instead of
 * looping forever — is otherwise only observable by waiting for an alarm that
 * never ends.
 */
export function blockedTickPolicy(
  previousRuns: number,
  outcome: "blocked" | "resolved",
): { runs: number; reschedule: boolean; halted: boolean } {
  if (outcome === "resolved") return { runs: 0, reschedule: true, halted: false };
  const runs = previousRuns + 1;
  const halted = runs >= BLOCKED_TICK_LIMIT;
  return { runs, reschedule: !halted, halted };
}

export class CampaignDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS pending (
          player_id TEXT PRIMARY KEY,
          raw_text TEXT NOT NULL,
          via TEXT NOT NULL,
          submitted_at INTEGER NOT NULL
        );
      `);
    });
  }

  // ─── meta helpers ──────────────────────────────────────────────────────

  #get<T>(key: string): T | null {
    const row = this.ctx.storage.sql
      .exec<{ v: string }>("SELECT v FROM meta WHERE k = ?", key)
      .toArray()[0];
    return row ? (JSON.parse(row.v) as T) : null;
  }

  #put(key: string, value: unknown): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
      key,
      JSON.stringify(value),
    );
  }

  #world(): WorldState {
    const world = this.#get<WorldState>("world");
    if (!world) throw new Error("campaign not initialised");
    return world;
  }

  #config(): CampaignConfig {
    return this.#get<CampaignConfig>("config") ?? DEFAULT_CAMPAIGN_CONFIG;
  }

  #dm(): DmConfig {
    return {
      apiKey: this.env.ANTHROPIC_API_KEY,
      narrateModel: this.env.MODEL_NARRATE,
      cheapModel: this.env.MODEL_CHEAP,
    };
  }

  /**
   * D1-backed monthly spend cap. Exceeding it degrades narration to templated
   * prose — it never blocks a tick, and it never blocks play.
   */
  #budget(): BudgetGuard {
    const cap = Number.parseInt(this.env.CAMPAIGN_MONTHLY_TOKEN_BUDGET ?? "400000", 10);
    const month = new Date().toISOString().slice(0, 7);
    const db = this.env.DB;
    return {
      canSpend: async (campaignId) => {
        // Global kill switch first: when spend is running away, one row flip
        // should stop every campaign at once without waiting for a deploy.
        try {
          const flag = await db
            .prepare("SELECT value FROM settings WHERE key = 'inference_enabled'")
            .first<{ value: string }>();
          if (flag && flag.value !== "1") return false;
        } catch {
          /* a missing settings table must not disable the game */
        }

        if (!Number.isFinite(cap) || cap <= 0) return true;
        try {
          const row = await db
            .prepare(
              "SELECT input_tokens, output_tokens FROM token_budget WHERE campaign_id = ? AND month = ?",
            )
            .bind(campaignId, month)
            .first<{ input_tokens: number; output_tokens: number }>();
          // Both directions count. Output-only was the wrong meter: this
          // workload sends a large fact sheet every tick, so input is the
          // bigger share of the bill and was entirely unmetered.
          const spent = (row?.input_tokens ?? 0) + (row?.output_tokens ?? 0);
          return spent < cap;
        } catch {
          // A budget-table failure must not stop the game — but it must not be
          // invisible either, or the cap silently stops existing.
          console.error(`budget check failed for ${campaignId}; allowing and degrading open`);
          return true;
        }
      },
      record: async (campaignId, inputTokens, outputTokens) => {
        try {
          await db
            .prepare(
              `INSERT INTO token_budget (campaign_id, month, input_tokens, output_tokens)
               VALUES (?, ?, ?, ?)
               ON CONFLICT(campaign_id, month) DO UPDATE SET
                 input_tokens = input_tokens + excluded.input_tokens,
                 output_tokens = output_tokens + excluded.output_tokens`,
            )
            .bind(campaignId, month, inputTokens, outputTokens)
            .run();
        } catch (err) {
          console.error(
            `budget accounting failed for ${campaignId}:`,
            err instanceof Error ? err.message : String(err),
          );
        }
      },
    };
  }

  /** Record that the read model drifted from canon, so it is visible and repairable. */
  async #recordProjectionFailure(
    campaignId: string,
    tick: number,
    kind: string,
    err: unknown,
  ): Promise<void> {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`projection failed campaign=${campaignId} tick=${tick} kind=${kind}: ${detail}`);
    try {
      await this.env.DB.prepare(
        `INSERT INTO projection_failures (id, campaign_id, tick, kind, detail, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          `pf_${crypto.randomUUID().slice(0, 12)}`,
          campaignId,
          tick,
          kind,
          detail.slice(0, 500),
          new Date().toISOString(),
        )
        .run();
    } catch {
      // If D1 is down hard we cannot record that D1 is down. The console line
      // above is the fallback; reproject repairs whatever was missed.
    }
  }

  // ─── lifecycle ─────────────────────────────────────────────────────────

  async init(req: CampaignInit): Promise<{ tick: number; place: string }> {
    if (this.#get<WorldState>("world")) {
      const existing = this.#world();
      return { tick: existing.tick, place: existing.scene.situation };
    }

    const { state, events } = generateWorld(
      req.campaignId,
      seedFrom(req.campaignId, 0, "genesis"),
      { historyYears: req.historyYears ?? 80 },
    );
    assertWorldInvariants(state);

    this.#put("world", state);
    this.#put("config", {
      ...DEFAULT_CAMPAIGN_CONFIG,
      cadence: req.cadence,
      quorumFraction: req.quorumFraction ?? DEFAULT_CAMPAIGN_CONFIG.quorumFraction,
    } satisfies CampaignConfig);
    this.#put("meta", { name: req.name, slug: req.slug, campaignId: req.campaignId });
    this.#put("history", events.slice(-200));

    await this.#projectGenesis(req, state, events);
    await this.#scheduleNextTick();
    return { tick: state.tick, place: state.scene.situation };
  }

  async join(playerId: string, name: string, concept?: string): Promise<JoinResult> {
    const world = this.#world();
    const character = joinCharacter(world, {
      playerId,
      name,
      concept,
      seed: seedFrom(world.campaignId, Object.keys(world.characters).length, `join-${playerId}`),
    });
    assertWorldInvariants(world);
    this.#put("world", world);
    // A first player makes the campaign live; make sure the clock is running.
    await this.#scheduleNextTick();
    return {
      characterId: character.id,
      characterName: character.name,
      prompt: promptFor(character, world),
    };
  }

  /**
   * Record a player's action for the current tick.
   *
   * Re-submitting replaces the previous text rather than erroring — a player
   * who replies twice by email has changed their mind, not made a mistake.
   */
  async submitAction(
    playerId: string,
    rawText: string,
    via: "email" | "web",
  ): Promise<{ accepted: boolean; resolvedNow: boolean; reason?: string }> {
    // Inbound email submits detached via `waitUntil`, so a throw here surfaces
    // as an unhandled rejection rather than a message the sender can act on.
    // A binding that outlives its campaign is a normal thing to encounter.
    const world = this.#get<WorldState>("world");
    if (!world) return { accepted: false, resolvedNow: false, reason: "campaign not initialised" };
    const character = Object.values(world.characters).find((c) => c.playerId === playerId);
    if (!character) return { accepted: false, resolvedNow: false, reason: "not a member" };

    const text = rawText.trim();
    if (text.length === 0) return { accepted: false, resolvedNow: false, reason: "empty action" };

    this.ctx.storage.sql.exec(
      `INSERT INTO pending (player_id, raw_text, via, submitted_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(player_id) DO UPDATE SET
         raw_text = excluded.raw_text, via = excluded.via, submitted_at = excluded.submitted_at`,
      playerId,
      text.slice(0, 8000),
      via,
      Date.now(),
    );

    // Early resolve when enough of the active table has acted.
    const pending = this.#pending();
    const stubs: PlayerAction[] = pending.map((p) => ({
      id: `stub-${p.player_id}`,
      characterId: `chr_${p.player_id}`,
      playerId: p.player_id,
      tick: world.tick + 1,
      kind: "investigate",
      targetId: null,
      rawText: p.raw_text,
      intent: "",
      via: "web",
      auto: false,
    }));

    if (isQuorumMet(world, stubs, this.#config())) {
      // The action is already durably in `pending`. Resolving the tick is
      // everything that comes *after* accepting it — narration, mail, D1
      // projection — and all of that depends on services that can be slow or
      // briefly unavailable. Letting a failure there propagate turns an
      // accepted turn into a 500 and loses the player's writing, which is the
      // worst possible trade: the expensive, irreplaceable part already
      // succeeded.
      //
      // So: accept, and let the alarm resolve. The tick is late, not lost.
      try {
        await this.resolveTick("quorum");
        return { accepted: true, resolvedNow: true };
      } catch (err) {
        console.error(
          `inline resolve failed for ${world.campaignId} at tick ${world.tick}; ` +
            `action is stored and the alarm will retry:`,
          err instanceof Error ? (err.stack ?? err.message) : String(err),
        );
        await this.#scheduleNextTick();
        return { accepted: true, resolvedNow: false };
      }
    }
    return { accepted: true, resolvedNow: false };
  }

  /**
   * Resolve a downtime action immediately, between ticks.
   *
   * Deliberately not queued into the tick: downtime is for people who want to
   * do more *now*, and making them wait for the group's clock would defeat
   * the point. It also cannot change attributes or skills, so resolving it
   * out of band cannot advantage anyone — see src/sim/downtime.ts.
   */
  async submitDowntime(
    playerId: string,
    kind: string,
    detail: string,
    targetId: string | null,
  ): Promise<{ ok: boolean; outcome?: string; reason?: string }> {
    const world = this.#get<WorldState>("world");
    if (!world) return { ok: false, reason: "campaign not initialised" };
    if (!isDowntimeKind(kind)) return { ok: false, reason: "unknown downtime activity" };

    const character = Object.values(world.characters).find((c) => c.playerId === playerId);
    if (!character) return { ok: false, reason: "not a member" };

    const log = new EventLog(world.tick);
    const result = resolveDowntime(
      world,
      { characterId: character.id, kind, detail, targetId },
      log,
    );
    if (!result.ok) return { ok: false, reason: result.reason };

    const violations = checkWorldInvariants(world);
    if (violations.length > 0) {
      return { ok: false, reason: "that would have broken the world" };
    }

    this.#put("world", world);
    this.ctx.waitUntil(
      (async () => {
        await this.#writeEvents(world.campaignId, result.events);
        await this.#writeEntities(world);
      })().catch((err) => console.error("downtime projection failed", err)),
    );
    return { ok: true, outcome: result.outcome };
  }

  /** Recent player-authored side material, folded into the next beat. */
  async recordSideMaterial(kind: "letter" | "journal", summary: string): Promise<void> {
    const recent = this.#get<string[]>("side") ?? [];
    this.#put("side", [...recent, `${kind}: ${summary}`].slice(-12));
  }

  #pending(): PendingRow[] {
    return this.ctx.storage.sql
      .exec<PendingRow>("SELECT player_id, raw_text, via, submitted_at FROM pending")
      .toArray();
  }

  override async alarm(): Promise<void> {
    await this.resolveTick("deadline");
    // Heal a lagging chronicle without waiting for a host to notice the
    // banner. Projection failures were already visible and repairable by hand;
    // "visible" is the right shape but it still leaves the public artifact
    // wrong for as long as nobody looks. Runs after the tick so a repair can
    // never delay canon, and swallows its own errors for the same reason —
    // the next alarm will try again.
    await this.#healProjection();
  }

  async #healProjection(): Promise<void> {
    try {
      const world = this.#get<WorldState>("world");
      if (!world) return;
      const open = await this.env.DB.prepare(
        "SELECT COUNT(*) AS n FROM projection_failures WHERE campaign_id = ? AND resolved_at IS NULL",
      )
        .bind(world.campaignId)
        .first<{ n: number }>();
      if ((open?.n ?? 0) === 0) return;
      await this.reproject();
      console.log(`chronicle reprojected automatically for ${world.campaignId}`);
    } catch (err) {
      console.error("automatic reprojection failed; will retry next alarm", err);
    }
  }

  // ─── the tick ──────────────────────────────────────────────────────────

  async resolveTick(reason: TickSummary["reason"]): Promise<TickSummary> {
    const world = this.#world();
    const config = this.#config();
    const meta = this.#get<{ name: string; slug: string }>("meta") ?? { name: "Campaign", slug: "c" };
    const pending = this.#pending();
    const dm = this.#dm();

    // Turn free text into typed actions. Each parse is independent, so one
    // bad reply cannot spoil the tick for everyone else.
    const submitted: PlayerAction[] = [];
    for (const row of pending) {
      const character = Object.values(world.characters).find((c) => c.playerId === row.player_id);
      if (!character) continue;
      let parsed;
      try {
        parsed = await parseIntent(dm, world, character.name, row.raw_text);
      } catch {
        parsed = { kind: "investigate" as const, targetId: null, intent: "acts", source: "keywords" as const };
      }
      submitted.push({
        id: `act-${world.tick + 1}-${row.player_id}`,
        characterId: character.id,
        playerId: row.player_id,
        tick: world.tick + 1,
        kind: parsed.kind,
        targetId: parsed.targetId,
        rawText: row.raw_text,
        intent: parsed.intent,
        via: row.via === "email" ? "email" : "web",
        auto: false,
      });
    }

    const history = this.#get<WorldEvent[]>("history") ?? [];

    // Recaps for players coming back from a long absence must reach further
    // than the DO's rolling event buffer. That buffer is capped so DO storage
    // stays bounded, which is right — but a player returning after months
    // would then get a recap built from events that all postdate the ones they
    // actually missed, which is precisely the case the promise is about.
    //
    // D1 holds every projected event for the campaign, so the gap is filled
    // from there for exactly the players who need it. Best-effort: a recap is
    // a courtesy, and failing to build one must never stop a tick resolving.
    const oldestRetained = history[0]?.tick ?? world.tick;
    const acting = new Set(submitted.map((a) => a.playerId));
    const returningFromBefore = Object.values(world.characters)
      .filter((c) => c.presence === "offscreen" && acting.has(c.playerId))
      .map((c) => c.lastActedTick)
      .filter((t) => t < oldestRetained);

    let recapHistory = history;
    if (returningFromBefore.length > 0) {
      try {
        const from = Math.min(...returningFromBefore);
        const older = await this.env.DB.prepare(
          `SELECT tick, kind, summary, significance FROM events
           WHERE campaign_id = ? AND tick > ? AND tick < ? AND significance >= 55
           ORDER BY significance DESC LIMIT 200`,
        )
          .bind(world.campaignId, from, oldestRetained)
          .all<{ tick: number; kind: string; summary: string; significance: number }>();
        const rows = (older.results ?? []).map(
          (e) =>
            ({
              tick: e.tick,
              kind: e.kind,
              summary: e.summary,
              significance: e.significance,
              actorId: null,
              targetIds: [],
              regionId: null,
              data: {},
            }) as unknown as WorldEvent,
        );
        if (rows.length > 0) recapHistory = [...rows, ...history];
      } catch (err) {
        console.error("could not widen recap history from D1", err);
      }
    }

    const before = structuredClone(world);
    const result = runTick(world, submitted, config, { history: recapHistory });

    // The sim is canon, so a tick that would corrupt it is discarded whole
    // rather than half-written. Rolling back to the last good state keeps the
    // campaign playable instead of wedged.
    const violations = checkWorldInvariants(result.state);
    if (violations.length > 0) {
      // Roll back, but do NOT throw. A deterministic invariant failure would
      // otherwise reproduce on every alarm forever: same state, same pending
      // actions, same crash — a campaign wedged with no way out. Clearing the
      // pending queue changes the inputs, so the next tick is a different
      // computation, and rescheduling keeps the clock alive.
      console.error(
        `tick ${before.tick + 1} rejected for campaign ${before.campaignId}:`,
        violations.slice(0, 5).join("; "),
      );
      this.#put("world", before);
      this.ctx.storage.sql.exec("DELETE FROM pending");

      // Clearing pending changes the inputs, so a violation caused by player
      // actions will not recur. A violation caused by deterministic world
      // drift will: same state, same drift, same rejection, on every alarm
      // forever — a campaign that looks alive and never moves.
      //
      // So count consecutive rejections. After a few, stop rescheduling and
      // say so out loud. A halted campaign is a bad state; a campaign quietly
      // failing the same tick until someone notices is a worse one.
      const policy = blockedTickPolicy(this.#get<number>("blockedRuns") ?? 0, "blocked");
      this.#put("blockedRuns", policy.runs);
      this.#put("blockedDetail", violations.slice(0, 5));

      // Canon does not advance, but the record of it must. A turn that
      // silently does nothing is indistinguishable from an outage to the
      // group, and to anyone debugging it later.
      try {
        await this.env.DB.prepare(
          `INSERT INTO beats (campaign_id, tick, prose, situation, source, created_at)
           VALUES (?, ?, ?, ?, 'blocked', ?)
           ON CONFLICT(campaign_id, tick) DO NOTHING`,
        )
          .bind(
            before.campaignId,
            before.tick,
            "The turn could not be resolved — the world would have ended up in a state that " +
              "cannot be true. Nothing was lost; the story simply did not move. " +
              "Everyone's submitted actions were cleared, so send them again when you like.",
            before.scene.situation,
            new Date().toISOString(),
          )
          .run();
      } catch (err) {
        await this.#recordProjectionFailure(before.campaignId, before.tick, "blocked-beat", err);
      }

      if (policy.reschedule) {
        await this.#scheduleNextTick();
      } else {
        // Explicitly halted, not silently looping. `resume()` is the way out,
        // and the snapshot says so to the host.
        this.#put("haltedAt", Date.now());
        console.error(
          `campaign ${before.campaignId} halted after ${policy.runs} consecutive blocked ticks`,
        );
      }

      return {
        tick: before.tick,
        source: "blocked",
        eventCount: 0,
        drifted: [],
        reason,
      };
    }

    // A tick got through: the campaign is not in a repeating failure.
    if ((this.#get<number>("blockedRuns") ?? 0) > 0) {
      this.#put("blockedRuns", 0);
      this.#put("blockedDetail", []);
      this.#put("haltedAt", null);
    }

    pruneWorld(result.state);

    // Letters and journals players wrote between ticks become facts the
    // narrator can weave in, so side material affects the shared story
    // instead of sitting in a drawer.
    const side = this.#get<string[]>("side") ?? [];
    const beat = await narrateBeat(
      dm,
      result.state,
      result.events,
      result.resolutions,
      this.#budget(),
      side,
    );
    if (side.length > 0) this.#put("side", []);
    // Deliberately NOT written back into world state. `beat.situation` is model
    // output; the canonical scene line is produced deterministically by
    // `describeScene` during drift. Persisting the model's version here would
    // let it steer every subsequent tick, which is exactly the state authority
    // this design denies it.

    this.#put("world", result.state);
    this.#put("history", [...history, ...result.events].slice(-400));
    this.ctx.storage.sql.exec("DELETE FROM pending");

    await this.#project(result.state, result.events, beat, meta);
    await this.#scheduleNextTick();

    // A deadline tick has no HTTP caller, so the fan-out has to happen here.
    // Detached: nobody should wait on N mail sends, and a bounce must not roll
    // back a tick that already resolved.
    this.ctx.waitUntil(
      this.#fanOut(result.state, beat, result, meta).catch((err) => {
        console.error("fan-out failed", err);
      }),
    );

    return {
      tick: result.state.tick,
      source: beat.source,
      eventCount: result.events.length,
      drifted: result.resolutions.filter((r) => r.action.auto).map((r) => r.action.playerId),
      reason,
    };
  }

  async #scheduleNextTick(): Promise<void> {
    const config = this.#config();
    const at = Date.now() + CADENCE_MS[config.cadence];
    await this.ctx.storage.setAlarm(at);
    this.#put("deadlineAt", at);
    try {
      await this.env.DB.prepare("UPDATE campaigns SET deadline_at = ?, tick = ? WHERE id = ?")
        .bind(at, this.#world().tick, this.#world().campaignId)
        .run();
    } catch {
      /* the DO alarm is the real clock; D1 only mirrors it for display */
    }
  }

  /** Mail every member their beat, their prompt, and any recap they are owed. */
  async #fanOut(
    state: WorldState,
    beat: Beat,
    result: { resolutions: { action: PlayerAction }[]; recaps: Record<string, string[]> },
    meta: { name: string; slug: string },
  ): Promise<void> {
    const members = await this.env.DB.prepare(
      `SELECT m.player_id, p.email FROM memberships m
       JOIN players p ON p.id = m.player_id WHERE m.campaign_id = ?`,
    )
      .bind(state.campaignId)
      .all<{ player_id: string; email: string }>();

    // First line of the beat makes a serviceable subject; fall back to place.
    const headline =
      beat.prose.split("\n").find((l) => l.trim().length > 0)?.slice(0, 70) ??
      `${state.season} of year ${state.year}`;

    for (const member of members.results ?? []) {
      const character = Object.values(state.characters).find((c) => c.playerId === member.player_id);
      if (!character) continue;

      const auto = result.resolutions.find(
        (r) => r.action.characterId === character.id && r.action.auto,
      );

      const sent = await sendBeat(this.env, {
        campaignId: state.campaignId,
        campaignSlug: meta.slug,
        campaignName: meta.name,
        tick: state.tick,
        playerId: member.player_id,
        toEmail: member.email,
        headline,
        prose: beat.prose,
        prompt: promptFor(character, state),
        recap: result.recaps[character.id],
        actedForYou: auto ? auto.action.intent : null,
      });

      // A beat that did not reach its player is a lost turn on the primary
      // channel. Record it against that player so the app can tell them
      // plainly, and clear the moment a later beat gets through.
      await this.#recordDelivery(
        state.campaignId,
        member.player_id,
        state.tick,
        sent.ok ? null : sent.error,
      );
    }
  }

  async #recordDelivery(
    campaignId: string,
    playerId: string,
    tick: number,
    /** Null when the beat went out; otherwise the provider's own words. */
    error: string | null,
  ): Promise<void> {
    try {
      if (error === null) {
        await this.env.DB.prepare(
          `UPDATE delivery_failures SET resolved_at = ?
           WHERE campaign_id = ? AND player_id = ? AND resolved_at IS NULL`,
        )
          .bind(new Date().toISOString(), campaignId, playerId)
          .run();
        return;
      }
      await this.env.DB.prepare(
        `INSERT INTO delivery_failures (id, campaign_id, player_id, tick, kind, detail, created_at)
         VALUES (?, ?, ?, ?, 'beat', ?, ?)`,
      )
        .bind(
          `dlv_${campaignId}_${playerId}_${tick}`,
          campaignId,
          playerId,
          tick,
          error.slice(0, 300),
          new Date().toISOString(),
        )
        .run();
    } catch (err) {
      // Bookkeeping about a failure must never become a second failure that
      // stops the fan-out; the remaining players still need their beat.
      console.error("delivery bookkeeping failed", err);
    }
  }

  // ─── projection into D1 ────────────────────────────────────────────────

  async #projectGenesis(req: CampaignInit, state: WorldState, events: WorldEvent[]): Promise<void> {
    await this.#writeEvents(req.campaignId, events);
    await this.#writeEntities(state);
  }

  async #project(
    state: WorldState,
    events: WorldEvent[],
    beat: Beat,
    meta: { name: string; slug: string },
  ): Promise<void> {
    void meta;
    await this.#writeEvents(state.campaignId, events);
    await this.#writeEntities(state);
    try {
      await this.env.DB.prepare(
        `INSERT INTO beats (campaign_id, tick, prose, situation, source, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(campaign_id, tick) DO UPDATE SET
           prose = excluded.prose, situation = excluded.situation, source = excluded.source`,
      )
        .bind(state.campaignId, state.tick, beat.prose, beat.situation, beat.source, new Date().toISOString())
        .run();
    } catch (err) {
      await this.#recordProjectionFailure(state.campaignId, state.tick, "beat", err);
    }
  }

  async #writeEvents(campaignId: string, events: readonly WorldEvent[]): Promise<void> {
    if (events.length === 0) return;
    const now = new Date().toISOString();
    const stmt = this.env.DB.prepare(
      `INSERT INTO events (campaign_id, event_id, tick, kind, actor_id, region_id, summary, significance, data, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(campaign_id, event_id) DO NOTHING`,
    );
    try {
      // D1 batches are capped; chunk so a busy genesis does not exceed it.
      for (let i = 0; i < events.length; i += 50) {
        await this.env.DB.batch(
          events.slice(i, i + 50).map((e) =>
            stmt.bind(
              campaignId,
              e.id,
              e.tick,
              e.kind,
              e.actorId,
              e.regionId,
              e.summary,
              e.significance,
              JSON.stringify(e.data),
              now,
            ),
          ),
        );
      }
    } catch (err) {
      await this.#recordProjectionFailure(campaignId, events[0]?.tick ?? 0, "events", err);
    }
  }

  async #writeEntities(state: WorldState): Promise<void> {
    const rows: [string, string, string, string][] = [];
    for (const r of Object.values(state.regions)) rows.push([r.id, "region", r.name, JSON.stringify(r)]);
    for (const s of Object.values(state.settlements)) rows.push([s.id, "settlement", s.name, JSON.stringify(s)]);
    for (const f of Object.values(state.factions)) rows.push([f.id, "faction", f.name, JSON.stringify(f)]);
    for (const n of Object.values(state.npcs)) rows.push([n.id, "npc", n.name, JSON.stringify(n)]);
    for (const t of Object.values(state.threats)) {
      // Never leak an unrevealed threat into a publicly readable chronicle.
      if (t.revealed || t.resolved) rows.push([t.id, "threat", t.name, JSON.stringify(t)]);
    }
    for (const c of Object.values(state.characters)) rows.push([c.id, "character", c.name, JSON.stringify(c)]);

    const stmt = this.env.DB.prepare(
      `INSERT INTO entities (campaign_id, entity_id, kind, name, data) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(campaign_id, entity_id) DO UPDATE SET
         kind = excluded.kind, name = excluded.name, data = excluded.data`,
    );
    try {
      for (let i = 0; i < rows.length; i += 50) {
        await this.env.DB.batch(
          rows.slice(i, i + 50).map(([id, kind, name, data]) =>
            stmt.bind(state.campaignId, id, kind, name, data),
          ),
        );
      }
    } catch (err) {
      await this.#recordProjectionFailure(state.campaignId, state.tick, "entities", err);
    }
  }

  // ─── reads ─────────────────────────────────────────────────────────────

  async snapshot(): Promise<CampaignSnapshot> {
    const world = this.#world();
    const config = this.#config();
    const meta = this.#get<{ name: string }>("meta") ?? { name: "Campaign" };
    const pendingIds = new Set(this.#pending().map((p) => p.player_id));

    const place =
      (world.scene.settlementId && world.settlements[world.scene.settlementId]?.name) ??
      world.regions[world.scene.regionId]?.name ??
      "the road";

    const active = Object.values(world.characters).filter((c) => c.presence !== "offscreen");
    return {
      campaignId: world.campaignId,
      name: meta.name,
      tick: world.tick,
      year: world.year,
      season: world.season,
      place,
      situation: world.scene.situation,
      tension: Math.round(world.scene.tension),
      deadlineAt: this.#get<number>("deadlineAt"),
      pace: { cadence: config.cadence, quorumFraction: config.quorumFraction },
      quorum: {
        need: quorumSize(world, config),
        have: [...pendingIds].filter((id) => active.some((c) => c.playerId === id)).length,
        active: active.length,
      },
      cast: Object.values(world.characters).map((c) => ({
        characterId: c.id,
        playerId: c.playerId,
        name: c.name,
        concept: c.concept,
        presence: c.presence,
        standing: renownLabel(c.renown),
        conditions: c.conditions,
        hasPending: pendingIds.has(c.playerId),
      })),
      halted: this.#haltState(),
    };
  }

  #haltState(): CampaignSnapshot["halted"] {
    const since = this.#get<number>("haltedAt");
    if (!since) return null;
    return {
      since,
      consecutiveBlockedTicks: this.#get<number>("blockedRuns") ?? 0,
      violations: this.#get<string[]>("blockedDetail") ?? [],
    };
  }

  /**
   * Take a halted campaign off the bench.
   *
   * Deliberately not automatic. The counter exists because retrying was not
   * working, so the only honest resume is one a person asked for after looking
   * at the violations.
   */
  /**
   * Change the group's clock mid-campaign.
   *
   * Groups discover their real pace by playing: a table that signed up for
   * daily and is managing weekly should be able to say so without starting
   * over. The pending deadline is recomputed from the *current* tick, so
   * slowing down does not strand a deadline that has already passed and
   * speeding up does not fire one instantly.
   */
  async setPace(
    next: { cadence?: Cadence; quorumFraction?: number },
  ): Promise<{ cadence: Cadence; quorumFraction: number }> {
    const config = this.#config();
    const cadence = next.cadence ?? config.cadence;
    const quorumFraction =
      next.quorumFraction === undefined
        ? config.quorumFraction
        : Math.min(1, Math.max(0.1, next.quorumFraction));

    this.#put("config", { ...config, cadence, quorumFraction });
    await this.#scheduleNextTick();
    return { cadence, quorumFraction };
  }

  async resume(): Promise<{ resumed: boolean; wasHalted: boolean }> {
    const wasHalted = Boolean(this.#get<number>("haltedAt"));
    this.#put("blockedRuns", 0);
    this.#put("blockedDetail", []);
    this.#put("haltedAt", null);
    this.ctx.storage.sql.exec("DELETE FROM pending");
    await this.#scheduleNextTick();
    return { resumed: true, wasHalted };
  }

  /**
   * Everything one player needs to understand their own position.
   *
   * Previously the app showed a prompt and a party list and nothing else — you
   * had to leave for the chronicle to find out what had actually happened, and
   * there was no way at all to see your own character. That is a poor surface
   * for the app that is meant to be the richer one.
   */
  async mySheet(playerId: string): Promise<{
    characterId: string;
    name: string;
    concept: string;
    attributes: Record<string, number>;
    skills: Record<string, number>;
    tendencies: string[];
    conditions: string[];
    standing: string;
    presence: string;
    where: string;
    /** Named bonds, strongest first — the relationships that make a campaign. */
    bonds: { name: string; feeling: string }[];
  } | null> {
    const world = this.#get<WorldState>("world");
    if (!world) return null;
    const c = Object.values(world.characters).find((x) => x.playerId === playerId);
    if (!c) return null;

    const nameOf = (id: string): string | null =>
      world.npcs[id]?.name ?? world.factions[id]?.name ?? world.settlements[id]?.name ?? null;

    const bonds = Object.entries(c.bonds)
      .map(([id, value]) => ({ name: nameOf(id), value }))
      .filter((b): b is { name: string; value: number } => b.name !== null && Math.abs(b.value) >= 8)
      .sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
      .slice(0, 8)
      .map((b) => ({
        name: b.name,
        feeling:
          b.value >= 55 ? "trusts you" : b.value >= 20 ? "thinks well of you" :
          b.value > 0 ? "knows you" :
          b.value > -25 ? "is wary of you" : "holds a grudge",
      }));

    return {
      characterId: c.id,
      name: c.name,
      concept: c.concept,
      attributes: c.attributes,
      skills: c.skills,
      tendencies: c.tendencies,
      conditions: c.conditions,
      standing: renownLabel(c.renown),
      presence: c.presence,
      where:
        (c.locationId && world.settlements[c.locationId]?.name) ??
        (c.locationId && world.regions[c.locationId]?.name) ??
        "the road",
      bonds,
    };
  }

  /** The exact prompt a player should be answering right now. */
  async promptForPlayer(playerId: string): Promise<string | null> {
    const world = this.#world();
    const character = Object.values(world.characters).find((c) => c.playerId === playerId);
    return character ? promptFor(character, world) : null;
  }

  /**
   * Rebuild the D1 read model from canonical DO state.
   *
   * Projection writes are swallowed so a D1 blip cannot wedge a tick, which
   * means the public chronicle can silently drift from the truth. This is the
   * repair path: the DO holds canon, so entities and the recent event history
   * can always be replayed onto D1. Without it, "recoverable" was a claim with
   * no mechanism behind it.
   */
  async reproject(): Promise<{ entities: number; events: number }> {
    const world = this.#get<WorldState>("world");
    if (!world) return { entities: 0, events: 0 };
    const history = this.#get<WorldEvent[]>("history") ?? [];
    await this.#writeEntities(world);
    await this.#writeEvents(world.campaignId, history);
    try {
      await this.env.DB.prepare("UPDATE campaigns SET tick = ? WHERE id = ?")
        .bind(world.tick, world.campaignId)
        .run();
    } catch {
      /* the tick mirror is cosmetic */
    }
    try {
      await this.env.DB.prepare(
        "UPDATE projection_failures SET resolved_at = ? WHERE campaign_id = ? AND resolved_at IS NULL",
      )
        .bind(new Date().toISOString(), world.campaignId)
        .run();
    } catch {
      /* best effort */
    }
    return { entities: Object.keys(world.characters).length + Object.keys(world.npcs).length, events: history.length };
  }

  /** Full canonical world — used by the adversarial smoke suite and by tests. */
  async debugWorld(): Promise<WorldState> {
    return this.#world();
  }
}
