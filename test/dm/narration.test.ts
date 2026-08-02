import { beforeEach, describe, expect, it } from "vitest";
import { templatedBeat } from "../../src/dm/fallback";
import { parseIntentKeywords, resolveTarget } from "../../src/dm/intent";
import { narrateBeat, normalizeProse, UNLIMITED_BUDGET } from "../../src/dm/narrate";
import type { DmConfig } from "../../src/dm/narrate";
import { joinCharacter } from "../../src/sim/character";
import { generateWorld } from "../../src/sim/genesis";
import { seedFrom } from "../../src/sim/prng";
import { DEFAULT_CAMPAIGN_CONFIG, runTick } from "../../src/sim/tick";
import type { PlayerAction, WorldState } from "../../src/sim/types";

const NO_KEY: DmConfig = {
  apiKey: undefined,
  narrateModel: "claude-sonnet-5",
  cheapModel: "claude-haiku-4-5",
};

function world(id = "narr"): WorldState {
  const { state } = generateWorld(id, seedFrom(id, 0, "genesis"), { historyYears: 40 });
  joinCharacter(state, { playerId: "p0", name: "Kestrel", seed: seedFrom(id, 0, "join") });
  joinCharacter(state, { playerId: "p1", name: "Bram", seed: seedFrom(id, 1, "join") });
  return state;
}

const act = (state: WorldState, playerId: string, rawText: string): PlayerAction => {
  const c = Object.values(state.characters).find((x) => x.playerId === playerId)!;
  return {
    id: `a-${playerId}`,
    characterId: c.id,
    playerId,
    tick: state.tick + 1,
    kind: "investigate",
    targetId: null,
    rawText,
    intent: "looks into it",
    via: "email",
    auto: false,
  };
};

describe("templated narration (the no-inference floor)", () => {
  it("produces readable prose with no model involved", () => {
    const state = world();
    const r = runTick(state, [act(state, "p0", "I ask around the market.")], DEFAULT_CAMPAIGN_CONFIG);
    const beat = templatedBeat(state, r.events, r.resolutions);
    expect(beat.prose.length).toBeGreaterThan(40);
    expect(beat.situation.length).toBeGreaterThan(0);
  });

  it("is deterministic for identical input", () => {
    const build = () => {
      const s = world("det");
      const r = runTick(s, [act(s, "p0", "I ask around.")], DEFAULT_CAMPAIGN_CONFIG);
      return templatedBeat(s, r.events, r.resolutions).prose;
    };
    expect(build()).toBe(build());
  });

  it("quotes the player's own words back to them", () => {
    const state = world();
    const words = "I put my shoulder to the door and shove.";
    const r = runTick(state, [act(state, "p0", words)], DEFAULT_CAMPAIGN_CONFIG);
    expect(templatedBeat(state, r.events, r.resolutions).prose).toContain(words);
  });

  it("does not quote words for an auto-action, because the player did not write any", () => {
    const state = world();
    runTick(state, [act(state, "p0", "x")], DEFAULT_CAMPAIGN_CONFIG);
    const r = runTick(state, [act(state, "p0", "y")], DEFAULT_CAMPAIGN_CONFIG);
    const beat = templatedBeat(state, r.events, r.resolutions);
    const autos = r.resolutions.filter((x) => x.action.auto);
    expect(autos.length).toBeGreaterThan(0);
    expect(beat.prose).toContain("acting on their own while away");
  });

  it("says something even on a completely empty tick", () => {
    const state = world();
    const beat = templatedBeat(state, [], []);
    expect(beat.prose).toContain("quiet turn");
  });

  it("names the place and the season so a reader can orient", () => {
    const state = world();
    const beat = templatedBeat(state, [], []);
    expect(beat.prose).toContain(String(state.year));
    expect(beat.prose).toContain(state.season);
  });
});

