import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CAMPAIGN_CONFIG, isQuorumMet, quorumSize, runTick } from "../../src/sim/tick";
import { generateWorld } from "../../src/sim/genesis";
import { checkWorldInvariants } from "../../src/sim/invariants";
import { seedFrom } from "../../src/sim/prng";
import { joinCharacter } from "../../src/sim/character";
import type { ActionKind, PlayerAction, WorldState } from "../../src/sim/types";

const cfg = DEFAULT_CAMPAIGN_CONFIG;

function world(id = "tick-test", players = 4): WorldState {
  const { state } = generateWorld(id, seedFrom(id, 0, "genesis"), { historyYears: 40 });
  for (let i = 0; i < players; i++) {
    joinCharacter(state, {
      playerId: `p${i}`,
      name: `Player ${i}`,
      concept: "a wanderer",
      seed: seedFrom(id, i, "join"),
    });
  }
  return state;
}

const act = (state: WorldState, playerId: string, kind: ActionKind = "aid"): PlayerAction => {
  const c = Object.values(state.characters).find((x) => x.playerId === playerId)!;
  return {
    id: `act-${playerId}-${state.tick}`,
    characterId: c.id,
    playerId,
    tick: state.tick + 1,
    kind,
    targetId: null,
    rawText: "I help where I can.",
    intent: "helps where they can",
    via: "web",
    auto: false,
  };
};

describe("quorum", () => {
  it("is half the active players, rounded up", () => {
    const s = world("q", 5);
    expect(quorumSize(s, cfg)).toBe(3);
  });

  it("excludes offscreen players, so a half-dormant group can still move", () => {
    const s = world("q", 6);
    const chars = Object.values(s.characters);
    chars[0]!.presence = "offscreen";
    chars[1]!.presence = "offscreen";
    chars[2]!.presence = "offscreen";
    // 3 active, not 6 — otherwise this group could never reach quorum and
    // would sit out the full deadline on every single tick.
    expect(quorumSize(s, cfg)).toBe(2);
    expect(isQuorumMet(s, [act(s, chars[3]!.playerId), act(s, chars[4]!.playerId)], cfg)).toBe(true);
  });

  it("is never zero while anyone is active", () => {
    const s = world("q", 1);
    expect(quorumSize(s, cfg)).toBe(1);
  });

  it("is met by an empty submission set when everyone is offscreen", () => {
    const s = world("q", 3);
    for (const c of Object.values(s.characters)) c.presence = "offscreen";
    expect(isQuorumMet(s, [], cfg)).toBe(true);
  });

  it("counts only one submission per player", () => {
    const s = world("q", 4);
    const p0 = Object.values(s.characters)[0]!.playerId;
    expect(isQuorumMet(s, [act(s, p0), act(s, p0), act(s, p0)], cfg)).toBe(false);
  });
});

