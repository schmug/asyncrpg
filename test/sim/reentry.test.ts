/**
 * Coming back after a long absence.
 *
 * The promise is that being busy costs nothing. Holding a character's numbers
 * still while everyone else's rise satisfies the letter of that and not the
 * spirit: they return behind. `restoreStanding` is the catch-up that closes
 * the gap — and, just as importantly, does not overshoot it into a reward for
 * staying away.
 */

import { describe, expect, it } from "vitest";
import { restoreStanding } from "../../src/sim/character";
import type { Character, WorldState } from "../../src/sim/types";

function character(id: string, renown: number, bonds: Record<string, number> = {}): Character {
  return {
    id,
    playerId: `p_${id}`,
    name: id,
    concept: "a traveller",
    attributes: { might: 2, wits: 2, presence: 2, resolve: 2 },
    skills: {},
    tendencies: [],
    bonds,
    renown,
    conditions: [],
    locationId: "set_1",
    presence: "present",
    lastActedTick: 0,
  } as unknown as Character;
}

function world(...cast: Character[]): WorldState {
  return {
    characters: Object.fromEntries(cast.map((c) => [c.id, c])),
  } as unknown as WorldState;
}

describe("restoreStanding", () => {
  it("lifts a returning character to the middle of the party", () => {
    const back = character("back", 5);
    const state = world(back, character("a", 20), character("b", 30), character("c", 40));
    restoreStanding(state, back);
    expect(back.renown).toBe(30);
  });

  it("never lifts them past the people who actually showed up", () => {
    const back = character("back", 5);
    const state = world(back, character("a", 10), character("b", 12), character("c", 90));
    restoreStanding(state, back);
    expect(back.renown).toBe(12);
    expect(back.renown).toBeLessThan(90);
  });

  it("leaves a character who is already ahead exactly where they are", () => {
    // Absence is not a reason to take anything away either.
    const back = character("back", 50);
    const state = world(back, character("a", 10), character("b", 12));
    restoreStanding(state, back);
    expect(back.renown).toBe(50);
  });

  it("brings bonds up to the party's regard, per person", () => {
    const back = character("back", 5, { npc_1: 0 });
    const state = world(
      back,
      character("a", 10, { npc_1: 40 }),
      character("b", 10, { npc_1: 60 }),
    );
    restoreStanding(state, back);
    expect(back.bonds.npc_1).toBe(50);
  });

  it("does not weaken a bond the returning character already held more strongly", () => {
    const back = character("back", 5, { npc_1: 80 });
    const state = world(back, character("a", 10, { npc_1: 10 }), character("b", 10, { npc_1: 20 }));
    restoreStanding(state, back);
    expect(back.bonds.npc_1).toBe(80);
  });

  it("does nothing at all in a party of one", () => {
    const back = character("back", 5, { npc_1: 3 });
    const state = world(back);
    restoreStanding(state, back);
    expect(back.renown).toBe(5);
    expect(back.bonds.npc_1).toBe(3);
  });

  it("is idempotent — returning twice is not returning twice as hard", () => {
    const back = character("back", 5);
    const state = world(back, character("a", 20), character("b", 40));
    restoreStanding(state, back);
    const once = back.renown;
    restoreStanding(state, back);
    expect(back.renown).toBe(once);
  });
});
