import { beforeEach, describe, expect, it } from "vitest";
import { joinCharacter } from "../../src/sim/character";
import { isDowntimeKind, resolveDowntime } from "../../src/sim/downtime";
import { EventLog } from "../../src/sim/events";
import { generateWorld } from "../../src/sim/genesis";
import { checkWorldInvariants } from "../../src/sim/invariants";
import { seedFrom } from "../../src/sim/prng";
import { DOWNTIME_KINDS } from "../../src/sim/types";
import type { WorldState } from "../../src/sim/types";

function world(id = "dt"): WorldState {
  const { state } = generateWorld(id, seedFrom(id, 0, "genesis"), { historyYears: 40 });
  joinCharacter(state, { playerId: "p0", name: "Kestrel", seed: seedFrom(id, 0, "join") });
  joinCharacter(state, { playerId: "p1", name: "Bram", seed: seedFrom(id, 1, "join") });
  state.tick = 5;
  return state;
}

const CHR = "chr_p0";

describe("downtime", () => {
  let state: WorldState;
  beforeEach(() => {
    state = world();
  });

  it("recognises every declared kind and rejects anything else", () => {
    for (const k of DOWNTIME_KINDS) expect(isDowntimeKind(k)).toBe(true);
    expect(isDowntimeKind("meditate")).toBe(false);
    expect(isDowntimeKind("")).toBe(false);
  });

  it("resolves every kind without breaking the world", () => {
    for (const kind of DOWNTIME_KINDS) {
      const r = resolveDowntime(
        state,
        { characterId: CHR, kind, detail: "", targetId: null },
        new EventLog(state.tick),
      );
      expect(r.ok).toBe(true);
      expect(r.outcome.length).toBeGreaterThan(0);
      expect(checkWorldInvariants(state)).toEqual([]);
    }
  });

  it("is deterministic", () => {
    const run = () => {
      const s = world("det");
      s.tick = 5;
      const r = resolveDowntime(
        s,
        { characterId: CHR, kind: "network", detail: "", targetId: null },
        new EventLog(5),
      );
      return JSON.stringify({ outcome: r.outcome, state: s });
    };
    expect(run()).toBe(run());
  });

  it("refuses an unknown character rather than throwing", () => {
    const r = resolveDowntime(
      state,
      { characterId: "chr_nope", kind: "craft", detail: "", targetId: null },
      new EventLog(1),
    );
    expect(r.ok).toBe(false);
  });

  describe("the no-advantage constraint", () => {
    it("never changes attributes or skills, for any kind, ever", () => {
      // This is the load-bearing property. If downtime could raise a stat,
      // skipping it would be a penalty and the whole no-penalty promise
      // would be false in slow motion.
      const before = {
        attributes: { ...state.characters[CHR]!.attributes },
        skills: { ...state.characters[CHR]!.skills },
      };
      for (const kind of DOWNTIME_KINDS) {
        for (let i = 0; i < 40; i++) {
          state.tick = i;
          resolveDowntime(
            state,
            { characterId: CHR, kind, detail: `run ${i}`, targetId: null },
            new EventLog(i),
          );
        }
      }
      expect(state.characters[CHR]!.attributes).toEqual(before.attributes);
      expect(state.characters[CHR]!.skills).toEqual(before.skills);
    });

    it("does not touch the other players' characters", () => {
      const other = JSON.stringify(state.characters.chr_p1);
      for (const kind of DOWNTIME_KINDS) {
        resolveDowntime(
          state,
          { characterId: CHR, kind, detail: "", targetId: null },
          new EventLog(1),
        );
      }
      expect(JSON.stringify(state.characters.chr_p1)).toBe(other);
    });

    it("cannot inflict a condition on anyone", () => {
      for (const kind of DOWNTIME_KINDS) {
        for (let i = 0; i < 20; i++) {
          state.tick = i;
          resolveDowntime(state, { characterId: CHR, kind, detail: "", targetId: null }, new EventLog(i));
        }
      }
      expect(state.characters[CHR]!.conditions).toEqual([]);
    });

    it("renown gain is small and asymptotic, so grinding downtime cannot cap it", () => {
      const start = state.characters[CHR]!.renown;
      for (let i = 0; i < 500; i++) {
        state.tick = i;
        resolveDowntime(state, { characterId: CHR, kind: "train", detail: "", targetId: null }, new EventLog(i));
      }
      const after = state.characters[CHR]!.renown;
      expect(after).toBeGreaterThan(start);
      expect(after).toBeLessThan(100);
    });
  });

  describe("effects", () => {
    it("recover clears exactly one condition", () => {
      state.characters[CHR]!.conditions = ["wounded", "shaken"];
      const r = resolveDowntime(
        state,
        { characterId: CHR, kind: "recover", detail: "", targetId: null },
        new EventLog(1),
      );
      expect(state.characters[CHR]!.conditions).toEqual(["shaken"]);
      expect(r.outcome).toMatch(/wounded/);
    });

    it("recover on a healthy character is harmless", () => {
      const r = resolveDowntime(
        state,
        { characterId: CHR, kind: "recover", detail: "", targetId: null },
        new EventLog(1),
      );
      expect(r.ok).toBe(true);
      expect(state.characters[CHR]!.conditions).toEqual([]);
    });

    it("research can reveal a hidden threat", () => {
      for (const t of Object.values(state.threats)) {
        t.revealed = false;
        t.resolved = false;
      }
      resolveDowntime(
        state,
        { characterId: CHR, kind: "research", detail: "", targetId: null },
        new EventLog(1),
      );
      expect(Object.values(state.threats).some((t) => t.revealed)).toBe(true);
    });

    it("network builds a mutual bond with a living NPC", () => {
      const npc = Object.values(state.npcs).find((n) => n.alive)!;
      resolveDowntime(
        state,
        { characterId: CHR, kind: "network", detail: "", targetId: npc.id },
        new EventLog(1),
      );
      expect(npc.attitudes[CHR]).toBeGreaterThan(0);
      expect(state.characters[CHR]!.bonds[npc.id]).toBeGreaterThan(0);
    });

    it("network cannot befriend a dead NPC", () => {
      const npc = Object.values(state.npcs).find((n) => n.alive)!;
      npc.alive = false;
      resolveDowntime(
        state,
        { characterId: CHR, kind: "network", detail: "", targetId: npc.id },
        new EventLog(1),
      );
      expect(npc.attitudes[CHR]).toBeUndefined();
    });

    it("craft uses the player's own words when they supply them", () => {
      const r = resolveDowntime(
        state,
        { characterId: CHR, kind: "craft", detail: "a bone flute", targetId: null },
        new EventLog(1),
      );
      expect(r.outcome).toContain("a bone flute");
    });

    it("records a low-significance event so it does not crowd the chronicle", () => {
      const log = new EventLog(1);
      const r = resolveDowntime(
        state,
        { characterId: CHR, kind: "craft", detail: "", targetId: null },
        log,
      );
      expect(r.events[0]!.kind).toBe("downtime_action");
      expect(r.events[0]!.significance).toBeLessThan(55);
    });

    it("tolerates a target id that does not exist", () => {
      for (const kind of DOWNTIME_KINDS) {
        expect(() =>
          resolveDowntime(
            state,
            { characterId: CHR, kind, detail: "", targetId: "nope_404" },
            new EventLog(1),
          ),
        ).not.toThrow();
      }
      expect(checkWorldInvariants(state)).toEqual([]);
    });
  });
});
