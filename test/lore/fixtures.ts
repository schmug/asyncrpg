import type { WorldState } from "../../src/sim/types";

/** Minimal hand-built world. Genesis is not needed and would be slower. */
export function world(): WorldState {
  return {
    campaignId: "cmp_1",
    tick: 5,
    year: 812,
    season: "autumn",
    regions: {
      rgn_0: { id: "rgn_0", name: "Thornreach", terrain: "forest", danger: 52,
               controllingFactionId: null, neighborIds: [] },
    },
    settlements: {
      stl_0: { id: "stl_0", name: "Vresford", regionId: "rgn_0", population: 3200,
               prosperity: 60, defense: 30, unrest: 12, controllingFactionId: "fac_0",
               razed: false },
      stl_1: { id: "stl_1", name: "Kelford", regionId: "rgn_0", population: 900,
               prosperity: 20, defense: 10, unrest: 40, controllingFactionId: null,
               razed: true },
    },
    factions: {
      fac_0: { id: "fac_0", name: "The Ashen Coil", kind: "cult", power: 44, treasury: 30,
               seatSettlementId: "stl_0",
               agenda: { kind: "seize_settlement", targetId: "stl_1", progress: 78, urgency: 6 },
               relations: {}, defunct: false },
      fac_1: { id: "fac_1", name: "House Vresk", kind: "noble_house", power: 10, treasury: 5,
               seatSettlementId: null,
               agenda: { kind: "enrich", targetId: null, progress: 0, urgency: 1 },
               relations: {}, defunct: true },
    },
    npcs: {
      npc_0: { id: "npc_0", name: "Sera Coldwater", role: "steward", factionId: "fac_0",
               locationId: "stl_0", alive: true, traits: [], attitudes: {}, renown: 40 },
      npc_1: { id: "npc_1", name: "Bran One-Hand", role: "outrider", factionId: null,
               locationId: null, alive: false, traits: [], attitudes: {}, renown: 20 },
    },
    threats: {
      thr_0: { id: "thr_0", name: "the Grey Blight", kind: "blight", regionId: "rgn_0",
               severity: 40, growthRate: 2, revealed: true, resolved: false },
      thr_1: { id: "thr_1", name: "the Kelth raiders", kind: "raiders", regionId: "rgn_0",
               severity: 10, growthRate: 1, revealed: false, resolved: false },
    },
    characters: {},
    scene: { regionId: "rgn_0", settlementId: "stl_0", situation: "", tension: 30 },
  };
}
