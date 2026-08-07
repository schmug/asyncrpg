/**
 * Inbound-path verification loopback.
 *
 * The one rung of the verification ladder that could not be proven was the
 * inbound SMTP hop: showing that a beat we send is really delivered, and that
 * a reply to it really reaches `email()` through Cloudflare Email Routing.
 * Everything else was covered by integration tests handing synthetic MIME to
 * the handler, which proves the logic and not the plumbing.
 *
 * This closes it. A reserved address on a *different* onboarded zone from the
 * game's own inbox acts as a test player's mailbox:
 *
 *   1. the game sends a beat to `<loopback>@q-r.contact`      — real send
 *   2. Email Routing delivers it back to this Worker           — real hop #1
 *   3. we record it, then reply to `rpg@cortech.online`        — real send
 *   4. Email Routing delivers that to this Worker              — real hop #2
 *   5. normal inbound handling submits the action
 *
 * Two independent zones and two real deliveries. If any part of the mail path
 * is broken, this fails.
 *
 * Inert unless `EMAIL_LOOPBACK_ADDRESS` is set. It is a deliberate, narrow,
 * configuration-gated diagnostic, not an always-on auto-responder: it replies
 * only to mail addressed to that exact address, and only when the message
 * carries our own outbound campaign header.
 */

import type { Env } from "../env";
import { INBOX_LOCAL } from "./parse";

export interface LoopbackMessage {
  to: string;
  from: string;
  subject: string;
  messageId: string;
  inReplyTo: string;
  body: string;
  /**
   * The header From. Distinct from the envelope sender: Cloudflare rewrites
   * the envelope to `bounces@cf-bounce.<domain>` on mail it sends, so the two
   * disagree on every message this loop handles.
   */
  headerFrom: string;
  /** Our own `X-Asyncrpg-Campaign` header, present only on beats we sent. */
  campaignHeader: string | null;
}

export function isLoopbackAddress(env: Env, to: string | null | undefined): boolean {
  const configured = env.EMAIL_LOOPBACK_ADDRESS?.trim().toLowerCase();
  if (!configured || !to) return false;
  const bare = (/<([^>]+)>/.exec(to)?.[1] ?? to).trim().toLowerCase();
  return bare === configured;
}

async function record(
  env: Env,
  direction: "received" | "replied",
  m: Partial<LoopbackMessage>,
): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO email_loopback
         (id, direction, to_address, from_address, subject, message_id, in_reply_to, body, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        `lb_${crypto.randomUUID().slice(0, 12)}`,
        direction,
        (m.to ?? "").slice(0, 320),
        (m.from ?? "").slice(0, 320),
        (m.subject ?? "").slice(0, 500),
        (m.messageId ?? "").slice(0, 320),
        (m.inReplyTo ?? "").slice(0, 320),
        (m.body ?? "").slice(0, 8000),
        new Date().toISOString(),
      )
      .run();
  } catch (err) {
    console.error("loopback record failed:", err instanceof Error ? err.message : String(err));
  }
}

/**
 * Handle a message delivered to the loopback address.
 *
 * Returns true when the message was consumed here, so the caller skips normal
 * player-action handling.
 */
export async function handleLoopback(env: Env, m: LoopbackMessage): Promise<boolean> {
  await record(env, "received", { ...m, from: `${m.from} (header: ${m.headerFrom})` });

  // Only ever reply to something this game sent. Without this check the
  // address would answer any mail that reached it, including a bounce — and
  // two auto-responders talking to each other is a mail loop.
  if (!m.campaignHeader) {
    console.warn("loopback: received mail with no campaign header; not replying");
    return true;
  }

  const replyTo = `${INBOX_LOCAL}@${env.MAIL_DOMAIN}`;
  const action =
    "I check the road before first light and note who is already awake. " +
    "(sent by the inbound-path verification loopback)";

  try {
    await env.EMAIL.send({
      to: replyTo,
      // From the loopback address itself: the inbound handler authenticates on
      // the envelope sender, so the reply has to genuinely originate here.
      from: { email: env.EMAIL_LOOPBACK_ADDRESS!, name: "Loopback Player" },
      // Echoing the subject preserves the `#code` marker, which is the
      // fallback binding path when threading headers are stripped.
      subject: `Re: ${m.subject}`.slice(0, 900),
      text: action,
    });
    await record(env, "replied", {
      to: replyTo,
      from: env.EMAIL_LOOPBACK_ADDRESS!,
      subject: `Re: ${m.subject}`,
      inReplyTo: m.messageId,
      body: action,
    });
  } catch (err) {
    console.error("loopback reply failed:", err instanceof Error ? err.message : String(err));
  }
  return true;
}
