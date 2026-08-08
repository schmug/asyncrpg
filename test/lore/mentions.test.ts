import { describe, expect, it } from "vitest";
import { blurbFor, dangerLabel, dossierPath, sizeLabel } from "../../src/lore/mentions";
import { world } from "./fixtures";

describe("banding labels", () => {
  it("bands population into prose with an article", () => {
    expect(sizeLabel(9000)).toBe("a city");
    expect(sizeLabel(5000)).toBe("a city");
    expect(sizeLabel(4999)).toBe("a town");
    expect(sizeLabel(1500)).toBe("a town");
    expect(sizeLabel(1499)).toBe("a village");
    expect(sizeLabel(400)).toBe("a village");
    expect(sizeLabel(399)).toBe("a hamlet");
    expect(sizeLabel(0)).toBe("a hamlet");
  });

  it("bands danger into prose", () => {
    expect(dangerLabel(90)).toBe("perilous");
    expect(dangerLabel(70)).toBe("perilous");
    expect(dangerLabel(69)).toBe("dangerous");
    expect(dangerLabel(45)).toBe("dangerous");
    expect(dangerLabel(44)).toBe("uneasy");
    expect(dangerLabel(20)).toBe("uneasy");
    expect(dangerLabel(19)).toBe("quiet");
    expect(dangerLabel(0)).toBe("quiet");
  });
});

describe("blurbs", () => {
  const w = world();

  it("describes a faction by kind and seat", () => {
    expect(blurbFor("faction", "fac_0", w)).toBe("cult · seated at Vresford");
  });

  it("describes a defunct faction without stats", () => {
    expect(blurbFor("faction", "fac_1", w)).toBe("broken and scattered");
  });

  it("describes a living npc by role, faction, and place", () => {
    expect(blurbFor("npc", "npc_0", w)).toBe("steward of The Ashen Coil, at Vresford");
  });

  it("marks a dead npc", () => {
    expect(blurbFor("npc", "npc_1", w)).toBe("outrider · died");
  });

  it("describes a settlement by size band and region", () => {
    expect(blurbFor("settlement", "stl_0", w)).toBe("a town in Thornreach");
  });

  it("describes a razed settlement as abandoned", () => {
    expect(blurbFor("settlement", "stl_1", w)).toBe("abandoned");
  });

  it("describes a region by terrain and danger band", () => {
    expect(blurbFor("region", "rgn_0", w)).toBe("forest · dangerous");
  });

  it("describes a threat with a grammatical phrase", () => {
    expect(blurbFor("threat", "thr_0", w)).toBe("a blight in Thornreach");
  });

  it("never leaks a raw 0-100 field or an agenda", () => {
    for (const [kind, id] of [
      ["faction", "fac_0"], ["npc", "npc_0"], ["settlement", "stl_0"],
      ["region", "rgn_0"], ["threat", "thr_0"],
    ] as const) {
      const blurb = blurbFor(kind, id, w);
      expect(blurb).not.toMatch(/\d/);
      // Word-boundary anchored so this catches a raw field name leaking as
      // text without false-flagging "dangerous" — the deliberately banded
      // adjective a region blurb is supposed to contain (spec §6). The raw
      // numeric-value check above (`not.toMatch(/\d/)`) is what actually
      // guards against a raw 0-100 field appearing.
      expect(blurb).not.toMatch(/progress|treasury|power|severity|\bdanger\b|agenda|seize/i);
    }
  });

  it("returns an empty string for an unknown id rather than throwing", () => {
    expect(blurbFor("faction", "fac_nope", w)).toBe("");
  });
});

describe("dossierPath", () => {
  it("builds an encoded path", () => {
    expect(dossierPath("demo", "fac_0")).toBe("/c/demo/who/fac_0");
  });

  it("encodes a slug with unusual characters", () => {
    expect(dossierPath("a b", "fac_0")).toBe("/c/a%20b/who/fac_0");
  });
});
