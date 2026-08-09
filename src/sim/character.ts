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

/**
 * The pool a character's tendencies are drawn from when a player does not
 * write their own.
 *
 * It has to be comfortably larger than a table's worth of draws. With six
 * entries and two per character, a party of three drew every option and
 * collided constantly: the demo world gave both a hedge-doctor and a marsh
 * guide "cannot walk past a locked door", and because the narrator is told a
 * character's tendencies every tick, it dutifully wrote the same line about
 * both of them, in a marsh, for seven turns running.
 */
const DEFAULT_TENDENCIES = [
  "looks after the people nearest to hand",
  "would rather talk than fight",
  "cannot walk past a locked door",
  "keeps their word even when it costs",
  "trusts their own eyes over any report",
  "takes the careful road",
  "remembers every debt, owed and owing",
  "speaks plainly when tact would serve better",
  "gives away more than they can spare",
  "needs to know how a thing works before trusting it",
  "counts the exits in every room",
  "cannot let an unfair thing stand unremarked",
  "saves the last of everything for later",
  "tells the story better than it happened",
  "distrusts anyone who is never afraid",
  "works until the work is finished, or they are",
];

/**
 * Two tendencies nobody else at the table already has, where that is possible.
 *
 * Deterministic: the shuffle comes from the character's own seed, and the
 * exclusion set is read from world state, so a replay of the same joins in the
 * same order produces the same characters. When the pool is exhausted — a very
 * large party — it falls back to allowing repeats rather than leaving a
 * character with nothing, because a shared tendency is a blemish and an empty
 * one is a bug.
 */
function drawTendencies(state: WorldState, rng: Rng): string[] {
  const taken = new Set(
    Object.values(state.characters).flatMap((c) => c.tendencies),
  );
  const shuffled = rng.shuffle(DEFAULT_TENDENCIES);
  const fresh = shuffled.filter((t) => !taken.has(t));
  return (fresh.length >= 2 ? fresh : shuffled).slice(0, 2);
}

/**
 * Bring a returning character back to the table as an equal.
 *
 * The no-penalty promise held mechanically — nothing was taken away while they
 * were gone — but not socially. Renown and bonds only ever accrue through
 * *acting*, so a player who missed a month came back to a party that had grown
 * closer and better known without them. Nothing was lost; they were simply
 * behind, which is the same disadvantage wearing a different coat.
 *
 * So on return, standing is lifted to the middle of the party — never above
 * it. A returning player is not rewarded for absence and cannot overtake the
 * people who showed up; they are merely no longer starting from behind. The
 * people who played still have the story: they did the things, and the
 * chronicle says so permanently. That is the asymmetry this design wants —
 * presence earns narrative, not power.
 */
export function restoreStanding(state: WorldState, character: Character): void {
  const others = Object.values(state.characters).filter((c) => c.id !== character.id);
  if (others.length === 0) return;

  const median = (values: number[]): number => {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
  };

  character.renown = Math.max(character.renown, Math.round(median(others.map((c) => c.renown))));

  // Bonds are per-target, so parity is judged per-target too: for each person
  // the rest of the party knows, the returning character is brought up to the
  // party's middle regard for them — again, never past it.
  const targets = new Set(others.flatMap((c) => Object.keys(c.bonds)));
  for (const target of targets) {
    if (target === character.id) continue;
    const held = others
      .filter((c) => c.id !== target && c.bonds[target] !== undefined)
      .map((c) => c.bonds[target]!);
    if (held.length === 0) continue;
    const parity = Math.round(median(held));
    const current = character.bonds[target] ?? 0;
    if (parity > current) character.bonds[target] = parity;
  }
}

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
      drawTendencies(state, rng),
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
