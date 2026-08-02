/**
 * Health endpoint provenance.
 *
 * The critic reviews a clone of a git revision while the evidence bundle is
 * captured from a live deployment. Cycle 1 produced a false finding because
 * those two were different revisions and nothing in the capture could show it.
 * `/api/health` therefore reports the revision the running Worker was built
 * from, so a skew is a fact anyone can check rather than an assumption.
 */

import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env as runtimeEnv } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Env } from "../../src/env";
import worker from "../../src/index";

const env = runtimeEnv as unknown as Env;

async function health(overrides: Partial<Env> = {}): Promise<Record<string, unknown>> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request("https://play.cortech.online/api/health"),
    { ...env, ...overrides } as Env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return (await res.json()) as Record<string, unknown>;
}

describe("/api/health", () => {
  it("reports the revision the running build came from", async () => {
    const body = await health({ GIT_REVISION: "0123456789abcdef0123456789abcdef01234567" });
    expect(body.ok).toBe(true);
    expect(body.revision).toBe("0123456789abcdef0123456789abcdef01234567");
  });

  it("says so plainly when the build carries no revision, rather than omitting it", async () => {
    const body = await health({ GIT_REVISION: undefined });
    expect(body.ok).toBe(true);
    // An absent key would read as "this deployment predates provenance"; an
    // explicit "unknown" reads as "this build was deployed without a revision",
    // which is the thing a reviewer actually needs to distinguish.
    expect(body.revision).toBe("unknown");
  });
});
