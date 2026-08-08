# DM Role — Slice 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a campaign a transferable DM seat and a review window, so the DM can hold and rewrite a beat before players see it — without touching world state at all.

**Architecture:** The Durable Object's single alarm becomes a two-phase machine. Phase `open` means "the alarm resolves the tick"; phase `review` means "the alarm publishes the held beat." A tick still resolves exactly on the cadence clock; only *publication* waits. The cadence deadline is computed at resolution time and stored, so the review window is carved out of the front of the next cycle and the clock never drifts. The seat itself lives in D1 (`campaigns.dm_player_id`), which the DO reads at resolution time — a D1 failure degrades to today's immediate-publish behavior rather than stranding a beat.

**Tech Stack:** TypeScript, Cloudflare Workers, Durable Objects with SQLite storage, D1, Vitest via `@cloudflare/vitest-pool-workers`, vanilla JS PWA (no framework).

## Global Constraints

- **Spec:** [`docs/specs/2026-08-08-dm-role-design.md`](../specs/2026-08-08-dm-role-design.md). Slice 1 is §3, §4, and the prose-editing half of §7–§9. **Do not implement typed canon ops (§5) or the free-text front door (§6)** — those are slices 2 and 3.
- **Slice 1 touches no world state.** No file under `src/sim/` is modified. If a task seems to require it, stop and escalate.
- **Review window defaults:** daily `2h`, weekly `24h`, monthly `72h`. **Hard caps:** daily `8h`, weekly `56h`, monthly `10d` (⅓ of cadence in each case).
- **Seat reversion:** after **3** consecutive windows expiring untouched, the seat reverts to the host.
- **`campaigns.review_window_ms` NULL means "use the cadence default."** `0` means publish immediately.
- **The cadence deadline is absolute.** A review window never extends the tick cycle.
- **Publication must be idempotent** — keyed on `beats.published_at IS NULL`, safe to call twice, and self-healed by the next resolution.
- **No `Math.random()` in `src/sim/`.** (Unchanged, restated because it is load-bearing; `crypto.randomUUID()` in the DO and router is fine and already used.)
- **Conventional commit prefixes:** `feat:`, `fix:`, `test:`, `docs:`, `refactor:`, `chore:`.
- **Run `npm test && npm run typecheck` before every commit.** Report counts explicitly.
- **Test fixtures run against the real migrations, and `PRAGMA foreign_keys` is 1.** `test/helpers/schema.ts` applies `migrations/*.sql` themselves, so every `CHECK` and `REFERENCES` clause is enforced in tests exactly as in production. Seed parents before children — `players`, then `campaigns`, then `memberships`/`beats`/`events`/`entities`. Never relax a migration to make a fixture pass; fix the fixture.
- **Not implemented, deliberately:** spec §9's "DM leaves the campaign → seat reverts to host". There is no leave-a-campaign flow anywhere in the app today, so there is nothing to hook it to. Whoever builds membership removal owns adding it; do not build a leave flow for this.

---

### Task 1: Migration and test schema helper

**Files:**
- Create: `migrations/0005_dm.sql`
- Create: `test/helpers/schema.ts`
- Modify: `test/env.d.ts` — declare `*.sql?raw`
- Test: `test/integration/dm-migration.test.ts`

**Interfaces:**

`test/helpers/schema.ts` does not describe the schema. It reads `migrations/0001_init.sql` … `0005_dm.sql` as strings (Vite's `?raw` suffix), splits each into statements, and applies them in filename order through `applyD1Migrations` from `cloudflare:test`. The fixture therefore *is* production DDL — every table, every `CHECK`, every `REFERENCES` — and the migrations get real automated coverage: delete one and the suite goes red.

- Consumes: nothing.
- Produces, from `test/helpers/schema.ts`:
  - `applySchema(db: D1Database): Promise<void>` — brings `db` to the current schema: all 17 tables the five migrations create, with production's constraints. Idempotent (`applyD1Migrations` records what it ran in `d1_migrations`), so it is safe in a `beforeEach` even though the pool shares one D1 instance across the tests in a file. Every later task's test file imports it.
  - `applySchemaThrough(db: D1Database, name: string): Promise<void>` — apply up to and including `name`, and stop. This is what makes a backfill testable: seed rows against the old shape, then call `applySchema` to run the remainder over them for real.
  - `resetDatabase(db: D1Database): Promise<void>` — drop every table including `d1_migrations`, so the next `applySchema` runs the chain from bare.
  - `splitStatements(sql: string): string[]` and `MIGRATIONS: D1Migration[]` — exported so the schema test can assert the split is correct.

**A naive `sql.split(";")` is wrong for these files.** `0001_init.sql` lines 83 and 113 and `0003_ops.sql` line 5 each carry a semicolon inside a `--` comment; splitting on the raw character shears those into fragments that no longer parse. `splitStatements` walks the text, skipping comments and quoted spans, and breaks only at top level. The schema test pins the per-file statement counts (22 / 3 / 6 / 2 / 8) and asserts every statement begins with a DDL/DML verb, so a mis-parse fails loudly instead of corrupting a fixture.

**Foreign keys are enforced.** `PRAGMA foreign_keys` is 1 in the workers pool, and the real DDL declares the constraints, so a fixture must seed `players` before `campaigns` before `beats`. A row that production would reject is now rejected in tests too — which is the point.

Note on the existing `test/integration/email-handler.test.ts`: it declares its own inline `SCHEMA` constant. **Leave it alone.** Migrating it is unrelated churn; the helper is for new tests.

- [ ] **Step 1: Write the failing test**

Create `test/integration/dm-migration.test.ts`. It has three parts: the fixture's own guard rails (the split is whole, every table exists, constraints are real), the two column-shape assertions, and — the one that matters — the backfill, exercised the only way it can be: apply 0001–0004, write a beat against that older shape, then run 0005 over it.

```ts
/**
 * The slice-1 schema, and the one migration hazard in it.
 *
 * Adding `beats.published_at` with a NULL default retroactively marks every
 * historical beat as "held in review", which would empty the chronicle of every
 * campaign in production. The backfill is the point of this test.
 *
 * These run against `migrations/*.sql` themselves, not a restatement of them
 * (see `test/helpers/schema.ts`). Deleting `0005_dm.sql`, or deleting its
 * `UPDATE beats` line, turns this file red.
 */

import { env as runtimeEnv } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  MIGRATIONS,
  applySchema,
  applySchemaThrough,
  resetDatabase,
  splitStatements,
} from "../helpers/schema";
import type { Env } from "../../src/env";

const env = runtimeEnv as unknown as Env;

/** Every table the five migrations create. `applySchema` must produce all of them. */
const PRODUCTION_TABLES = [
  "auth_tokens",
  "beats",
  "campaigns",
  "downtime",
  "email_loopback",
  "entities",
  "events",
  "invites",
  "journals",
  "letters",
  "memberships",
  "players",
  "projection_failures",
  "rate_limits",
  "reply_bindings",
  "settings",
  "token_budget",
];

/**
 * Statements per migration file.
 *
 * This is the guard on the splitter. Three of these files carry a semicolon
 * inside a `--` comment, so `split(";")` would report 24/3/7/2/8 and hand D1
 * sheared fragments; the numbers below are the real statement counts. If a
 * migration is edited, update the number deliberately — a surprise here means
 * the splitter mis-parsed something.
 */
const STATEMENT_COUNTS: Record<string, number> = {
  "0001_init.sql": 22,
  "0002_invites.sql": 3,
  "0003_ops.sql": 6,
  "0004_email_loopback.sql": 2,
  "0005_dm.sql": 8,
};

async function tableNames(): Promise<string[]> {
  const { results } = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all<{ name: string }>();
  return results.map((r) => r.name);
}

describe("the migration fixture", () => {
  it("splits every migration into whole statements", () => {
    for (const migration of MIGRATIONS) {
      expect(migration.queries.length, migration.name).toBe(
        STATEMENT_COUNTS[migration.name],
      );
      for (const query of migration.queries) {
        // A comment-semicolon shear leaves a fragment starting mid-sentence.
        // Every real statement here starts with one of these verbs.
        expect(query, `${migration.name}: ${query.slice(0, 60)}`).toMatch(
          /^(CREATE|ALTER|UPDATE|INSERT|DROP)\b/i,
        );
      }
    }
  });

  it("keeps a semicolon that lives inside a comment out of the statement stream", () => {
    const sql = [
      "-- a semicolon; inside a comment",
      "CREATE TABLE a (x TEXT DEFAULT 'has ; inside');",
      "CREATE TABLE b (y TEXT);",
    ].join("\n");
    expect(splitStatements(sql)).toEqual([
      "CREATE TABLE a (x TEXT DEFAULT 'has ; inside')",
      "CREATE TABLE b (y TEXT)",
    ]);
  });

  it("creates every table this project uses", async () => {
    await resetDatabase(env.DB);
    await applySchema(env.DB);
    expect(await tableNames()).toEqual(
      expect.arrayContaining(PRODUCTION_TABLES),
    );
  });

  it("carries production's constraints, not a relaxed copy of them", async () => {
    await resetDatabase(env.DB);
    await applySchema(env.DB);
    // REFERENCES survives: a campaign with no such creator is rejected.
    await expect(
      env.DB.prepare(
        `INSERT INTO campaigns (id, slug, name, cadence, created_by, created_at)
         VALUES ('cmp_orphan', 'orphan', 'Orphan', 'weekly', 'plr_nobody', '2026-01-01T00:00:00Z')`,
      ).run(),
    ).rejects.toThrow(/FOREIGN KEY/i);
  });
});

describe("slice-1 schema", () => {
  beforeEach(async () => {
    await resetDatabase(env.DB);
    await applySchema(env.DB);
  });

  it("gives campaigns a DM seat and a window, both empty by default", async () => {
    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO players (id, email, created_at) VALUES ('plr_a', 'a@example.com', ?)",
    ).bind(now).run();
    await env.DB.prepare(
      `INSERT INTO campaigns (id, slug, name, cadence, created_by, created_at)
       VALUES ('cmp_a', 'a', 'A', 'weekly', 'plr_a', ?)`,
    ).bind(now).run();

    const row = await env.DB.prepare(
      "SELECT dm_player_id, review_window_ms FROM campaigns WHERE id = 'cmp_a'",
    ).first<{ dm_player_id: string | null; review_window_ms: number | null }>();

    expect(row?.dm_player_id).toBeNull();
    expect(row?.review_window_ms).toBeNull();
  });

  it("gives beats the publication and revision columns", async () => {
    const now = new Date().toISOString();
    // `beats.campaign_id` REFERENCES campaigns, which REFERENCES players, so
    // the row this test is actually about needs both seeded first.
    await env.DB.prepare(
      "INSERT INTO players (id, email, created_at) VALUES ('plr_b', 'b@example.com', ?)",
    ).bind(now).run();
    await env.DB.prepare(
      `INSERT INTO campaigns (id, slug, name, cadence, created_by, created_at)
       VALUES ('cmp_b', 'b', 'B', 'weekly', 'plr_b', ?)`,
    ).bind(now).run();
    await env.DB.prepare(
      `INSERT INTO beats (campaign_id, tick, prose, situation, source, created_at)
       VALUES ('cmp_b', 1, 'The gate holds.', 'At the gate.', 'model', ?)`,
    ).bind(now).run();

    const row = await env.DB.prepare(
      "SELECT published_at, revised_by, original_prose FROM beats WHERE campaign_id = 'cmp_b'",
    ).first<{ published_at: string | null; revised_by: string | null; original_prose: string | null }>();

    expect(row).not.toBeNull();
    expect(row?.revised_by).toBeNull();
    expect(row?.original_prose).toBeNull();
  });
});

