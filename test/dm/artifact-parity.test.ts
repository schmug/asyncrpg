/**
 * The artifact list exists twice, and must not drift.
 *
 * `src/dm/narrate.ts` rejects corrupted prose before it becomes canon.
 * `scripts/smoke.mjs` checks the *live* chronicle, because the validator only
 * ever covers beats written after it shipped — and it is plain JS run outside
 * the bundler, so it cannot import the real list.
 *
 * A copy that silently falls behind is worse than no copy: the gate would keep
 * passing while a known artifact class shipped. Four classes have reached
 * production so far, each caught by a critic rather than by us, so this guard
 * earns its keep.
 */

import { describe, expect, it } from "vitest";
import { ARTIFACT_PATTERNS } from "../../src/dm/narrate";
// Inlined at transform time. The workers pool sandboxes `fs` to the bundle, so
// the file cannot be read at runtime — `?raw` gets it in as a string instead.
import smoke from "../../scripts/smoke.mjs?raw";

describe("artifact pattern parity", () => {
  it("has patterns to check", () => {
    expect(ARTIFACT_PATTERNS.length).toBeGreaterThanOrEqual(7);
  });

  it.each(ARTIFACT_PATTERNS.map((re) => [re.source, re] as const))(
    "smoke.mjs still carries the pattern %s",
    (source) => {
      expect(smoke).toContain(source);
    },
  );

  it("carries the closed allowlist too, not just the blocklist", () => {
    // The blocklist missed a new artifact class on five consecutive cycles.
    // The allowlist is the rule that actually holds, so the live check must
    // have it as well — mirroring only the patterns would leave the smoke
    // suite one cycle behind again.
    expect(smoke).toContain("ALLOWED_PROSE");
    expect(smoke).toContain("Script=Latin");
    expect(smoke).toMatch(/only characters prose is made of/);
    expect(smoke).toMatch(/run of invisible filler/);
  });

  it("checks the chronicle against every pattern it carries", () => {
    // The mirrored list is iterated, not hand-unrolled, so one loop covers all
    // of them — assert the loop is what runs.
    expect(smoke).toMatch(/for \(const \[label, re\] of ARTIFACT_PATTERNS\)/);
  });
});
