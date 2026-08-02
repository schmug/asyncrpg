#!/usr/bin/env node
/**
 * Independent-critic runner.
 *
 * Per cycle: clean clone of committed HEAD -> live-capture evidence bundle
 * (endpoint captures, gate evidence, smoke/UI outputs, real narration,
 * screenshots) -> critic CLI in a read-only sandbox with a fresh context ->
 * verdict JSON + full transcript in critic-reports/.
 *
 * The bundle is the whole game: the critic's sandbox has no network and no
 * node_modules, so anything not captured here reads to it as absent.
 *
 * Usage: node scripts/critic.mjs <cycleNumber>
 * Exits 2 when no JSON verdict could be extracted.
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ─── CONFIG ──────────────────────────────────────────────────────────────
const BASE = "https://play.cortech.online";
const DEMO_SLUG = "demo";
const CAPTURE_PATHS = [
  ["/", "index.html.txt"],
  ["/api/health", "health.txt"],
  ["/app.css", "app.css.txt"],
  ["/app.js", "app.js.txt"],
  ["/manifest.webmanifest", "manifest.txt"],
  [`/c/${DEMO_SLUG}`, "chronicle-demo.html.txt"],
  ["/api/me", "api-me-unauthenticated.txt"],
  ["/api/nope", "api-unknown-endpoint.txt"],
  [`/c/${DEMO_SLUG}-does-not-exist`, "chronicle-missing.txt"],
];
const EVIDENCE = [
  { cmd: "node", args: ["scripts/smoke.mjs", BASE], file: "smoke-output.txt" },
  { cmd: "node", args: ["scripts/ui-smoke.mjs", BASE], file: "ui-smoke-output.txt" },
  { cmd: "node", args: ["scripts/email-e2e.mjs", BASE], file: "email-e2e-output.txt" },
  { cmd: "npx", args: ["tsx", "scripts/sim-soak.ts", "--ticks", "1000"], file: "sim-soak-output.txt" },
  { cmd: "node", args: ["scripts/dump-narration.mjs", BASE, DEMO_SLUG], file: "generated-narration.txt" },
];
const COPY_DIRS = ["critic-reports/ui"];
const CRITIC = { cmd: "codex", args: ["exec", "--skip-git-repo-check", "--sandbox", "read-only"] };
// ─────────────────────────────────────────────────────────────────────────

const cycle = String(process.argv[2] ?? "0").padStart(2, "0");
const repoRoot = process.cwd();
const work = join(tmpdir(), `critic-${cycle}-${Date.now()}`);

execFileSync("git", ["clone", "--depth", "1", "--quiet", `file://${repoRoot}`, work]);

function tryRun(cmd, args, timeout = 600_000) {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", timeout, maxBuffer: 32 * 1024 * 1024 });
  } catch (err) {
    return `${err.stdout ?? ""}\n${err.stderr ?? ""}\nEXITED NON-ZERO`;
  }
}

const cap = join(work, "live-capture");
mkdirSync(cap, { recursive: true });

// Gate evidence: the critic's sandbox has no network and no node_modules, so
// prove the gates ran on the exact revision under review.
const sha = tryRun("git", ["rev-parse", "HEAD"]).trim();
writeFileSync(
  join(cap, "gates.txt"),
  [
    `revision under review: ${sha}`,
    `captured at: (see timings.json)`,
    `\n$ npm run typecheck\n${tryRun("npm", ["run", "typecheck"])}`,
    `\n$ npm test\n${tryRun("npm", ["test"])}`,
    `\n$ gh run list (GitHub Actions CI)\n${tryRun("gh", ["run", "list", "--limit", "10"])}`,
    `\n$ git log --oneline -20\n${tryRun("git", ["log", "--oneline", "-20"])}`,
    // Cycle 1 produced a false finding because the cloned repo and the live
    // deployment were different revisions: the smoke suite in the clone
    // asserted behavior the deployment had already changed. Record both so a
    // skew is visible rather than mistaken for a product defect.
    `\n$ git status --porcelain (uncommitted changes in the working tree)\n${tryRun("git", ["status", "--porcelain"], 30_000) || "(clean)"}`,
    `\n$ wrangler deployments list (what is actually serving ${BASE})\n${tryRun("npx", ["wrangler", "deployments", "list"], 120_000)}`,
  ].join("\n"),
);

const timings = [];
for (const [path, name] of CAPTURE_PATHS) {
  const t0 = Date.now();
  let status = 0;
  let body = "";
  let headers = "";
  try {
    const res = await fetch(BASE + path, { redirect: "manual" });
    status = res.status;
    body = await res.text();
    headers = [...res.headers.entries()].map(([k, v]) => `${k}: ${v}`).join("\n");
  } catch (err) {
    body = `FETCH FAILED: ${err.message}`;
  }
  const ms = Date.now() - t0;
  writeFileSync(
    join(cap, name),
    `# GET ${path}\n# status: ${status}  time: ${ms}ms\n\n## headers\n${headers}\n\n## body\n${body.slice(0, 90_000)}`,
  );
  timings.push({ path, status, ms, bytes: body.length, at: new Date().toISOString() });
}
writeFileSync(join(cap, "timings.json"), JSON.stringify(timings, null, 2));

for (const step of EVIDENCE) {
  console.error(`[critic] evidence: ${step.cmd} ${step.args.join(" ")}`);
  writeFileSync(join(cap, step.file), tryRun(step.cmd, step.args));
}
for (const dir of COPY_DIRS) {
  try {
    cpSync(dir, join(cap, dir.split("/").pop()), { recursive: true });
  } catch {
    /* optional */
  }
}

const prompt = readFileSync("scripts/critic-prompt.md", "utf8");
console.error(`[critic] cycle ${cycle}: running ${CRITIC.cmd} in ${work}`);
let out = "";
try {
  out = execFileSync(CRITIC.cmd, [...CRITIC.args, "--cd", work, "-"], {
    input: prompt,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 45 * 60 * 1000,
    stdio: ["pipe", "pipe", "ignore"],
  });
} catch (err) {
  out = err.stdout ?? "";
  if (!out) throw err;
}

const blocks = [...out.matchAll(/```json\s*([\s\S]*?)```/g)];
let verdict = null;
for (let i = blocks.length - 1; i >= 0 && !verdict; i--) {
  try {
    verdict = JSON.parse(blocks[i][1]);
  } catch {
    /* try an earlier block */
  }
}

mkdirSync("critic-reports", { recursive: true });
writeFileSync(`critic-reports/cycle-${cycle}.md`, out);
if (verdict) {
  verdict.cycle = Number(cycle);
  verdict.revision = sha;
  verdict.capturedAt = new Date().toISOString();
  writeFileSync(`critic-reports/cycle-${cycle}.json`, JSON.stringify(verdict, null, 2));
  const s = verdict.scores ?? {};
  console.log(
    `\ncycle ${cycle} — ${verdict.verdict}  ` +
      Object.entries(s)
        .map(([k, v]) => `${k}:${v}`)
        .join("  "),
  );
  console.log(`${(verdict.requiredFixes ?? []).length} required fixes`);
} else {
  console.error(`[critic] FAILED to extract JSON verdict — see critic-reports/cycle-${cycle}.md`);
  process.exit(2);
}