describe("resolveTarget", () => {
  let state: WorldState;
  beforeEach(() => {
    state = world("tgt");
  });

  it("matches an exact entity name", () => {
    const npc = Object.values(state.npcs).find((n) => n.alive)!;
    expect(resolveTarget(state, npc.name)).toBe(npc.id);
  });

  it("is case-insensitive", () => {
    const npc = Object.values(state.npcs).find((n) => n.alive)!;
    expect(resolveTarget(state, npc.name.toUpperCase())).toBe(npc.id);
  });

  it("matches a partial reference inside a longer phrase", () => {
    const town = Object.values(state.settlements).find((s) => !s.razed)!;
    expect(resolveTarget(state, `the walls of ${town.name} itself`)).toBe(town.id);
  });

  it("returns null for an invented name rather than guessing", () => {
    expect(resolveTarget(state, "the Duke of Nowhere At All")).toBeNull();
  });

  it("returns null for a string too short to be meaningful", () => {
    expect(resolveTarget(state, "a")).toBeNull();
    expect(resolveTarget(state, "")).toBeNull();
  });

  it("never resolves to a razed settlement or a dead NPC", () => {
    const town = Object.values(state.settlements).find((s) => !s.razed)!;
    town.razed = true;
    town.population = 0;
    expect(resolveTarget(state, town.name)).toBeNull();

    const npc = Object.values(state.npcs).find((n) => n.alive)!;
    npc.alive = false;
    expect(resolveTarget(state, npc.name)).toBeNull();
  });

  it("does not reveal an unrevealed threat by name", () => {
    const threat = Object.values(state.threats).find((t) => !t.resolved)!;
    threat.revealed = false;
    expect(resolveTarget(state, threat.name)).toBeNull();
  });
});

describe("keyword intent parsing (works with no API key)", () => {
  let state: WorldState;
  beforeEach(() => {
    state = world("kw");
  });

  it.each([
    ["I attack the raiders head on", "confront"],
    ["I try to talk her round", "parley"],
    ["I search the storeroom carefully", "investigate"],
    ["I scout the pass before dawn", "scout"],
    ["I travel to the coast", "travel"],
    ["I haggle for grain at the market", "trade"],
    ["I help the wounded", "aid"],
    ["I stand watch through the night", "guard"],
    ["I sing for the crowd", "perform"],
    ["I read everything I can find", "study"],
  ])("maps %j to %s", (text, expected) => {
    expect(parseIntentKeywords(state, text).kind).toBe(expected);
  });

  it("finds a named entity mentioned in the text", () => {
    const npc = Object.values(state.npcs).find((n) => n.alive)!;
    const parsed = parseIntentKeywords(state, `I want to talk to ${npc.name} about the debt.`);
    expect(parsed.targetId).toBe(npc.id);
    expect(parsed.kind).toBe("parley");
  });

  it("falls back to a sensible default rather than failing on unparseable text", () => {
    const parsed = parseIntentKeywords(state, "hmmm");
    expect(parsed.kind).toBeTruthy();
    expect(parsed.targetId).toBeNull();
    expect(parsed.source).toBe("keywords");
  });

  it("handles empty and whitespace input without throwing", () => {
    expect(() => parseIntentKeywords(state, "")).not.toThrow();
    expect(() => parseIntentKeywords(state, "   \n  ")).not.toThrow();
  });

  it("truncates a rambling intent to a storable length", () => {
    const parsed = parseIntentKeywords(state, "I search ".repeat(200));
    expect(parsed.intent.length).toBeLessThanOrEqual(120);
  });
});