describe("the 0005 backfill", () => {
  /**
   * The hazard, reproduced: a beat that existed before `published_at` did.
   *
   * Applying 0001–0004 only, writing a beat against that older shape, and then
   * running 0005 over it is the one arrangement in which the `UPDATE beats SET
   * published_at = created_at` line does any work. Delete that line and this
   * test fails.
   */
  async function seedLegacyBeatThenMigrate(): Promise<void> {
    await resetDatabase(env.DB);
    await applySchemaThrough(env.DB, "0004_email_loopback.sql");

    await env.DB.prepare(
      "INSERT INTO players (id, email, created_at) VALUES ('plr_old', 'old@example.com', '2025-12-01T00:00:00Z')",
    ).run();
    await env.DB.prepare(
      `INSERT INTO campaigns (id, slug, name, cadence, created_by, created_at)
       VALUES ('cmp_old', 'old', 'Old Hold', 'weekly', 'plr_old', '2025-12-01T00:00:00Z')`,
    ).run();
    await env.DB.prepare(
      `INSERT INTO beats (campaign_id, tick, prose, situation, source, created_at)
       VALUES ('cmp_old', 1, 'The gate held, once.', 'At the gate.', 'model', '2026-01-01T00:00:00Z')`,
    ).run();

    await applySchema(env.DB);
  }

  it("has no published_at column before 0005 runs", async () => {
    await resetDatabase(env.DB);
    await applySchemaThrough(env.DB, "0004_email_loopback.sql");
    const { results } = await env.DB.prepare("PRAGMA table_info(beats)").all<{ name: string }>();
    expect(results.map((r) => r.name)).not.toContain("published_at");
  });

  it("leaves no pre-existing beat held in review", async () => {
    await seedLegacyBeatThenMigrate();

    const held = await env.DB.prepare(
      "SELECT count(*) AS n FROM beats WHERE published_at IS NULL",
    ).first<{ n: number }>();
    expect(held?.n).toBe(0);
  });

  it("backfills published_at from created_at, so the chronicle keeps its history", async () => {
    await seedLegacyBeatThenMigrate();

    const row = await env.DB.prepare(
      "SELECT published_at FROM beats WHERE campaign_id = 'cmp_old' AND tick = 1",
    ).first<{ published_at: string | null }>();

    expect(row?.published_at).toBe("2026-01-01T00:00:00Z");
  });

  it("still defaults a beat written after the migration to held", async () => {
    // The backfill must be a one-time repair, not a default that would make
    // `published_at` meaningless for beats the DM is supposed to hold.
    await seedLegacyBeatThenMigrate();
    await env.DB.prepare(
      `INSERT INTO beats (campaign_id, tick, prose, situation, source, created_at)
       VALUES ('cmp_old', 2, 'The gate holds.', 'At the gate.', 'model', '2026-02-01T00:00:00Z')`,
    ).run();

    const row = await env.DB.prepare(
      "SELECT published_at FROM beats WHERE campaign_id = 'cmp_old' AND tick = 2",
    ).first<{ published_at: string | null }>();

    expect(row?.published_at).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npm test -- test/integration/dm-migration.test.ts
```

Expected: FAIL — `test/helpers/schema.ts` does not exist, so the import cannot resolve.

- [ ] **Step 3: Write the migration**

Create `migrations/0005_dm.sql`:

```sql
-- The DM seat, and the review window that gives it something to do.
--
-- The seat is a single column rather than a `memberships.role` value, so
-- "exactly one DM per campaign" is structural rather than something application
-- code has to remember to enforce. `memberships.role` stays vestigial: it is
-- written at join time and read nowhere, authorization lives on
-- `campaigns.created_by` (host) and `campaigns.dm_player_id` (DM), and SQLite
-- cannot alter its CHECK constraint anyway.
ALTER TABLE campaigns ADD COLUMN dm_player_id TEXT REFERENCES players(id);

-- NULL means "use the cadence default" (2h daily / 24h weekly / 72h monthly),
-- so changing cadence does the right thing without a second edit. 0 means
-- publish immediately and let the DM edit afterwards.
ALTER TABLE campaigns ADD COLUMN review_window_ms INTEGER;

-- Consecutive review windows that expired without the DM touching anything.
-- At 3 the seat reverts to the host: going quiet should cost nothing, it should
-- just hand the chair to someone who is there.
ALTER TABLE campaigns ADD COLUMN dm_missed_windows INTEGER NOT NULL DEFAULT 0;

-- NULL = held in DM review, not yet visible to players and not yet mailed.
ALTER TABLE beats ADD COLUMN published_at TEXT;
-- Who rewrote the prose, if anyone. Attribution is the whole accountability
-- story for a DM who also plays a character.
ALTER TABLE beats ADD COLUMN revised_by TEXT REFERENCES players(id);
-- What the model or the template originally wrote, retained so a rewrite is
-- always recoverable.
ALTER TABLE beats ADD COLUMN original_prose TEXT;

-- Without this every beat written before this migration is NULL and therefore
-- "held", which empties the chronicle of every existing campaign.
UPDATE beats SET published_at = created_at WHERE published_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_beats_published
  ON beats(campaign_id, published_at);
```

- [ ] **Step 4: Write the test schema helper**

Create `test/helpers/schema.ts`. Do not restate the DDL here — read the migration files:

```ts
/**
 * Test fixtures get the production schema, not a restatement of it.
 *
 * The workers pool hands us a real D1 instance but does not run `migrations/`,
 * so this helper reads the migration files themselves — via Vite's `?raw` — and
 * applies them in filename order. Nothing here describes the schema. That is
 * the point: a fixture that restates the DDL drifts from production silently,
 * accepts rows production rejects (it had no `CHECK` or `REFERENCES` clauses),
 * and leaves the migrations with zero automated coverage. Reading the files
 * means every constraint and every table is exactly what ships, and deleting or
 * breaking a migration turns the suite red.
 *
 * `PRAGMA foreign_keys` is 1 in this pool, so foreign keys really are enforced
 * here. Fixtures must seed parents before children.
 */

import { applyD1Migrations, type D1Migration } from "cloudflare:test";

/**
 * Split a migration file into executable statements.
 *
 * `sql.split(";")` is *not* safe for these files. Three of them carry a
 * semicolon inside a `--` comment (`0001_init.sql` lines 83 and 113,
 * `0003_ops.sql` line 5), and a naive split shears each of those into two
 * fragments — half a comment and a chunk of DDL that no longer parses. So this
 * walks the text instead, skipping comments and quoted spans, and breaks only
 * on a semicolon at top level.
 *
 * Spans handled: `--` line comments, C-style block comments, `'…'` and `"…"`
 * and `` `…` `` with doubled-quote escapes, and `[…]` identifier quoting.
 *
 * Not handled: a compound statement body (`CREATE TRIGGER … BEGIN … END;`),
 * which would need SQLite's keyword-aware rule. No migration has one, and
 * `dm-migration.test.ts` asserts the per-file statement counts and that every
 * statement begins with a DDL/DML keyword — so adding a trigger fails loudly
 * there rather than corrupting a fixture quietly.
 */
export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let i = 0;

  while (i < sql.length) {
    const ch = sql[i]!;
    const next = sql[i + 1];

    if (ch === "-" && next === "-") {
      // Drop the comment, keep the newline so tokens stay separated.
      while (i < sql.length && sql[i] !== "\n") i++;
      continue;
    }

    if (ch === "/" && next === "*") {
      i += 2;
      while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i += 2;
      current += " ";
      continue;
    }

    if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch;
      current += ch;
      i++;
      while (i < sql.length) {
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) {
            // A doubled quote is a literal quote, not the end of the span.
            current += quote + quote;
            i += 2;
            continue;
          }
          current += quote;
          i++;
          break;
        }
        current += sql[i]!;
        i++;
      }
      continue;
    }

    if (ch === "[") {
      while (i < sql.length && sql[i] !== "]") {
        current += sql[i]!;
        i++;
      }
      current += "]";
      i++;
      continue;
    }

    if (ch === ";") {
      const done = current.trim();
      if (done) statements.push(done);
      current = "";
      i++;
      continue;
    }

    current += ch;
    i++;
  }

  const tail = current.trim();
  if (tail) statements.push(tail);
  return statements;
}

/**
 * Every migration, in the order D1 applies them.
 *
 * Discovered rather than listed. `import.meta.glob` is resolved by Vite at
 * build time — the workers runtime never globs anything — so this is a static
 * set of imports by the time it runs, and a new `migrations/*.sql` is picked up
 * with no edit here.
 *
 * That matters more than the saved line. A hand-maintained list is a fixture
 * that silently stops covering the schema the moment someone forgets it: the
 * missing table only surfaces later as `no such table` in whichever unrelated
 * test happens to touch it next. Review proved that gap was real — an unlisted
 * migration left the suite fully green.
 */
const SOURCES = import.meta.glob<string>("../../migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});

export const MIGRATIONS: D1Migration[] = Object.keys(SOURCES)
  // Glob order is not guaranteed; D1 applies migrations in filename order and
  // 0005 depends on 0001's tables existing.
  .sort()
  .map((path) => ({
    name: path.slice(path.lastIndexOf("/") + 1),
    queries: splitStatements(SOURCES[path]!),
  }));

/**
 * Bring `db` up to the current schema — every table this project uses, with
 * production's constraints.
 *
 * Idempotent: `applyD1Migrations` records what it has run in `d1_migrations`
 * and skips those, so calling this from `beforeEach` across a whole file is
 * safe even though the pool shares one D1 instance between tests in a file.
 */
export async function applySchema(db: D1Database): Promise<void> {
  await applyD1Migrations(db, MIGRATIONS);
}

/**
 * Bring `db` up to `name` and stop — the state the database was in *before* the
 * next migration ran.
 *
 * This is what makes a backfill testable: seed rows against the old shape, then
 * call `applySchema` to run the remaining migration over them for real.
 */
export async function applySchemaThrough(db: D1Database, name: string): Promise<void> {
  const index = MIGRATIONS.findIndex((m) => m.name === name);
  if (index < 0) throw new Error(`no such migration: ${name}`);
  await applyD1Migrations(db, MIGRATIONS.slice(0, index + 1));
}

/**
 * Drop everything, including the `d1_migrations` bookkeeping, so the next
 * `applySchema` runs the whole chain from bare.
 *
 * Foreign keys are on, so `DROP TABLE` on a parent that still has children
 * fails. Rather than hard-code a dependency order that a future migration would
 * invalidate, drop what can be dropped and repeat until a pass makes no
 * progress.
 */
export async function resetDatabase(db: D1Database): Promise<void> {
  // `_cf_%` is D1's own bookkeeping (`_cf_METADATA`); the runtime refuses to
  // drop it, and it is not part of anyone's schema.
  const { results } = await db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' " +
        "AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'",
    )
    .all<{ name: string }>();

  let pending = results.map((r) => r.name);
  while (pending.length > 0) {
    const blocked: string[] = [];
    let lastError: unknown;
    for (const name of pending) {
      try {
        await db.prepare(`DROP TABLE IF EXISTS "${name.replace(/"/g, '""')}"`).run();
      } catch (err) {
        lastError = err;
        blocked.push(name);
      }
    }
    if (blocked.length === pending.length) {
      throw new Error(`could not drop ${blocked.join(", ")}: ${String(lastError)}`);
    }
    pending = blocked;
  }
}
```

And declare both Vite features the helper leans on in `test/env.d.ts`, alongside the existing `cloudflare:workers` augmentation. Without these `npm test` passes but `npm run typecheck` fails:

```ts
// Vite's `?raw` suffix, used by `test/helpers/schema.ts` to read the real
// migration files rather than restate them.
declare module "*.sql?raw" {
  const sql: string;
  export default sql;
}

// `import.meta.glob`, used by the same helper to discover every migration
// instead of hand-listing them. Declared here rather than pulling in
// `vite/client` wholesale, which would also drag in DOM-flavoured asset and
// CSS-module types that nothing in this project uses.
interface ImportMeta {
  glob<T = unknown>(
    pattern: string,
    options?: { query?: string; import?: string; eager?: boolean },
  ): Record<string, T>;
}
```

- [ ] **Step 5: Run the test and watch it pass**

```bash
npm test -- test/integration/dm-migration.test.ts
```

Expected: PASS, 10 tests.

- [ ] **Step 6: Prove the backfill test actually tests the backfill**

A migration test that stays green when the migration is gone is worth nothing — which is exactly what a hand-restated fixture produces. Mutate the migration and watch the suite fail. Both mutations must go red; restore after each.

```bash
cp migrations/0005_dm.sql /tmp/0005_dm.sql.bak
```

Delete the backfill line — `UPDATE beats SET published_at = created_at WHERE published_at IS NULL;` — from `migrations/0005_dm.sql`, then:

```bash
npm test -- test/integration/dm-migration.test.ts
```

Expected: FAIL. "leaves no pre-existing beat held in review" reports 1 instead of 0, and "backfills published_at from created_at" reports `null` instead of `2026-01-01T00:00:00Z`. That `null` is the production hazard, reproduced: every beat written before the migration would be held, and every existing campaign's chronicle would go blank.

Restore it, delete the whole file, and run again:

```bash
cp /tmp/0005_dm.sql.bak migrations/0005_dm.sql && rm migrations/0005_dm.sql && npm test
```

Expected: FAIL — `ENOENT: no such file or directory, open '../../migrations/0005_dm.sql'`, because the fixture imports the file rather than describing it.

```bash
cp /tmp/0005_dm.sql.bak migrations/0005_dm.sql && npm test && npm run typecheck
```

Expected: green again, and `git status migrations/` clean.

(The earlier version of this step drove `wrangler d1 execute --local` by hand. It could not work: it inserted into `beats` before any schema existed, and the row violated `beats.campaign_id REFERENCES campaigns(id)` and `campaigns.created_by REFERENCES players(id)`. The automated test above replaces it and runs on every commit.)

- [ ] **Step 7: Commit**

```bash
git add migrations/0005_dm.sql test/helpers/schema.ts test/env.d.ts test/integration/dm-migration.test.ts && git commit -m "feat: schema for the DM seat and the review window"
```

---

### Task 2: The seat — assign, vacate, reclaim

**Files:**
- Create: `src/dm/seat.ts`
- Modify: `src/index.ts` — the route regex at line 266, and a new `/dm` branch after the `/invite` branch (line 288)
- Test: `test/integration/dm-seat.test.ts`

**Interfaces:**
- Consumes: `applySchema` from `test/helpers/schema.ts` (Task 1).
- Produces, from `src/dm/seat.ts`:
  - `interface Seat { dmPlayerId: string | null; reviewWindowMs: number | null; missedWindows: number }`
  - `getSeat(db: D1Database, campaignId: string): Promise<Seat | null>`
  - `setSeat(db: D1Database, campaignId: string, playerId: string | null): Promise<void>` — also resets `dm_missed_windows` to 0
  - `DEFAULT_WINDOW_MS: Record<"daily" | "weekly" | "monthly", number>`
  - `MAX_WINDOW_MS: Record<"daily" | "weekly" | "monthly", number>`
  - `resolveWindowMs(cadence: string, configured: number | null): number`

`resolveWindowMs` is the single place the default/cap rules live; Tasks 3, 6, and 7 all call it rather than restating the numbers.

- [ ] **Step 1: Write the failing test**

Create `test/integration/dm-seat.test.ts`:

```ts
/**
 * The DM seat: who holds it, who can move it, and what the window resolves to.
 */

import { env as runtimeEnv } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { applySchema } from "../helpers/schema";
import { DEFAULT_WINDOW_MS, getSeat, resolveWindowMs, setSeat } from "../../src/dm/seat";
import type { Env } from "../../src/env";

const env = runtimeEnv as unknown as Env;
const CAMPAIGN = "cmp_seat";

