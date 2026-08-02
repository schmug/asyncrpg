import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        // Deterministic secrets for tests. Production values are set with
        // `wrangler secret put` and are never committed.
        bindings: {
          EMAIL_TOKEN_SECRET: "test-token-secret-do-not-use-in-prod",
          AUTH_TOKEN_SECRET: "test-auth-secret-do-not-use-in-prod",
        },
      },
    }),
  ],
  test: {
    globals: true,
  },
});
