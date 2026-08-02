/**
 * Player action resolution.
 *
 * Free text arrives as a typed `PlayerAction` (the model's only other job), and
 * from here on everything is deterministic: attribute + skill + a seeded die
 * against a difficulty derived from real world state. Same seed, same state,
 * same outcome — so a player can be told exactly why something happened, and a
 * disputed tick can be replayed rather than argued about.
 *
 * The one asymmetry is deliberate: actions the DM took on behalf of an absent
 * player can never come out badly. See `AUTO_FLOOR` below.
 */

import { EventLog } from "./events";
import { clamp } from "./invariants";
import type { Rng } from "./prng";
import type {
  ActionKind,
  ActionResolution,
  Attribute,
  Character,
  Outcome,
  PlayerAction,
  WorldState,
} from "./types";

interface ActionSpec {
  attribute: Attribute;
  skill: string;
  /** Shown in the composer and used to build the intent prompt. */
  hint: string;
}

export const ACTION_SPECS: Record<ActionKind, ActionSpec> = {
  parley: { attribute: "spirit", skill: "persuasion", hint: "talk someone round" },
  investigate: { attribute: "wits", skill: "insight", hint: "look into something closely" },
  aid: { attribute: "spirit", skill: "care", hint: "help people who need it" },
  confront: { attribute: "might", skill: "arms", hint: "meet something head on" },
  travel: { attribute: "grace", skill: "survival", hint: "go somewhere else" },
  scout: { attribute: "wits", skill: "survival", hint: "range ahead and look" },
  trade: { attribute: "wits", skill: "barter", hint: "deal, bargain, move goods" },
  perform: { attribute: "grace", skill: "performance", hint: "play, sing, hold a crowd" },
  study: { attribute: "wits", skill: "lore", hint: "read, research, remember" },
  guard: { attribute: "might", skill: "arms", hint: "stand watch over something" },
};

/**
 * The best an auto-action can do is `partial` and the worst is also `partial`.
 *
 * A player who is busy with life must never come back to find the DM got their
 * character maimed, disgraced, or killed on their behalf. Capping the upside
 * too is what keeps that fair to everyone else: being absent is never a
 * penalty, and it is never an advantage either.
 */
const AUTO_FLOOR: Outcome = "partial";

const OUTCOME_ORDER: Outcome[] = [
  "critical_failure",
  "failure",
  "partial",
  "success",
  "critical_success",
];

function outcomeFor(margin: number): Outcome {
  if (margin >= 10) return "critical_success";
  if (margin >= 0) return "success";
  if (margin >= -5) return "partial";
  if (margin >= -15) return "failure";
  return "critical_failure";
}

const isGood = (o: Outcome) => o === "success" || o === "critical_success";
const isBad = (o: Outcome) => o === "failure" || o === "critical_failure";

/** Difficulty rises with local danger, unrest, and how big the target is. */
function difficultyFor(state: WorldState, action: PlayerAction, character: Character): number {
  let d = 12;
  const regionId =
    (character.locationId && state.settlements[character.locationId]?.regionId) ??
    character.locationId ??
    state.scene.regionId;
  const region = state.regions[regionId];
  if (region) d += region.danger / 12;
  d += state.scene.tension / 20;

  const target = action.targetId;
  if (target) {
    const threat = state.threats[target];
    const faction = state.factions[target];
    const npc = state.npcs[target];
    const town = state.settlements[target];
    if (threat) d += threat.severity / 8;
    if (faction) d += faction.power / 14;
    if (npc) d += npc.renown / 18 - (npc.attitudes[character.id] ?? 0) / 25;
    if (town) d += town.unrest / 22;
  }
  return clamp(Math.round(d), 5, 32);
}

/** Positive on success, negative on failure — scales every downstream effect. */
function magnitudeFor(outcome: Outcome, rng: Rng): number {
  switch (outcome) {
    case "critical_success": return rng.int(9, 16);
    case "success": return rng.int(4, 9);
    case "partial": return rng.int(1, 3);
    case "failure": return -rng.int(3, 7);
    case "critical_failure": return -rng.int(8, 14);
  }
}

const bump = (rec: Record<string, number>, key: string, by: number): void => {
  rec[key] = clamp((rec[key] ?? 0) + by, -100, 100);
};

/**
 * Make a model-written intent safe to splice into a sentence.
 *
 * The intent lands inside `"<Name> <intent><detail>, and it works."`, so any
 * of these produce visible garbage in the chronicle:
 *   - leading character name      -> "Bram Ashfoot Bram checks the stores"
 *   - sentence capitalization     -> "Bram Ashfoot Sets up to listen"
 *   - trailing punctuation        -> "...to investigate. through Ryarguscrag"
 * All three were live in production before this existed.
 */