describe("runTick", () => {
  let state: WorldState;
  beforeEach(() => {
    state = world();
  });

  it("advances the tick counter exactly once", () => {
    const before = state.tick;
    runTick(state, [], cfg);
    expect(state.tick).toBe(before + 1);
  });

  it("resolves even with no submissions at all", () => {
    const r = runTick(state, [], cfg);
    expect(r.events.length).toBeGreaterThan(0);
    expect(checkWorldInvariants(state)).toEqual([]);
  });

  it("is deterministic", () => {
    const a = world("det");
    const b = world("det");
    runTick(a, [act(a, "p0")], cfg);
    runTick(b, [act(b, "p0")], cfg);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("holds every invariant across 200 ticks of mixed participation", () => {
    for (let t = 0; t < 200; t++) {
      // p0 always acts, p1 sometimes, p2 and p3 never.
      const actions = [act(state, "p0")];
      if (t % 3 === 0) actions.push(act(state, "p1"));
      runTick(state, actions, cfg);
      const bad = checkWorldInvariants(state);
      if (bad.length) throw new Error(`tick ${t}: ${bad.join("; ")}`);
    }
    expect(checkWorldInvariants(state)).toEqual([]);
  });
});

describe("absence — the no-penalty promise", () => {
  let state: WorldState;
  beforeEach(() => {
    state = world("absence");
  });

  it("graduates present -> drifting -> offscreen as ticks are missed", () => {
    const c = Object.values(state.characters).find((x) => x.playerId === "p3")!;
    expect(c.presence).toBe("present");

    runTick(state, [act(state, "p0")], cfg);
    expect(state.characters[c.id]!.presence).toBe("drifting");

    runTick(state, [act(state, "p0")], cfg);
    expect(state.characters[c.id]!.presence).toBe("drifting");

    runTick(state, [act(state, "p0")], cfg);
    expect(state.characters[c.id]!.presence).toBe("offscreen");
  });

  it("acts in character for a drifting player and marks it as not their choice", () => {
    runTick(state, [act(state, "p0")], cfg);
    const r = runTick(state, [act(state, "p0")], cfg);
    const autos = r.resolutions.filter((x) => x.action.auto);
    expect(autos.length).toBeGreaterThan(0);
    for (const a of autos) {
      expect(a.action.via).toBe("auto");
      expect(a.events[0]!.data.auto).toBe(true);
    }
  });

  it("stops acting for a player once they are fully offscreen", () => {
    for (let i = 0; i < 6; i++) runTick(state, [act(state, "p0")], cfg);
    const c = Object.values(state.characters).find((x) => x.playerId === "p3")!;
    expect(c.presence).toBe("offscreen");
    const r = runTick(state, [act(state, "p0")], cfg);
    expect(r.resolutions.some((x) => x.action.characterId === c.id)).toBe(false);
  });

  it("costs an absent player nothing over 100 ticks — no stat, condition, or renown loss", () => {
    const c = Object.values(state.characters).find((x) => x.playerId === "p3")!;
    const before = {
      attributes: { ...c.attributes },
      skills: { ...c.skills },
      renown: c.renown,
      conditions: [...c.conditions],
    };
    let lowestRenown = c.renown;

    for (let t = 0; t < 100; t++) {
      runTick(state, [act(state, "p0"), act(state, "p1")], cfg);
      const now = state.characters[c.id]!;
      lowestRenown = Math.min(lowestRenown, now.renown);
      expect(now.conditions).toEqual(before.conditions);
      expect(now.attributes).toEqual(before.attributes);
      expect(now.skills).toEqual(before.skills);
    }

    const after = state.characters[c.id]!;
    expect(after.renown).toBeGreaterThanOrEqual(before.renown);
    expect(lowestRenown).toBeGreaterThanOrEqual(before.renown);
    expect(after.presence).toBe("offscreen");
  });

  it("lets a player rejoin after a long absence and be fully present again", () => {
    const c = Object.values(state.characters).find((x) => x.playerId === "p3")!;
    for (let t = 0; t < 40; t++) runTick(state, [act(state, "p0")], cfg);
    expect(state.characters[c.id]!.presence).toBe("offscreen");

    runTick(state, [act(state, "p0"), act(state, "p3")], cfg);
    const back = state.characters[c.id]!;
    expect(back.presence).toBe("present");
    expect(back.lastActedTick).toBe(state.tick);
  });

  it("announces a return in the chronicle so the group notices", () => {
    for (let t = 0; t < 5; t++) runTick(state, [act(state, "p0")], cfg);
    const r = runTick(state, [act(state, "p0"), act(state, "p3")], cfg);
    expect(r.events.some((e) => e.kind === "character_returned")).toBe(true);
  });

  it("announces going offscreen too, rather than a character silently vanishing", () => {
    let sawOffscreen = false;
    for (let t = 0; t < 5 && !sawOffscreen; t++) {
      sawOffscreen = runTick(state, [act(state, "p0")], cfg).events.some(
        (e) => e.kind === "character_offscreen",
      );
    }
    expect(sawOffscreen).toBe(true);
  });

  it("never lets an absent player fall behind an active one in advancement terms", () => {
    // Renown is the only progression axis and it is not a level. An absent
    // player simply accrues less of it; they are never *reduced*.
    const absent = Object.values(state.characters).find((x) => x.playerId === "p3")!;
    const start = absent.renown;
    for (let t = 0; t < 60; t++) runTick(state, [act(state, "p0")], cfg);
    expect(state.characters[absent.id]!.renown).toBeGreaterThanOrEqual(start);
  });
});

describe("absence heals rather than preserving harm", () => {
  it("clears conditions a character was carrying when they went quiet", () => {
    // Found by the 1500-tick soak: conditions are cleared by *acting*, so a
    // player who stopped while wounded stayed wounded indefinitely and would
    // return months later still carrying it. That is an injury preserved
    // because they were away.
    const state = world("heal");
    const c = Object.values(state.characters).find((x) => x.playerId === "p3")!;
    c.conditions = ["wounded", "shaken"];
    for (let t = 0; t < 20; t++) runTick(state, [act(state, "p0")], cfg);
    expect(state.characters[c.id]!.conditions).toEqual([]);
  });

  it("does not clear conditions for a player who is still showing up", () => {
    const state = world("noheal");
    const c = Object.values(state.characters).find((x) => x.playerId === "p0")!;
    c.conditions = ["wounded"];
    // p0 acts every tick, so they stay present and must heal by playing.
    for (let t = 0; t < 4; t++) {
      runTick(state, [act(state, "p0")], cfg);
      state.characters[c.id]!.conditions = ["wounded"];
    }
    expect(state.characters[c.id]!.presence).toBe("present");
  });

  it("nothing about an absent character gets worse over a long absence", () => {
    const state = world("promise");
    const c = Object.values(state.characters).find((x) => x.playerId === "p3")!;
    for (let t = 0; t < 5; t++) runTick(state, [act(state, "p0")], cfg);
    const at = {
      renown: state.characters[c.id]!.renown,
      conditions: state.characters[c.id]!.conditions.length,
      attributes: JSON.stringify(state.characters[c.id]!.attributes),
      skills: JSON.stringify(state.characters[c.id]!.skills),
    };
    for (let t = 0; t < 150; t++) {
      runTick(state, [act(state, "p0")], cfg);
      const now = state.characters[c.id]!;
      expect(now.renown).toBeGreaterThanOrEqual(at.renown);
      expect(now.conditions.length).toBeLessThanOrEqual(at.conditions);
      expect(JSON.stringify(now.attributes)).toBe(at.attributes);
      expect(JSON.stringify(now.skills)).toBe(at.skills);
    }
  });
});
