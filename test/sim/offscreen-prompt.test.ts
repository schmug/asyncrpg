/**
 * What an offscreen player is asked.
 *
 * "Quietly steps offscreen" is a promise about being left alone, and the
 * mechanics honoured it while the mail did not: every member got the same
 * "What do you do?" every turn, so a player who had stopped playing kept
 * receiving a weekly request for a turn they were not holding up. That is the
 * social half of the penalty the design forbids, delivered by email.
 *
 * They still get the beat. The story stays theirs to read, and coming back
 * must remain one reply away — only the ask is dropped.
 */

import { describe, expect, it } from "vitest";
import { promptFor } from "../../src/dm/fallback";
import { joinCharacter } from "../../src/sim/character";
import { generateWorld } from "../../src/sim/genesis";
import { seedFrom } from "../../src/sim/prng";
import type { WorldState } from "../../src/sim/types";

function world(): WorldState {
  const { state } = generateWorld("off", seedFrom("off", 0, "genesis"), { historyYears: 20 });
  joinCharacter(state, { playerId: "p0", name: "Kestrel", seed: seedFrom("off", 0, "join") });
  return state;
}

/** Mirrors the branch in CampaignDO#fanOut. */
function promptSent(state: WorldState, presence: string): string {
  const c = Object.values(state.characters)[0]!;
  c.presence = presence as typeof c.presence;
  return c.presence === "offscreen"
    ? `${c.name} is offscreen for now. Nothing needs doing — ` +
        `reply whenever you feel like rejoining, and you will get a recap.`
    : promptFor(c, state);
}

describe("what an offscreen player is asked to do", () => {
  it("asks a present player for their turn", () => {
    const state = world();
    const prompt = promptSent(state, "present");
    expect(prompt).not.toMatch(/offscreen/i);
    expect(prompt.length).toBeGreaterThan(0);
  });

  it("still asks a drifting player — they have not stepped out yet", () => {
    const state = world();
    expect(promptSent(state, "drifting")).not.toMatch(/offscreen/i);
  });

  it("does not ask an offscreen player for a turn", () => {
    const state = world();
    const prompt = promptSent(state, "offscreen");
    expect(prompt).toMatch(/nothing needs doing/i);
    expect(prompt).not.toMatch(/what do you do/i);
  });

  it("still tells an offscreen player how to come back", () => {
    const state = world();
    // The whole point is that re-entry stays one reply away.
    expect(promptSent(state, "offscreen")).toMatch(/reply|rejoin/i);
    expect(promptSent(state, "offscreen")).toMatch(/recap/i);
  });
});
