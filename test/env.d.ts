declare module "cloudflare:workers" {
  interface ProvidedEnv extends Env {}
}

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
