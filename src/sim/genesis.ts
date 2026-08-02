/**
 * World genesis.
 *
 * Builds a world and then *lives in it* for decades before any player arrives,
 * using the exact same drift rules that will govern live play. The party does
 * not begin on page one of the world's story; they begin in the middle of one,
 * surrounded by grudges, ruins, and unfinished business they had no part in.
 */

import { driftWorld, pickAgenda } from "./drift";
import { EventLog } from "./events";
import { clamp } from "./invariants";
import { NameForge } from "./names";
import { Rng } from "./prng";
import { FACTION_KINDS, TERRAINS, THREAT_KINDS } from "./types";
import type {
  CampaignId,
  Faction,
  Npc,
  Region,
  Settlement,
  Threat,
  WorldEvent,
  WorldState,
} from "./types";

export interface GenesisOptions {
  /** Years of pre-play history to simulate. Default 80. */
  historyYears?: number;
}

export interface GenesisResult {
  state: WorldState;
  /** The generated past, all stamped tick 0 with the in-fiction year in `data`. */
  events: WorldEvent[];
}

export function generateWorld(
  campaignId: CampaignId,
  seed: number,
  opts: GenesisOptions = {},
): GenesisResult {
  const historyYears = Math.max(0, Math.floor(opts.historyYears ?? 80));
  const rng = new Rng(seed);
  const forge = new NameForge();
  const log = new EventLog(0);

  // ─── Regions, in a ring so adjacency is symmetric by construction ──────
  const regionCount = rng.int(4, 7);
  const regions: Record<string, Region> = {};
  const regionIds: string[] = [];
  for (let i = 0; i < regionCount; i++) {
    const id = `rgn_${i}`;
    const terrain = rng.pick(TERRAINS);
    regions[id] = {
      id,
      name: forge.region(rng, terrain),
      terrain,
      danger: rng.int(5, 45),
      controllingFactionId: null,
      neighborIds: [],
    };
    regionIds.push(id);
  }
  for (let i = 0; i < regionIds.length; i++) {
    const a = regionIds[i]!;
    const b = regionIds[(i + 1) % regionIds.length]!;
    if (a === b) continue;
    if (!regions[a]!.neighborIds.includes(b)) regions[a]!.neighborIds.push(b);
    if (!regions[b]!.neighborIds.includes(a)) regions[b]!.neighborIds.push(a);
  }
  // A few chords so the map is not a bare circle.
  for (let i = 0; i < Math.floor(regionCount / 2); i++) {
    const a = rng.pick(regionIds);
    const b = rng.pick(regionIds);
    if (a === b) continue;
    if (!regions[a]!.neighborIds.includes(b)) regions[a]!.neighborIds.push(b);
    if (!regions[b]!.neighborIds.includes(a)) regions[b]!.neighborIds.push(a);
  }

  // ─── Settlements ───────────────────────────────────────────────────────
  const settlements: Record<string, Settlement> = {};
  const settlementIds: string[] = [];
  let sIdx = 0;
  for (const regionId of regionIds) {
    const count = rng.int(1, 3);
    for (let i = 0; i < count; i++) {
      const id = `stl_${sIdx++}`;
      settlements[id] = {
        id,
        name: forge.settlement(rng),
        regionId,
        population: rng.int(200, 9000),
        prosperity: rng.int(25, 75),
        defense: rng.int(10, 60),
        unrest: rng.int(0, 30),
        controllingFactionId: null,
        razed: false,
      };
      settlementIds.push(id);
    }
  }

  // ─── Factions ──────────────────────────────────────────────────────────
  const factionCount = rng.int(3, 5);
  const factions: Record<string, Faction> = {};
  const factionIds: string[] = [];
  for (let i = 0; i < factionCount; i++) {
    const id = `fac_${i}`;
    const kind = rng.pick(FACTION_KINDS);
    factions[id] = {
      id,
      name: forge.faction(rng, kind),
      kind,
      power: rng.int(25, 70),
      treasury: rng.int(20, 70),
      seatSettlementId: null,
      agenda: { kind: "court_favor", targetId: null, progress: 0, urgency: rng.int(2, 8) },
      relations: {},
      defunct: false,
    };
    factionIds.push(id);
  }

  // Hand out seats and holdings.
  const shuffledTowns = rng.shuffle(settlementIds);
  shuffledTowns.forEach((townId, i) => {
    const owner = factionIds[i % factionIds.length]!;
    settlements[townId]!.controllingFactionId = owner;
    if (factions[owner]!.seatSettlementId === null) factions[owner]!.seatSettlementId = townId;
  });
  for (const id of factionIds) {
    if (factions[id]!.seatSettlementId === null) {
      const held = settlementIds.find((t) => settlements[t]!.controllingFactionId === id);
      factions[id]!.seatSettlementId = held ?? null;
    }
  }

  // Opening diplomacy, symmetric.
  for (let i = 0; i < factionIds.length; i++) {
    for (let j = i + 1; j < factionIds.length; j++) {
      const a = factionIds[i]!;
      const b = factionIds[j]!;
      const v = rng.int(-70, 45);
      factions[a]!.relations[b] = v;
      factions[b]!.relations[a] = v;
    }
  }
  // Guarantee at least one feud. A world without a standing grievance has no
  // pressure in it, and the first tick reads as a travel brochure.
  if (factionIds.length >= 2) {
    const hasFeud = factionIds.some((id) =>
      Object.values(factions[id]!.relations).some((v) => v <= -30),
    );
    if (!hasFeud) {
      const [a, b] = rng.shuffle(factionIds);
      const v = rng.int(-85, -45);
      factions[a!]!.relations[b!] = v;
      factions[b!]!.relations[a!] = v;
    }
  }

  // Regional control follows whoever holds the most towns there.
  for (const regionId of regionIds) {
    const tally = new Map<string, number>();
    for (const t of settlementIds) {
      const s = settlements[t]!;
      if (s.regionId !== regionId || !s.controllingFactionId) continue;
      tally.set(s.controllingFactionId, (tally.get(s.controllingFactionId) ?? 0) + 1);
    }
    let best: string | null = null;
    let bestN = 0;
    for (const [fid, n] of [...tally.entries()].sort((x, y) => x[0].localeCompare(y[0]))) {
      if (n > bestN) { best = fid; bestN = n; }
    }
    regions[regionId]!.controllingFactionId = best;
  }

  // ─── NPCs ──────────────────────────────────────────────────────────────
  const npcs: Record<string, Npc> = {};
  let nIdx = 0;
  for (const factionId of factionIds) {
    const f = factions[factionId]!;
    const count = rng.int(2, 4);
    for (let i = 0; i < count; i++) {
      const id = `npc_${nIdx++}`;
      npcs[id] = {
        id,
        name: forge.person(rng),
        role: forge.role(rng, f.kind),
        factionId,
        locationId: f.seatSettlementId ?? rng.pick(settlementIds),
        alive: true,
        traits: forge.traits(rng, rng.int(1, 3)),
        attitudes: {},
        renown: rng.int(10, 70),
      };
    }
  }
  // A few unaffiliated people, so `expand_influence` has someone to recruit.
  for (let i = 0; i < rng.int(2, 4); i++) {
    const id = `npc_${nIdx++}`;
    npcs[id] = {
      id,
      name: forge.person(rng),
      role: rng.pick(["hedge-witch", "ferryman", "scribe", "hunter", "innkeeper", "physician"]),
      factionId: null,
      locationId: rng.pick(settlementIds),
      alive: true,
      traits: forge.traits(rng, rng.int(1, 2)),
      attitudes: {},
      renown: rng.int(5, 35),
    };
  }

  // ─── Threats ───────────────────────────────────────────────────────────
  const threats: Record<string, Threat> = {};
  const threatCount = rng.int(2, 4);
  for (let i = 0; i < threatCount; i++) {
    const id = `thr_${i}`;
    const kind = rng.pick(THREAT_KINDS);
    threats[id] = {
      id,
      name: forge.threat(rng, kind),
      kind,
      regionId: rng.pick(regionIds),
      severity: rng.int(0, 25),
      growthRate: 0.4 + rng.next() * 1.4,
      revealed: false,
      resolved: false,
    };
  }

  const openingRegion = rng.pick(regionIds);
  const openingTown =
    settlementIds.filter((t) => settlements[t]!.regionId === openingRegion)[0] ?? null;

  const state: WorldState = {
    campaignId,
    tick: 0,
    year: 1,
    season: "spring",
    regions,
    settlements,
    factions,
    npcs,
    threats,
    characters: {},
    scene: {
      regionId: openingRegion,
      settlementId: openingTown,
      situation: "The road ends here, and the season turns.",
      tension: 20,
    },
  };

  for (const id of factionIds) {
    state.factions[id]!.agenda = pickAgenda(state, state.factions[id]!, rng.fork(`agenda-${id}`));
  }

  log.add("genesis", `The chronicle of ${state.regions[openingRegion]!.name} begins.`, {
    regionId: openingRegion,
    significance: 100,
    data: { year: state.year, historyYears },
  });

  // ─── Live the history ──────────────────────────────────────────────────
  for (let season = 0; season < historyYears * 4; season++) {
    driftWorld(state, rng.fork(`history-${season}`), log, forge, { historical: true });
  }

  // Rebuild the opening scene against the world history actually produced.
  const survivingTowns = Object.values(state.settlements).filter((s) => !s.razed);
  const anchorTown = survivingTowns.length
    ? survivingTowns.reduce((a, b) => (a.prosperity >= b.prosperity ? a : b))
    : null;
  state.scene.regionId = anchorTown?.regionId ?? openingRegion;
  state.scene.settlementId = anchorTown?.id ?? null;
  state.scene.situation = anchorTown
    ? `${anchorTown.name} in the ${state.season} of year ${state.year}. The road ends here.`
    : `The ${state.season} of year ${state.year}, and nowhere left that is safe.`;
  state.scene.tension = clamp(state.scene.tension, 0, 100);

  return { state, events: log.events };
}
