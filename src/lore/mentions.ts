/**
 * The read-side of the world, for humans.
 *
 * Two jobs: turn an entity into a one-line description a reader can use, and
 * find the entities a piece of prose mentions. Neither touches canon — this
 * module is a pure function of `WorldState` and a string, with no I/O and no
 * inference, so it is testable the same way `src/sim` is.
 *
 * Numbers are banded into prose rather than printed. That follows
 * `renownLabel` in `src/sim/character.ts`, and it is also a disclosure rule:
 * a reader learns that a region is "dangerous", not that its danger is 52.
 */

import type { WorldState } from "../sim/types";

export type LinkableKind = "faction" | "npc" | "settlement" | "region" | "threat";

export interface Mention {
  id: string;
  kind: LinkableKind;
  name: string;
  blurb: string;
}

export function sizeLabel(population: number): string {
  if (population >= 5000) return "a city";
  if (population >= 1500) return "a town";
  if (population >= 400) return "a village";
  return "a hamlet";
}

export function dangerLabel(danger: number): string {
  if (danger >= 70) return "perilous";
  if (danger >= 45) return "dangerous";
  if (danger >= 20) return "uneasy";
  return "quiet";
}

/** Article baked in, so the blurb reads as English in a list. */
const THREAT_PHRASE: Record<string, string> = {
  blight: "a blight",
  raiders: "raiders",
  plague: "a plague",
  famine: "a famine",
  haunting: "a haunting",
  schism: "a schism",
  beast: "a beast",
};

/**
 * Look an entity up by id **without** walking the prototype chain.
 *
 * `WorldState`'s buckets are plain object literals, so `map["__proto__"]`
 * returns `Object.prototype` and `map["constructor"]` returns `Object` — both
 * truthy, both sailing straight past a `if (!row) return ""` guard and into a
 * blurb (`"a town in Object"`) or a crash (`f.kind.replace` on `undefined`).
 * Entity ids reach this module from D1's untyped `entities.kind`/`entity_id`
 * TEXT columns and from a URL path segment, so this is a live input, not a
 * hypothetical.
 *
 * Also the single place a *dangling* reference is turned into "absent": a
 * razed settlement or a purged faction can leave a stale id on a row, and the
 * blurb should lose the clause rather than the page.
 */
function own<T>(map: Record<string, T> | undefined, id: unknown): T | undefined {
  if (!map || typeof id !== "string" || !Object.hasOwn(map, id)) return undefined;
  return map[id];
}

export function blurbFor(kind: LinkableKind, id: string, state: WorldState): string {
  switch (kind) {
    case "faction": {
      const f = own(state.factions, id);
      if (!f) return "";
      if (f.defunct) return "broken and scattered";
      const seat = own(state.settlements, f.seatSettlementId);
      const what = f.kind.replace(/_/g, " ");
      return seat ? `${what} · seated at ${seat.name}` : what;
    }
    case "npc": {
      const n = own(state.npcs, id);
      if (!n) return "";
      if (!n.alive) return `${n.role} · died`;
      const faction = own(state.factions, n.factionId);
      // `locationId` may name either bucket; settlements are simply tried first.
      const place = own(state.settlements, n.locationId) ?? own(state.regions, n.locationId);
      return (
        n.role +
        (faction ? ` of ${faction.name}` : "") +
        (place ? `, at ${place.name}` : "")
      );
    }
    case "settlement": {
      const s = own(state.settlements, id);
      if (!s) return "";
      if (s.razed) return "abandoned";
      const region = own(state.regions, s.regionId);
      const size = sizeLabel(s.population);
      return region ? `${size} in ${region.name}` : size;
    }
    case "region": {
      const r = own(state.regions, id);
      if (!r) return "";
      return `${r.terrain} · ${dangerLabel(r.danger)}`;
    }
    case "threat": {
      const t = own(state.threats, id);
      if (!t) return "";
      const phrase = THREAT_PHRASE[t.kind] ?? "a danger";
      const region = own(state.regions, t.regionId);
      const where = region ? `${phrase} in ${region.name}` : phrase;
      return t.resolved ? `${where} · ended` : where;
    }
    // TypeScript proves the switch exhaustive over `LinkableKind`, but the
    // caller reads `kind` out of D1's untyped TEXT column and casts. A
    // `character` row landing here must return a string, not `undefined` — the
    // consumer renders the result directly and would print the literal text
    // "undefined" or throw inside `escapeHtml`.
    default:
      return "";
  }
}