describe("narrateBeat degradation", () => {
  it("falls back to templated prose when no API key is configured", async () => {
    const state = world();
    const r = runTick(state, [act(state, "p0", "I look around.")], DEFAULT_CAMPAIGN_CONFIG);
    const beat = await narrateBeat(NO_KEY, state, r.events, r.resolutions);
    expect(beat.source).toBe("templated");
    expect(beat.degradedReason).toMatch(/ANTHROPIC_API_KEY/);
    expect(beat.prose.length).toBeGreaterThan(40);
  });

  it("falls back when the campaign budget is exhausted, and does not call the API", async () => {
    const state = world();
    const r = runTick(state, [act(state, "p0", "I look around.")], DEFAULT_CAMPAIGN_CONFIG);
    let recorded = false;
    const beat = await narrateBeat(
      { ...NO_KEY, apiKey: "sk-ant-not-used" },
      state,
      r.events,
      r.resolutions,
      { canSpend: async () => false, record: async () => { recorded = true; } },
    );
    expect(beat.source).toBe("templated");
    expect(beat.degradedReason).toMatch(/budget/);
    expect(recorded).toBe(false);
  });

  it("falls back rather than throwing when the API is unreachable", async () => {
    const state = world();
    const r = runTick(state, [act(state, "p0", "I look around.")], DEFAULT_CAMPAIGN_CONFIG);
    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("network is down");
    }) as typeof fetch;
    try {
      const beat = await narrateBeat(
        { ...NO_KEY, apiKey: "sk-ant-test" },
        state,
        r.events,
        r.resolutions,
        UNLIMITED_BUDGET,
      );
      expect(beat.source).toBe("templated");
      expect(beat.degradedReason).toMatch(/narration failed/);
      expect(beat.prose.length).toBeGreaterThan(40);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("rejects model output that is too short to be a real beat", async () => {
    const state = world();
    const r = runTick(state, [act(state, "p0", "I look around.")], DEFAULT_CAMPAIGN_CONFIG);
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-5",
          stop_reason: "end_turn",
          content: [{ type: "text", text: JSON.stringify({ prose: "ok", situation: "here" }) }],
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as typeof fetch;
    try {
      const beat = await narrateBeat(
        { ...NO_KEY, apiKey: "sk-ant-test" },
        state,
        r.events,
        r.resolutions,
        UNLIMITED_BUDGET,
      );
      expect(beat.source).toBe("templated");
      expect(beat.degradedReason).toMatch(/validation/);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("uses model prose when it is well-formed, and bounds the stored situation line", async () => {
    const state = world();
    const r = runTick(state, [act(state, "p0", "I look around.")], DEFAULT_CAMPAIGN_CONFIG);
    const prose = "The envoy waits at the gate, mud to the knee. ".repeat(6);
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-5",
          stop_reason: "end_turn",
          content: [{ type: "text", text: JSON.stringify({ prose, situation: "x".repeat(900) }) }],
          usage: { input_tokens: 100, output_tokens: 200 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as typeof fetch;
    try {
      const spend: number[] = [];
      const beat = await narrateBeat(
        { ...NO_KEY, apiKey: "sk-ant-test" },
        state,
        r.events,
        r.resolutions,
        { canSpend: async () => true, record: async (_c, i, o) => { spend.push(i, o); } },
      );
      expect(beat.source).toBe("model");
      expect(beat.prose).toContain("mud to the knee");
      expect(beat.situation.length).toBeLessThanOrEqual(200);
      expect(spend).toEqual([100, 200]);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("rejects a beat that was cut off at max_tokens", async () => {
    // Structured outputs keep truncated JSON parseable, so the only reliable
    // signal that generation finished is stop_reason. This case reached
    // production once: a truncated beat parsed fine and was stored as prose.
    const state = world();
    const r = runTick(state, [act(state, "p0", "I look around.")], DEFAULT_CAMPAIGN_CONFIG);
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-5",
          stop_reason: "max_tokens",
          content: [
            {
              type: "text",
              text: JSON.stringify({
                prose: "The envoy waits at the gate, mud to the knee. ".repeat(4),
                situation: "at the gate",
              }),
            },
          ],
          usage: { input_tokens: 100, output_tokens: 6000 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as typeof fetch;
    try {
      const beat = await narrateBeat(
        { ...NO_KEY, apiKey: "sk-ant-test" },
        state,
        r.events,
        r.resolutions,
        UNLIMITED_BUDGET,
      );
      expect(beat.source).toBe("templated");
      expect(beat.degradedReason).toMatch(/max_tokens/);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("rejects visibly mangled prose even when the response claims to be complete", async () => {
    const state = world();
    const r = runTick(state, [act(state, "p0", "I look around.")], DEFAULT_CAMPAIGN_CONFIG);
    const original = globalThis.fetch;
    // Real corruption observed in production: sentences fused with no space
    // after terminal punctuation.
    const mangled =
      "The morning settles cold over Dahold, and there is work enough to keep three pairs " +
      "of hands busy without anyone needing to invent trouble.ot. of it.was about to boil " +
      "over on the narrow lane, and Kestrel plants themself between the two knots of men.";
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-5",
          stop_reason: "end_turn",
          content: [{ type: "text", text: JSON.stringify({ prose: mangled, situation: "here" }) }],
          usage: { input_tokens: 100, output_tokens: 200 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as typeof fetch;
    try {
      const beat = await narrateBeat(
        { ...NO_KEY, apiKey: "sk-ant-test" },
        state,
        r.events,
        r.resolutions,
        UNLIMITED_BUDGET,
      );
      expect(beat.source).toBe("templated");
      expect(beat.degradedReason).toMatch(/validation/);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("strips a stray markdown fence instead of shipping it into canon", async () => {
    const state = world();
    const r = runTick(state, [act(state, "p0", "I look around.")], DEFAULT_CAMPAIGN_CONFIG);
    const original = globalThis.fetch;
    // Real corruption observed on the public chronicle: the model closed a
    // fence it had opened outside the JSON string, and the backticks rode all
    // the way through to the reader.
    const fenced =
      "Kestrel walked into the gap between the two lines and stood there, empty-handed, " +
      "refusing every shout to move. Braemburgh's war paused because a traveller with " +
      "reasons of their own wouldn't step aside.```";
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-5",
          stop_reason: "end_turn",
          content: [{ type: "text", text: JSON.stringify({ prose: fenced, situation: "war```" }) }],
          usage: { input_tokens: 100, output_tokens: 200 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as typeof fetch;
    try {
      const beat = await narrateBeat(
        { ...NO_KEY, apiKey: "sk-ant-test" },
        state,
        r.events,
        r.resolutions,
        UNLIMITED_BUDGET,
      );
      // The writing is sound; only the wrapper was wrong. Falling back to
      // templated prose here would discard a good beat over three backticks.
      expect(beat.source).toBe("model");
      expect(beat.prose).not.toContain("`");
      expect(beat.situation).not.toContain("`");
      expect(beat.prose).toMatch(/wouldn't step aside\.$/);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("rewrites escape sequences the model wrote as literal text", () => {
    // Observed on the public chronicle: the model meant a line break, was
    // already inside a JSON string, and escaped it wrongly.
    expect(normalizeProse("gets repeated at supper tables for a week.//n")).toBe(
      "gets repeated at supper tables for a week.",
    );
    expect(normalizeProse("He turned away.//nThe next morning")).toBe(
      "He turned away.\nThe next morning",
    );
    expect(normalizeProse("He turned away.\\nThe next morning")).toBe(
      "He turned away.\nThe next morning",
    );
    expect(normalizeProse("He turned away.\\\\nThe next morning")).toBe(
      "He turned away.\nThe next morning",
    );
  });

  it("leaves ordinary prose containing slashes and words alone", () => {
    // The guard must not eat real writing. "n" starting a word after a slash
    // is the dangerous case: "and/nor", a path, a fraction.
    const fine =
      "The tithe was 2/3 of the harvest, and/nor did anyone argue. " +
      "He kept a note in his ledger marked north/northeast.";
    expect(normalizeProse(fine)).toBe(fine);
  });

  it("does not mistake ordinary prose for corruption", async () => {
    const state = world();
    const r = runTick(state, [act(state, "p0", "I look around.")], DEFAULT_CAMPAIGN_CONFIG);
    const original = globalThis.fetch;
    // Decimals, ellipses, abbreviations, and em-dashes must all pass.
    const fine =
      "The tithe came to 1.5 measures of grain, no more. Bram counted it twice... then a " +
      "third time. Mrs. Vane watched from the door — she always watched — and said nothing " +
      "at all until the cart had gone. It was not a good morning, but it was an honest one.";
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-5",
          stop_reason: "end_turn",
          content: [{ type: "text", text: JSON.stringify({ prose: fine, situation: "here" }) }],
          usage: { input_tokens: 100, output_tokens: 200 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as typeof fetch;
    try {
      const beat = await narrateBeat(
        { ...NO_KEY, apiKey: "sk-ant-test" },
        state,
        r.events,
        r.resolutions,
        UNLIMITED_BUDGET,
      );
      expect(beat.source).toBe("model");
      expect(beat.prose).toContain("1.5 measures");
    } finally {
      globalThis.fetch = original;
    }
  });

  it("falls back when the model declines the request", async () => {
    const state = world();
    const r = runTick(state, [act(state, "p0", "I look around.")], DEFAULT_CAMPAIGN_CONFIG);
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-5",
          stop_reason: "refusal",
          content: [],
          usage: { input_tokens: 10, output_tokens: 0 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as typeof fetch;
    try {
      const beat = await narrateBeat(
        { ...NO_KEY, apiKey: "sk-ant-test" },
        state,
        r.events,
        r.resolutions,
        UNLIMITED_BUDGET,
      );
      expect(beat.source).toBe("templated");
      expect(beat.degradedReason).toMatch(/declined/);
    } finally {
      globalThis.fetch = original;
    }
  });
});
