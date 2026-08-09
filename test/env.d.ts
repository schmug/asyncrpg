declare module "cloudflare:workers" {
  interface ProvidedEnv extends Env {}
}

// Vite's `?raw` suffix — a module's source text, inlined at transform time.
// `test/helpers/schema.ts` uses it to read the real migration files rather
// than restate them, and `test/dm/artifact-parity.test.ts` uses it to read
// `scripts/smoke.mjs`.
declare module "*?raw" {
  const content: string;
  export default content;
}

// `import.meta.glob`, used by `test/helpers/schema.ts` to discover every
// migration instead of hand-listing them. Declared here rather than pulling in
// `vite/client` wholesale, which would also drag in DOM-flavoured asset and
// CSS-module types that nothing in this project uses.
interface ImportMeta {
  glob<T = unknown>(
    pattern: string,
    options?: { query?: string; import?: string; eager?: boolean },
  ): Record<string, T>;
}