export function normalizeIntent(intent: string, characterName: string): string {
  let text = intent.replace(/\s+/g, " ").trim();

  // Strip the character's name, or any leading word of it, from the front.
  const names = [characterName, ...characterName.split(/\s+/)].filter((n) => n.length >= 3);
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    text = text.replace(new RegExp(`^${escaped}\\b[\\s,:'"-]*`, "i"), "").trim();
  }

  text = text.replace(/[.!?;,\s]+$/, "");
  // Lowercase a leading capital unless it looks like a proper noun (two caps
  // in a row, or a following capitalized word — "Ashfall", "The Grey Blight").
  if (/^[A-Z][a-z]/.test(text) && !/^[A-Z][a-z]+ [A-Z]/.test(text)) {
    text = text.charAt(0).toLowerCase() + text.slice(1);
  }
  return text.slice(0, 160);
}

const OUTCOME_PHRASE: Record<Outcome, string> = {
  critical_success: "and it goes better than anyone expected",
  success: "and it works",
  partial: "and it half-works",
  failure: "and it does not go well",
  critical_failure: "and it goes badly wrong",
};

export function resolveAction(
  state: WorldState,
  action: PlayerAction,
  rng: Rng,
  log: EventLog,
): ActionResolution {
  const character = state.characters[action.characterId];
  if (!character) {
    throw new Error(`resolveAction: no such character ${action.characterId}`);
  }

  const spec = ACTION_SPECS[action.kind];
  const roll = rng.int(1, 20);
  const total = roll + (character.attributes[spec.attribute] ?? 1) * 2 + (character.skills[spec.skill] ?? 0) * 2;
  const difficulty = difficultyFor(state, action, character);

  let outcome = outcomeFor(total - difficulty);
  if (action.auto) {
    // Clamp both ends: an absent player is neither punished nor rewarded.
    const i = OUTCOME_ORDER.indexOf(outcome);
    const floor = OUTCOME_ORDER.indexOf(AUTO_FLOOR);
    if (i < floor) outcome = AUTO_FLOOR;
    if (i > floor) outcome = AUTO_FLOOR;
  }

  const mag = magnitudeFor(outcome, rng);
  const target = action.targetId;
  const npc = target ? state.npcs[target] : undefined;
  const faction = target ? state.factions[target] : undefined;
  const threat = target ? state.threats[target] : undefined;
  const town = target ? state.settlements[target] : undefined;
  const region = target ? state.regions[target] : undefined;

  // ─── Effects ───────────────────────────────────────────────────────────
  let detail = "";
  switch (action.kind) {
    case "parley": {
      if (npc?.alive) {
        bump(npc.attitudes, character.id, mag);
        bump(character.bonds, npc.id, Math.round(mag * 0.7));
        detail = ` with ${npc.name}`;
      } else if (faction && !faction.defunct) {
        detail = ` with ${faction.name}`;
      }
      break;
    }
    case "investigate": {
      if (threat && !threat.resolved && isGood(outcome)) {
        threat.revealed = true;
        detail = ` into ${threat.name}`;
      } else if (npc) detail = ` into ${npc.name}`;
      else if (town) detail = ` into ${town.name}`;
      break;
    }
    case "aid": {
      if (town && !town.razed) {
        town.prosperity = clamp(town.prosperity + mag * 0.5, 0, 100);
        town.unrest = clamp(town.unrest - mag * 0.6, 0, 100);
        detail = ` in ${town.name}`;
      } else if (npc?.alive) {
        bump(npc.attitudes, character.id, Math.round(mag * 1.2));
        detail = ` to ${npc.name}`;
      }
      break;
    }
    case "confront": {
      if (threat && !threat.resolved) {
        threat.severity = clamp(threat.severity - mag, 0, 100);
        if (threat.severity <= 0) {
          threat.severity = 0;
          threat.resolved = true;
          log.add("threat_resolved", `${character.name} brought an end to ${threat.name}.`, {
            actorId: character.id,
            targetIds: [threat.id],
            regionId: threat.regionId,
            significance: 90,
            data: { byPlayer: true },
          });
        }
        detail = ` with ${threat.name}`;
      } else if (npc?.alive) {
        bump(npc.attitudes, character.id, -Math.abs(mag));
        detail = ` with ${npc.name}`;
      } else if (faction && !faction.defunct) {
        faction.power = clamp(faction.power - Math.max(0, mag) * 0.3, 0, 100);
        detail = ` with ${faction.name}`;
      }
      break;
    }
    case "travel": {
      const here =
        (character.locationId && state.settlements[character.locationId]?.regionId) ??
        character.locationId;
      const dest = region ?? (town ? state.regions[town.regionId] : undefined);
      const reachable =
        dest && (here === dest.id || (here != null && state.regions[here]?.neighborIds.includes(dest.id)));
      if (dest && reachable && !isBad(outcome)) {
        character.locationId = town && !town.razed ? town.id : dest.id;
        detail = ` to ${town && !town.razed ? town.name : dest.name}`;
      } else if (dest) {
        detail = ` toward ${dest.name}`;
      }
      break;
    }
    case "scout": {
      if (threat && !threat.resolved && !isBad(outcome)) {
        threat.revealed = true;
        detail = ` and finds ${threat.name}`;
      }
      const scoutRegion = region ?? (character.locationId ? state.regions[state.settlements[character.locationId]?.regionId ?? character.locationId] : undefined);
      if (scoutRegion && isGood(outcome)) {
        scoutRegion.danger = clamp(scoutRegion.danger - mag * 0.3, 0, 100);
        if (!detail) detail = ` through ${scoutRegion.name}`;
      }
      break;
    }
    case "trade": {
      if (town && !town.razed) {
        town.prosperity = clamp(town.prosperity + mag * 0.4, 0, 100);
        const lord = town.controllingFactionId ? state.factions[town.controllingFactionId] : undefined;
        if (lord && !lord.defunct) lord.treasury = clamp(lord.treasury + mag * 0.2, 0, 100);
        detail = ` in ${town.name}`;
      } else if (faction && !faction.defunct) {
        faction.treasury = clamp(faction.treasury + mag * 0.3, 0, 100);
        detail = ` with ${faction.name}`;
      }
      break;
    }
    case "perform": {
      const where = town ?? (character.locationId ? state.settlements[character.locationId] : undefined);
      if (where && !where.razed) {
        where.unrest = clamp(where.unrest - mag * 0.5, 0, 100);
        detail = ` in ${where.name}`;
      }
      break;
    }
    case "study": {
      if (threat && !threat.resolved && isGood(outcome)) {
        threat.revealed = true;
        detail = ` on ${threat.name}`;
      } else if (faction) detail = ` on ${faction.name}`;
      else if (npc) detail = ` on ${npc.name}`;
      break;
    }
    case "guard": {
      const where = town ?? (character.locationId ? state.settlements[character.locationId] : undefined);
      if (where && !where.razed) {
        where.defense = clamp(where.defense + mag * 0.4, 0, 100);
        where.unrest = clamp(where.unrest - mag * 0.2, 0, 100);
        detail = ` over ${where.name}`;
      }
      break;
    }
  }

  // ─── Character consequences ────────────────────────────────────────────
  // Renown only ever moves up on a real, player-authored action; an
  // auto-action can add a little but never subtract. Failure costs standing
  // only when the player chose to take the risk.
  if (isGood(outcome)) {
    // Diminishing returns: getting a name is easy, becoming a legend is not.
    // A flat rate saturates the scale in about fifty successful actions, after
    // which renown stops distinguishing anyone from anyone.
    const headroom = 1 - character.renown / 100;
    character.renown = clamp(character.renown + mag * 0.5 * headroom, 0, 100);
  } else if (isBad(outcome) && !action.auto) {
    character.renown = clamp(character.renown - Math.abs(mag) * 0.25, 0, 100);
  }

  if (outcome === "critical_failure" && !action.auto) {
    const condition = action.kind === "confront" ? "wounded" : "shaken";
    if (!character.conditions.includes(condition)) character.conditions.push(condition);
  }
  if (outcome === "critical_success" && character.conditions.length > 0) {
    character.conditions.shift();
  }

  // `lastActedTick` tracks *player-authored* action only. If an auto-action
  // reset it, a silent player would be auto-played forever and would never
  // graduate to offscreen — the escalation would be dead code, and the DM
  // would keep speaking for someone who stopped playing months ago.
  if (!action.auto) {
    character.lastActedTick = action.tick;
    character.presence = "present";
  }

  const significance = clamp(
    30 + Math.abs(mag) * 2 + (outcome === "critical_success" || outcome === "critical_failure" ? 20 : 0),
    0,
    100,
  );

  const phrase = normalizeIntent(action.intent || spec.hint, character.name) || spec.hint;
  const events = [
    log.add(
      "player_action",
      `${character.name} ${phrase}${detail}, ${OUTCOME_PHRASE[outcome]}.`,
      {
        actorId: character.id,
        targetIds: target ? [target] : [],
        regionId:
          (character.locationId && state.settlements[character.locationId]?.regionId) ??
          character.locationId ??
          null,
        significance,
        data: {
          kind: action.kind,
          outcome,
          roll,
          total,
          difficulty,
          auto: action.auto,
          via: action.via,
          rawText: action.rawText,
          playerId: action.playerId,
        },
      },
    ),
  ];

  return { action, outcome, roll, total, difficulty, events };
}
