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

  /**
   * The git revision this Worker was built from, injected at deploy time by
   * `npm run deploy`. Reported on `/api/health` so that "the code I am reading"
   * and "the deployment I am measuring" can be shown to be the same thing —
   * a review of one against the other is otherwise unfalsifiable.
   */
  GIT_REVISION?: string;

  // Secrets — absent in local dev and in CI. Every path degrades rather than
  // failing when these are unset.
  ANTHROPIC_API_KEY?: string;
  /**
   * Reserved mailbox on a second onboarded zone, used to prove the inbound
   * SMTP hop end to end. Unset in normal operation, which makes the loopback
   * entirely inert.
   */
  EMAIL_LOOPBACK_ADDRESS?: string;
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
