# Email Keyword Links — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Entity names in a beat email link to a per-entity dossier page, with a plain-text who's-who recap, so a player who forgets what a faction is can find out without leaving their inbox.

**Architecture:** A pure module `src/lore/mentions.ts` scans beat prose against `WorldState` and returns both the entities mentioned and the prose pre-split into text/mention segments. `#fanOut` runs it once per tick; `sendBeat` renders segments into linked HTML and a who's-who block in both MIME parts. A new route `/c/<slug>/who/<entity_id>` renders a dossier built only from already-published chronicle events. A prerequisite migration projects `WorldEvent.targetIds` into D1, which the dossier's event query needs and which is a pre-existing bug (issue #7).

**Tech Stack:** TypeScript, Cloudflare Workers, D1 (SQLite), Durable Objects, Vitest via `@cloudflare/vitest-pool-workers`.

**Spec:** `docs/specs/2026-08-08-email-keyword-links-design.md`

## Global Constraints

- Workers runtime only — no Node-specific APIs.
- No new dependencies.
- **`src/sim/` must not be modified.** `npm run sim:soak` output must be unchanged.
- **Escaping is never weakened.** Prose is tokenized on raw text and each segment escaped individually, so a match can never straddle an escape sequence.
- **When `scanProse` finds nothing, email output must be byte-identical to today's.** This is an asserted test, not an aspiration.
- Projection writes are deliberately swallowed so a D1 blip cannot wedge a tick (`#recordProjectionFailure`). Preserve that.
- No raw `power`, `treasury`, `prosperity`, `unrest`, `defense`, `severity`, or `danger` value, no agenda kind/target/progress, and no relation or attitude value may reach a blurb or the dossier page.
- Commit messages use conventional prefixes (`feat:`, `fix:`, `test:`, `docs:`).
- Do not merge. Open a PR and stop.

## File Structure

| File | Responsibility |
|---|---|
| `migrations/0005_event_targets.sql` | **new** — adds `events.target_ids` |
| `src/campaign-do.ts` | **modify** — bind `target_ids` in `#writeEvents`; call `scanProse` in `#fanOut` |
| `src/lore/mentions.ts` | **new** — pure: banding labels, blurbs, prose scanning. No I/O. |
| `src/web/dossier.ts` | **new** — renders one entity page |
| `src/index.ts` | **modify** — one route |
| `src/email/outbound.ts` | **modify** — `BeatMail.scan`, linkified HTML, who's-who in both parts |
| `test/lore/mentions.test.ts` | **new** — pure unit tests |
| `test/email/outbound.test.ts` | **new** — rendering + byte-identity |
| `test/web/dossier.test.ts` | **new** — route, access, disclosure |
| `test/integration/projection.test.ts` | **new** — `target_ids` write + reproject backfill |

`src/lore/` rather than `src/sim/` because this is the read-side for humans and never touches canon; not `src/web/` because email consumes it too.

**Task order matters:** Task 1 unblocks Task 4's event query. Task 2 unblocks Task 3. Tasks 2–4 must land before Task 5, so that no email ever links to a page that does not exist.

---

### Task 1: Project `WorldEvent.targetIds` into D1

Closes https://github.com/schmug/asyncrpg/issues/7.

**Files:**
- Create: `migrations/0005_event_targets.sql`
- Modify: `src/campaign-do.ts:620-651` (`#writeEvents`)
- Test: `test/integration/projection.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: the `events.target_ids` column, a JSON array string (e.g. `["stl_3","npc_7"]`), queryable with `EXISTS (SELECT 1 FROM json_each(events.target_ids) WHERE value = ?)`. Task 4 relies on it.

**Background the implementer needs:** `WorldEvent` has a top-level `targetIds: EntityId[]` field (`src/sim/types.ts:227`) that is *not* part of `data`. `#writeEvents` serializes `data` but never `targetIds`. For many event kinds `actorId` is `null` and `targetIds` is the only link to the entity — a prosperity shift is `{ targetIds: [s.id], regionId: s.regionId }` with no actor (`src/sim/drift.ts:645`).

- [ ] **Step 1: Write the failing test**

Create `test/integration/projection.test.ts`:

```ts
/**
 * Event projection carries `targetIds`.
 *
 * For many event kinds `actorId` is null and `targetIds` is the only link back
 * to the entity, so without this the read model can answer "what did X do" but
 * not "what happened to X". See issue #7.
 */

import { env as runtimeEnv } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../src/env";

const env = runtimeEnv as unknown as Env;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (campaign_id TEXT NOT NULL, event_id TEXT NOT NULL,
  tick INTEGER NOT NULL, kind TEXT NOT NULL, actor_id TEXT, region_id TEXT,
  summary TEXT NOT NULL, significance INTEGER NOT NULL, data TEXT NOT NULL DEFAULT '{}',
  target_ids TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL,
  PRIMARY KEY (campaign_id, event_id));
`;

const CAMPAIGN = "cmp_projection";

describe("event projection", () => {
  beforeAll(async () => {
    for (const stmt of SCHEMA.split(";").map((s) => s.trim()).filter(Boolean)) {
      await env.DB.prepare(stmt).run();
    }
  });

  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM events WHERE campaign_id = ?").bind(CAMPAIGN).run();
  });

  it("finds an event by an id that appears only in targetIds", async () => {
    // The shape that fails today: no actor, entity named only as a target.
    await env.DB.prepare(
      `INSERT INTO events (campaign_id, event_id, tick, kind, actor_id, region_id,
                           summary, significance, data, target_ids, created_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?, ?, '{}', ?, ?)`,
    )
      .bind(
        CAMPAIGN, "evt_1", 4, "prosperity_shift", "rgn_0",
        "Trade thinned at Vresford.", 34, JSON.stringify(["stl_3"]),
        new Date().toISOString(),
      )
      .run();

    const found = await env.DB.prepare(
      `SELECT event_id FROM events
       WHERE campaign_id = ?1
         AND EXISTS (SELECT 1 FROM json_each(events.target_ids) WHERE value = ?2)`,
    )
      .bind(CAMPAIGN, "stl_3")
      .all<{ event_id: string }>();

    expect(found.results?.map((r) => r.event_id)).toEqual(["evt_1"]);
  });

  it("defaults to an empty array for rows written before the migration", async () => {
    await env.DB.prepare(
      `INSERT INTO events (campaign_id, event_id, tick, kind, actor_id, region_id,
                           summary, significance, data, created_at)
       VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, '{}', ?)`,
    )
      .bind(CAMPAIGN, "evt_old", 1, "unrest_shift", "Old row.", 20, new Date().toISOString())
      .run();

    const row = await env.DB.prepare(
      "SELECT target_ids FROM events WHERE campaign_id = ? AND event_id = ?",
    )
      .bind(CAMPAIGN, "evt_old")
      .first<{ target_ids: string }>();

    expect(row?.target_ids).toBe("[]");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/integration/projection.test.ts`
Expected: FAIL. The `CREATE TABLE` in this test declares `target_ids`, but the real `migrations/0001_init.sql` events table does not — confirm the failure is a genuine schema/query error and not a typo before continuing.

- [ ] **Step 3: Write the migration**

Create `migrations/0005_event_targets.sql`:

```sql
-- `WorldEvent.targetIds` carries *who an event happened to*. For many event
-- kinds it is the only link to the entity, because `actor_id` is null — a
-- prosperity shift names the settlement as a target and has no actor at all.
--
-- It was populated throughout the sim from the beginning but never projected,
-- so the read model could answer "what did X do" and not "what happened to X".
-- Issue #7.
ALTER TABLE events ADD COLUMN target_ids TEXT NOT NULL DEFAULT '[]';
```

No new index. Lookup is `campaign_id` (covered by the primary key) narrowed further
by `ORDER BY tick`, which `idx_events_tick` (`migrations/0001_init.sql:55`) already
serves; the `json_each` predicate is a residual filter over an already-small set.
An index on a JSON blob column would not be usable by that predicate anyway.

- [ ] **Step 4: Bind the column in `#writeEvents`**

In `src/campaign-do.ts`, in `#writeEvents`, add `target_ids` to the column list, add one `?` to the `VALUES` list, and add the bind between `significance` and `data`:

```ts
    const stmt = this.env.DB.prepare(
      `INSERT INTO events (campaign_id, event_id, tick, kind, actor_id, region_id, summary, significance, target_ids, data, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(campaign_id, event_id) DO NOTHING`,
    );
```

and in the `stmt.bind(...)` call, between `e.significance` and `JSON.stringify(e.data)`:

```ts
              e.significance,
              // Top-level on WorldEvent, not part of `data` — easy to miss, and
              // missing it is exactly what issue #7 was.
              JSON.stringify(e.targetIds ?? []),
              JSON.stringify(e.data),
```

Leave the surrounding `try`/`catch` and `#recordProjectionFailure` untouched.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/integration/projection.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 6: Verify the backfill path already works**

`reproject()` (`src/campaign-do.ts:802`) replays the DO's retained `history` — full `WorldEvent` objects, `targetIds` included — through the same `#writeEvents`. No code change needed. Add a test to `test/integration/projection.test.ts` that proves the replay writes the column:

```ts
  it("replaying an event through the same insert populates target_ids", async () => {
    // Stands in for reproject(): the DO replays retained WorldEvent objects
    // through #writeEvents, so anything that path writes, the repair writes.
    const replay = { targetIds: ["fac_2", "stl_1"], data: {} };
    await env.DB.prepare(
      `INSERT INTO events (campaign_id, event_id, tick, kind, actor_id, region_id,
                           summary, significance, target_ids, data, created_at)
       VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?)
       ON CONFLICT(campaign_id, event_id) DO NOTHING`,
    )
      .bind(
        CAMPAIGN, "evt_replay", 7, "war_declared", "War was declared.", 80,
        JSON.stringify(replay.targetIds), JSON.stringify(replay.data),
        new Date().toISOString(),
      )
      .run();

    const found = await env.DB.prepare(
      `SELECT event_id FROM events
       WHERE campaign_id = ?1
         AND EXISTS (SELECT 1 FROM json_each(events.target_ids) WHERE value = ?2)`,
    )
      .bind(CAMPAIGN, "fac_2")
      .all<{ event_id: string }>();

    expect(found.results).toHaveLength(1);
  });
```

Run: `npx vitest run test/integration/projection.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 7: Run the full suite and the sim soak**

Run: `npm test && npm run typecheck && npm run sim:soak -- --ticks 200`
Expected: all pass; soak unchanged (`src/sim/` was not touched).

- [ ] **Step 8: Commit**

```bash
git add migrations/0005_event_targets.sql src/campaign-do.ts test/integration/projection.test.ts
git commit -m "fix: project WorldEvent.targetIds into D1

targetIds is set at 22 sites across the sim but was never bound in
#writeEvents, so the read model could answer 'what did X do' and not
'what happened to X'. For many event kinds actor_id is null and
targetIds is the only link to the entity.

Additive migration with a '[]' default; reproject() backfills existing
campaigns through the same insert path.

Closes #7"
```

---

### Task 2: Banding labels and blurbs

**Files:**
- Create: `src/lore/mentions.ts`
- Test: `test/lore/mentions.test.ts`

**Interfaces:**
- Consumes: `WorldState` and entity types from `src/sim/types.ts`.
- Produces:
  ```ts
  export type LinkableKind = "faction" | "npc" | "settlement" | "region" | "threat";
  export interface Mention { id: string; kind: LinkableKind; name: string; blurb: string }
  export function sizeLabel(population: number): string
  export function dangerLabel(danger: number): string
  export function blurbFor(kind: LinkableKind, id: string, state: WorldState): string
  export function dossierPath(slug: string, entityId: string): string
  ```
  Tasks 3, 4, and 5 all consume these.

**Why banding:** `renownLabel` (`src/sim/character.ts:105`) is the established pattern for showing a 0–100 field to a reader as prose. Raw numbers are also a disclosure leak — see Global Constraints.

- [ ] **Step 1: Write the failing test**

Create `test/lore/mentions.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { blurbFor, dangerLabel, dossierPath, sizeLabel } from "../../src/lore/mentions";
import type { WorldState } from "../../src/sim/types";

/** Minimal hand-built world. Genesis is not needed and would be slower. */
export function world(): WorldState {
  return {
    campaignId: "cmp_1",
    tick: 5,
    year: 812,
    season: "autumn",
    regions: {
      rgn_0: { id: "rgn_0", name: "Thornreach", terrain: "forest", danger: 52,
               controllingFactionId: null, neighborIds: [] },
    },
    settlements: {
      stl_0: { id: "stl_0", name: "Vresford", regionId: "rgn_0", population: 3200,
               prosperity: 60, defense: 30, unrest: 12, controllingFactionId: "fac_0",
               razed: false },
      stl_1: { id: "stl_1", name: "Kelford", regionId: "rgn_0", population: 900,
               prosperity: 20, defense: 10, unrest: 40, controllingFactionId: null,
               razed: true },
    },
    factions: {
      fac_0: { id: "fac_0", name: "The Ashen Coil", kind: "cult", power: 44, treasury: 30,
               seatSettlementId: "stl_0",
               agenda: { kind: "seize_settlement", targetId: "stl_1", progress: 78, urgency: 6 },
               relations: {}, defunct: false },
      fac_1: { id: "fac_1", name: "House Vresk", kind: "noble_house", power: 10, treasury: 5,
               seatSettlementId: null,
               agenda: { kind: "enrich", targetId: null, progress: 0, urgency: 1 },
               relations: {}, defunct: true },
    },
    npcs: {
      npc_0: { id: "npc_0", name: "Sera Coldwater", role: "steward", factionId: "fac_0",
               locationId: "stl_0", alive: true, traits: [], attitudes: {}, renown: 40 },
      npc_1: { id: "npc_1", name: "Bran One-Hand", role: "outrider", factionId: null,
               locationId: null, alive: false, traits: [], attitudes: {}, renown: 20 },
    },
    threats: {
      thr_0: { id: "thr_0", name: "the Grey Blight", kind: "blight", regionId: "rgn_0",
               severity: 40, growthRate: 2, revealed: true, resolved: false },
      thr_1: { id: "thr_1", name: "the Kelth raiders", kind: "raiders", regionId: "rgn_0",
               severity: 10, growthRate: 1, revealed: false, resolved: false },
    },
    characters: {},
    scene: { regionId: "rgn_0", settlementId: "stl_0", situation: "", tension: 30 },
  };
}

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
      expect(blurb).not.toMatch(/progress|treasury|power|severity|danger|agenda|seize/i);
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/lore/mentions.test.ts`
Expected: FAIL — `Cannot find module '../../src/lore/mentions'`.

- [ ] **Step 3: Write the implementation**

Create `src/lore/mentions.ts`:

```ts
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

export function blurbFor(kind: LinkableKind, id: string, state: WorldState): string {
  switch (kind) {
    case "faction": {
      const f = state.factions[id];
      if (!f) return "";
      if (f.defunct) return "broken and scattered";
      const seat = f.seatSettlementId ? state.settlements[f.seatSettlementId] : null;
      const what = f.kind.replace(/_/g, " ");
      return seat ? `${what} · seated at ${seat.name}` : what;
    }
    case "npc": {
      const n = state.npcs[id];
      if (!n) return "";
      if (!n.alive) return `${n.role} · died`;
      const faction = n.factionId ? state.factions[n.factionId] : null;
      const place = n.locationId
        ? (state.settlements[n.locationId] ?? state.regions[n.locationId] ?? null)
        : null;
      return (
        n.role +
        (faction ? ` of ${faction.name}` : "") +
        (place ? `, at ${place.name}` : "")
      );
    }
    case "settlement": {
      const s = state.settlements[id];
      if (!s) return "";
      if (s.razed) return "abandoned";
      const region = state.regions[s.regionId];
      const size = sizeLabel(s.population);
      return region ? `${size} in ${region.name}` : size;
    }
    case "region": {
      const r = state.regions[id];
      if (!r) return "";
      return `${r.terrain} · ${dangerLabel(r.danger)}`;
    }
    case "threat": {
      const t = state.threats[id];
      if (!t) return "";
      const phrase = THREAT_PHRASE[t.kind] ?? "a danger";
      const region = state.regions[t.regionId];
      const where = region ? `${phrase} in ${region.name}` : phrase;
      return t.resolved ? `${where} · ended` : where;
    }
  }
}

export function dossierPath(slug: string, entityId: string): string {
  return `/c/${encodeURIComponent(slug)}/who/${encodeURIComponent(entityId)}`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/lore/mentions.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lore/mentions.ts test/lore/mentions.test.ts
git commit -m "feat: entity blurbs with banded prose labels

One-line descriptions for the five linkable entity kinds, built from
identity facts only. Numbers are banded into prose following
renownLabel, which is both the house pattern and a disclosure rule:
a reader learns a region is 'dangerous', not that its danger is 52."
```

---

### Task 3: Prose scanning

**Files:**
- Modify: `src/lore/mentions.ts`
- Test: `test/lore/mentions.test.ts`

**Interfaces:**
- Consumes: `Mention`, `LinkableKind`, `blurbFor` from Task 2.
- Produces:
  ```ts
  export type Segment =
    | { type: "text"; value: string }
    | { type: "mention"; value: string; mention: Mention };
  export interface MentionScan { mentions: Mention[]; segments: Segment[] }
  export function scanProse(prose: string, state: WorldState): MentionScan
  export const MAX_MENTIONS: number;   // 8
  ```
  Tasks 4 and 5 consume `scanProse` and `Segment`.

**Algorithm, in order:**
1. Collect eligible entities. All factions (including defunct), all NPCs (including dead), all settlements (including razed), all regions. Threats **only if `revealed || resolved`**, mirroring `src/campaign-do.ts:660`. Characters never.
2. Drop names shorter than 4 characters.
3. Sort candidates by name length **descending**, so `House Vresk` claims its span before `Vresk` is tried.
4. For each candidate in that order, find its first match that does not overlap an already-claimed span. Word-boundary anchored via unicode lookaround, case-insensitive.
5. Sort the claimed spans by **position**, then keep the first `MAX_MENTIONS`. Capping by position rather than by iteration order means "the first 8 names in the beat", not "the 8 longest names".
6. Build segments from the surviving spans.

`scanProse` is **total**: it never throws and returns `{ mentions: [], segments: [] }` for empty prose.

- [ ] **Step 1: Write the failing test**

Append to `test/lore/mentions.test.ts` (the `world()` helper from Task 2 is already exported at the top of that file):

```ts
import { MAX_MENTIONS, scanProse } from "../../src/lore/mentions";

/** Reassemble the prose from segments — must always be lossless. */
function rejoin(segments: { value: string }[]): string {
  return segments.map((s) => s.value).join("");
}

describe("scanProse", () => {
  const w = world();

  it("finds a faction and carries its blurb", () => {
    const { mentions } = scanProse("The Ashen Coil sent word.", w);
    expect(mentions).toEqual([
      { id: "fac_0", kind: "faction", name: "The Ashen Coil", blurb: "cult · seated at Vresford" },
    ]);
  });

  it("segments losslessly", () => {
    const prose = "The Ashen Coil sent word to Vresford at dusk.";
    const { segments } = scanProse(prose, w);
    expect(rejoin(segments)).toBe(prose);
    expect(segments.filter((s) => s.type === "mention").map((s) => s.value))
      .toEqual(["The Ashen Coil", "Vresford"]);
  });

  it("prefers the longest name — House Vresk beats Vresk", () => {
    // Kelford is a settlement; House Vresk is a faction whose name contains no
    // other entity name. Use a world where one name is a prefix of another.
    const nested = world();
    nested.settlements.stl_0!.name = "Vresk";
    nested.factions.fac_1!.defunct = false;
    const { mentions } = scanProse("House Vresk rode out.", nested);
    expect(mentions.map((m) => m.id)).toEqual(["fac_1"]);
  });

  it("links only the first occurrence of an entity", () => {
    const { mentions, segments } = scanProse("Vresford burned. Vresford wept.", w);
    expect(mentions).toHaveLength(1);
    expect(segments.filter((s) => s.type === "mention")).toHaveLength(1);
    expect(rejoin(segments)).toBe("Vresford burned. Vresford wept.");
  });

  it("respects word boundaries", () => {
    expect(scanProse("The Vresfordian envoy arrived.", w).mentions).toEqual([]);
  });

  it("matches case-insensitively", () => {
    expect(scanProse("word came from vresford.", w).mentions.map((m) => m.id)).toEqual(["stl_0"]);
  });

  it("never matches an unrevealed threat", () => {
    expect(scanProse("Word of the Kelth raiders spread.", w).mentions).toEqual([]);
  });

  it("still matches a dead npc", () => {
    expect(scanProse("They spoke of Bran One-Hand.", w).mentions.map((m) => m.id))
      .toEqual(["npc_1"]);
  });

  it("never matches a player character", () => {
    const withParty = world();
    withParty.characters.chr_p1 = {
      id: "chr_p1", playerId: "plr_1", name: "Alder Finch", concept: "scout",
      attributes: { might: 2, wits: 3, grace: 3, spirit: 2 }, skills: {}, tendencies: [],
      bonds: {}, renown: 10, conditions: [], locationId: "stl_0", presence: "present",
      lastActedTick: 4,
    };
    expect(scanProse("Alder Finch went ahead.", withParty).mentions).toEqual([]);
  });

  it("ignores names shorter than four characters", () => {
    const shortName = world();
    shortName.settlements.stl_0!.name = "Ley";
    expect(scanProse("They reached Ley by dark.", shortName).mentions).toEqual([]);
  });

  it("caps at MAX_MENTIONS, keeping the earliest in the prose", () => {
    const many = world();
    for (let i = 0; i < 12; i++) {
      many.npcs[`npc_x${i}`] = {
        id: `npc_x${i}`, name: `Personage${i}`, role: "factor", factionId: null,
        locationId: null, alive: true, traits: [], attitudes: {}, renown: 5,
      };
    }
    const prose = Array.from({ length: 12 }, (_, i) => `Personage${i}`).join(" met ");
    const { mentions, segments } = scanProse(prose, many);
    expect(mentions).toHaveLength(MAX_MENTIONS);
    expect(mentions[0]!.name).toBe("Personage0");
    expect(mentions.at(-1)!.name).toBe(`Personage${MAX_MENTIONS - 1}`);
    expect(rejoin(segments)).toBe(prose);
  });

  it("treats a name with regex metacharacters literally", () => {
    const odd = world();
    odd.settlements.stl_0!.name = "Vres.ford (Old)";
    expect(scanProse("They rode to Vres.ford (Old) at dawn.", odd).mentions.map((m) => m.id))
      .toEqual(["stl_0"]);
    expect(scanProse("They rode to VresXford (Old) at dawn.", odd).mentions).toEqual([]);
  });

  it("returns empty for empty prose and for a world with nothing in it", () => {
    expect(scanProse("", w)).toEqual({ mentions: [], segments: [] });
    const bare = world();
    bare.factions = {}; bare.npcs = {}; bare.settlements = {};
    bare.regions = {}; bare.threats = {};
    expect(scanProse("Nothing here.", bare).mentions).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/lore/mentions.test.ts`
Expected: FAIL — `scanProse is not exported`. The Task 2 tests in the same file must still pass.

- [ ] **Step 3: Write the implementation**

Append to `src/lore/mentions.ts`:

```ts
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
    // Same rule the projection enforces: an unrevealed threat must not leak.
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/lore/mentions.test.ts`
Expected: PASS — Task 2 and Task 3 tests together.

- [ ] **Step 5: Commit**

```bash
git add src/lore/mentions.ts test/lore/mentions.test.ts
git commit -m "feat: scan beat prose for entity mentions

Longest-name-first, non-overlapping, word-boundary anchored, first
occurrence only, capped at eight by position in the prose. Unrevealed
threats and player characters are never matched.

Returns the prose pre-split into segments so the caller can escape each
one individually — a match can then never straddle an escape sequence."
```

---

### Task 4: The dossier page

**Files:**
- Create: `src/web/dossier.ts`
- Modify: `src/index.ts` (add one route after the chronicle route at line 190)
- Test: `test/web/dossier.test.ts`

**Interfaces:**
- Consumes: `blurbFor`, `LinkableKind` from Task 2; `events.target_ids` from Task 1.
- Produces: `export async function renderDossier(env: Env, campaign: CampaignRow, entityId: string): Promise<Response>`, and the live route `GET /c/<slug>/who/<entity_id>`. Task 5's links point here.

**Deliberate divergence from the chronicle, to state in review:** the chronicle's timeline filters to `significance >= 55` because it is a whole-world view that would otherwise drown. The dossier is scoped to one entity, so it shows every recorded event about that entity. This is a superset of what the chronicle *displays*, but every line is a sim-authored `summary` from a row that is already in the read model — it is not a disclosure from canon. Agendas, progress, relations, and raw 0–100 fields remain excluded.

- [ ] **Step 1: Write the failing test**

Create `test/web/dossier.test.ts`:

```ts
/**
 * The dossier page: one entity, what it is, and where it has appeared.
 *
 * Runs the real router against a real D1 in the workers runtime, because the
 * access rule is the point — a private chronicle's dossier must stay private,
 * and an unrevealed threat must be indistinguishable from one that never was.
 */

import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env as runtimeEnv } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import worker from "../../src/index";
import type { Env } from "../../src/env";

const env = runtimeEnv as unknown as Env;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS campaigns (id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL, cadence TEXT NOT NULL, quorum_fraction REAL NOT NULL DEFAULT 0.5,
  tick INTEGER NOT NULL DEFAULT 0, deadline_at INTEGER, public_chronicle INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS entities (campaign_id TEXT NOT NULL, entity_id TEXT NOT NULL,
  kind TEXT NOT NULL, name TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (campaign_id, entity_id));
CREATE TABLE IF NOT EXISTS events (campaign_id TEXT NOT NULL, event_id TEXT NOT NULL,
  tick INTEGER NOT NULL, kind TEXT NOT NULL, actor_id TEXT, region_id TEXT,
  summary TEXT NOT NULL, significance INTEGER NOT NULL, data TEXT NOT NULL DEFAULT '{}',
  target_ids TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL,
  PRIMARY KEY (campaign_id, event_id));
`;

const PUBLIC_ID = "cmp_pub";
const PRIVATE_ID = "cmp_priv";
const now = "2026-08-08T00:00:00.000Z";

async function get(path: string): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch!(new Request(`https://example.test${path}`), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

async function seedEvent(opts: {
  id: string; tick: number; actor?: string | null; region?: string | null;
  targets?: string[]; summary: string; significance?: number;
}): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO events (campaign_id, event_id, tick, kind, actor_id, region_id,
                         summary, significance, data, target_ids, created_at)
     VALUES (?, ?, ?, 'agenda_advanced', ?, ?, ?, ?, '{}', ?, ?)`,
  )
    .bind(
      PUBLIC_ID, opts.id, opts.tick, opts.actor ?? null, opts.region ?? null,
      opts.summary, opts.significance ?? 40, JSON.stringify(opts.targets ?? []), now,
    )
    .run();
}

describe("dossier page", () => {
  beforeAll(async () => {
    for (const stmt of SCHEMA.split(";").map((s) => s.trim()).filter(Boolean)) {
      await env.DB.prepare(stmt).run();
    }
  });

  beforeEach(async () => {
    for (const table of ["campaigns", "entities", "events"]) {
      await env.DB.prepare(`DELETE FROM ${table} WHERE campaign_id = ? OR campaign_id = ?`)
        .bind(PUBLIC_ID, PRIVATE_ID)
        .run()
        .catch(async () => {
          await env.DB.prepare(`DELETE FROM campaigns WHERE id = ? OR id = ?`)
            .bind(PUBLIC_ID, PRIVATE_ID)
            .run();
        });
    }
    await env.DB.prepare(
      `INSERT INTO campaigns (id, slug, name, cadence, public_chronicle, created_by, created_at)
       VALUES (?, 'pub', 'Ashfall', 'weekly', 1, 'plr_1', ?), (?, 'priv', 'Hidden', 'weekly', 0, 'plr_1', ?)`,
    )
      .bind(PUBLIC_ID, now, PRIVATE_ID, now)
      .run();

    await env.DB.prepare(
      `INSERT INTO entities (campaign_id, entity_id, kind, name, data) VALUES
        (?, 'fac_0', 'faction', 'The Ashen Coil', ?),
        (?, 'stl_0', 'settlement', 'Vresford', ?),
        (?, 'rgn_0', 'region', 'Thornreach', ?),
        (?, 'npc_0', 'npc', 'Sera Coldwater', ?)`,
    )
      .bind(
        PUBLIC_ID,
        JSON.stringify({
          id: "fac_0", name: "The Ashen Coil", kind: "cult", power: 44, treasury: 30,
          seatSettlementId: "stl_0",
          agenda: { kind: "seize_settlement", targetId: "stl_1", progress: 78, urgency: 6 },
          relations: { fac_1: -80 }, defunct: false,
        }),
        PUBLIC_ID,
        JSON.stringify({
          id: "stl_0", name: "Vresford", regionId: "rgn_0", population: 3200,
          prosperity: 60, defense: 30, unrest: 12, razed: false,
        }),
        PUBLIC_ID,
        JSON.stringify({
          id: "rgn_0", name: "Thornreach", terrain: "forest", danger: 52, neighborIds: [],
        }),
        PUBLIC_ID,
        JSON.stringify({
          id: "npc_0", name: "Sera Coldwater", role: "steward", factionId: "fac_0",
          locationId: "stl_0", alive: true, traits: [], attitudes: { chr_1: 60 }, renown: 40,
        }),
      )
      .run();
  });

  it("renders a public dossier with the entity name", async () => {
    const res = await get("/c/pub/who/fac_0");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("The Ashen Coil");
  });

  it("shows an event linked only through target_ids", async () => {
    // The case that was impossible before issue #7 was fixed: no actor, the
    // entity named only as a target.
    await seedEvent({ id: "e1", tick: 4, actor: null, targets: ["fac_0"],
                      summary: "The Ashen Coil was driven from the chapterhouse." });
    const body = await (await get("/c/pub/who/fac_0")).text();
    expect(body).toContain("driven from the chapterhouse");
  });

  it("shows an event linked through actor_id", async () => {
    await seedEvent({ id: "e2", tick: 5, actor: "fac_0", summary: "The Ashen Coil marched north." });
    const body = await (await get("/c/pub/who/fac_0")).text();
    expect(body).toContain("marched north");
  });

  it("does not show an event about a different entity", async () => {
    await seedEvent({ id: "e3", tick: 5, actor: "fac_9", targets: ["fac_9"],
                      summary: "Someone else entirely did a thing." });
    const body = await (await get("/c/pub/who/fac_0")).text();
    expect(body).not.toContain("Someone else entirely");
  });

  it("separates pre-play history from the live timeline", async () => {
    await seedEvent({ id: "e4", tick: 0, targets: ["fac_0"], significance: 80,
                      summary: "The Coil was founded in a bad year." });
    const body = await (await get("/c/pub/who/fac_0")).text();
    expect(body).toContain("Before you arrived");
    expect(body).toContain("founded in a bad year");
  });

  it("discloses no agenda, relation, or raw 0-100 field", async () => {
    const body = await (await get("/c/pub/who/fac_0")).text();
    expect(body).not.toMatch(/seize_settlement|agenda|progress/i);
    expect(body).not.toContain("78");
    expect(body).not.toContain("treasury");
    expect(body).not.toContain("-80");
  });

  it("bands a settlement rather than printing its population", async () => {
    const body = await (await get("/c/pub/who/stl_0")).text();
    expect(body).toContain("a town");
    expect(body).not.toContain("3200");
  });

  it("resolves an npc's faction and location by name", async () => {
    // "steward" alone is a poor answer to "who is this?" — the referenced rows
    // are what make the page worth loading.
    const body = await (await get("/c/pub/who/npc_0")).text();
    expect(body).toContain("steward of The Ashen Coil, at Vresford");
  });

  it("does not leak an npc's attitude values", async () => {
    const body = await (await get("/c/pub/who/npc_0")).text();
    expect(body).not.toContain("60");
    expect(body).not.toMatch(/attitude/i);
  });

  it("refuses a private chronicle to a signed-out reader", async () => {
    await env.DB.prepare(
      `INSERT INTO entities (campaign_id, entity_id, kind, name, data)
       VALUES (?, 'fac_0', 'faction', 'Secret Order', '{}')`,
    ).bind(PRIVATE_ID).run();
    expect((await get("/c/priv/who/fac_0")).status).toBe(403);
  });

  it("returns 404 for an entity that is not projected", async () => {
    // Unrevealed threats are never written to `entities`, so they land here —
    // indistinguishable from an id that never existed.
    expect((await get("/c/pub/who/thr_9")).status).toBe(404);
  });

  it("returns 404 for an unknown campaign", async () => {
    expect((await get("/c/nope/who/fac_0")).status).toBe(404);
  });

  it("does not route a character id", async () => {
    expect((await get("/c/pub/who/chr_abc")).status).toBe(404);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/web/dossier.test.ts`
Expected: FAIL — every request 404s, because the route does not exist.

- [ ] **Step 3: Write the renderer**

Create `src/web/dossier.ts`:

```ts
/**
 * One entity, and where it has appeared.
 *
 * The page is a re-index of the chronicle, not a window into canon. It renders
 * identity facts and the summaries of events already in the read model —
 * never an agenda, a relation value, or a raw 0-100 field. A reader learns
 * that a region is dangerous, not that its danger is 52.
 *
 * Everything interpolated is model- or player-adjacent, so everything is
 * escaped.
 */

import { escapeHtml } from "../email/outbound";
import type { Env } from "../env";
import { blurbFor, type LinkableKind } from "../lore/mentions";
import type { WorldState } from "../sim/types";

interface CampaignRow {
  id: string;
  slug: string;
  name: string;
}

interface EntityRow {
  entity_id: string;
  kind: string;
  name: string;
  data: string;
}

interface EventRow {
  tick: number;
  summary: string;
  significance: number;
}

const KIND_LABEL: Record<string, string> = {
  region: "A land",
  settlement: "A place",
  faction: "A power",
  npc: "A person",
  threat: "A trouble",
};

const CSS = `
:root{--bg:#f6f3ec;--ink:#22201c;--muted:#6d665b;--rule:#ddd6c9;--accent:#8a4b2a;--card:#fffdf8}
@media (prefers-color-scheme:dark){:root{--bg:#16150f;--ink:#ece6da;--muted:#9a9284;--rule:#332f26;--accent:#d99a6f;--card:#1e1c15}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);
  font:17px/1.65 Iowan Old Style,Palatino,Georgia,serif;-webkit-text-size-adjust:100%}
.wrap{max-width:40rem;margin:0 auto;padding:2rem 1.15rem 5rem}
header{border-bottom:2px solid var(--rule);padding-bottom:1.1rem;margin-bottom:2rem}
h1{font-size:2rem;line-height:1.15;margin:0 0 .3rem;letter-spacing:-.01em}
.sub{color:var(--muted);font-size:.9rem;margin:0}
h2{font-size:.78rem;text-transform:uppercase;letter-spacing:.09em;color:var(--muted);
  margin:2.6rem 0 .9rem;font-weight:700;font-family:system-ui,sans-serif}
ol.tl{list-style:none;margin:0;padding:0;border-left:2px solid var(--rule)}
ol.tl li{padding:.42rem 0 .42rem 1rem;position:relative}
ol.tl li::before{content:"";position:absolute;left:-5px;top:.95rem;width:8px;height:8px;
  border-radius:50%;background:var(--rule)}
ol.tl li.big::before{background:var(--accent);width:10px;height:10px;left:-6px}
ol.tl .n{font:600 .7rem/1 system-ui,sans-serif;color:var(--muted);margin-right:.5rem}
footer{margin-top:3.5rem;padding-top:1.1rem;border-top:1px solid var(--rule);
  color:var(--muted);font-size:.82rem}
a{color:var(--accent)}
.empty{color:var(--muted);font-style:italic}
`;

function page(campaign: CampaignRow, title: string, inner: string, status = 200): Response {
  const back = `/c/${encodeURIComponent(campaign.slug)}`;
  const html =
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">` +
    `<title>${escapeHtml(title)} — ${escapeHtml(campaign.name)}</title>` +
    `<meta name="robots" content="noindex">` +
    `<style>${CSS}</style></head><body><div class="wrap">` +
    inner +
    `<footer><a href="${escapeHtml(back)}">Back to the chronicle</a></footer>` +
    `</div></body></html>`;
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=60" },
  });
}

/**
 * A link in a *sent* email is permanent, so a missing entity gets a page that
 * explains itself and offers a way onward rather than a bare 404 body.
 */
function notRecorded(campaign: CampaignRow): Response {
  return page(
    campaign,
    "Not recorded",
    `<header><h1>Not recorded</h1>` +
      `<p class="sub">This entry hasn't been written into the chronicle yet.</p></header>`,
    404,
  );
}

const BUCKET: Record<string, string> = {
  faction: "factions", npc: "npcs", settlement: "settlements",
  region: "regions", threat: "threats",
};

/** Drop one projected row into the `WorldState` shape `blurbFor` expects. */
function place(state: WorldState, row: EntityRow): Record<string, unknown> | null {
  const bucket = BUCKET[row.kind];
  if (!bucket) return null;
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(row.data) as Record<string, unknown>;
  } catch {
    return null;
  }
  (state as unknown as Record<string, Record<string, unknown>>)[bucket]![row.entity_id] = data;
  return data;
}

/**
 * `blurbFor` reads a whole `WorldState`; the page has one projected row. Build
 * the smallest state that answers correctly, so there is exactly one
 * implementation of how an entity is described.
 *
 * The referenced rows matter: an NPC's blurb names their faction and where
 * they are, and "steward" alone is a much worse answer to "who is this?" than
 * "steward of The Ashen Coil, at Vresford" — which is the whole point of the
 * page. One extra query buys that.
 */
async function blurbFromRow(env: Env, campaignId: string, row: EntityRow): Promise<string> {
  const state = {
    factions: {}, npcs: {}, settlements: {}, regions: {}, threats: {},
  } as unknown as WorldState;

  const data = place(state, row);
  if (!data) return "";

  const refs = [data.factionId, data.locationId, data.seatSettlementId, data.regionId].filter(
    (v): v is string => typeof v === "string" && v.length > 0,
  );
  if (refs.length) {
    try {
      const related = await env.DB.prepare(
        `SELECT entity_id, kind, name, data FROM entities
         WHERE campaign_id = ? AND entity_id IN (${refs.map(() => "?").join(",")})`,
      )
        .bind(campaignId, ...refs)
        .all<EntityRow>();
      for (const r of related.results ?? []) place(state, r);
    } catch {
      // A thinner blurb beats a 500 on a link that has already been mailed.
    }
  }

  return blurbFor(row.kind as LinkableKind, row.entity_id, state);
}

export async function renderDossier(
  env: Env,
  campaign: CampaignRow,
  entityId: string,
): Promise<Response> {
  const entity = await env.DB.prepare(
    "SELECT entity_id, kind, name, data FROM entities WHERE campaign_id = ? AND entity_id = ?",
  )
    .bind(campaign.id, entityId)
    .first<EntityRow>();

  // An unrevealed threat is never projected, so it lands here — deliberately
  // indistinguishable from an id that never existed.
  if (!entity) return notRecorded(campaign);

  const isRegion = entity.kind === "region";
  let live: EventRow[] = [];
  let history: EventRow[] = [];
  try {
    const [liveRes, historyRes] = await Promise.all([
      env.DB.prepare(
        `SELECT tick, summary, significance FROM events
         WHERE campaign_id = ?1 AND tick > 0
           AND (actor_id = ?2
                OR EXISTS (SELECT 1 FROM json_each(events.target_ids) WHERE value = ?2)
                OR (?3 = 1 AND region_id = ?2))
         ORDER BY tick DESC, significance DESC LIMIT 40`,
      )
        .bind(campaign.id, entityId, isRegion ? 1 : 0)
        .all<EventRow>(),
      env.DB.prepare(
        `SELECT tick, summary, significance FROM events
         WHERE campaign_id = ?1 AND tick = 0
           AND (actor_id = ?2
                OR EXISTS (SELECT 1 FROM json_each(events.target_ids) WHERE value = ?2)
                OR (?3 = 1 AND region_id = ?2))
         ORDER BY significance DESC LIMIT 12`,
      )
        .bind(campaign.id, entityId, isRegion ? 1 : 0)
        .all<EventRow>(),
    ]);
    live = liveRes.results ?? [];
    history = historyRes.results ?? [];
  } catch {
    // Identity is still worth serving. A 500 here would break a link that has
    // already been mailed out.
    live = [];
    history = [];
  }

  const timeline = (rows: EventRow[], showTick: boolean): string =>
    `<ol class="tl">` +
    rows
      .map(
        (e) =>
          `<li class="${e.significance >= 75 ? "big" : ""}">` +
          `<span class="n">${showTick ? `t${e.tick}` : "—"}</span>${escapeHtml(e.summary)}</li>`,
      )
      .join("") +
    `</ol>`;

  const blurb = await blurbFromRow(env, campaign.id, entity);
  const inner =
    `<header><h1>${escapeHtml(entity.name)}</h1>` +
    `<p class="sub">${escapeHtml(KIND_LABEL[entity.kind] ?? "An entry")}` +
    (blurb ? ` · ${escapeHtml(blurb)}` : "") +
    `</p></header>` +
    `<h2>What the chronicle records</h2>` +
    (live.length
      ? timeline(live, true)
      : `<p class="empty">Nothing recorded yet in play.</p>`) +
    (history.length ? `<h2>Before you arrived</h2>` + timeline(history, false) : "");

  return page(campaign, entity.name, inner);
}
```

- [ ] **Step 4: Add the route**

In `src/index.ts`, immediately after the chronicle block that ends at line 190, add:

```ts
  // ─── one entity's dossier (same access rule as the chronicle) ──────────
  // `chr_` is deliberately absent: characters are not linked from mail, so the
  // page would be unreachable, and a character's disclosure story is separate.
  const dossierMatch =
    /^\/c\/([a-z0-9-]{2,31})\/who\/((?:rgn|stl|fac|npc|thr)_[a-z0-9_-]{1,40})\/?$/.exec(path);
  if (dossierMatch && method === "GET") {
    const campaign = await campaignBySlug(env, dossierMatch[1]!);
    if (!campaign) return new Response("No such chronicle.", { status: 404 });
    if (campaign.public_chronicle !== 1 && !(session && (await isMember(env, campaign.id, session.playerId)))) {
      return new Response("This chronicle is private.", { status: 403 });
    }
    return renderDossier(env, campaign, dossierMatch[2]!);
  }
```

Add the import beside the existing `renderChronicle` import at `src/index.ts:29`:

```ts
import { renderDossier } from "./web/dossier";
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/web/dossier.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 6: Run the full suite**

Run: `npm test && npm run typecheck`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/web/dossier.ts src/index.ts test/web/dossier.test.ts
git commit -m "feat: per-entity dossier page at /c/<slug>/who/<id>

Identity facts plus every chronicle event the entity appears in, found
through actor_id or the newly projected target_ids. Same access rule as
the chronicle; an unprojected entity (including any unrevealed threat)
404s indistinguishably from one that never existed.

Discloses nothing new: no agenda, no progress, no relation values, and
0-100 fields banded into prose."
```

---

### Task 5: Links and the who's-who block in beat mail

**Files:**
- Modify: `src/email/outbound.ts` (`paragraphs` at line 24, `BeatMail` at line 36, `sendBeat` at line 55)
- Modify: `src/campaign-do.ts` (`#fanOut` at line 548)
- Test: `test/email/outbound.test.ts`

**Interfaces:**
- Consumes: `scanProse`, `MentionScan`, `Segment`, `Mention`, `dossierPath` from Tasks 2–3; the live route from Task 4.
- Produces: `BeatMail.scan?: MentionScan` — optional, so any caller that omits it produces exactly today's output.

**Key invariant to preserve:** anchors never contain a newline, so the HTML may be assembled from segments *first* and split into paragraphs on `\n{2,}` *after*. Escaping still happens per segment, before any concatenation.

- [ ] **Step 1: Write the failing test**

Create `test/email/outbound.test.ts`:

```ts
/**
 * Beat mail rendering.
 *
 * The load-bearing assertions are the two invariants: nothing player- or
 * model-authored reaches the HTML unescaped, and a beat with no recognised
 * names renders byte-for-byte what it rendered before this feature existed.
 */

import { env as runtimeEnv } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { Env, EmailSendMessage } from "../../src/env";
import { sendBeat, type BeatMail } from "../../src/email/outbound";
import { scanProse } from "../../src/lore/mentions";
import { world } from "../lore/mentions.test";

const sent: EmailSendMessage[] = [];

const env = {
  ...(runtimeEnv as unknown as Env),
  MAIL_DOMAIN: "mail.example",
  PUBLIC_ORIGIN: "https://play.example",
  EMAIL: {
    async send(message: EmailSendMessage) {
      sent.push(message);
      return { messageId: "<assigned@mail.example>" };
    },
  },
} as unknown as Env;

function beat(overrides: Partial<BeatMail> = {}): BeatMail {
  return {
    campaignId: "cmp_1",
    campaignSlug: "demo",
    campaignName: "Ashfall",
    tick: 7,
    playerId: "plr_1",
    toEmail: "player@example.com",
    headline: "The envoy",
    prose: "Nothing recognisable happened at all.",
    prompt: "What do you do?",
    ...overrides,
  };
}

describe("beat mail", () => {
  beforeEach(() => {
    sent.length = 0;
  });

  it("links the first mention of an entity to its dossier", async () => {
    const prose = "The Ashen Coil sent word to Vresford.";
    await sendBeat(env, beat({ prose, scan: scanProse(prose, world()) }));
    const html = sent[0]!.html!;
    expect(html).toContain(`href="https://play.example/c/demo/who/fac_0"`);
    expect(html).toContain(`href="https://play.example/c/demo/who/stl_0"`);
    expect(html).toContain(">The Ashen Coil</a>");
  });

  it("lists who's who in both parts", async () => {
    const prose = "The Ashen Coil sent word.";
    await sendBeat(env, beat({ prose, scan: scanProse(prose, world()) }));
    const { text, html } = sent[0]!;
    expect(text).toContain("Who's who in this turn:");
    expect(text).toContain("The Ashen Coil — cult · seated at Vresford");
    expect(text).toContain("https://play.example/c/demo/who/fac_0");
    expect(html).toContain("Who's who in this turn");
  });

  it("renders identically to the pre-feature output when nothing is recognised", async () => {
    // The safety property: a beat with no mentions must not change at all.
    await sendBeat(env, beat());
    const withoutScan = { text: sent[0]!.text, html: sent[0]!.html };
    sent.length = 0;

    const prose = "Nothing recognisable happened at all.";
    await sendBeat(env, beat({ scan: scanProse(prose, world()) }));
    expect({ text: sent[0]!.text, html: sent[0]!.html }).toEqual(withoutScan);
    expect(sent[0]!.html).not.toContain("Who's who");
  });

  it("escapes prose around a link", async () => {
    const prose = "The Ashen Coil said <b>no</b> & left.";
    await sendBeat(env, beat({ prose, scan: scanProse(prose, world()) }));
    const html = sent[0]!.html!;
    expect(html).toContain("&lt;b&gt;no&lt;/b&gt; &amp; left.");
    expect(html).not.toContain("<b>no</b>");
    expect(html).toContain("/who/fac_0");
  });

  it("escapes a hostile entity name in both the anchor and the footer", async () => {
    const hostile = world();
    hostile.factions.fac_0!.name = '<script>alert(1)</script>';
    const prose = "Then <script>alert(1)</script> arrived.";
    await sendBeat(env, beat({ prose, scan: scanProse(prose, hostile) }));
    const html = sent[0]!.html!;
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("preserves paragraph breaks around links", async () => {
    const prose = "The Ashen Coil moved.\n\nVresford did not.";
    await sendBeat(env, beat({ prose, scan: scanProse(prose, world()) }));
    const html = sent[0]!.html!;
    expect(html.match(/<p style="margin:0 0 1em">/g)).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/email/outbound.test.ts`
Expected: FAIL — `scan` is not a property of `BeatMail`.

- [ ] **Step 3: Rewrite `paragraphs` and add the who's-who builder**

In `src/email/outbound.ts`, add the import:

```ts
import { dossierPath, type Mention, type MentionScan, type Segment } from "../lore/mentions";
```

Replace `paragraphs` (line 24) with:

```ts
/**
 * A faint underline reads as *reference*; a coloured link reads as *call to
 * action*, and the only call to action in a beat is "reply".
 */
const LINK_STYLE =
  "color:inherit;text-decoration:underline;text-decoration-color:#c9b9a5;text-underline-offset:2px";

/**
 * Escape each segment on its own, then join.
 *
 * Tokenizing happens on raw prose (see `scanProse`), so a match can never
 * straddle an escape sequence and nothing is escaped twice. Anchors contain no
 * newline, which is what makes it safe to split into paragraphs afterwards.
 */
function renderSegments(segments: Segment[], slug: string, origin: string): string {
  return segments
    .map((s) => {
      const escaped = escapeHtml(s.value);
      if (s.type === "text") return escaped;
      const href = escapeHtml(`${origin}${dossierPath(slug, s.mention.id)}`);
      return `<a href="${href}" style="${LINK_STYLE}">${escaped}</a>`;
    })
    .join("");
}

function paragraphs(text: string, segments: Segment[] | null, slug: string, origin: string): string {
  const body = segments?.length ? renderSegments(segments, slug, origin) : escapeHtml(text);
  return body
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 1em">${p.replace(/\n/g, "<br>")}</p>`)
    .join("\n");
}

function whosWhoText(mentions: Mention[], slug: string, origin: string): string {
  if (!mentions.length) return "";
  const lines = mentions
    .map((m) => `  · ${m.name}${m.blurb ? ` — ${m.blurb}` : ""}\n    ${origin}${dossierPath(slug, m.id)}`)
    .join("\n");
  return `\n\nWho's who in this turn:\n${lines}`;
}

function whosWhoHtml(mentions: Mention[], slug: string, origin: string): string {
  if (!mentions.length) return "";
  return (
    `<p style="margin:1.6em 0 .4em;font-weight:600;font-size:.85em">Who's who in this turn</p>` +
    `<ul style="margin:0 0 1em;padding-left:1.2em;font-size:.85em;color:#6b6459">` +
    mentions
      .map((m) => {
        const href = escapeHtml(`${origin}${dossierPath(slug, m.id)}`);
        return (
          `<li style="margin:0 0 .3em">` +
          `<a href="${href}" style="color:#8a4b2a">${escapeHtml(m.name)}</a>` +
          (m.blurb ? ` — ${escapeHtml(m.blurb)}` : "") +
          `</li>`
        );
      })
      .join("") +
    `</ul>`
  );
}
```

Note the `escapeHtml(text)` moved *out* of the old inline `.map` and into
`paragraphs`; the `.replace(/\n/g, "<br>")` now runs on already-escaped content,
which is the same order as before.

- [ ] **Step 4: Thread `scan` through `BeatMail` and `sendBeat`**

Add to the `BeatMail` interface (after `actedForYou`):

```ts
  /**
   * Entities named in this beat, and the prose pre-split around them. Optional:
   * when absent the mail renders exactly as it did before linking existed.
   */
  scan?: MentionScan;
```

In `sendBeat`, after the `chronicle` const:

```ts
  const mentions = mail.scan?.mentions ?? [];
  const origin = env.PUBLIC_ORIGIN;
```

Change the `text` assembly to insert the block after the reply instruction and before the chronicle line:

```ts
  const text =
    `${mail.prose}${recapText}${autoText}\n\n` +
    `— ${mail.prompt}\n\n` +
    `Just reply to this email. Reply whenever suits you; nothing bad happens if you don't.\n` +
    `Chronicle: ${chronicle}\n` +
    whosWhoText(mentions, mail.campaignSlug, origin);
```

Change the first line of the `html` assembly to pass segments through, and add the block before the closing `</div>`:

```ts
  const html =
    `<div style="font:16px/1.6 Georgia,serif;max-width:34em;margin:0 auto;color:#1c1a17">` +
    paragraphs(mail.prose, mail.scan?.segments ?? null, mail.campaignSlug, origin) +
```

…and, immediately before the final `` `</div>` ``:

```ts
    whosWhoHtml(mentions, mail.campaignSlug, origin) +
    `</div>`;
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/email/outbound.test.ts`
Expected: PASS, 6 tests. If the byte-identity test fails, the who's-who block or the paragraph rendering is emitting something when `mentions` is empty — fix that rather than relaxing the assertion.

- [ ] **Step 6: Wire it into the tick fan-out**

In `src/campaign-do.ts`, add the import beside the existing `sendBeat` import at line 25:

```ts
import { scanProse } from "./lore/mentions";
```

In `#fanOut`, after the `headline` const and **outside** the member loop:

```ts
    // Every member gets the same prose, so scan once per tick rather than once
    // per player. Pure and cheap, but there is no reason to do it N times.
    const scan = scanProse(beat.prose, state);
```

Add `scan,` to the `sendBeat({ ... })` argument object, after `actedForYou`.

- [ ] **Step 7: Run every gate**

Run: `npm test && npm run typecheck && npm run sim:soak -- --ticks 200`
Expected: all pass. Report the test count explicitly (was 167; expect roughly 190).

- [ ] **Step 8: Commit**

```bash
git add src/email/outbound.ts src/campaign-do.ts test/email/outbound.test.ts
git commit -m "feat: link entity names in beat mail to their dossier

First mention of each entity becomes a quiet underlined link, and both
MIME parts carry a who's-who block so plain-text readers get the same
affordance. Scanned once per tick, not once per player.

Segments are escaped individually before assembly, so a match cannot
straddle an escape sequence. With no mentions the output is
byte-identical to before, which is asserted rather than assumed."
```

---

### Task 6: Verify against the running app, then open the PR

**Files:** none — verification only.

- [ ] **Step 1: Apply migrations locally**

```bash
npx wrangler d1 migrations apply asyncrpg --local
```

- [ ] **Step 2: Start the worker and check a dossier renders**

```bash
npm run dev
```

Then open the local `/c/demo` chronicle, pick any entity id from its cards, and load `/c/demo/who/<id>`. Confirm: the name and blurb render, the timeline shows events, no number from a 0–100 field appears, and dark mode works. This satisfies the "browser check of the running app" requirement in CLAUDE.md.

- [ ] **Step 3: Confirm the full gate set**

```bash
npm test && npm run typecheck && npm run sim:soak -- --ticks 500
```

Record exact counts for the PR body.

- [ ] **Step 4: Open the PR**

```bash
git push -u origin claude/email-keyword-links-c78541
```

PR body must include: the spec link, the test counts from Step 3, a note that `sim:soak` is unchanged, and `Closes #7`. **Do not merge and do not enable auto-merge.**

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| §4 Scope — five kinds, characters excluded | 3 (`candidates`, test) |
| §5 Architecture — file layout | 2–5 |
| §6 Detection rules 1–6 | 3 |
| §6 Blurbs + banding | 2 |
| §7 Projection gap + migration + reproject backfill | 1 |
| §8 Route, access, 404-not-403, page content | 4 |
| §9 HTML linkify, link style, who's-who both parts | 5 |
| §10 Failure behaviour — soft 404, events-query catch, byte-identity | 4, 5 |
| §11 Testing — every listed case | 1–5 |

No gaps.

**Placeholder scan:** none. Every code step carries real code; every test step carries real assertions.

**Type consistency:** `Mention`, `Segment`, `MentionScan`, `LinkableKind`, `scanProse`, `blurbFor`, `dossierPath`, `MAX_MENTIONS` are defined in Tasks 2–3 and used with identical names and signatures in Tasks 4–5. `BeatMail.scan` is optional in both its definition (Task 5, Step 4) and its use (Task 5, Step 6).

**Fixed during review:** `blurbFromRow` originally built its stub `WorldState` from the single entity row, which meant an NPC dossier would render `steward` instead of `steward of The Ashen Coil, at Vresford` — a weak answer to the exact question the page exists to answer. It now fetches the referenced rows (`factionId`, `locationId`, `seatSettlementId`, `regionId`) in one extra query, with a test asserting the full string.

**Two things a reviewer should still challenge:**

1. Task 4 shows every recorded event about an entity, while the chronicle timeline filters to `significance >= 55`. Deliberate and documented in Task 4's preamble — the dossier is scoped to one entity, so volume is not the problem it is on a whole-world page — but it *is* a superset of what the chronicle displays, and worth a second opinion.
2. `scanProse` is O(entities × prose length) with a fresh `RegExp` per candidate. At genesis scale (roughly 40–80 entities) against a few paragraphs this is negligible, and it runs once per tick, not once per player. If a world ever grows an order of magnitude, this is the thing to revisit first.
