/**
 * The tick — one complete, deterministic advance of a campaign.
 *
 * Order matters and is fixed:
 *   1. reclassify presence from how long each player has been quiet
 *   2. fill in auto-actions for drifting players
 *   3. advance the world (which happens regardless of anyone)
 *   4. resolve player actions in a stable order
 *
 * The world drifts *before* actions resolve so that players are always
 * responding to the situation the tick actually presents, not to a stale one.
 *
 * `runTick` never throws on missing or malformed input and never leaves the
 * campaign unable to advance. A stuck campaign is the one failure mode this
 * design cannot tolerate: it silently ends the game for everyone.
 */

import { buildRecap, pickAutoAction, presenceFor, restoreStanding } from "./character";
import type { AbsenceConfig } from "./character";
import { driftWorld } from "./drift";
import { EventLog } from "./events";
import { NameForge } from "./names";
import { Rng, seedFrom } from "./prng";
import { resolveAction } from "./actions";
import type { ActionResolution, PlayerAction, TickResult, WorldEvent, WorldState } from "./types";

export type Cadence = "daily" | "weekly" | "monthly";

export interface CampaignConfig extends AbsenceConfig {
  cadence: Cadence;
  /** Fraction of active players whose submissions resolve the tick early. */
  quorumFraction: number;
}

export const DEFAULT_CAMPAIGN_CONFIG: CampaignConfig = {
  cadence: "weekly",
  quorumFraction: 0.5,
  driftAfterTicks: 1,
  offscreenAfterTicks: 3,
};

export const CADENCE_MS: Record<Cadence, number> = {
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
  monthly: 30 * 24 * 60 * 60 * 1000,
};

/** Characters who are not offscreen. Only these count toward quorum. */
export function activeCharacters(state: WorldState) {
  return Object.values(state.characters).filter((c) => c.presence !== "offscreen");
}

/**
 * How many distinct players must submit to resolve the tick early.
 *
 * Computed over *active* players only. Counting dormant players would make
 * quorum unreachable for a half-asleep group, which would quietly convert
 * "resolves early when people are keen" into "always waits the full deadline".
 */
export function quorumSize(state: WorldState, cfg: CampaignConfig): number {
  const active = activeCharacters(state).length;
  if (active === 0) return 0;
  return Math.max(1, Math.ceil(active * cfg.quorumFraction));
}

export function isQuorumMet(
  state: WorldState,
  submitted: readonly PlayerAction[],
  cfg: CampaignConfig,
): boolean {
  const need = quorumSize(state, cfg);
  if (need === 0) return true;
  const activeIds = new Set(activeCharacters(state).map((c) => c.playerId));
  const distinct = new Set(
    submitted.filter((a) => activeIds.has(a.playerId)).map((a) => a.playerId),
  );
  return distinct.size >= need;
}

/** Names already in use, so a tick's new NPCs cannot collide with old ones. */
function forgeFor(state: WorldState): NameForge {
  return new NameForge([
    ...Object.values(state.regions).map((r) => r.name),
    ...Object.values(state.settlements).map((s) => s.name),
    ...Object.values(state.factions).map((f) => f.name),
    ...Object.values(state.npcs).map((n) => n.name),
    ...Object.values(state.threats).map((t) => t.name),
    ...Object.values(state.characters).map((c) => c.name),
  ]);
}

export interface RunTickOptions {
  /**
   * Prior events, used only to build recaps for returning players. Passing
   * nothing simply yields an empty recap — never an error.
   */
  history?: readonly WorldEvent[];
}

export function runTick(
  state: WorldState,
  submitted: readonly PlayerAction[],
  cfg: CampaignConfig = DEFAULT_CAMPAIGN_CONFIG,
  opts: RunTickOptions = {},
): TickResult {
  const tick = state.tick + 1;
  const log = new EventLog(tick);
  const forge = forgeFor(state);

  // Keep only the first submission per player, and drop anything aimed at a
  // character that no longer exists. Duplicate submissions are a normal
  // consequence of email — someone replies twice — not an error condition.
  const byPlayer = new Map<string, PlayerAction>();
  for (const a of submitted) {
    const character = state.characters[a.characterId];
    if (!character || character.playerId !== a.playerId) continue;
    if (!byPlayer.has(a.playerId)) byPlayer.set(a.playerId, { ...a, tick });
  }

  // ─── 1. Presence, and the events that go with changing it ──────────────
  const recaps: Record<string, string[]> = {};
  for (const character of Object.values(state.characters)) {
    const acted = byPlayer.has(character.playerId);
    const wasPresence = character.presence;

    if (acted) {
      if (wasPresence === "offscreen") {
        recaps[character.id] = buildRecap(opts.history ?? [], character.lastActedTick);
        restoreStanding(state, character);
        log.add("character_returned", `${character.name} is back among the party.`, {
          actorId: character.id,
          significance: 55,
          data: { awayTicks: tick - character.lastActedTick },
        });
      }
      character.presence = "present";
      continue;
    }

    const missed = tick - character.lastActedTick;
    const next = presenceFor(missed, cfg);
    character.presence = next;

    // Time off-page heals. Conditions are cleared by acting, so a character
    // who stops playing while wounded stays wounded forever and returns
    // months later still carrying it — an injury preserved precisely *because*
    // they were away, which is the penalty this design forbids. Away is rest.
    if (next !== "present" && character.conditions.length > 0 && missed % 3 === 0) {
      character.conditions.shift();
    }
    if (next === "offscreen" && wasPresence !== "offscreen") {
      log.add(
        "character_offscreen",
        `${character.name} has business elsewhere for a while.`,
        {
          actorId: character.id,
          significance: 35,
          data: { missedTicks: missed },
        },
      );
    }
  }

  // ─── 2. Auto-actions for drifting players ──────────────────────────────
  const autoRng = new Rng(seedFrom(state.campaignId, tick, "auto"));
  const toResolve: PlayerAction[] = [];
  for (const character of Object.values(state.characters).sort((a, b) => a.id.localeCompare(b.id))) {
    const submittedAction = byPlayer.get(character.playerId);
    if (submittedAction) {
      toResolve.push(submittedAction);
    } else if (character.presence === "drifting") {
      toResolve.push(pickAutoAction(state, character, tick, autoRng.fork(character.id)));
    }
    // Offscreen characters do nothing at all. That is the point.
  }

  // ─── 3. The world moves, with or without the party ─────────────────────
  state.tick = tick;
  driftWorld(state, new Rng(seedFrom(state.campaignId, tick, "world")), log, forge);

  // ─── 4. Resolve actions in a stable order ──────────────────────────────
  const resolutions: ActionResolution[] = [];
  for (const action of toResolve) {
    // One bad action must not take the whole tick down with it.
    try {
      resolutions.push(
        resolveAction(state, action, new Rng(seedFrom(state.campaignId, tick, `act-${action.characterId}`)), log),
      );
    } catch (err) {
      log.add("player_action", `${action.intent || "An attempt"} came to nothing.`, {
        actorId: action.characterId,
        significance: 10,
        data: { error: String(err), unresolved: true },
      });
    }
  }

  return { state, events: log.events, resolutions, recaps };
}
