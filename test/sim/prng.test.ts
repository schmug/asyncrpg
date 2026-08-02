import { describe, expect, it } from "vitest";
import { Rng, seedFrom } from "../../src/sim/prng";

describe("seedFrom", () => {
  it("is deterministic for the same inputs", () => {
    expect(seedFrom("camp-1", 7)).toBe(seedFrom("camp-1", 7));
  });

  it("differs across campaigns and across ticks", () => {
    expect(seedFrom("camp-1", 7)).not.toBe(seedFrom("camp-2", 7));
    expect(seedFrom("camp-1", 7)).not.toBe(seedFrom("camp-1", 8));
  });

  it("accepts a purpose to fork independent streams from one tick", () => {
    expect(seedFrom("camp-1", 7, "world")).not.toBe(seedFrom("camp-1", 7, "actions"));
  });
});

describe("Rng", () => {
  it("replays exactly from the same seed", () => {
    const a = new Rng(seedFrom("c", 1));
    const b = new Rng(seedFrom("c", 1));
    const seqA = Array.from({ length: 50 }, () => a.next());
    const seqB = Array.from({ length: 50 }, () => b.next());
    expect(seqA).toEqual(seqB);
  });

  it("diverges from a different seed", () => {
    const a = new Rng(seedFrom("c", 1));
    const b = new Rng(seedFrom("c", 2));
    expect(Array.from({ length: 20 }, () => a.next())).not.toEqual(
      Array.from({ length: 20 }, () => b.next()),
    );
  });

  it("produces values in [0, 1)", () => {
    const r = new Rng(seedFrom("c", 3));
    for (let i = 0; i < 5000; i++) {
      const v = r.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("int(min, max) stays inclusive-in-range and covers both endpoints", () => {
    const r = new Rng(seedFrom("c", 4));
    const seen = new Set<number>();
    for (let i = 0; i < 2000; i++) {
      const v = r.int(1, 6);
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(1);
      expect(v).toBeLessThanOrEqual(6);
      seen.add(v);
    }
    expect(seen).toEqual(new Set([1, 2, 3, 4, 5, 6]));
  });

  it("int handles a degenerate single-value range", () => {
    const r = new Rng(seedFrom("c", 5));
    expect(r.int(3, 3)).toBe(3);
  });

  it("pick returns an element and never undefined for a non-empty list", () => {
    const r = new Rng(seedFrom("c", 6));
    const items = ["a", "b", "c"];
    for (let i = 0; i < 200; i++) {
      expect(items).toContain(r.pick(items));
    }
  });

  it("pick throws on an empty list rather than returning undefined", () => {
    const r = new Rng(seedFrom("c", 7));
    expect(() => r.pick([])).toThrow(/empty/i);
  });

  it("shuffle is a permutation and is deterministic", () => {
    const src = [1, 2, 3, 4, 5, 6, 7, 8];
    const a = new Rng(seedFrom("c", 8)).shuffle(src);
    const b = new Rng(seedFrom("c", 8)).shuffle(src);
    expect(a).toEqual(b);
    expect([...a].sort((x, y) => x - y)).toEqual(src);
    expect(src).toEqual([1, 2, 3, 4, 5, 6, 7, 8]); // does not mutate input
  });

  it("chance is deterministic and respects the bounds", () => {
    const r = new Rng(seedFrom("c", 9));
    expect(r.chance(0)).toBe(false);
    expect(r.chance(1)).toBe(true);
    let hits = 0;
    const r2 = new Rng(seedFrom("c", 10));
    for (let i = 0; i < 10000; i++) if (r2.chance(0.3)) hits++;
    expect(hits / 10000).toBeGreaterThan(0.26);
    expect(hits / 10000).toBeLessThan(0.34);
  });

  it("weighted respects weights and ignores zero-weight entries", () => {
    const r = new Rng(seedFrom("c", 11));
    const counts: Record<string, number> = { a: 0, b: 0, never: 0 };
    for (let i = 0; i < 6000; i++) {
      counts[r.weighted([["a", 3], ["b", 1], ["never", 0]])]! += 1;
    }
    expect(counts.never).toBe(0);
    expect(counts.a).toBeGreaterThan(counts.b! * 2);
  });

  it("fork produces an independent but reproducible substream", () => {
    const parent = () => new Rng(seedFrom("c", 12));
    const f1 = parent().fork("faction").next();
    const f2 = parent().fork("faction").next();
    const f3 = parent().fork("threat").next();
    expect(f1).toBe(f2);
    expect(f1).not.toBe(f3);
  });

  it("advancing a fork does not disturb the parent stream", () => {
    const a = new Rng(seedFrom("c", 13));
    a.next();
    const expectedSecond = a.next();

    const b = new Rng(seedFrom("c", 13));
    b.next();
    const child = b.fork("x");
    for (let i = 0; i < 100; i++) child.next();

    expect(b.next()).toBe(expectedSecond);
  });
});
