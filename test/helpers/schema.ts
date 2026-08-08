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
 * missing table only surfaces as `no such table` in whichever unrelated test
 * happens to touch it next. Reviewing this file proved that gap was real — an
 * unlisted migration left the suite fully green.
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
