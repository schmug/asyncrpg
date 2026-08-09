declare module "cloudflare:workers" {
  interface ProvidedEnv extends Env {}
}

/** Vite's `?raw` suffix — a module's source text, inlined at transform time. */
declare module "*?raw" {
  const content: string;
  export default content;
}
