export interface Env {
  DB: D1Database;
  CAMPAIGN: DurableObjectNamespace<import("./campaign-do").CampaignDO>;
  EMAIL: { send(message: EmailSendMessage): Promise<unknown> };
  ASSETS: Fetcher;

  MAIL_DOMAIN: string;
  PUBLIC_ORIGIN: string;
  MODEL_NARRATE: string;
  MODEL_CHEAP: string;
  CAMPAIGN_MONTHLY_TOKEN_BUDGET: string;

  // Secrets — absent in local dev and in CI. Every path degrades rather than
  // failing when these are unset.
  ANTHROPIC_API_KEY?: string;
  EMAIL_TOKEN_SECRET?: string;
  AUTH_TOKEN_SECRET?: string;
}

/** Shape accepted by the Cloudflare Email Sending Workers binding. */
export interface EmailSendMessage {
  to: string;
  from: { email: string; name?: string };
  subject: string;
  text: string;
  html?: string;
  replyTo?: string;
  headers?: Record<string, string>;
}
