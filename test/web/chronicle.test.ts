/**
 * Chapters.
 *
 * A chronicle a group still reads months later has to be navigable. An
 * undifferentiated stack of numbered turns is a log; chapters named for what
 * happened in them are how you find "the one where the Concern went to war"
 * without reading forward from the beginning.
 */

import { describe, expect, it } from "vitest";
import { chapters } from "../../src/web/chronicle";

const beat = (tick: number) => ({
  tick,
  prose: `Turn ${tick} happened.`,
  source: "model",
  created_at: "2026-08-02T00:00:00Z",
});

const event = (tick: number, summary: string, significance: number, kind = "faction_war") => ({
  tick,
  kind,
  summary,
  significance,
});

describe("chapters", () => {
  it("returns nothing for a campaign that has not started", () => {
    expect(chapters([], [])).toEqual([]);
  });

  it("keeps every turn, in the order it was given", () => {
    const beats = [7, 6, 5, 4, 3, 2, 1].map(beat);
    const out = chapters(beats, [event(6, "The Black Riders came to open war", 90)]);
    expect(out.flatMap((c) => c.beats).map((b) => b.tick)).toEqual([7, 6, 5, 4, 3, 2, 1]);
  });

  it("starts a chapter at a consequential turn and names it for that event", () => {
    const out = chapters(
      [7, 6, 5].map(beat),
      [event(6, "The Black Riders and The Hinslaeg Concern came to open war", 90)],
    );
    expect(out).toHaveLength(2);
    expect(out[0]!.title).toBe("The Black Riders and The Hinslaeg Concern came to open war");
    expect(out[0]!.beats.map((b) => b.tick)).toEqual([7, 6]);
  });

  it("files the quiet turns before the first crisis under their own heading", () => {
    const out = chapters([7, 6, 5].map(beat), [event(6, "War broke out", 90)]);
    expect(out.at(-1)!.title).toBe("Before all that");
    expect(out.at(-1)!.beats.map((b) => b.tick)).toEqual([5]);
  });

  it("gives a campaign with no turning points one honest chapter", () => {
    const out = chapters([3, 2, 1].map(beat), []);
    expect(out).toHaveLength(1);
    expect(out[0]!.title).toBe("The story so far");
    expect(out[0]!.span).toBe("Turns 1–3");
  });

  it("ignores events that are merely notable", () => {
    // 55 clears the timeline's bar but is not a chapter break; otherwise every
    // turn becomes its own chapter and the grouping means nothing.
    const out = chapters([3, 2, 1].map(beat), [event(2, "Someone haggled well", 60)]);
    expect(out).toHaveLength(1);
  });

  it("labels a single-turn chapter without a range", () => {
    const out = chapters([2, 1].map(beat), [event(2, "The city fell", 95)]);
    expect(out[0]!.span).toBe("Turn 2");
  });

  it("strips the outcome clause the sim appends to action summaries", () => {
    const out = chapters(
      [2, 1].map(beat),
      [event(2, "Kestrel Vane stands between them and refuses to move, and it works", 88)],
    );
    expect(out[0]!.title).toBe("Kestrel Vane stands between them and refuses to move");
  });

  it("truncates a title too long to read as a heading", () => {
    const out = chapters([2, 1].map(beat), [event(2, "x".repeat(200), 90)]);
    expect(out[0]!.title.length).toBeLessThanOrEqual(72);
    expect(out[0]!.title.endsWith("…")).toBe(true);
  });

  it("takes the first of several big events in one turn rather than dithering", () => {
    const out = chapters(
      [2, 1].map(beat),
      [event(2, "The city fell", 95), event(2, "A rival rose", 90)],
    );
    expect(out[0]!.title).toBe("The city fell");
  });

  it("names a chapter for what the world did, not for a well-rolled errand", () => {
    // A routine action that rolls well clears the significance bar easily, and
    // "Bram checked the stores" is a good turn, not an era.
    const out = chapters(
      [2, 1].map(beat),
      [
        event(2, "Bram Ashfoot checks the stores and counts what remains", 90, "player_action"),
        event(2, "Traernstead threw out its rulers", 80, "settlement_uprising"),
      ],
    );
    expect(out[0]!.title).toBe("Traernstead threw out its rulers");
  });

  it("breaks on a world event the significance score alone would overlook", () => {
    // A settlement changing hands scores in the seventies; it is exactly the
    // kind of turn a chapter should start at.
    const out = chapters([3, 2, 1].map(beat), [event(2, "Suspaes threw out its rulers", 72)]);
    expect(out).toHaveLength(2);
    expect(out[0]!.title).toBe("Suspaes threw out its rulers");
  });

  it("does not break on a merely well-rolled action", () => {
    // Roughly one critical success happens per turn. If each began a chapter,
    // every turn would be its own chapter and the grouping would say nothing.
    const out = chapters(
      [3, 2, 1].map(beat),
      [event(2, "Bram Ashfoot checks the stores", 80, "player_action")],
    );
    expect(out).toHaveLength(1);
  });

  it("still uses a player action when that is all the turn had", () => {
    const out = chapters(
      [2, 1].map(beat),
      [event(2, "Kestrel Vane stands between them and refuses to move", 88, "player_action")],
    );
    expect(out[0]!.title).toBe("Kestrel Vane stands between them and refuses to move");
  });
});