describe("dm seat", () => {
  beforeEach(async () => {
    await applySchema(env.DB);
    for (const t of ["memberships", "campaigns", "players"]) {
      await env.DB.prepare(`DELETE FROM ${t}`).run();
    }
    const now = new Date().toISOString();
    for (const [id, email] of [["plr_host", "host@example.com"], ["plr_two", "two@example.com"]]) {
      await env.DB.prepare(
        "INSERT INTO players (id, email, created_at) VALUES (?, ?, ?)",
      ).bind(id, email, now).run();
    }
    await env.DB.prepare(
      `INSERT INTO campaigns (id, slug, name, cadence, created_by, created_at)
       VALUES (?, 'seat', 'Seat', 'weekly', 'plr_host', ?)`,
    ).bind(CAMPAIGN, now).run();
  });

  it("reads an empty seat", async () => {
    const seat = await getSeat(env.DB, CAMPAIGN);
    expect(seat).toEqual({ dmPlayerId: null, reviewWindowMs: null, missedWindows: 0 });
  });

  it("returns null for a campaign that does not exist", async () => {
    expect(await getSeat(env.DB, "cmp_nope")).toBeNull();
  });

  it("assigns and vacates the seat", async () => {
    await setSeat(env.DB, CAMPAIGN, "plr_two");
    expect((await getSeat(env.DB, CAMPAIGN))?.dmPlayerId).toBe("plr_two");

    await setSeat(env.DB, CAMPAIGN, null);
    expect((await getSeat(env.DB, CAMPAIGN))?.dmPlayerId).toBeNull();
  });

  it("resets the missed-window counter when the seat moves", async () => {
    await env.DB.prepare("UPDATE campaigns SET dm_missed_windows = 2 WHERE id = ?")
      .bind(CAMPAIGN).run();
    await setSeat(env.DB, CAMPAIGN, "plr_two");
    expect((await getSeat(env.DB, CAMPAIGN))?.missedWindows).toBe(0);
  });

  describe("resolveWindowMs", () => {
    it("uses the cadence default when unconfigured", () => {
      expect(resolveWindowMs("weekly", null)).toBe(DEFAULT_WINDOW_MS.weekly);
      expect(resolveWindowMs("daily", null)).toBe(DEFAULT_WINDOW_MS.daily);
    });

    it("honours an explicit zero rather than treating it as unset", () => {
      expect(resolveWindowMs("weekly", 0)).toBe(0);
    });

    it("clamps to the cadence cap", () => {
      // 10 days on a daily campaign would swallow ten whole turns.
      expect(resolveWindowMs("daily", 10 * 86_400_000)).toBe(8 * 3_600_000);
    });

    it("rejects a negative window", () => {
      expect(resolveWindowMs("weekly", -5)).toBe(0);
    });

    it("falls back to the weekly default for an unknown cadence", () => {
      expect(resolveWindowMs("fortnightly", null)).toBe(DEFAULT_WINDOW_MS.weekly);
    });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npm test -- test/integration/dm-seat.test.ts
```

Expected: FAIL — cannot resolve `../../src/dm/seat`.

- [ ] **Step 3: Write the implementation**

Create `src/dm/seat.ts`:

```ts
/**
 * The DM seat.
 *
 * Exactly one player per campaign holds it, which is enforced structurally by
 * it being a single column rather than a membership role. The host owns the
 * campaign and can always reclaim the seat; the seat itself only confers
 * authority over the story.
 *
 * The window numbers live here and nowhere else. Every caller that needs to
 * know how long to hold a beat goes through `resolveWindowMs`.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** How long publication waits by default, per cadence. */
export const DEFAULT_WINDOW_MS = {
  daily: 2 * HOUR,
  weekly: 24 * HOUR,
  monthly: 72 * HOUR,
} as const;

/**
 * A third of the cycle, in each case. Past that the story stops feeling like it
 * runs on a clock, which is the one thing players are promised about timing.
 */
export const MAX_WINDOW_MS = {
  daily: 8 * HOUR,
  weekly: 56 * HOUR,
  monthly: 10 * DAY,
} as const;

type Cadence = keyof typeof DEFAULT_WINDOW_MS;

const isCadence = (v: string): v is Cadence => v in DEFAULT_WINDOW_MS;

export interface Seat {
  dmPlayerId: string | null;
  /** NULL means "use the cadence default". 0 means publish immediately. */
  reviewWindowMs: number | null;
  missedWindows: number;
}

export async function getSeat(db: D1Database, campaignId: string): Promise<Seat | null> {
  const row = await db
    .prepare(
      "SELECT dm_player_id, review_window_ms, dm_missed_windows FROM campaigns WHERE id = ?",
    )
    .bind(campaignId)
    .first<{
      dm_player_id: string | null;
      review_window_ms: number | null;
      dm_missed_windows: number;
    }>();
  if (!row) return null;
  return {
    dmPlayerId: row.dm_player_id,
    reviewWindowMs: row.review_window_ms,
    missedWindows: row.dm_missed_windows ?? 0,
  };
}

/** Assign the seat, or vacate it with `null`. Either way the miss count resets. */
export async function setSeat(
  db: D1Database,
  campaignId: string,
  playerId: string | null,
): Promise<void> {
  await db
    .prepare("UPDATE campaigns SET dm_player_id = ?, dm_missed_windows = 0 WHERE id = ?")
    .bind(playerId, campaignId)
    .run();
}

/**
 * Turn a stored window into the one actually used.
 *
 * `null` is "unset, use the default" and `0` is "publish immediately" — a
 * meaningful distinction, so this cannot be written with `??` alone.
 */
export function resolveWindowMs(cadence: string, configured: number | null): number {
  const key: Cadence = isCadence(cadence) ? cadence : "weekly";
  if (configured === null || configured === undefined) return DEFAULT_WINDOW_MS[key];
  if (!Number.isFinite(configured) || configured <= 0) return 0;
  return Math.min(configured, MAX_WINDOW_MS[key]);
}
```

- [ ] **Step 4: Run the test and watch it pass**

```bash
npm test -- test/integration/dm-seat.test.ts
```

Expected: PASS, 9 tests.

- [ ] **Step 5: Widen the route regex — under `/dm` only**

The current pattern only allows a single lowercase action segment, so `/dm/window` would 404. In `src/index.ts` at line 266, replace:

```ts
  const campaignMatch = /^\/api\/campaigns\/([a-z0-9-]{2,31})(\/[a-z]+)?$/.exec(path);
```

with:

```ts
  // A second segment is allowed under `/dm` and nowhere else, because the DM
  // endpoints are the only nested ones (`/dm/beat`, `/dm/window`).
  const campaignMatch = /^\/api\/campaigns\/([a-z0-9-]{2,31})(\/dm\/[a-z]+|\/[a-z]+)?$/.exec(path);
```

Do **not** reach for a blanket `((?:\/[a-z]+){0,2})?`. That was the first
attempt and it enlarges the API surface for every action, not just `/dm`:
`/invite/extra`, `/action/x`, `/resolve/now`, `/downtime/extra`, `/letter/x`,
`/journal/x` and `/reproject/now` all begin matching, fall through every
`action === "/…"` comparison inside the branch, and return **405 where they
used to 404**. Not a hole — group 2 stays clean and `!member` still gates — but
an unrequested behaviour change that tells a prober "this endpoint exists,
wrong method". The alternation above is exactly as permissive as the original
for every non-DM path; its only new matches are `/dm/<lowercase word>`, which
covers all eight nested DM endpoints in the spec's §8 table and nothing else.

Pin it: assert `/invite/extra`, `/action/x` and `/resolve/now` still 404
alongside the test that asserts `/dm/window` and `/dm/beat` route.

- [ ] **Step 6: Add the seat endpoint**

In `src/index.ts`, immediately after the `/invite` branch closes (line 288) and **before** `if (!member) return fail(403, ...)`, add:

```ts
    // The seat moves by host or by the sitting DM. Reading who holds it is a
    // member-level fact and is served by the campaign GET below, not here.
    if (action === "/dm" && method === "POST") {
      const seat = await getSeat(env.DB, campaign.id);
      const isHost = campaign.created_by === session.playerId;
      const isDm = seat?.dmPlayerId === session.playerId;
      if (!isHost && !isDm) return fail(403, "only the host or the current DM can move the seat");

      // Vacating has to be something the caller *said*, never something the
      // request failed to say. Only an explicit `{ playerId: null }` vacates.
      const body = await readJson<Record<string, unknown>>(request);
      if (body === null || typeof body !== "object" || Array.isArray(body) || !("playerId" in body)) {
        return fail(400, "send { playerId }, or { playerId: null } to vacate the seat");
      }
      const target = body.playerId;
      if (target !== null) {
        // Still an unchecked cast over network input: the key is present, but
        // its value is whatever the caller sent, and handing D1 a non-string to
        // bind throws inside the driver — a malformed request as a 500.
        if (typeof target !== "string") {
          return fail(400, "playerId must be a player id, or null to vacate the seat");
        }
        if (!(await isMember(env, campaign.id, target))) {
          return fail(400, "that person is not in this campaign");
        }
      }
      await setSeat(env.DB, campaign.id, target);
      return json({ ok: true, dmPlayerId: target });
    }
```

Do **not** write `const target = body?.playerId ?? null;`. That was the first
attempt and it is wrong in a way that reads as harmless. `readJson` returns
`null` for an unparseable body **and, identically, for one over its 32 KB
cap**, so `?.`/`??` collapses eleven distinct shapes into "vacate the seat" and
answers `200 {"ok":true}`: `{}`, no body at all, an empty body, non-JSON
garbage, a JSON `null`/`true`/array/string/number, a misspelled key, and — the
one that stings — a well-formed `{"playerId":"plr_…"}` that merely grew past
the cap. A dropped body, a proxy that stripped it, or a truncated client retry
would silently empty the DM seat and report success. The spec
(`docs/specs/2026-08-08-dm-role-design.md` §8) says `{ playerId }` assigns and
`{ playerId: null }` vacates; absent, malformed, or oversized is a 400. Keep
both guards — the envelope check above and the `typeof target !== "string"`
check inside — they catch different things, and dropping the inner one yields
a 500 from the D1 driver.

Add the import at the top of `src/index.ts`, after the `./email/inbound` import:

```ts
import { getSeat, setSeat } from "./dm/seat";
```

- [ ] **Step 7: Add the endpoint tests**

Append to `test/integration/dm-seat.test.ts`, inside the top-level `describe`:

```ts
  describe("POST /api/campaigns/:slug/dm", () => {
    // A signed-in request needs a session cookie; mint one the same way the
    // auth module does rather than reaching through the HTTP login flow.
    async function sessionCookieFor(playerId: string): Promise<string> {
      const { mintSessionForTest } = await import("../helpers/session");
      return mintSessionForTest(env, playerId);
    }

    async function post(playerId: string, body: unknown): Promise<Response> {
      const worker = (await import("../../src/index")).default;
      return worker.fetch!(
        new Request("https://example.com/api/campaigns/seat/dm", {
          method: "POST",
          headers: {
            cookie: await sessionCookieFor(playerId),
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        }),
        env,
        { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext,
      );
    }

    beforeEach(async () => {
      const now = new Date().toISOString();
      for (const id of ["plr_host", "plr_two"]) {
        await env.DB.prepare(
          `INSERT OR IGNORE INTO memberships
             (campaign_id, player_id, character_id, character_name, joined_at)
           VALUES (?, ?, ?, ?, ?)`,
        ).bind(CAMPAIGN, id, `chr_${id}`, id, now).run();
      }
    });

    it("lets the host designate someone else", async () => {
      const res = await post("plr_host", { playerId: "plr_two" });
      expect(res.status).toBe(200);
      expect((await getSeat(env.DB, CAMPAIGN))?.dmPlayerId).toBe("plr_two");
    });

    it("lets the sitting DM hand the seat on", async () => {
      await setSeat(env.DB, CAMPAIGN, "plr_two");
      const res = await post("plr_two", { playerId: "plr_host" });
      expect(res.status).toBe(200);
      expect((await getSeat(env.DB, CAMPAIGN))?.dmPlayerId).toBe("plr_host");
    });

    it("lets the host reclaim from a DM who will not give it up", async () => {
      await setSeat(env.DB, CAMPAIGN, "plr_two");
      const res = await post("plr_host", { playerId: "plr_host" });
      expect(res.status).toBe(200);
      expect((await getSeat(env.DB, CAMPAIGN))?.dmPlayerId).toBe("plr_host");
    });

    it("refuses a member who is neither host nor DM", async () => {
      const res = await post("plr_two", { playerId: "plr_two" });
      expect(res.status).toBe(403);
    });

    it("refuses to seat someone who is not in the campaign", async () => {
      const now = new Date().toISOString();
      await env.DB.prepare("INSERT INTO players (id, email, created_at) VALUES (?,?,?)")
        .bind("plr_out", "out@example.com", now).run();
      const res = await post("plr_host", { playerId: "plr_out" });
      expect(res.status).toBe(400);
    });

    it("vacates on an explicit null", async () => {
      await setSeat(env.DB, CAMPAIGN, "plr_two");
      const res = await post("plr_host", { playerId: null });
      expect(res.status).toBe(200);
      expect((await getSeat(env.DB, CAMPAIGN))?.dmPlayerId).toBeNull();
    });

    // Testing only the shape that *should* vacate is what let the
    // `body?.playerId ?? null` bug through review. Every shape that must not
    // vacate needs a row, and each row asserts the seat is still where it was
    // — a 400 that destroyed the seat anyway would pass a status-only check.
    // Several of these cannot be expressed through `JSON.stringify`, so the
    // request helper needs a way to send raw bytes.
    const MALFORMED: Array<[string, { body?: unknown; raw?: string }]> = [
      ["an empty object", { body: {} }],
      ["no body at all", {}],
      ["an empty body", { raw: "" }],
      ["a body that is not JSON", { raw: "not json at all" }],
      ["a JSON null", { raw: "null" }],
      ["a JSON true", { raw: "true" }],
      ["a JSON array", { raw: '["plr_two"]' }],
      ["a JSON string", { raw: '"plr_two"' }],
      ["a JSON number", { raw: "42" }],
      ["a misspelled key", { body: { player_id: "plr_two" } }],
      [
        "an oversized but otherwise well-formed body",
        { raw: `{"playerId":"plr_two","pad":"${"x".repeat(40_000)}"}` },
      ],
    ];

    for (const [label, init] of MALFORMED) {
      it(`rejects ${label} rather than vacating the seat`, async () => {
        await setSeat(env.DB, CAMPAIGN, "plr_two");
        const res = await call("/api/campaigns/seat/dm", {
          method: "POST",
          playerId: "plr_host",
          ...init,
        });
        expect(res.status, label).toBe(400);
        expect((await getSeat(env.DB, CAMPAIGN))?.dmPlayerId, label).toBe("plr_two");
      });
    }
  });
```

- [ ] **Step 8: Write the session test helper**

Create `test/helpers/session.ts`:

```ts
/**
 * Mint a session cookie for a player without going through the magic-link flow.
 *
 * Tests that exercise authorization need a signed-in request; making each one
 * round-trip an email is noise. This uses the same `sessionCookie` the login
 * callback does, so what is being bypassed is delivery, not verification.
 */

import { sessionCookie } from "../../src/auth";
import type { Env } from "../../src/env";

export async function mintSessionForTest(env: Env, playerId: string): Promise<string> {
  const cookie = await sessionCookie(env, playerId);
  // `sessionCookie` returns a Set-Cookie value; a request needs just name=value.
  return cookie.split(";")[0]!;
}
```

If `sessionCookie` has a different signature than `(env, playerId)`, read `src/auth.ts` and adapt this helper to it — do not change `src/auth.ts` to fit the helper.

- [ ] **Step 9: Seat the creator when a campaign is made**

The spec's default is "the campaign creator holds the seat." Without this the column stays NULL and no campaign ever holds a beat.

In `src/index.ts`, in the `POST /api/campaigns` handler, extend the INSERT at line 247 to seat the creator in the same statement:

```ts
    await env.DB.prepare(
      `INSERT INTO campaigns (id, slug, name, cadence, created_by, dm_player_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(id, slug, name, cadence, session.playerId, session.playerId, new Date().toISOString())
      .run();
```

Add the test to `test/integration/dm-seat.test.ts`, inside the `POST /api/campaigns/:slug/dm` describe:

```ts
    it("seats the creator when a campaign is made", async () => {
      const worker = (await import("../../src/index")).default;
      const res = await worker.fetch!(
        new Request("https://example.com/api/campaigns", {
          method: "POST",
          headers: {
            cookie: await mintSessionForTest(env, "plr_two"),
            "content-type": "application/json",
          },
          body: JSON.stringify({ name: "Fresh", slug: "freshhold", cadence: "weekly" }),
        }),
        env,
        { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext,
      );
      expect(res.status).toBe(201);

      const row = await env.DB.prepare(
        "SELECT dm_player_id FROM campaigns WHERE slug = 'freshhold'",
      ).first<{ dm_player_id: string | null }>();
      expect(row?.dm_player_id).toBe("plr_two");
    });
```

Import `mintSessionForTest` at the top of the test file rather than the dynamic import used elsewhere in it:

```ts
import { mintSessionForTest } from "../helpers/session";
```

and simplify `sessionCookieFor` to call it directly.

- [ ] **Step 10: Run the tests and watch them pass**

```bash
npm test -- test/integration/dm-seat.test.ts
```

Expected: PASS, 16 tests.

- [ ] **Step 11: Full gates, then commit**

```bash
npm test && npm run typecheck
```

```bash
git add src/dm/seat.ts src/index.ts test/helpers/session.ts test/integration/dm-seat.test.ts && git commit -m "feat: a transferable DM seat, distinct from the host"
```

---

### Task 3: The phase machine — hold a beat instead of publishing it

**Files:**
- Modify: `src/campaign-do.ts` — `resolveTick` (line 400), `#scheduleNextTick` (line 533), `#project` (line 597), `alarm` (line 394)
- Test: `test/integration/dm-window.test.ts`

**Interfaces:**
- Consumes: `getSeat`, `resolveWindowMs` from `src/dm/seat.ts` (Task 2).
- Produces, on `CampaignDO`:
  - `publishHeldBeat(): Promise<{ published: boolean; tick: number | null }>` — idempotent; returns `published: false` when there was nothing held
  - `reviewState(): Promise<{ phase: "open" | "review"; heldTick: number | null; windowClosesAt: number | null }>`
  - `TickSummary` gains `held: boolean`

This is the core of the slice. Read the whole task before starting.

**How the alarm is shared.** The DO has exactly one alarm. A `phase` key in `meta` says what the next firing means. On resolution the *absolute* next tick deadline is computed and stored as `nextDeadlineAt`, then the alarm is set to the window's end instead. When the window fires, the beat publishes and the alarm is reset to the stored `nextDeadlineAt` — so the cadence never drifts, no matter how long the window was.

**Where the seat is read.** The DO reads `campaigns.dm_player_id` and `review_window_ms` from D1 at resolution time. If that read throws, treat it as "no DM" and publish immediately: a D1 blip must degrade to today's behavior, never strand a beat.

- [ ] **Step 1: Write the failing test**

Create `test/integration/dm-window.test.ts`:

```ts
/**
 * The review window.
 *
 * The property under test is that a tick resolves on the clock while
 * publication waits — and that publication happens exactly once no matter which
 * path gets there first.
 */

import { env as runtimeEnv } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { applySchema } from "../helpers/schema";
import { setSeat } from "../../src/dm/seat";
import type { Env } from "../../src/env";

const env = runtimeEnv as unknown as Env;
const CAMPAIGN = "cmp_win";
const HOST = "plr_host";

function stub() {
  return env.CAMPAIGN.get(env.CAMPAIGN.idFromName(CAMPAIGN));
}

async function seedCampaign(): Promise<void> {
  await applySchema(env.DB);
  for (const t of ["beats", "events", "entities", "memberships", "campaigns", "players"]) {
    await env.DB.prepare(`DELETE FROM ${t}`).run();
  }
  const now = new Date().toISOString();
  await env.DB.prepare("INSERT INTO players (id, email, created_at) VALUES (?,?,?)")
    .bind(HOST, "host@example.com", now).run();
  await env.DB.prepare(
    `INSERT INTO campaigns (id, slug, name, cadence, created_by, created_at)
     VALUES (?, 'win', 'Windy Hold', 'weekly', ?, ?)`,
  ).bind(CAMPAIGN, HOST, now).run();

  const campaign = stub();
  await campaign.init({ campaignId: CAMPAIGN, slug: "win", name: "Windy Hold", cadence: "weekly" });
  const joined = await campaign.join(HOST, "Host");
  await env.DB.prepare(
    `INSERT INTO memberships (campaign_id, player_id, character_id, character_name, joined_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).bind(CAMPAIGN, HOST, joined.characterId, joined.characterName, now).run();
}

async function beatRow(tick: number) {
  return env.DB.prepare(
    "SELECT tick, prose, published_at FROM beats WHERE campaign_id = ? AND tick = ?",
  ).bind(CAMPAIGN, tick).first<{ tick: number; prose: string; published_at: string | null }>();
}

describe("review window", () => {
  beforeEach(seedCampaign);

  it("publishes immediately when no DM holds the seat", async () => {
    const summary = await stub().resolveTick("manual");
    expect(summary.held).toBe(false);
    expect((await beatRow(summary.tick))?.published_at).not.toBeNull();
  });

  it("holds the beat when a DM holds the seat", async () => {
    await setSeat(env.DB, CAMPAIGN, HOST);
    const summary = await stub().resolveTick("manual");

    expect(summary.held).toBe(true);
    // Canon advanced — only publication is waiting.
    expect(summary.tick).toBeGreaterThan(0);
    expect((await beatRow(summary.tick))?.published_at).toBeNull();
  });

  it("reports the phase and when the window closes", async () => {
    await setSeat(env.DB, CAMPAIGN, HOST);
    const summary = await stub().resolveTick("manual");
    const state = await stub().reviewState();

    expect(state.phase).toBe("review");
    expect(state.heldTick).toBe(summary.tick);
    expect(state.windowClosesAt).toBeGreaterThan(Date.now());
  });

  it("publishes on demand and returns to the open phase", async () => {
    await setSeat(env.DB, CAMPAIGN, HOST);
    const summary = await stub().resolveTick("manual");

    const out = await stub().publishHeldBeat();
    expect(out).toEqual({ published: true, tick: summary.tick });
    expect((await beatRow(summary.tick))?.published_at).not.toBeNull();
    expect((await stub().reviewState()).phase).toBe("open");
  });

  it("is idempotent — a second publish is a no-op, not a duplicate", async () => {
    await setSeat(env.DB, CAMPAIGN, HOST);
    await stub().resolveTick("manual");

    const first = await stub().publishHeldBeat();
    const second = await stub().publishHeldBeat();
    expect(first.published).toBe(true);
    expect(second).toEqual({ published: false, tick: null });
  });

  it("publishes with no DM seated without error", async () => {
    await stub().resolveTick("manual");
    expect(await stub().publishHeldBeat()).toEqual({ published: false, tick: null });
  });

  it("does not let the review window push the tick deadline out", async () => {
    await setSeat(env.DB, CAMPAIGN, HOST);
    const before = Date.now();
    await stub().resolveTick("manual");

    const snapshot = await stub().snapshot();
    const weekMs = 7 * 24 * 3_600_000;
    // The countdown players see is the tick deadline, not the window's end.
    expect(snapshot.deadlineAt).toBeGreaterThan(before + weekMs - 60_000);
    expect(snapshot.deadlineAt).toBeLessThan(before + weekMs + 60_000);
  });

  it("heals a lost review alarm by publishing on the next resolution", async () => {
    await setSeat(env.DB, CAMPAIGN, HOST);
    const first = await stub().resolveTick("manual");
    expect((await beatRow(first.tick))?.published_at).toBeNull();

    // The review alarm never fires; the next tick resolves anyway.
    const second = await stub().resolveTick("manual");
    expect((await beatRow(first.tick))?.published_at).not.toBeNull();
    expect(second.tick).toBeGreaterThan(first.tick);
  });

  it("publishes immediately when the window is zero", async () => {
    await setSeat(env.DB, CAMPAIGN, HOST);
    await env.DB.prepare("UPDATE campaigns SET review_window_ms = 0 WHERE id = ?")
      .bind(CAMPAIGN).run();

    const summary = await stub().resolveTick("manual");
    expect(summary.held).toBe(false);
    expect((await beatRow(summary.tick))?.published_at).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npm test -- test/integration/dm-window.test.ts
```

Expected: FAIL — `summary.held` is undefined and `reviewState`/`publishHeldBeat` are not functions.

- [ ] **Step 3: Add the imports and the summary field**

In `src/campaign-do.ts`, add after the `./dm/fallback` import (line 23):

```ts
import { getSeat, resolveWindowMs } from "./dm/seat";
```

Extend `TickSummary` (line 59) with one field:

```ts
export type TickSummary = {
  tick: number;
  /** "model" or "templated" — surfaced honestly, including to smoke tests. */
  source: string;
  eventCount: number;
  /** Player ids whose action was auto-chosen this tick. */
  drifted: string[];
  reason: "quorum" | "deadline" | "manual";
  /** True when the beat is waiting on the DM rather than already sent. */
  held: boolean;
};
```

Both early-return paths in `resolveTick` (the invariant-violation return at line 478 and the success return at line 524) need `held` added. The violation path is always `held: false` — a blocked beat has nothing to review.

- [ ] **Step 4: Split scheduling into two phases**

Replace `#scheduleNextTick` (line 533) with these three methods:

```ts
  /**
   * Compute and store the next tick deadline, and arm the alarm for it.
   *
   * The deadline is absolute from the moment a tick resolves. A review window
   * is carved out of the front of the next cycle rather than added to it, so
   * however long the DM takes, the clock the group agreed to does not drift.
   */
  async #scheduleNextTick(): Promise<void> {
    const config = this.#config();
    const at = Date.now() + CADENCE_MS[config.cadence];
    this.#put("nextDeadlineAt", at);
    await this.#armFor(at);
  }

  /** Point the single alarm at a moment, and mirror it to D1 for the countdown. */
  async #armFor(at: number): Promise<void> {
    await this.ctx.storage.setAlarm(at);
    this.#put("deadlineAt", this.#get<number>("nextDeadlineAt") ?? at);
    try {
      await this.env.DB.prepare("UPDATE campaigns SET deadline_at = ?, tick = ? WHERE id = ?")
        .bind(this.#get<number>("nextDeadlineAt") ?? at, this.#world().tick, this.#world().campaignId)
        .run();
    } catch {
      /* the DO alarm is the real clock; D1 only mirrors it for display */
    }
  }

  /**
   * Hold publication and arm the alarm for the window's end instead.
   *
   * `nextDeadlineAt` is already stored, so the alarm can be handed back to the
   * tick clock the moment the beat publishes.
   */
  async #openReviewWindow(tick: number, windowMs: number): Promise<void> {
    const closesAt = Date.now() + windowMs;
    this.#put("phase", "review");
    this.#put("heldTick", tick);
    this.#put("windowClosesAt", closesAt);
    await this.ctx.storage.setAlarm(closesAt);
  }
```

- [ ] **Step 5: Teach the alarm which phase it is in**

Replace `alarm()` (line 394):

```ts
  override async alarm(): Promise<void> {
    // One alarm, two meanings. In `review` it ends the DM's window; otherwise
    // it is the tick clock.
    if (this.#get<string>("phase") === "review") {
      await this.publishHeldBeat({ expired: true });
      return;
    }
    await this.resolveTick("deadline");
  }
```

- [ ] **Step 6: Hold instead of fanning out**

In `resolveTick`, replace the block from `await this.#project(...)` through the `ctx.waitUntil(this.#fanOut(...))` call (lines 512–522) with:

```ts
    // A held beat from a previous window that never published — a lost alarm,
    // or a manual resolve during review. Publish it before moving on, so no
    // beat can ever be stranded unseen.
    await this.publishHeldBeat({ expired: true });

    await this.#project(result.state, result.events, beat, meta);
    await this.#scheduleNextTick();

    const windowMs = await this.#reviewWindowMs();
    if (windowMs > 0) {
      // Canon has advanced and the beat is written; only delivery waits.
      this.#put("heldFanOut", {
        tick: result.state.tick,
        recaps: result.recaps,
        autoBy: Object.fromEntries(
          result.resolutions
            .filter((r) => r.action.auto)
            .map((r) => [r.action.characterId, r.action.intent]),
        ),
      });
      await this.#openReviewWindow(result.state.tick, windowMs);
      return { ...summaryFields, held: true };
    }

    // A deadline tick has no HTTP caller, so the fan-out has to happen here.
    // Detached: nobody should wait on N mail sends, and a bounce must not roll
    // back a tick that already resolved.
    await this.#markPublished(result.state.tick);
    this.ctx.waitUntil(
      this.#fanOut(result.state, beat, result, meta).catch((err) => {
        console.error("fan-out failed", err);
      }),
    );
    return { ...summaryFields, held: false };
```

where `summaryFields` is the existing return object, hoisted just above:

```ts
    const summaryFields = {
      tick: result.state.tick,
      source: beat.source,
      eventCount: result.events.length,
      drifted: result.resolutions.filter((r) => r.action.auto).map((r) => r.action.playerId),
      reason,
    };
```

Delete the old trailing `return { ... }` at lines 524–530.

- [ ] **Step 7: Add the window lookup, publish, and state readers**

Add these methods to `CampaignDO`, next to `resolveTick`:

```ts
  /**
   * How long to hold this campaign's next beat, from the D1 seat row.
   *
   * A read failure means "publish now". A blip in the read model must degrade
   * to today's behavior, never leave a beat sitting unseen.
   */
  async #reviewWindowMs(): Promise<number> {
    try {
      const seat = await getSeat(this.env.DB, this.#world().campaignId);
      if (!seat?.dmPlayerId) return 0;
      return resolveWindowMs(this.#config().cadence, seat.reviewWindowMs);
    } catch (err) {
      console.error("seat lookup failed; publishing immediately", err);
      return 0;
    }
  }

  async #markPublished(tick: number): Promise<void> {
    try {
      await this.env.DB.prepare(
        "UPDATE beats SET published_at = ? WHERE campaign_id = ? AND tick = ? AND published_at IS NULL",
      )
        .bind(new Date().toISOString(), this.#world().campaignId, tick)
        .run();
    } catch (err) {
      await this.#recordProjectionFailure(this.#world().campaignId, tick, "publish", err);
    }
  }

  /**
   * Publish whatever is held: mark the beat visible, mail it, hand the alarm
   * back to the tick clock.
   *
   * Idempotent by design — the review alarm, the DM's publish button, and the
   * next tick's self-heal can all race to get here, and only one of them should
   * result in mail going out.
   */
  async publishHeldBeat(opts: { expired?: boolean } = {}): Promise<{
    published: boolean;
    tick: number | null;
  }> {
    const tick = this.#get<number>("heldTick");
    if (this.#get<string>("phase") !== "review" || tick === null) {
      return { published: false, tick: null };
    }

    // Clear the phase first. If mail throws we must not re-enter this method
    // and send twice; the beat is already canon and already written.
    this.#put("phase", "open");
    this.#put("heldTick", null);
    this.#put("windowClosesAt", null);

    await this.#markPublished(tick);

    const held = this.#get<{
      tick: number;
      recaps: Record<string, string[]>;
      autoBy: Record<string, string>;
    }>("heldFanOut");
    this.#put("heldFanOut", null);

    const state = this.#world();
    const meta = this.#get<{ name: string; slug: string }>("meta") ?? { name: "Campaign", slug: "c" };
    const row = await this.env.DB.prepare(
      "SELECT prose, situation, source FROM beats WHERE campaign_id = ? AND tick = ?",
    )
      .bind(state.campaignId, tick)
      .first<{ prose: string; situation: string; source: string }>();

    if (row && held) {
      // Read the prose back from D1 rather than from memory: the DM may have
      // rewritten it during the window, and what publishes must be their
      // version, not the one narration produced.
      const beat = { prose: row.prose, situation: row.situation, source: row.source } as Beat;
      const resolutions = Object.entries(held.autoBy).map(([characterId, intent]) => ({
        action: { characterId, intent, auto: true } as PlayerAction,
      }));
      this.ctx.waitUntil(
        this.#fanOut(state, beat, { resolutions, recaps: held.recaps }, meta).catch((err) => {
          console.error("fan-out failed", err);
        }),
      );
    }

    if (opts.expired) await this.#countMissedWindow();
    else await this.#resetMissedWindows();

    await this.#armFor(this.#get<number>("nextDeadlineAt") ?? Date.now() + 60_000);
    return { published: true, tick };
  }

  async reviewState(): Promise<{
    phase: "open" | "review";
    heldTick: number | null;
    windowClosesAt: number | null;
  }> {
    return {
      phase: this.#get<string>("phase") === "review" ? "review" : "open",
      heldTick: this.#get<number>("heldTick"),
      windowClosesAt: this.#get<number>("windowClosesAt"),
    };
  }
```

`#countMissedWindow` and `#resetMissedWindows` are written in Task 7. For now add these stubs so this task's tests run, and **do not** leave them stubbed past Task 7:

```ts
  async #countMissedWindow(): Promise<void> {}
  async #resetMissedWindows(): Promise<void> {}
```

- [ ] **Step 8: Stop quorum from resolving a tick through an open window**

Without this, a group that reaches quorum during the review window triggers `resolveTick`, which self-heals by publishing the held beat and *immediately* resolves the next turn — so players never get to read the beat before the story moves past it. Actions still submit freely; only the early resolve waits.

In `src/campaign-do.ts` `submitAction`, replace the quorum block at lines 331–335:

```ts
    if (isQuorumMet(world, stubs, this.#config())) {
      await this.resolveTick("quorum");
      return { accepted: true, resolvedNow: true };
    }
    return { accepted: true, resolvedNow: false };
```

with:

```ts
    // Quorum during a review window must not resolve the next turn: players
    // would never see the beat they are acting after. The action is accepted
    // and sits in `pending`, which is parsed at the next resolution anyway, so
    // it resolves against whatever the DM leaves behind.
    if (isQuorumMet(world, stubs, this.#config()) && this.#get<string>("phase") !== "review") {
      await this.resolveTick("quorum");
      return { accepted: true, resolvedNow: true };
    }
    return { accepted: true, resolvedNow: false };
```

Add the test to `test/integration/dm-window.test.ts`, inside the top-level `describe`:

```ts
  it("accepts actions during the window but does not resolve on quorum", async () => {
    await setSeat(env.DB, CAMPAIGN, HOST);
    const first = await stub().resolveTick("manual");

    // One player is the whole active table here, so this is quorum.
    const out = await stub().submitAction(HOST, "I search the shrine.", "web");
    expect(out.accepted).toBe(true);
    expect(out.resolvedNow).toBe(false);

    const state = await stub().reviewState();
    expect(state.phase).toBe("review");
    expect(state.heldTick).toBe(first.tick);
  });

  it("resolves on quorum again once the beat is published", async () => {
    await setSeat(env.DB, CAMPAIGN, HOST);
    await stub().resolveTick("manual");
    await stub().publishHeldBeat();

    const out = await stub().submitAction(HOST, "I search the shrine.", "web");
    expect(out.resolvedNow).toBe(true);
  });
```

- [ ] **Step 9: Run the tests and watch them pass**

```bash
npm test -- test/integration/dm-window.test.ts
```

Expected: PASS, 11 tests.

- [ ] **Step 10: Run the full suite — this task changes the shared tick path**

```bash
npm test && npm run typecheck
```

Expected: all previously passing tests still pass. The most likely breakage is a test asserting on `TickSummary`'s exact shape; add `held: false` to its expectation rather than loosening the assertion.

- [ ] **Step 11: Commit**

```bash
git add src/campaign-do.ts test/integration/dm-window.test.ts && git commit -m "feat: hold a beat for DM review without moving the tick clock"
```

---

### Task 4: Held beats are invisible until published

**Files:**
- Modify: `src/web/chronicle.ts:88`
- Modify: `src/index.ts:296-300` (the `latestBeat` query in the campaign GET)
- Test: `test/integration/dm-visibility.test.ts`

**Interfaces:**
- Consumes: `applySchema` (Task 1), `setSeat` (Task 2), `publishHeldBeat` (Task 3).
- Produces: nothing new. This is the read-path half of Task 3.

- [ ] **Step 1: Write the failing test**

Create `test/integration/dm-visibility.test.ts`:

```ts
/**
 * A held beat must not leak before the DM publishes it — not to the public
 * chronicle, not to another member's app, not to a logged-out reader.
 *
 * The DM is the one exception: they cannot review what they cannot see.
 */

import { env as runtimeEnv } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { applySchema } from "../helpers/schema";
import { mintSessionForTest } from "../helpers/session";
import { setSeat } from "../../src/dm/seat";
import worker from "../../src/index";
import type { Env } from "../../src/env";

const env = runtimeEnv as unknown as Env;
const CAMPAIGN = "cmp_vis";
const DM = "plr_dm";
const PLAYER = "plr_player";
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

async function get(path: string, playerId?: string): Promise<Response> {
  const headers = new Headers();
  if (playerId) headers.set("cookie", await mintSessionForTest(env, playerId));
  return worker.fetch!(new Request(`https://example.com${path}`, { headers }), env, ctx);
}

describe("held beat visibility", () => {
  beforeEach(async () => {
    await applySchema(env.DB);
    for (const t of ["beats", "memberships", "campaigns", "players"]) {
      await env.DB.prepare(`DELETE FROM ${t}`).run();
    }
    const now = new Date().toISOString();
    for (const [id, email] of [[DM, "dm@example.com"], [PLAYER, "p@example.com"]]) {
      await env.DB.prepare("INSERT INTO players (id, email, created_at) VALUES (?,?,?)")
        .bind(id, email, now).run();
    }
    await env.DB.prepare(
      `INSERT INTO campaigns (id, slug, name, cadence, created_by, created_at)
       VALUES (?, 'vis', 'Vista', 'weekly', ?, ?)`,
    ).bind(CAMPAIGN, DM, now).run();
    for (const id of [DM, PLAYER]) {
      await env.DB.prepare(
        `INSERT INTO memberships (campaign_id, player_id, character_id, character_name, joined_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).bind(CAMPAIGN, id, `chr_${id}`, id, now).run();
    }
    await setSeat(env.DB, CAMPAIGN, DM);

    // Tick 1 published, tick 2 held.
    await env.DB.prepare(
      `INSERT INTO beats (campaign_id, tick, prose, situation, source, created_at, published_at)
       VALUES (?, 1, 'The published beat.', 's', 'model', ?, ?)`,
    ).bind(CAMPAIGN, now, now).run();
    await env.DB.prepare(
      `INSERT INTO beats (campaign_id, tick, prose, situation, source, created_at, published_at)
       VALUES (?, 2, 'The held beat.', 's', 'model', ?, NULL)`,
    ).bind(CAMPAIGN, now).run();
  });

  it("keeps a held beat out of the public chronicle", async () => {
    const body = await (await get(`/c/vis`)).text();
    expect(body).toContain("The published beat.");
    expect(body).not.toContain("The held beat.");
  });

  it("keeps a held beat out of another member's app", async () => {
    const body = await (await get(`/api/campaigns/vis`, PLAYER)).json<{
      latestBeat: { tick: number; prose: string } | null;
    }>();
    expect(body.latestBeat?.tick).toBe(1);
    expect(body.latestBeat?.prose).toBe("The published beat.");
  });

  it("shows the held beat to the DM, flagged as held", async () => {
    const body = await (await get(`/api/campaigns/vis`, DM)).json<{
      latestBeat: { tick: number; prose: string; held?: boolean } | null;
    }>();
    expect(body.latestBeat?.tick).toBe(2);
    expect(body.latestBeat?.prose).toBe("The held beat.");
    expect(body.latestBeat?.held).toBe(true);
  });

  it("shows the beat to everyone once published", async () => {
    await env.DB.prepare(
      "UPDATE beats SET published_at = ? WHERE campaign_id = ? AND tick = 2",
    ).bind(new Date().toISOString(), CAMPAIGN).run();

    const body = await (await get(`/api/campaigns/vis`, PLAYER)).json<{
      latestBeat: { tick: number } | null;
    }>();
    expect(body.latestBeat?.tick).toBe(2);

    const page = await (await get(`/c/vis`)).text();
    expect(page).toContain("The held beat.");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npm test -- test/integration/dm-visibility.test.ts
```

Expected: FAIL — the chronicle renders the held beat and the other member's `latestBeat` is tick 2.

- [ ] **Step 3: Filter the chronicle**

In `src/web/chronicle.ts` at line 88, change:

```ts
      "SELECT tick, prose, source, created_at FROM beats WHERE campaign_id = ? ORDER BY tick DESC LIMIT 25",
```

to:

```ts
      // A beat held for DM review is not part of the chronicle yet. The public
      // page has no session, so there is no reviewer exception to make here.
      "SELECT tick, prose, source, created_at FROM beats WHERE campaign_id = ? " +
        "AND published_at IS NOT NULL ORDER BY tick DESC LIMIT 25",
```

- [ ] **Step 4: Filter the app's latest beat, with the DM exception**

In `src/index.ts`, replace the `latestBeat` query inside the `Promise.all` (lines 296–300):

```ts
        env.DB.prepare(
          "SELECT tick, prose, source FROM beats WHERE campaign_id = ? ORDER BY tick DESC LIMIT 1",
        )
          .bind(campaign.id)
          .first<{ tick: number; prose: string; source: string }>(),
```

with:

```ts
        // The DM sees the held beat — they cannot review what they cannot see.
        // Everyone else sees the most recent published one.
        (async () => {
          const seat = await getSeat(env.DB, campaign.id);
          const dmSees = seat?.dmPlayerId === session.playerId;
          return env.DB.prepare(
            "SELECT tick, prose, source, published_at FROM beats WHERE campaign_id = ? " +
              (dmSees ? "" : "AND published_at IS NOT NULL ") +
              "ORDER BY tick DESC LIMIT 1",
          )
            .bind(campaign.id)
            .first<{ tick: number; prose: string; source: string; published_at: string | null }>();
        })(),
```

Then in the `json({...})` response object below it, replace `latestBeat: latest ?? null,` with:

```ts
        latestBeat: latest
          ? {
              tick: latest.tick,
              prose: latest.prose,
              source: latest.source,
              held: latest.published_at === null,
            }
          : null,
```

- [ ] **Step 5: Run the tests and watch them pass**

```bash
npm test -- test/integration/dm-visibility.test.ts
```

Expected: PASS, 4 tests.

- [ ] **Step 6: Full gates, then commit**

```bash
npm test && npm run typecheck
```

```bash
git add src/web/chronicle.ts src/index.ts test/integration/dm-visibility.test.ts && git commit -m "feat: hold beats out of the chronicle until the DM publishes"
```

---

### Task 5: Prose editing and attribution

**Files:**
- Modify: `src/index.ts` — new branches after the `/dm` branch from Task 2
- Modify: `src/web/chronicle.ts` — render the attribution line
- Test: `test/integration/dm-edit.test.ts`

**Interfaces:**
- Consumes: `getSeat` (Task 2), `publishHeldBeat` / `reviewState` (Task 3).
- Produces: three endpoints — `GET /api/campaigns/:slug/dm/review`, `PATCH /api/campaigns/:slug/dm/beat`, `POST /api/campaigns/:slug/dm/publish`.

- [ ] **Step 1: Write the failing test**

Create `test/integration/dm-edit.test.ts`:

```ts
/**
 * Prose editing: who may do it, what is retained, and what readers are told.
 */

import { env as runtimeEnv } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { applySchema } from "../helpers/schema";
import { mintSessionForTest } from "../helpers/session";
import { setSeat } from "../../src/dm/seat";
import worker from "../../src/index";
import type { Env } from "../../src/env";

const env = runtimeEnv as unknown as Env;
const CAMPAIGN = "cmp_edit";
const DM = "plr_dm";
const PLAYER = "plr_player";
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

async function call(
  method: string,
  path: string,
  playerId: string,
  body?: unknown,
): Promise<Response> {
  return worker.fetch!(
    new Request(`https://example.com${path}`, {
      method,
      headers: {
        cookie: await mintSessionForTest(env, playerId),
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env,
    ctx,
  );
}

describe("dm prose editing", () => {
  beforeEach(async () => {
    await applySchema(env.DB);
    for (const t of ["beats", "memberships", "campaigns", "players"]) {
      await env.DB.prepare(`DELETE FROM ${t}`).run();
    }
    const now = new Date().toISOString();
    for (const [id, email] of [[DM, "dm@example.com"], [PLAYER, "p@example.com"]]) {
      await env.DB.prepare("INSERT INTO players (id, email, created_at) VALUES (?,?,?)")
        .bind(id, email, now).run();
    }
    await env.DB.prepare(
      `INSERT INTO campaigns (id, slug, name, cadence, created_by, created_at)
       VALUES (?, 'edit', 'Editor', 'weekly', ?, ?)`,
    ).bind(CAMPAIGN, DM, now).run();
    for (const id of [DM, PLAYER]) {
      await env.DB.prepare(
        `INSERT INTO memberships (campaign_id, player_id, character_id, character_name, joined_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).bind(CAMPAIGN, id, `chr_${id}`, id, now).run();
    }
    await setSeat(env.DB, CAMPAIGN, DM);
    await env.DB.prepare(
      `INSERT INTO beats (campaign_id, tick, prose, situation, source, created_at, published_at)
       VALUES (?, 4, 'The model wrote this.', 'At the ford.', 'model', ?, NULL)`,
    ).bind(CAMPAIGN, now).run();
  });

  async function beat() {
    return env.DB.prepare(
      "SELECT prose, original_prose, revised_by FROM beats WHERE campaign_id = ? AND tick = 4",
    ).bind(CAMPAIGN).first<{ prose: string; original_prose: string | null; revised_by: string | null }>();
  }

  it("rewrites the prose and retains the original", async () => {
    const res = await call("PATCH", "/api/campaigns/edit/dm/beat", DM, {
      tick: 4,
      prose: "The ford ran high, and they crossed it anyway.",
    });
    expect(res.status).toBe(200);

    const row = await beat();
    expect(row?.prose).toBe("The ford ran high, and they crossed it anyway.");
    expect(row?.original_prose).toBe("The model wrote this.");
    expect(row?.revised_by).toBe(DM);
  });

  it("keeps the first original across a second edit", async () => {
    await call("PATCH", "/api/campaigns/edit/dm/beat", DM, { tick: 4, prose: "First rewrite." });
    await call("PATCH", "/api/campaigns/edit/dm/beat", DM, { tick: 4, prose: "Second rewrite." });

    const row = await beat();
    expect(row?.prose).toBe("Second rewrite.");
    // The original is what the machine wrote, not the DM's previous draft.
    expect(row?.original_prose).toBe("The model wrote this.");
  });

  it("refuses a member who does not hold the seat", async () => {
    const res = await call("PATCH", "/api/campaigns/edit/dm/beat", PLAYER, {
      tick: 4,
      prose: "I rewrite the story.",
    });
    expect(res.status).toBe(403);
    expect((await beat())?.prose).toBe("The model wrote this.");
  });

  it("rejects empty prose rather than blanking a beat", async () => {
    const res = await call("PATCH", "/api/campaigns/edit/dm/beat", DM, { tick: 4, prose: "   " });
    expect(res.status).toBe(400);
    expect((await beat())?.prose).toBe("The model wrote this.");
  });

  it("rejects prose beyond the column's sane bound", async () => {
    const res = await call("PATCH", "/api/campaigns/edit/dm/beat", DM, {
      tick: 4,
      prose: "x".repeat(20_001),
    });
    expect(res.status).toBe(400);
  });

  it("404s for a tick with no beat", async () => {
    const res = await call("PATCH", "/api/campaigns/edit/dm/beat", DM, { tick: 99, prose: "Hi." });
    expect(res.status).toBe(404);
  });

  it("serves the held beat to the DM for review", async () => {
    const body = await (await call("GET", "/api/campaigns/edit/dm/review", DM)).json<{
      beat: { tick: number; prose: string } | null;
      phase: string;
    }>();
    expect(body.beat?.tick).toBe(4);
    expect(body.beat?.prose).toBe("The model wrote this.");
  });

  it("refuses the review view to a non-DM", async () => {
    expect((await call("GET", "/api/campaigns/edit/dm/review", PLAYER)).status).toBe(403);
  });

  it("publishes on request", async () => {
    const res = await call("POST", "/api/campaigns/edit/dm/publish", DM);
    expect(res.status).toBe(200);
  });

  it("refuses publish from a non-DM", async () => {
    expect((await call("POST", "/api/campaigns/edit/dm/publish", PLAYER)).status).toBe(403);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npm test -- test/integration/dm-edit.test.ts
```

Expected: FAIL — every DM route returns 405.

- [ ] **Step 3: Add the endpoints**

In `src/index.ts`, immediately after the `/dm` branch from Task 2, add:

```ts
    // Everything below the seat itself requires holding it.
    if (action?.startsWith("/dm/")) {
      const seat = await getSeat(env.DB, campaign.id);
      if (seat?.dmPlayerId !== session.playerId) {
        return fail(403, "only the DM can do that");
      }

      if (action === "/dm/review" && method === "GET") {
        const [state, held] = await Promise.all([
          campaignStub.reviewState(),
          env.DB.prepare(
            `SELECT tick, prose, situation, source, published_at, revised_by, original_prose
             FROM beats WHERE campaign_id = ? ORDER BY tick DESC LIMIT 1`,
          )
            .bind(campaign.id)
            .first<{
              tick: number;
              prose: string;
              situation: string;
              source: string;
              published_at: string | null;
              revised_by: string | null;
              original_prose: string | null;
            }>(),
        ]);
        return json({
          ok: true,
          phase: state.phase,
          windowClosesAt: state.windowClosesAt,
          beat: held
            ? { ...held, held: held.published_at === null, publishedAt: held.published_at }
            : null,
        });
      }

      if (action === "/dm/beat" && method === "PATCH") {
        const body = await readJson<{ tick?: number; prose?: string }>(request);
        const tick = Number(body?.tick);
        const prose = (body?.prose ?? "").trim();
        if (!Number.isInteger(tick)) return fail(400, "which turn?");
        if (!prose) return fail(400, "write something, or leave it as it is");
        // Generous, but not unbounded: a beat is a few hundred words.
        if (prose.length > 20_000) return fail(400, "that is too long for one beat");

        // `original_prose` is set only once, so it stays what the machine wrote
        // rather than sliding to the DM's previous draft on every edit.
        const out = await env.DB.prepare(
          `UPDATE beats
             SET prose = ?,
                 original_prose = COALESCE(original_prose, prose),
                 revised_by = ?
           WHERE campaign_id = ? AND tick = ?`,
        )
          .bind(prose, session.playerId, campaign.id, tick)
          .run();
        if (!out.meta.changes) return fail(404, "no such turn");
        return json({ ok: true, tick });
      }

      if (action === "/dm/publish" && method === "POST") {
        const out = await campaignStub.publishHeldBeat();
        return json({ ok: true, ...out });
      }
    }
```

- [ ] **Step 4: Run the tests and watch them pass**

```bash
npm test -- test/integration/dm-edit.test.ts
```

Expected: PASS, 10 tests.

- [ ] **Step 5: Show the attribution in the chronicle**

In `src/web/chronicle.ts` at line 88, extend the select to carry the reviser:

```ts
      "SELECT tick, prose, source, created_at, revised_by FROM beats WHERE campaign_id = ? " +
        "AND published_at IS NOT NULL ORDER BY tick DESC LIMIT 25",
```

Update the `beats` row type at line 21 to include `revised_by: string | null`, and where the beat is rendered (around line 146), append an attribution line after the prose:

```ts
            b.revised_by ? `<p class="d">Edited by the DM.</p>` : ``
```

Attribution is deliberately not a name: the chronicle is public, and "the DM" is the fact readers need. Who holds the seat is visible in-app to members.

- [ ] **Step 6: Test the attribution renders**

Append to `test/integration/dm-edit.test.ts`, inside the top-level `describe`:

```ts
  it("marks an edited beat in the public chronicle", async () => {
    await call("PATCH", "/api/campaigns/edit/dm/beat", DM, { tick: 4, prose: "A better beat." });
    await env.DB.prepare(
      "UPDATE beats SET published_at = ? WHERE campaign_id = ? AND tick = 4",
    ).bind(new Date().toISOString(), CAMPAIGN).run();

    const page = await (
      await worker.fetch!(new Request("https://example.com/c/edit"), env, ctx)
    ).text();
    expect(page).toContain("A better beat.");
    expect(page).toContain("Edited by the DM.");
  });

  it("does not mark an unedited beat", async () => {
    await env.DB.prepare(
      "UPDATE beats SET published_at = ? WHERE campaign_id = ? AND tick = 4",
    ).bind(new Date().toISOString(), CAMPAIGN).run();

    const page = await (
      await worker.fetch!(new Request("https://example.com/c/edit"), env, ctx)
    ).text();
    expect(page).not.toContain("Edited by the DM.");
  });
```

- [ ] **Step 7: Run and watch them pass**

```bash
npm test -- test/integration/dm-edit.test.ts
```

Expected: PASS, 12 tests.

- [ ] **Step 8: Full gates, then commit**

```bash
npm test && npm run typecheck
```

```bash
git add src/index.ts src/web/chronicle.ts test/integration/dm-edit.test.ts && git commit -m "feat: let the DM rewrite a beat, and say so in the chronicle"
```

---

### Task 6: Window configuration

**Files:**
- Modify: `src/index.ts` — a `/dm/window` branch inside the `/dm/` block from Task 5
- Test: `test/integration/dm-edit.test.ts` (append)

**Interfaces:**
- Consumes: `resolveWindowMs`, `MAX_WINDOW_MS` (Task 2).
- Produces: `PATCH /api/campaigns/:slug/dm/window`.

- [ ] **Step 1: Write the failing test**

Append to `test/integration/dm-edit.test.ts`, inside the top-level `describe`:

```ts
  describe("window configuration", () => {
    async function windowMs(): Promise<number | null> {
      const row = await env.DB.prepare(
        "SELECT review_window_ms FROM campaigns WHERE id = ?",
      ).bind(CAMPAIGN).first<{ review_window_ms: number | null }>();
      return row?.review_window_ms ?? null;
    }

    it("sets a window", async () => {
      const res = await call("PATCH", "/api/campaigns/edit/dm/window", DM, { ms: 3_600_000 });
      expect(res.status).toBe(200);
      expect(await windowMs()).toBe(3_600_000);
    });

    it("clamps past the cadence cap and reports the clamp", async () => {
      const res = await call("PATCH", "/api/campaigns/edit/dm/window", DM, {
        ms: 30 * 24 * 3_600_000,
      });
      const body = await res.json<{ ms: number; clamped: boolean }>();
      expect(body.ms).toBe(56 * 3_600_000); // the weekly cap
      expect(body.clamped).toBe(true);
    });

    it("accepts zero as publish-immediately", async () => {
      const res = await call("PATCH", "/api/campaigns/edit/dm/window", DM, { ms: 0 });
      expect(res.status).toBe(200);
      expect(await windowMs()).toBe(0);
    });

    it("accepts null as back-to-the-default", async () => {
      await call("PATCH", "/api/campaigns/edit/dm/window", DM, { ms: 0 });
      const res = await call("PATCH", "/api/campaigns/edit/dm/window", DM, { ms: null });
      expect(res.status).toBe(200);
      expect(await windowMs()).toBeNull();
    });

    it("refuses a non-DM", async () => {
      expect(
        (await call("PATCH", "/api/campaigns/edit/dm/window", PLAYER, { ms: 0 })).status,
      ).toBe(403);
    });
  });
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npm test -- test/integration/dm-edit.test.ts
```

Expected: FAIL — `/dm/window` falls through to 405.

- [ ] **Step 3: Add the endpoint**

In `src/index.ts`, inside the `/dm/` block, after the `/dm/publish` branch:

```ts
      if (action === "/dm/window" && method === "PATCH") {
        const body = await readJson<{ ms?: number | null }>(request);
        // null means "back to the cadence default"; 0 means "publish now and
        // let me edit afterwards". Both are real settings, so neither collapses
        // into the other.
        const requested = body?.ms ?? null;
        if (requested === null) {
          await env.DB.prepare("UPDATE campaigns SET review_window_ms = NULL WHERE id = ?")
            .bind(campaign.id)
            .run();
          return json({ ok: true, ms: resolveWindowMs(campaign.cadence, null), clamped: false });
        }
        if (typeof requested !== "number" || !Number.isFinite(requested) || requested < 0) {
          return fail(400, "a window is a number of milliseconds, or null");
        }
        const effective = resolveWindowMs(campaign.cadence, requested);
        await env.DB.prepare("UPDATE campaigns SET review_window_ms = ? WHERE id = ?")
          .bind(effective, campaign.id)
          .run();
        return json({ ok: true, ms: effective, clamped: effective !== requested });
      }
```

Extend the `src/dm/seat` import in `src/index.ts` to include `resolveWindowMs`:

```ts
import { getSeat, resolveWindowMs, setSeat } from "./dm/seat";
```

- [ ] **Step 4: Run and watch it pass**

```bash
npm test -- test/integration/dm-edit.test.ts
```

Expected: PASS, 17 tests.

- [ ] **Step 5: Full gates, then commit**

```bash
npm test && npm run typecheck
```

```bash
git add src/index.ts test/integration/dm-edit.test.ts && git commit -m "feat: let the DM set the review window, clamped to the cadence"
```

---

### Task 7: The seat reverts after three missed windows

**Files:**
- Modify: `src/campaign-do.ts` — replace the two stubs added in Task 3 Step 7
- Test: `test/integration/dm-window.test.ts` (append)

**Interfaces:**
- Consumes: `getSeat`, `setSeat` (Task 2), `publishHeldBeat` (Task 3).
- Produces: nothing new. Replaces `#countMissedWindow` and `#resetMissedWindows`.

- [ ] **Step 1: Write the failing test**

Append to `test/integration/dm-window.test.ts`, inside the top-level `describe`:

```ts
  describe("a DM who stops showing up", () => {
    async function missed(): Promise<number> {
      const row = await env.DB.prepare(
        "SELECT dm_missed_windows FROM campaigns WHERE id = ?",
      ).bind(CAMPAIGN).first<{ dm_missed_windows: number }>();
      return row?.dm_missed_windows ?? 0;
    }

    async function seatHolder(): Promise<string | null> {
      const row = await env.DB.prepare(
        "SELECT dm_player_id FROM campaigns WHERE id = ?",
      ).bind(CAMPAIGN).first<{ dm_player_id: string | null }>();
      return row?.dm_player_id ?? null;
    }

    beforeEach(async () => {
      const now = new Date().toISOString();
      await env.DB.prepare("INSERT OR IGNORE INTO players (id, email, created_at) VALUES (?,?,?)")
        .bind("plr_dm", "dm@example.com", now).run();
      await env.DB.prepare(
        `INSERT OR IGNORE INTO memberships
           (campaign_id, player_id, character_id, character_name, joined_at)
         VALUES (?, 'plr_dm', 'chr_dm', 'Dee', ?)`,
      ).bind(CAMPAIGN, now).run();
      await setSeat(env.DB, CAMPAIGN, "plr_dm");
    });

    it("counts a window that expired untouched", async () => {
      await stub().resolveTick("manual");
      await stub().publishHeldBeat({ expired: true });
      expect(await missed()).toBe(1);
    });

    it("resets the count when the DM publishes themselves", async () => {
      await stub().resolveTick("manual");
      await stub().publishHeldBeat({ expired: true });
      await stub().resolveTick("manual");
      await stub().publishHeldBeat();
      expect(await missed()).toBe(0);
    });

    it("reverts the seat to the host after three", async () => {
      for (let i = 0; i < 3; i++) {
        await stub().resolveTick("manual");
        await stub().publishHeldBeat({ expired: true });
      }
      expect(await seatHolder()).toBe(HOST);
      // Reverting is a fresh start for whoever holds it now.
      expect(await missed()).toBe(0);
    });

    it("does not revert at two", async () => {
      for (let i = 0; i < 2; i++) {
        await stub().resolveTick("manual");
        await stub().publishHeldBeat({ expired: true });
      }
      expect(await seatHolder()).toBe("plr_dm");
    });
  });
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npm test -- test/integration/dm-window.test.ts
```

Expected: FAIL — the count stays 0 because the stubs do nothing.

- [ ] **Step 3: Replace the stubs**

In `src/campaign-do.ts`, replace:

```ts
  async #countMissedWindow(): Promise<void> {}
  async #resetMissedWindows(): Promise<void> {}
```

with:

```ts
  /**
   * A window that closed without the DM touching it.
   *
   * Three in a row hands the seat back to the host. Going quiet costs a DM
   * nothing — it just moves the chair to someone who is there, which is the
   * same principle the absence policy applies to players.
   */
  async #countMissedWindow(): Promise<void> {
    const campaignId = this.#world().campaignId;
    try {
      const seat = await getSeat(this.env.DB, campaignId);
      if (!seat?.dmPlayerId) return;

      const missed = seat.missedWindows + 1;
      if (missed < MISSED_WINDOWS_BEFORE_REVERT) {
        await this.env.DB.prepare("UPDATE campaigns SET dm_missed_windows = ? WHERE id = ?")
          .bind(missed, campaignId)
          .run();
        return;
      }

      const host = await this.env.DB.prepare("SELECT created_by FROM campaigns WHERE id = ?")
        .bind(campaignId)
        .first<{ created_by: string }>();
      // `setSeat` zeroes the counter, so the host starts with a clean slate.
      await setSeat(this.env.DB, campaignId, host?.created_by ?? null);
      console.log(`dm seat on ${campaignId} reverted to host after ${missed} missed windows`);
    } catch (err) {
      // Seat bookkeeping is not worth failing a publish over.
      console.error("missed-window accounting failed", err);
    }
  }

  async #resetMissedWindows(): Promise<void> {
    try {
      await this.env.DB.prepare(
        "UPDATE campaigns SET dm_missed_windows = 0 WHERE id = ? AND dm_missed_windows != 0",
      )
        .bind(this.#world().campaignId)
        .run();
    } catch (err) {
      console.error("missed-window reset failed", err);
    }
  }
```

Extend the seat import at the top of `src/campaign-do.ts`:

```ts
import { getSeat, resolveWindowMs, setSeat } from "./dm/seat";
```

And add the constant to `src/dm/seat.ts`:

```ts
/** Consecutive untouched windows before the seat goes back to the host. */
export const MISSED_WINDOWS_BEFORE_REVERT = 3;
```

importing it in `src/campaign-do.ts` alongside the rest.

- [ ] **Step 4: Run and watch it pass**

```bash
npm test -- test/integration/dm-window.test.ts
```

Expected: PASS, 13 tests.

- [ ] **Step 5: Full gates, then commit**

```bash
npm test && npm run typecheck
```

```bash
git add src/dm/seat.ts src/campaign-do.ts test/integration/dm-window.test.ts && git commit -m "feat: hand the DM seat back to the host after three missed windows"
```

---

### Task 8: Tell the DM a beat is waiting

**Files:**
- Modify: `src/email/outbound.ts` — add `sendReviewNotice`
- Modify: `src/campaign-do.ts` — call it from `#openReviewWindow`
- Test: `test/integration/dm-notice.test.ts`

**Interfaces:**
- Consumes: the existing `sendBeat` shape in `src/email/outbound.ts`.
- Produces: `sendReviewNotice(env: Env, opts: { campaignSlug: string; campaignName: string; tick: number; toEmail: string; prose: string; closesAt: number }): Promise<void>`

Read `src/email/outbound.ts` before writing this — match how `sendBeat` builds and sends a message rather than inventing a second style.

- [ ] **Step 1: Write the failing test**

Create `test/integration/dm-notice.test.ts`:

```ts
/**
 * The held-beat notice.
 *
 * A window the DM never hears about is just latency. This asserts the notice is
 * composed and addressed correctly, and — importantly — that a send failure
 * does not take the tick down with it.
 */

import { env as runtimeEnv } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { applySchema } from "../helpers/schema";
import { reviewNoticeBody, reviewNoticeSubject } from "../../src/email/outbound";
import type { Env } from "../../src/env";

const env = runtimeEnv as unknown as Env;

describe("review notice", () => {
  beforeEach(async () => {
    await applySchema(env.DB);
  });

  it("names the campaign and the turn in the subject", () => {
    const subject = reviewNoticeSubject("Windy Hold", 7);
    expect(subject).toContain("Windy Hold");
    expect(subject).toContain("7");
  });

  it("includes the prose so the DM can judge it without opening the app", () => {
    const body = reviewNoticeBody({
      campaignName: "Windy Hold",
      campaignSlug: "win",
      tick: 7,
      prose: "The ford ran high.",
      closesAt: Date.parse("2026-08-09T12:00:00Z"),
      origin: "https://play.example.com",
    });
    expect(body).toContain("The ford ran high.");
    expect(body).toContain("https://play.example.com");
  });

  it("says what happens if the DM does nothing", () => {
    const body = reviewNoticeBody({
      campaignName: "Windy Hold",
      campaignSlug: "win",
      tick: 7,
      prose: "The ford ran high.",
      closesAt: Date.parse("2026-08-09T12:00:00Z"),
      origin: "https://play.example.com",
    });
    // The promise the whole design rests on: silence is safe.
    expect(body.toLowerCase()).toMatch(/publish(es)? (on its own|automatically)|by itself/);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npm test -- test/integration/dm-notice.test.ts
```

Expected: FAIL — `reviewNoticeSubject` and `reviewNoticeBody` are not exported.

- [ ] **Step 3: Add the composer and sender**

Append to `src/email/outbound.ts`:

```ts
export function reviewNoticeSubject(campaignName: string, tick: number): string {
  return `[${campaignName}] Turn ${tick} is ready for you`;
}

export function reviewNoticeBody(opts: {
  campaignName: string;
  campaignSlug: string;
  tick: number;
  prose: string;
  closesAt: number;
  origin: string;
}): string {
  const closes = new Date(opts.closesAt).toUTCString();
  return [
    `Turn ${opts.tick} of ${opts.campaignName} has resolved. Nobody has seen it yet.`,
    ``,
    opts.prose,
    ``,
    `———`,
    ``,
    `Read it, rewrite it, or send it as it stands:`,
    `${opts.origin}/#/c/${opts.campaignSlug}/review`,
    ``,
    `If you do nothing it publishes on its own at ${closes}, so the story never`,
    `waits on you.`,
  ].join("\n");
}

/**
 * Mail the DM that a beat is held.
 *
 * Best-effort by construction: the window closes on the alarm whether or not
 * this arrives, so a mail failure costs a notification, never a turn.
 */
export async function sendReviewNotice(
  env: Env,
  opts: {
    campaignSlug: string;
    campaignName: string;
    tick: number;
    toEmail: string;
    prose: string;
    closesAt: number;
  },
): Promise<void> {
  await sendMail(env, {
    to: opts.toEmail,
    subject: reviewNoticeSubject(opts.campaignName, opts.tick),
    text: reviewNoticeBody({ ...opts, origin: env.PUBLIC_ORIGIN }),
  });
}
```

`sendMail` is whatever low-level helper `sendBeat` already uses in this file. If it is named differently or takes a different shape, use the real one — do not add a second mail path.

- [ ] **Step 4: Send it when the window opens**

In `src/campaign-do.ts`, at the end of `#openReviewWindow`, add:

```ts
    // Detached and swallowed: the window closes on the alarm regardless, so a
    // bounce costs a notification, never a turn.
    this.ctx.waitUntil(this.#notifyDm(tick, closesAt).catch(() => {}));
```

and add the method:

```ts
  async #notifyDm(tick: number, closesAt: number): Promise<void> {
    const state = this.#world();
    const meta = this.#get<{ name: string; slug: string }>("meta") ?? { name: "Campaign", slug: "c" };
    const seat = await getSeat(this.env.DB, state.campaignId);
    if (!seat?.dmPlayerId) return;

    const dm = await this.env.DB.prepare("SELECT email FROM players WHERE id = ?")
      .bind(seat.dmPlayerId)
      .first<{ email: string }>();
    if (!dm?.email) return;

    const beat = await this.env.DB.prepare(
      "SELECT prose FROM beats WHERE campaign_id = ? AND tick = ?",
    )
      .bind(state.campaignId, tick)
      .first<{ prose: string }>();

    await sendReviewNotice(this.env, {
      campaignSlug: meta.slug,
      campaignName: meta.name,
      tick,
      toEmail: dm.email,
      prose: beat?.prose ?? "",
      closesAt,
    });
  }
```

Extend the outbound import in `src/campaign-do.ts`:

```ts
import { sendBeat, sendReviewNotice } from "./email/outbound";
```

- [ ] **Step 5: Run and watch it pass**

```bash
npm test -- test/integration/dm-notice.test.ts
```

Expected: PASS, 3 tests.

- [ ] **Step 6: Confirm a mail failure cannot break a tick**

Append to `test/integration/dm-window.test.ts`, inside the top-level `describe`:

```ts
  it("still holds the beat when the DM notice cannot be sent", async () => {
    // No player row for the seat holder, so the notice lookup finds no address.
    await env.DB.prepare("UPDATE campaigns SET dm_player_id = 'plr_ghost' WHERE id = ?")
      .bind(CAMPAIGN).run();

    const summary = await stub().resolveTick("manual");
    expect(summary.held).toBe(true);
    expect((await stub().reviewState()).phase).toBe("review");
  });
```

```bash
npm test -- test/integration/dm-window.test.ts
```

Expected: PASS, 14 tests.

- [ ] **Step 7: Full gates, then commit**

```bash
npm test && npm run typecheck
```

```bash
git add src/email/outbound.ts src/campaign-do.ts test/integration/dm-notice.test.ts test/integration/dm-window.test.ts && git commit -m "feat: mail the DM when a beat is waiting on them"
```

---

### Task 9: The in-app surface

**Files:**
- Modify: `public/app.js`
- Modify: `public/app.css`
- Test: `scripts/ui-smoke.mjs` (append checks)

**Interfaces:**
- Consumes: `isHost` and `latestBeat.held` from the campaign GET (Task 4); `/dm`, `/dm/review`, `/dm/beat`, `/dm/publish`, `/dm/window` (Tasks 2, 5, 6).
- Produces: nothing other tasks consume.

Read `public/app.js` end to end before starting. It is a no-framework, no-inline-script app; match how existing panels render and bind rather than introducing a new pattern. The CSP forbids inline scripts, so all behavior goes in `app.js`.

- [ ] **Step 1: Add `dmPlayerId` to the campaign GET response**

In `src/index.ts`, the campaign GET currently returns `isHost`. Add the seat next to it so the app can render without a second request. Inside the same `Promise.all`, add `getSeat(env.DB, campaign.id)` and include in the response:

```ts
        isDm: seat?.dmPlayerId === session.playerId,
        dmPlayerId: seat?.dmPlayerId ?? null,
```

- [ ] **Step 2: Add the markup**

In `public/index.html`, inside `<section id="view-campaign">`, immediately after the `beat-box` section closes and before `<form id="action-form">`, add:

```html
        <section id="dm-box" hidden>
          <h2>You're the DM</h2>
          <p id="dm-idle" class="fine" hidden>
            Nothing waiting. You'll get an email when a turn is ready for you.
          </p>
          <div id="dm-review" hidden>
            <p id="dm-window" class="fine"></p>
            <label for="dm-prose">Turn <span id="dm-tick"></span> — nobody has seen this yet</label>
            <textarea id="dm-prose" rows="10" maxlength="20000"></textarea>
            <button id="dm-save" class="primary" type="button">Save changes</button>
            <button id="dm-publish" class="primary" type="button">Send it to the group</button>
          </div>
          <details id="dm-seat-details">
            <summary>Who runs this story</summary>
            <p id="dm-holder" class="fine"></p>
            <label for="dm-seat-to">Hand the DM seat to</label>
            <select id="dm-seat-to"></select>
            <button id="dm-seat-btn" type="button">Hand it over</button>
          </details>
        </section>
```

- [ ] **Step 3: Render and wire the panel**

In `public/app.js`, add this function above `renderSheet`:

```js
/**
 * The DM's panel.
 *
 * Only rendered for whoever holds the seat, plus a seat control for the host so
 * a campaign can never end up with a DM nobody can replace. Prose goes into a
 * textarea with `.value`, never innerHTML — it is model output.
 */
function renderDm(data) {
  const box = $("dm-box");
  const canMoveSeat = data.isDm || data.isHost;
  box.hidden = !canMoveSeat;
  if (!canMoveSeat) return;

  const held = data.isDm && data.latestBeat?.held ? data.latestBeat : null;
  $("dm-review").hidden = !held;
  $("dm-idle").hidden = !data.isDm || Boolean(held);

  if (held) {
    $("dm-tick").textContent = String(held.tick);
    $("dm-prose").value = held.prose;
    $("dm-window").textContent = data.campaign.windowClosesAt
      ? `Publishes on its own ${relative(data.campaign.windowClosesAt)} if you do nothing.`
      : "Publishes on its own if you do nothing.";
  }

  const holder = data.campaign.cast.find((m) => m.playerId === data.dmPlayerId);
  $("dm-holder").textContent = data.dmPlayerId
    ? `${holder ? holder.name : "Someone"} holds the DM seat.`
    : "Nobody holds the DM seat — turns publish as soon as they resolve.";

  const to = $("dm-seat-to");
  to.textContent = "";
  for (const m of data.campaign.cast) {
    const option = document.createElement("option");
    option.value = m.playerId;
    option.textContent = m.name;
    if (m.playerId === data.dmPlayerId) option.selected = true;
    to.append(option);
  }
  const none = document.createElement("option");
  none.value = "";
  none.textContent = "Nobody — publish turns immediately";
  to.append(none);
}
```

Call it from `renderCampaign`, just after `renderSheet(data.you);`:

```js
  renderDm(data);
```

Then add the handlers, next to the invite handler:

```js
// ─── the DM's controls ─────────────────────────────────────────────────────

/** Shared button handler: call an endpoint, report it, re-render. */
function wireDmButton(id, build, onOk) {
  $(id).addEventListener("click", async () => {
    const button = $(id);
    const call = build();
    if (call === null) return;
    button.disabled = true;
    try {
      const out = await api(`/api/campaigns/${encodeURIComponent(currentSlug)}${call.path}`, {
        method: call.method,
        body: call.body === undefined ? undefined : JSON.stringify(call.body),
      });
      say(onOk(out), "ok");
      await load();
    } catch (err) {
      say(err.message, "err");
    } finally {
      button.disabled = false;
    }
  });
}

wireDmButton(
  "dm-save",
  () => {
    const prose = $("dm-prose").value.trim();
    if (!prose) {
      say("Write something, or leave it as it is.", "err");
      return null;
    }
    return {
      method: "PATCH",
      path: "/dm/beat",
      body: { tick: Number($("dm-tick").textContent), prose },
    };
  },
  () => "Saved. Nobody has seen it yet — send it when you're ready.",
);

wireDmButton(
  "dm-publish",
  () => ({ method: "POST", path: "/dm/publish" }),
  (out) => (out.published ? "Sent. The group has it now." : "Nothing was waiting."),
);

wireDmButton(
  "dm-seat-btn",
  () => ({
    method: "POST",
    path: "/dm",
    body: { playerId: $("dm-seat-to").value || null },
  }),
  (out) => (out.dmPlayerId ? "Done — they run the story now." : "Seat vacated."),
);
```

`renderDm` reads `m.playerId` off each cast member; `CampaignSnapshot.cast` already carries it ([campaign-do.ts:81](../../src/campaign-do.ts)), so no snapshot change is needed.

- [ ] **Step 4: Surface the window's close time**

`renderDm` reads `data.campaign.windowClosesAt`. Add it to the campaign GET in `src/index.ts` by including `campaignStub.reviewState()` in the existing `Promise.all` and spreading it into the campaign object:

```ts
        campaign: { slug: campaign.slug, ...snapshot, windowClosesAt: review.windowClosesAt },
```

- [ ] **Step 5: Style the panel**

In `public/app.css`, add — using only the existing custom properties, and matching the file's existing selector style:

```css
#dm-box {
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 1rem;
  margin: 1.25rem 0;
}
#dm-box textarea {
  font-family: inherit;
  line-height: 1.5;
}
#dm-box button + button {
  margin-left: 0.5rem;
}
```

If `--line` or `--radius` are named differently in `app.css`, use the real names — do not add new custom properties.

- [ ] **Step 6: Verify by hand at a mobile viewport**

```bash
npm run dev
```

Open `http://localhost:8787`, sign in, create a campaign, set the window to something short, force a turn with the host `/resolve` control, and confirm: the beat is held, the DM panel shows it, an edit saves, and **Send it** publishes and reveals it to the chronicle.

- [ ] **Step 7: Add UI smoke checks**

In `scripts/ui-smoke.mjs`, after the checks that assert the campaign view has rendered, add — using the script's existing `check(name, ok, detail)` helper and its Playwright `page` handle:

```js
  // The creator holds the seat by default, so the DM panel must be there.
  const dmBox = await page.$("#dm-box");
  check("DM panel renders for the seat holder", dmBox !== null && !(await dmBox.isHidden()));

  const seatSelect = await page.$("#dm-seat-to");
  check("DM seat can be handed to another member", seatSelect !== null);

  // Every DM control has to be tappable at a mobile viewport, same bar as the
  // rest of the app.
  for (const id of ["dm-seat-btn"]) {
    const el = await page.$(`#${id}`);
    const box = el ? await el.boundingBox() : null;
    check(
      `${id} meets the touch-target minimum`,
      Boolean(box) && box.height >= 44 && box.width >= 44,
      box ? `${Math.round(box.width)}x${Math.round(box.height)}` : "not found",
    );
  }
```

If the script's touch-target minimum is a named constant rather than the literal `44`, use that constant.

- [ ] **Step 8: Run the UI smoke against local dev**

```bash
node scripts/ui-smoke.mjs http://localhost:8787
```

Expected: all checks pass, including the pre-existing ones.

- [ ] **Step 9: Commit**

```bash
npm test && npm run typecheck
```

```bash
git add public/app.js public/app.css src/index.ts scripts/ui-smoke.mjs && git commit -m "feat: DM review panel in the app"
```

---

### Task 10: Adversarial smoke, docs, and the promise rewording

**Files:**
- Modify: `scripts/smoke.mjs`
- Modify: `README.md`
- Modify: `docs/specs/2026-08-02-asyncrpg-design.md` — §5
- Modify: `docs/HANDOFF.md`

**Interfaces:**
- Consumes: every endpoint from Tasks 2, 5, and 6.
- Produces: nothing.

The promise rewording is in this slice even though slice 1 does not touch canon, because the DM seat now exists and the README must describe what it can do. The wording is fixed by the spec — copy it, do not paraphrase.

- [ ] **Step 1: Add the adversarial smoke checks**

In `scripts/smoke.mjs`, in the section that already exercises host-only endpoints with a second member's cookie, add — using the file's existing `req` and `check` helpers, and its existing cookie variables for the host and a second member (match the real names in the file; `hostCookie` / `otherCookie` below are placeholders for whatever it calls them):

```js
  // ─── the DM seat ─────────────────────────────────────────────────────────
  // The seat is the only thing in the app that can rewrite what the group
  // reads, so every one of these is a real escalation if it comes back 200.

  const dmBeat = await req(`/api/campaigns/${slug}/dm/beat`, {
    method: "PATCH",
    cookie: otherCookie,
    body: { tick: 1, prose: "I rewrite the story." },
  });
  check("non-DM cannot rewrite a beat", dmBeat.status === 403, `status ${dmBeat.status}`);

  const dmPublish = await req(`/api/campaigns/${slug}/dm/publish`, {
    method: "POST",
    cookie: otherCookie,
  });
  check("non-DM cannot publish", dmPublish.status === 403, `status ${dmPublish.status}`);

  const dmSeize = await req(`/api/campaigns/${slug}/dm`, {
    method: "POST",
    cookie: otherCookie,
    body: { playerId: otherPlayerId },
  });
  check("non-host non-DM cannot take the seat", dmSeize.status === 403, `status ${dmSeize.status}`);

  const dmOutsider = await req(`/api/campaigns/${slug}/dm`, {
    method: "POST",
    cookie: hostCookie,
    body: { playerId: `${SMOKE_PREFIX}_nobody` },
  });
  check("cannot seat a non-member", dmOutsider.status === 400, `status ${dmOutsider.status}`);

  const dmAnon = await req(`/api/campaigns/${slug}/dm/review`, { method: "GET" });
  check("review view needs a session", dmAnon.status === 401, `status ${dmAnon.status}`);

  // Idempotency, from the outside: two publishes, one published beat.
  await req(`/api/campaigns/${slug}/dm/publish`, { method: "POST", cookie: hostCookie });
  const second = await req(`/api/campaigns/${slug}/dm/publish`, {
    method: "POST",
    cookie: hostCookie,
  });
  check(
    "publishing twice does not publish twice",
    second.status === 200 && second.body?.published === false,
    `published=${second.body?.published}`,
  );
```

If the smoke script does not already create a second member for a campaign, reuse whatever it does for the existing "non-member cannot access" checks rather than adding a new fixture.

- [ ] **Step 2: Run the smoke suite**

```bash
node scripts/smoke.mjs http://localhost:8787
```

Expected: every check passes, pre-existing ones included.

- [ ] **Step 3: Reword the promise in the README**

Replace the README's absence paragraph with the exact wording from spec §10:

```markdown
The **simulation** never penalizes absence — never, for any length of absence,
costs you attributes, skills, renown, items, conditions, your life, or access to
anything. That is enforced by tests and proven by a 1500-tick soak.

A **human DM** has full authority over canon, and every edit they make is
recorded and attributed in the chronicle. Campaigns with no DM — and campaigns
whose DM edits nothing — get the promise absolutely.
```

Add a short section describing the DM seat: it defaults to the creator, transfers to any member, reverts to the host after three missed windows, and can be vacated.

**Do not** describe canon editing as available — slice 1 ships prose editing only. The wording above is about what the design permits a DM in general; the README's feature list must say what actually ships today.

- [ ] **Step 4: Update spec §5**

In `docs/specs/2026-08-02-asyncrpg-design.md` §5, add an implementation note in the style of the existing §2 note, pointing at `docs/specs/2026-08-08-dm-role-design.md` and carrying the same reworded promise.

- [ ] **Step 5: Update HANDOFF.md**

Add slice 1 to "What cycle N addressed", note that slices 2 and 3 are specced but unbuilt, and add a line to the gates table for the new tests.

- [ ] **Step 6: Full gates**

```bash
npm test && npm run typecheck && npm run sim:soak -- --ticks 500
```

The soak must be **unchanged** — slice 1 touches no simulation code. A soak difference means something reached into `src/sim/`; find it before continuing.

- [ ] **Step 7: Commit and open the PR**

```bash
git add README.md docs/ scripts/smoke.mjs && git commit -m "docs: the DM seat, and the promise split between sim and DM"
```

```bash
git push -u origin claude/scenario-creator-dm-906a14
```

Open a PR against `main` describing the slice, what it deliberately does not include (canon ops, free-text front door), and the migration hazard reviewers should check (`beats.published_at` backfill).

---

## Verification checklist

Before calling slice 1 done, confirm each of these by running it, not by reading the code:

- [ ] `npm test` — all passing, count reported
- [ ] `npm run typecheck` — clean
- [ ] `npm run sim:soak -- --ticks 500` — identical to before this branch
- [ ] `node scripts/smoke.mjs <url>` — all checks, including the six new adversarial ones
- [ ] `node scripts/ui-smoke.mjs <url>` — all checks at mobile viewport, console clean
- [ ] `npx wrangler d1 migrations apply asyncrpg --local` on a database with pre-existing beats leaves every one of them published
- [ ] A campaign with no DM behaves exactly as it did before this branch: beat publishes on resolution, mail goes out, chronicle updates
- [ ] A new campaign seats its creator as DM, and its first turn is held rather than published
- [ ] Reaching quorum during an open window does not resolve the next turn
