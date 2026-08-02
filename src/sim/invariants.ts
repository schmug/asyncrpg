/**
 * World invariants.
 *
 * This is the contract every path into world state must satisfy: genesis, each
 * deterministic tick, action resolution, and — critically — any state delta
 * proposed by the language model. The narrator is not trusted to keep the world
 * consistent; this file is what makes "the simulation is canon" enforceable
 * rather than aspirational.
 *
 * Violations throw. A tick that would corrupt the world must fail loudly and
 * roll back to the last good state rather than persist nonsense.
 */

import type { WorldState } from "./types";
import { ATTRIBUTES, PRESENCE, SEASONS, TERRAINS } from "./types";

export class InvariantError extends Error {
  readonly violations: string[];
  constructor(violations: string[]) {
    super(`World invariants violated:\n  - ${violations.join("\n  - ")}`);
    this.name = "InvariantError";
    this.violations = violations;
  }
}

const inRange = (v: unknown, lo: number, hi: number): boolean =>
  typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;

/**
 * Collect every violation rather than throwing on the first. When the model
 * proposes a bad delta we want the full list in the retry prompt, not a
 * one-at-a-time guessing game.
 */
export function checkWorldInvariants(state: WorldState): string[] {
  const bad: string[] = [];
  const has = (rec: Record<string, unknown>, id: string | null): boolean =>
    id === null || Object.prototype.hasOwnProperty.call(rec, id);

  if (!Number.isInteger(state.tick) || state.tick < 0) bad.push(`tick is not a non-negative integer: ${state.tick}`);
  if (!Number.isInteger(state.year)) bad.push(`year is not an integer: ${state.year}`);
  if (!SEASONS.includes(state.season)) bad.push(`unknown season: ${state.season}`);

  // ─── Regions ───────────────────────────────────────────────────────────
  for (const [id, r] of Object.entries(state.regions)) {
    if (r.id !== id) bad.push(`region ${id} has mismatched id ${r.id}`);
    if (!r.name?.trim()) bad.push(`region ${id} has no name`);
    if (!TERRAINS.includes(r.terrain)) bad.push(`region ${id} has unknown terrain ${r.terrain}`);
    if (!inRange(r.danger, 0, 100)) bad.push(`region ${id} danger out of range: ${r.danger}`);
    if (!has(state.factions, r.controllingFactionId))
      bad.push(`region ${id} controlled by unknown faction ${r.controllingFactionId}`);
    for (const n of r.neighborIds) {
      if (!has(state.regions, n)) bad.push(`region ${id} neighbors unknown region ${n}`);
      if (n === id) bad.push(`region ${id} is its own neighbor`);
      // Adjacency must be symmetric or travel rules break in one direction.
      if (state.regions[n] && !state.regions[n]!.neighborIds.includes(id))
        bad.push(`region adjacency ${id}->${n} is not symmetric`);
    }
  }

  // ─── Settlements ───────────────────────────────────────────────────────
  for (const [id, s] of Object.entries(state.settlements)) {
    if (s.id !== id) bad.push(`settlement ${id} has mismatched id ${s.id}`);
    if (!s.name?.trim()) bad.push(`settlement ${id} has no name`);
    if (!has(state.regions, s.regionId)) bad.push(`settlement ${id} in unknown region ${s.regionId}`);
    if (!inRange(s.prosperity, 0, 100)) bad.push(`settlement ${id} prosperity out of range: ${s.prosperity}`);
    if (!inRange(s.defense, 0, 100)) bad.push(`settlement ${id} defense out of range: ${s.defense}`);
    if (!inRange(s.unrest, 0, 100)) bad.push(`settlement ${id} unrest out of range: ${s.unrest}`);
    if (typeof s.population !== "number" || s.population < 0)
      bad.push(`settlement ${id} has negative population: ${s.population}`);
    if (!has(state.factions, s.controllingFactionId))
      bad.push(`settlement ${id} controlled by unknown faction ${s.controllingFactionId}`);
    if (s.razed && s.population > 0) bad.push(`settlement ${id} is razed but still populated`);
  }

  // ─── Factions ──────────────────────────────────────────────────────────
  for (const [id, f] of Object.entries(state.factions)) {
    if (f.id !== id) bad.push(`faction ${id} has mismatched id ${f.id}`);
    if (!f.name?.trim()) bad.push(`faction ${id} has no name`);
    if (!inRange(f.power, 0, 100)) bad.push(`faction ${id} power out of range: ${f.power}`);
    if (!inRange(f.treasury, 0, 100)) bad.push(`faction ${id} treasury out of range: ${f.treasury}`);
    if (!has(state.settlements, f.seatSettlementId))
      bad.push(`faction ${id} seated in unknown settlement ${f.seatSettlementId}`);
    if (!inRange(f.agenda.progress, 0, 100))
      bad.push(`faction ${id} agenda progress out of range: ${f.agenda.progress}`);
    if (!inRange(f.agenda.urgency, 1, 10))
      bad.push(`faction ${id} agenda urgency out of range: ${f.agenda.urgency}`);
    if (
      f.agenda.targetId !== null &&
      !has(state.factions, f.agenda.targetId) &&
      !has(state.settlements, f.agenda.targetId) &&
      !has(state.threats, f.agenda.targetId)
    ) {
      bad.push(`faction ${id} agenda targets unknown entity ${f.agenda.targetId}`);
    }
    for (const [other, v] of Object.entries(f.relations)) {
      if (!has(state.factions, other)) bad.push(`faction ${id} has relation to unknown faction ${other}`);
      if (!inRange(v, -100, 100)) bad.push(`faction ${id} relation to ${other} out of range: ${v}`);
      if (other === id) bad.push(`faction ${id} has a relation to itself`);
    }
  }

  // ─── NPCs ──────────────────────────────────────────────────────────────
  for (const [id, n] of Object.entries(state.npcs)) {
    if (n.id !== id) bad.push(`npc ${id} has mismatched id ${n.id}`);
    if (!n.name?.trim()) bad.push(`npc ${id} has no name`);
    if (!has(state.factions, n.factionId)) bad.push(`npc ${id} belongs to unknown faction ${n.factionId}`);
    if (n.locationId !== null && !has(state.settlements, n.locationId) && !has(state.regions, n.locationId))
      bad.push(`npc ${id} is at unknown location ${n.locationId}`);
    if (!inRange(n.renown, 0, 100)) bad.push(`npc ${id} renown out of range: ${n.renown}`);
    for (const [target, v] of Object.entries(n.attitudes)) {
      if (!inRange(v, -100, 100)) bad.push(`npc ${id} attitude to ${target} out of range: ${v}`);
    }
  }

  // ─── Threats ───────────────────────────────────────────────────────────
  for (const [id, t] of Object.entries(state.threats)) {
    if (t.id !== id) bad.push(`threat ${id} has mismatched id ${t.id}`);
    if (!t.name?.trim()) bad.push(`threat ${id} has no name`);
    if (!has(state.regions, t.regionId)) bad.push(`threat ${id} is in unknown region ${t.regionId}`);
    if (!inRange(t.severity, 0, 100)) bad.push(`threat ${id} severity out of range: ${t.severity}`);
    if (t.growthRate < 0) bad.push(`threat ${id} has negative growth rate: ${t.growthRate}`);
    if (t.resolved && t.severity > 0) bad.push(`threat ${id} is resolved but severity is ${t.severity}`);
  }

  // ─── Characters ────────────────────────────────────────────────────────
  for (const [id, c] of Object.entries(state.characters)) {
    if (c.id !== id) bad.push(`character ${id} has mismatched id ${c.id}`);
    if (!c.name?.trim()) bad.push(`character ${id} has no name`);
    if (!c.playerId?.trim()) bad.push(`character ${id} has no player`);
    if (!PRESENCE.includes(c.presence)) bad.push(`character ${id} has unknown presence ${c.presence}`);
    for (const a of ATTRIBUTES) {
      if (!inRange(c.attributes[a], 1, 5)) bad.push(`character ${id} ${a} out of range: ${c.attributes[a]}`);
    }
    for (const [skill, v] of Object.entries(c.skills)) {
      if (!inRange(v, 0, 5)) bad.push(`character ${id} skill ${skill} out of range: ${v}`);
    }
    if (!inRange(c.renown, 0, 100)) bad.push(`character ${id} renown out of range: ${c.renown}`);
    if (c.locationId !== null && !has(state.settlements, c.locationId) && !has(state.regions, c.locationId))
      bad.push(`character ${id} is at unknown location ${c.locationId}`);
    if (c.lastActedTick > state.tick)
      bad.push(`character ${id} last acted in the future: ${c.lastActedTick} > ${state.tick}`);
    for (const [target, v] of Object.entries(c.bonds)) {
      if (!inRange(v, -100, 100)) bad.push(`character ${id} bond to ${target} out of range: ${v}`);
    }
  }

  // ─── Scene ─────────────────────────────────────────────────────────────
  if (!has(state.regions, state.scene.regionId))
    bad.push(`scene is in unknown region ${state.scene.regionId}`);
  if (!has(state.settlements, state.scene.settlementId))
    bad.push(`scene is in unknown settlement ${state.scene.settlementId}`);
  if (!inRange(state.scene.tension, 0, 100)) bad.push(`scene tension out of range: ${state.scene.tension}`);

  return bad;
}

export function assertWorldInvariants(state: WorldState): void {
  const violations = checkWorldInvariants(state);
  if (violations.length > 0) throw new InvariantError(violations);
}

/** Clamp helper used throughout the sim so bounded fields cannot drift out. */
export const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;
