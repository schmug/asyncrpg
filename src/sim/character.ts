/**
 * Character creation and the absence policy.
 *
 * Characters are deliberately thin: four attributes, a handful of skills, and
 * a short list of behavioral tendencies. There is no level, no XP bar, and no
 * gear treadmill — the only thing that accumulates is renown, which records
 * what you became known for rather than how far ahead of the table you are.
 *
 * That is not minimalism for its own sake. A progression axis you can fall
 * behind on is fundamentally incompatible with "no penalty for being busy",
 * because the penalty is simply deferred into the numbers.
 */

import { clamp } from "./invariants";
import { Rng } from "./prng";
import { ATTRIBUTES } from "./types";
import type { Attribute, Character, PlayerId, WorldState } from "./types";

export const SKILLS = [
  "arms",
  "insight",
  "persuasion",
  "survival",
  "barter",
  "lore",
  "care",
  "performance",
] as const;

const DEFAULT_TENDENCIES = [
  "looks after the people nearest to hand",
  "would rather talk than fight",
  "cannot walk past a locked door",
  "keeps their word even when it costs",
  "trusts their own eyes over any report",
  "takes the careful road",
];

export interface JoinRequest {
  playerId: PlayerId;
  name: string;
  concept?: string;
  tendencies?: string[];
  /** Deterministic starting spread. */
  seed: number;
}

/**
 * Add a player's character to a world already in progress.
 *
 * Joining late is not a disadvantage: everyone starts from the same modest
 * spread regardless of what tick it is, because the alternative is a table
 * where the newcomer is visibly behind on arrival.
 */
export function joinCharacter(state: WorldState, req: JoinRequest): Character {
  const rng = new Rng(req.seed);
  const id = `chr_${req.playerId}`;
  if (state.characters[id]) return state.characters[id]!;

  const attributes = {} as Record<Attribute, number>;
  for (const a of ATTRIBUTES) attributes[a] = 2;
  // Two points to spend, so characters differ without anyone being weak.
  for (let i = 0; i < 2; i++) {
    const a = rng.pick(ATTRIBUTES);
    attributes[a] = clamp(attributes[a] + 1, 1, 5);
  }

  const skills: Record<string, number> = {};
  for (const s of rng.shuffle(SKILLS).slice(0, 3)) skills[s] = rng.int(1, 2);

  const anchor =
    state.scene.settlementId ??
    Object.values(state.settlements).find((s) => !s.razed)?.id ??
    state.scene.regionId;

  const character: Character = {
    id,
    playerId: req.playerId,
    name: req.name.trim() || "Someone",
    concept: req.concept?.trim() || "a traveller with reasons of their own",
    attributes,
    skills,
    tendencies:
      req.tendencies?.filter((t) => t.trim().length > 0).slice(0, 4) ??
      rng.shuffle(DEFAULT_TENDENCIES).slice(0, 2),
    bonds: {},
    renown: 5,
    conditions: [],
    locationId: anchor,
    presence: "present",
    lastActedTick: state.tick,
  };

  state.characters[id] = character;
  return character;
}

/**
 * Renown as a phrase, not a score.
 *
 * Showing "known 42/100" next to every player turns the one axis that
 * accumulates into a leaderboard, and a leaderboard makes being busy look like
 * losing. The underlying number still drives difficulty; players see standing.
 */
export function renownLabel(renown: number): string {
  if (renown >= 85) return "spoken of everywhere";
  if (renown >= 65) return "well known";
  if (renown >= 40) return "known around here";
  if (renown >= 18) return "a familiar face";
  return "not yet known";
}

export interface AbsenceConfig {
  /** Ticks of silence before the DM starts acting for a character. */
  driftAfterTicks: number;
  /** Ticks of silence before a character steps offscreen entirely. */
  offscreenAfterTicks: number;
}

/**
 * What a character's presence *should* be, given how long they have been
 * quiet. Pure and total — no clock, no I/O.
 */
export function presenceFor(
  missedTicks: number,
  cfg: AbsenceConfig,
): Character["presence"] {
  if (missedTicks >= cfg.offscreenAfterTicks) return "offscreen";
  if (missedTicks >= cfg.driftAfterTicks) return "drifting";
  return "present";
}

/**
 * Choose a low-risk action for a drifting character.
 *
 * Selection is driven by the character's own tendencies and immediate
 * surroundings so the result reads as *them*. Nothing here can pick a fight,
 * leave the region, or gamble — the outcome is floored at `partial` in
 * `resolveAction` regardless, but choosing a safe verb keeps the prose honest
 * rather than relying on a mechanical safety net the reader cannot see.
 */
export function pickAutoAction(
  state: WorldState,
  character: Character,
  tick: number,
  rng: Rng,
): import("./types").PlayerAction {
  const tendency = character.tendencies[0] ?? "keeps their own counsel";
  const here = character.locationId ? state.settlements[character.locationId] : undefined;

  const options: [import("./types").ActionKind, string, string | null][] = [
    ["aid", `lends a hand${here ? ` around ${here.name}` : ""}`, here?.id ?? null],
    ["guard", `keeps watch${here ? ` over ${here.name}` : ""}`, here?.id ?? null],
    ["study", "reads and asks quiet questions", null],
    ["perform", `plays for whoever will listen${here ? ` in ${here.name}` : ""}`, here?.id ?? null],
    ["trade", `sees to supplies${here ? ` in ${here.name}` : ""}`, here?.id ?? null],
  ];
  const [kind, intent, targetId] = rng.pick(options);

  return {
    id: `auto-${character.id}-${tick}`,
    characterId: character.id,
    playerId: character.playerId,
    tick,
    kind,
    targetId,
    rawText: "",
    intent: `${intent} — ${tendency}`,
    via: "auto",
    auto: true,
  };
}

/**
 * A deterministic summary of what a returning player missed.
 *
 * Built from the chronicle rather than from a model, so it is accurate and
 * free. The narrator may dress it up, but the facts come from here.
 */
export function buildRecap(
  events: readonly import("./types").WorldEvent[],
  sinceTick: number,
  limit = 8,
): string[] {
  return [...events]
    .filter((e) => e.tick > sinceTick)
    .sort((a, b) => b.significance - a.significance || a.tick - b.tick)
    .slice(0, limit)
    .sort((a, b) => a.tick - b.tick)
    .map((e) => e.summary);
}
