declare module "cloudflare:workers" {
  interface ProvidedEnv extends Env {}
}

// Vite's `?raw` suffix, used by `test/helpers/schema.ts` to read the real
// migration files rather than restate them.
declare module "*.sql?raw" {
  const sql: string;
  export default sql;
}