export function dossierPath(slug: string, entityId: string): string {
  return `/c/${encodeURIComponent(slug)}/who/${encodeURIComponent(entityId)}`;
}

export type Segment =
  | { type: "text"; value: string }
  | { type: "mention"; value: string; mention: Mention };

export interface MentionScan {
  /** Ordered by first appearance in the prose. */
  mentions: Mention[];
  /** The prose, split. Concatenating `value` reproduces the input exactly. */
  segments: Segment[];
}

/**
 * Beyond this the prose becomes hyperlink salad, and link density is the
 * fastest route to a spam folder.
 */
export const MAX_MENTIONS = 8;

/** Below this, a name matches too much ordinary text to be worth linking. */
const MIN_NAME_LENGTH = 4;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface Candidate {
  id: string;
  kind: LinkableKind;
  name: string;
}

function candidates(state: WorldState): Candidate[] {
  const out: Candidate[] = [];
  for (const f of Object.values(state.factions)) out.push({ id: f.id, kind: "faction", name: f.name });
  for (const n of Object.values(state.npcs)) out.push({ id: n.id, kind: "npc", name: n.name });
  for (const s of Object.values(state.settlements)) out.push({ id: s.id, kind: "settlement", name: s.name });
  for (const r of Object.values(state.regions)) out.push({ id: r.id, kind: "region", name: r.name });
  for (const t of Object.values(state.threats)) {
    // Same rule the projection enforces (`src/campaign-do.ts:660`): an
    // unrevealed threat must not leak.
    if (t.revealed || t.resolved) out.push({ id: t.id, kind: "threat", name: t.name });
  }
  // Player characters are deliberately absent.
  return out
    .filter((c) => c.name.length >= MIN_NAME_LENGTH)
    // Longest first, so `House Vresk` claims its span before `Vresk` is tried.
    .sort((a, b) => b.name.length - a.name.length);
}

export function scanProse(prose: string, state: WorldState): MentionScan {
  if (!prose) return { mentions: [], segments: [] };

  const claimed: { start: number; end: number; candidate: Candidate }[] = [];

  for (const candidate of candidates(state)) {
    // Unicode-aware boundaries: \b is ASCII-only, and names carry hyphens and
    // non-ASCII letters. `u` makes \p{L}/\p{N} legal.
    const re = new RegExp(
      `(?<![\\p{L}\\p{N}])${escapeRegExp(candidate.name)}(?![\\p{L}\\p{N}])`,
      "giu",
    );
    for (let m = re.exec(prose); m; m = re.exec(prose)) {
      const start = m.index;
      const end = start + m[0].length;
      if (claimed.some((c) => start < c.end && end > c.start)) continue;
      claimed.push({ start, end, candidate });
      break; // first non-overlapping occurrence only
    }
  }

  // Cap by position, not by iteration order: the first eight names a reader
  // meets, not the eight longest in the world.
  claimed.sort((a, b) => a.start - b.start);
  const kept = claimed.slice(0, MAX_MENTIONS);

  const mentions: Mention[] = kept.map(({ candidate }) => ({
    id: candidate.id,
    kind: candidate.kind,
    name: candidate.name,
    blurb: blurbFor(candidate.kind, candidate.id, state),
  }));

  const segments: Segment[] = [];
  let cursor = 0;
  kept.forEach(({ start, end }, i) => {
    if (start > cursor) segments.push({ type: "text", value: prose.slice(cursor, start) });
    // Use the prose's own casing, not the entity's, so the sentence still reads.
    segments.push({ type: "mention", value: prose.slice(start, end), mention: mentions[i]! });
    cursor = end;
  });
  if (cursor < prose.length) segments.push({ type: "text", value: prose.slice(cursor) });

  return { mentions, segments };
}
