/**
 * Bounding world state so an endless campaign stays endless.
 *
 * The sim creates entities and never destroys them: NPCs die but their rows
 * remain, threats resolve but stay listed, factions break apart but linger.
 * Over a few thousand ticks that is unbounded growth in a single Durable
 * Object row — a campaign that eventually cannot be saved.
 *
 * Pruning is deliberately memory-shaped rather than uniform: the *famous*
 * dead are kept and the forgotten are dropped, because a chronicle that
 * remembers everyone equally remembers no one. Removed entities survive in the
 * D1 event log either way — this only bounds live state.
 *
 * Every removal cleans up its own references, so the world still satisfies
 * every invariant afterwards.
 */

import { pickAgenda } from "./drift";
import { Rng, seedFrom } from "./prng";
import type { WorldState } from "./types";

export interface PruneLimits {
  maxNpcs: number;
  maxThreats: number;
  maxFactions: number;
}

export const DEFAULT_PRUNE_LIMITS: PruneLimits = {
  maxNpcs: 60,
  maxThreats: 24,
  maxFactions: 14,
};

/** Anything a character has a bond with is load-bearing to somebody. */
function bondedIds(state: WorldState): Set<string> {
  const ids = new Set<string>();
  for (const c of Object.values(state.characters)) {
    for (const [target, value] of Object.entries(c.bonds)) {
      if (Math.abs(value) >= 10) ids.add(target);
    }
  }
  return ids;
}

export function pruneWorld(state: WorldState, limits: PruneLimits = DEFAULT_PRUNE_LIMITS): void {
  const protectedIds = bondedIds(state);

  // ─── NPCs: keep the living, the famous, and anyone a player cares about ─
  const npcs = Object.values(state.npcs);
  if (npcs.length > limits.maxNpcs) {
    const droppable = npcs
      .filter((n) => !n.alive && !protectedIds.has(n.id))
      .sort((a, b) => a.renown - b.renown);
    let toDrop = npcs.length - limits.maxNpcs;
    for (const npc of droppable) {
      if (toDrop <= 0) break;
      delete state.npcs[npc.id];
      toDrop--;
    }
    // Bonds and attitudes may now reference a missing id. That is intentional
    // and legal: "you still owe someone who is gone" is meaningful, and the
    // invariants only range-check those maps rather than resolving them.
  }

  // ─── Threats: resolved ones first, least severe first ──────────────────
  const threats = Object.values(state.threats);
  if (threats.length > limits.maxThreats) {
    const droppable = threats
      .filter((t) => t.resolved && !protectedIds.has(t.id))
      .sort((a, b) => a.severity - b.severity);
    let toDrop = threats.length - limits.maxThreats;
    for (const threat of droppable) {
      if (toDrop <= 0) break;
      delete state.threats[threat.id];
      clearAgendaTarget(state, threat.id);
      toDrop--;
    }
  }

  // ─── Factions: defunct and weakest first, cleaning every reference ─────
  const factions = Object.values(state.factions);
  if (factions.length > limits.maxFactions) {
    const droppable = factions
      .filter((f) => f.defunct && !protectedIds.has(f.id))
      .sort((a, b) => a.power - b.power);
    let toDrop = factions.length - limits.maxFactions;
    for (const faction of droppable) {
      if (toDrop <= 0) break;
      removeFaction(state, faction.id);
      toDrop--;
    }
  }
}

function clearAgendaTarget(state: WorldState, removedId: string): void {
  for (const faction of Object.values(state.factions)) {
    if (faction.agenda.targetId !== removedId) continue;
    faction.agenda = pickAgenda(
      state,
      faction,
      new Rng(seedFrom(state.campaignId, state.tick, `reagenda-${faction.id}`)),
    );
  }
}

/**
 * Remove a faction and every reference to it.
 *
 * Missing any one of these leaves a dangling id that the invariant checker
 * will reject on the next tick, which would roll the tick back — so the
 * cleanup list here is exhaustive by design, not by convention.
 */
function removeFaction(state: WorldState, id: string): void {
  delete state.factions[id];

  for (const other of Object.values(state.factions)) {
    delete other.relations[id];
    if (other.agenda.targetId === id) {
      other.agenda = pickAgenda(
        state,
        other,
        new Rng(seedFrom(state.campaignId, state.tick, `reagenda-${other.id}`)),
      );
    }
  }
  for (const settlement of Object.values(state.settlements)) {
    if (settlement.controllingFactionId === id) settlement.controllingFactionId = null;
  }
  for (const region of Object.values(state.regions)) {
    if (region.controllingFactionId === id) region.controllingFactionId = null;
  }
  for (const npc of Object.values(state.npcs)) {
    if (npc.factionId === id) npc.factionId = null;
  }
}
