import { describe, expect, it } from "vitest";
import { generateWorld } from "../../src/sim/genesis";
import { assertWorldInvariants } from "../../src/sim/invariants";
import { seedFrom } from "../../src/sim/prng";

const world = (campaignId: string) =>
  generateWorld(campaignId, seedFrom(campaignId, 0, "genesis"), { historyYears: 60 });

describe("generateWorld", () => {
  it("is byte-identical for the same campaign id", () => {
    expect(JSON.stringify(world("camp-a").state)).toBe(JSON.stringify(world("camp-a").state));
  });

  it("produces a different world for a different campaign id", () => {
    expect(JSON.stringify(world("camp-a").state)).not.toBe(JSON.stringify(world("camp-b").state));
  });

  it("builds a world substantial enough to tell stories about", () => {
    const { state } = world("camp-a");
    expect(Object.keys(state.regions).length).toBeGreaterThanOrEqual(4);
    expect(Object.keys(state.settlements).length).toBeGreaterThanOrEqual(5);
    expect(Object.keys(state.factions).length).toBeGreaterThanOrEqual(3);
    expect(Object.keys(state.npcs).length).toBeGreaterThanOrEqual(8);
    expect(Object.keys(state.threats).length).toBeGreaterThanOrEqual(2);
  });

  it("satisfies every world invariant on creation", () => {
    expect(() => assertWorldInvariants(world("camp-a").state)).not.toThrow();
  });

  it("starts at tick 0 with no characters (players join afterwards)", () => {
    const { state } = world("camp-a");
    expect(state.tick).toBe(0);
    expect(Object.keys(state.characters)).toHaveLength(0);
  });

  it("opens on a scene anchored to a real region", () => {
    const { state } = world("camp-a");
    expect(state.regions[state.scene.regionId]).toBeDefined();
    expect(state.scene.situation.length).toBeGreaterThan(0);
    if (state.scene.settlementId) {
      expect(state.settlements[state.scene.settlementId]).toBeDefined();
    }
  });

  it("simulates a past — the world has history before anyone plays", () => {
    const { events } = world("camp-a");
    expect(events.length).toBeGreaterThanOrEqual(20);
    expect(events.every((e) => e.tick === 0)).toBe(true);
    // History must include consequential events, not just a list of foundings.
    const kinds = new Set(events.map((e) => e.kind));
    expect(kinds.size).toBeGreaterThanOrEqual(3);
  });

  it("gives every event a non-empty deterministic summary", () => {
    for (const e of world("camp-a").events) {
      expect(e.summary.trim().length).toBeGreaterThan(0);
      expect(e.significance).toBeGreaterThanOrEqual(0);
      expect(e.significance).toBeLessThanOrEqual(100);
    }
  });

  it("gives factions distinct names and at least one rivalry", () => {
    const { state } = world("camp-a");
    const names = Object.values(state.factions).map((f) => f.name);
    expect(new Set(names).size).toBe(names.length);

    const hasRivalry = Object.values(state.factions).some((f) =>
      Object.values(f.relations).some((v) => v < -20),
    );
    expect(hasRivalry).toBe(true);
  });

  it("scales history length with the historyYears option", () => {
    const short = generateWorld("c", seedFrom("c", 0, "genesis"), { historyYears: 10 });
    const long = generateWorld("c", seedFrom("c", 0, "genesis"), { historyYears: 120 });
    expect(long.events.length).toBeGreaterThan(short.events.length);
    expect(long.state.year).toBeGreaterThan(short.state.year);
  });

  it("holds invariants across many independently generated worlds", () => {
    for (let i = 0; i < 40; i++) {
      const w = generateWorld(`camp-${i}`, seedFrom(`camp-${i}`, 0, "genesis"), {
        historyYears: 80,
      });
      expect(() => assertWorldInvariants(w.state)).not.toThrow();
    }
  });
});
