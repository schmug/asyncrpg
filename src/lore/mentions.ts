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

import type {
  Faction,
  Npc,
  Region,
  Settlement,
  Threat,
  ThreatKind,
  WorldState,
} from "../sim/types";

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

/**
 * Article baked in, so the blurb reads as English in a list.
 *
 * Keyed by `ThreatKind`, not `string`: an eighth kind added to
 * `src/sim/types.ts` must be a compile error here, not a silent generic
 * fallback that quietly ships "a danger in Thornreach" to every player.
 */
const THREAT_PHRASE: Record<ThreatKind, string> = {
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

/**
 * A row that passed `Object.hasOwn` is still only *probably* the shape it
 * claims. `entities.data` is TEXT: it parses into some object, and a
 * half-written or pre-migration row can be `{}`. Reading a missing field is
 * how `f.kind.replace` throws and how "undefined" reaches a reader's inbox.
 */
function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * A 0-100 field that is actually present.
 *
 * `sizeLabel` and `dangerLabel` band from the bottom, so an absent number does
 * not fail — it falls through every threshold and comes back "a hamlet" or
 * "quiet". Absence is not zero, and a band asserted from a gap in a row is a
 * fabricated fact about the world.
 */
function present(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** The display name of a referenced row, or "" when the reference is unusable. */
function nameOf(row: { name?: unknown } | undefined): string {
  return typeof row?.name === "string" ? row.name : "";
}

/**
 * One line describing an entity, or `""` when it cannot be described.
 *
 * Two kinds of missing field arrive here, and they are not interchangeable:
 *
 * - Absence that would become a **positive claim** — `alive`, `population`,
 *   `danger`. `!n.alive` reads an absent field as *dead*, and the banding
 *   helpers report "a hamlet" and "quiet" for a number that is not there. Each
 *   is a fact invented out of a gap in a row, published on a page whose only
 *   job is answering "who is this?", with the chronicle beside it saying
 *   otherwise. Guarded below: no field, no blurb.
 * - Absence that merely **drops a clause** — `defunct`, `resolved`,
 *   `seatSettlementId`, `factionId`, `regionId`. Nothing is asserted; the
 *   description is thinner. Left alone, because a guard there would be the
 *   defensive padding this module deliberately avoids.
 *
 * Callers must read `""` as *omit the subtitle*, never as an empty element.
 */
export function blurbFor(kind: LinkableKind, id: string, state: WorldState): string {
  switch (kind) {
    case "faction": {
      const f = own(state.factions, id);
      if (!f) return "";
      if (f.defunct) return "broken and scattered";
      const what = str(f.kind).replace(/_/g, " ");
      if (!what) return "";
      const seat = nameOf(own(state.settlements, f.seatSettlementId));
      return seat ? `${what} · seated at ${seat}` : what;
    }
    case "npc": {
      const n = own(state.npcs, id);
      if (!n) return "";
      // Absent is not false. Death is the most consequential thing this page
      // can say about a person, so it is claimed only from an actual `false`.
      if (typeof n.alive !== "boolean") return "";
      const role = str(n.role);
      if (!n.alive) return role ? `${role} · died` : "died";
      const faction = nameOf(own(state.factions, n.factionId));
      // `locationId` may name either bucket; settlements are simply tried first.
      const place = nameOf(own(state.settlements, n.locationId) ?? own(state.regions, n.locationId));
      return (
        role +
        (faction ? ` of ${faction}` : "") +
        (place ? `, at ${place}` : "")
      ).trim();
    }
    case "settlement": {
      const s = own(state.settlements, id);
      if (!s) return "";
      if (s.razed) return "abandoned";
      if (!present(s.population)) return "";
      const region = nameOf(own(state.regions, s.regionId));
      const size = sizeLabel(s.population);
      return region ? `${size} in ${region}` : size;
    }
    case "region": {
      const r = own(state.regions, id);
      if (!r) return "";
      const terrain = str(r.terrain);
      if (!terrain || !present(r.danger)) return "";
      return `${terrain} · ${dangerLabel(r.danger)}`;
    }
    case "threat": {
      const t = own(state.threats, id);
      if (!t) return "";
      // No `?? "a danger"`: the map is exhaustive over `ThreatKind` by type, so
      // a miss here means a malformed row rather than a new kind, and a row we
      // cannot describe gets no blurb rather than a plausible-sounding one.
      const phrase = THREAT_PHRASE[t.kind];
      if (!phrase) return "";
      const region = nameOf(own(state.regions, t.regionId));
      const where = region ? `${phrase} in ${region}` : phrase;
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

/**
 * `Object.values` throws on `null`/`undefined`, and a `WorldState` rebuilt from
 * projected rows can be missing a bucket outright — the dossier renderer builds
 * one by hand. Rows that are not objects are dropped rather than dereferenced.
 */
function rows<T>(bucket: unknown): T[] {
  if (!bucket || typeof bucket !== "object") return [];
  return Object.values(bucket as Record<string, unknown>).filter(
    (row): row is T => !!row && typeof row === "object",
  );
}

function candidates(state: WorldState): Candidate[] {
  const s = (state ?? {}) as Partial<WorldState>;
  const out: Candidate[] = [];
  for (const f of rows<Faction>(s.factions)) out.push({ id: f.id, kind: "faction", name: f.name });
  for (const n of rows<Npc>(s.npcs)) out.push({ id: n.id, kind: "npc", name: n.name });
  for (const c of rows<Settlement>(s.settlements)) out.push({ id: c.id, kind: "settlement", name: c.name });
  for (const r of rows<Region>(s.regions)) out.push({ id: r.id, kind: "region", name: r.name });
  for (const t of rows<Threat>(s.threats)) {
    // Same rule the projection enforces (`src/campaign-do.ts:660`): an
    // unrevealed threat must not leak.
    if (t.revealed || t.resolved) out.push({ id: t.id, kind: "threat", name: t.name });
  }
  // Player characters are deliberately absent.
  return out
    .filter(
      (c) =>
        // An id is what becomes a dossier URL; without one the mention would
        // render a permanent dead link into an email that cannot be recalled.
        typeof c.id === "string" &&
        c.id.length > 0 &&
        typeof c.name === "string" &&
        c.name.length >= MIN_NAME_LENGTH,
    )
    // Longest first, so `House Vresk` claims its span before `Vresk` is tried.
    .sort((a, b) => b.name.length - a.name.length);
}

/**
 * Totality is a hard promise, not defensive padding.
 *
 * `#fanOut` is invoked as `.catch((err) => console.error("fan-out failed",
 * err))` (`src/campaign-do.ts:519-521`), so a throw raised here is swallowed
 * and the entire tick's beat email is lost — for every player in the campaign,
 * on the product's primary channel. Spec §10 promises a detection failure
 * degrades to output byte-identical to today's, which means the prose has to
 * survive even when detection gives up completely.
 */
export function scanProse(prose: string, state: WorldState): MentionScan {
  if (typeof prose !== "string" || !prose) return { mentions: [], segments: [] };
  try {
    return scan(prose, state);
  } catch {
    // One text segment, not an empty list: the caller rebuilds the body by
    // concatenating segments, so `[]` would drop the beat's prose entirely.
    return { mentions: [], segments: [{ type: "text", value: prose }] };
  }
}

function scan(prose: string, state: WorldState): MentionScan {
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
