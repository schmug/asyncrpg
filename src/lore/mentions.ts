/**
 * The read-side of the world, for humans.
 *
 * Two jobs: turn an entity into a one-line description a reader can use, and
 * find the entities a piece of prose mentions. Neither touches canon — this
 * module is a pure function of `WorldState` and a string, with no I/O and no
 * inference, so it is testable the same way `src/sim` is.
 *
 * Numbers are banded into prose rather than printed. That follows
 * `renownLabel` in `src/sim/character.ts`, and it is also a disclosure rule:
 * a reader learns that a region is "dangerous", not that its danger is 52.
 */

import type { WorldState } from "../sim/types";

export type LinkableKind = "faction" | "npc" | "settlement" | "region" | "threat";

export interface Mention {
  id: string;
  kind: LinkableKind;
  name: string;
  blurb: string;
}

export function sizeLabel(population: number): string {
  if (population >= 5000) return "a city";
  if (population >= 1500) return "a town";
  if (population >= 400) return "a village";
  return "a hamlet";
}

export function dangerLabel(danger: number): string {
  if (danger >= 70) return "perilous";
  if (danger >= 45) return "dangerous";
  if (danger >= 20) return "uneasy";
  return "quiet";
}

/** Article baked in, so the blurb reads as English in a list. */
const THREAT_PHRASE: Record<string, string> = {
  blight: "a blight",
  raiders: "raiders",
  plague: "a plague",
  famine: "a famine",
  haunting: "a haunting",
  schism: "a schism",
  beast: "a beast",
};

export function blurbFor(kind: LinkableKind, id: string, state: WorldState): string {
  switch (kind) {
    case "faction": {
      const f = state.factions[id];
      if (!f) return "";
      if (f.defunct) return "broken and scattered";
      const seat = f.seatSettlementId ? state.settlements[f.seatSettlementId] : null;
      const what = f.kind.replace(/_/g, " ");
      return seat ? `${what} · seated at ${seat.name}` : what;
    }
    case "npc": {
      const n = state.npcs[id];
      if (!n) return "";
      if (!n.alive) return `${n.role} · died`;
      const faction = n.factionId ? state.factions[n.factionId] : null;
      const place = n.locationId
        ? (state.settlements[n.locationId] ?? state.regions[n.locationId] ?? null)
        : null;
      return (
        n.role +
        (faction ? ` of ${faction.name}` : "") +
        (place ? `, at ${place.name}` : "")
      );
    }
    case "settlement": {
      const s = state.settlements[id];
      if (!s) return "";
      if (s.razed) return "abandoned";
      const region = state.regions[s.regionId];
      const size = sizeLabel(s.population);
      return region ? `${size} in ${region.name}` : size;
    }
    case "region": {
      const r = state.regions[id];
      if (!r) return "";
      return `${r.terrain} · ${dangerLabel(r.danger)}`;
    }
    case "threat": {
      const t = state.threats[id];
      if (!t) return "";
      const phrase = THREAT_PHRASE[t.kind] ?? "a danger";
      const region = state.regions[t.regionId];
      const where = region ? `${phrase} in ${region.name}` : phrase;
      return t.resolved ? `${where} · ended` : where;
    }
  }
}

export function dossierPath(slug: string, entityId: string): string {
  return `/c/${encodeURIComponent(slug)}/who/${encodeURIComponent(entityId)}`;
}
