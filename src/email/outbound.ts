/**
 * Outbound mail.
 *
 * Two rules govern everything here:
 *   1. Every message carries a stable `Message-ID` we record, so the reply
 *      binds back to (campaign, player, tick) with no work from the player.
 *   2. Anything written by a player or a model is escaped before it reaches
 *      the HTML part. Narrative prose is untrusted content by definition.
 */

import { shortCode } from "../auth";
import type { EmailSendMessage, Env } from "../env";
import { buildSubject, INBOX_LOCAL } from "./parse";

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function paragraphs(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 1em">${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
    .join("\n");
}

function messageId(domain: string): string {
  const rand = crypto.randomUUID();
  return `${rand}@${domain}`;
}

/**
 * Hand one message to the binding, with a single retry.
 *
 * The one place in this file that talks to the mail provider. Most send
 * failures are transient (rate limit, upstream blip), and dropping a message on
 * the first stumble loses a player their turn. A second failure is logged —
 * never thrown, and never silent: swallowing it without a line makes a total
 * mail outage invisible while every dashboard stays green.
 *
 * Returns the threading id the provider assigned, or `null` if nothing was
 * sent. `null` inside the wrapper means "the provider accepted the message but
 * named no id", which is a different thing and is why the return is nested.
 */
async function sendWithRetry(
  env: Env,
  message: EmailSendMessage,
  context: string,
): Promise<{ assignedMessageId: string | null } | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // Cloudflare Email Sending rejects a caller-supplied `Message-ID`
      // ("Only whitelisted headers and X-* headers are accepted"), so the
      // threading id cannot be chosen by us — it is assigned at send time and
      // read back off the response.
      const sent = (await env.EMAIL.send(message)) as
        | { messageId?: string; message_id?: string; id?: string }
        | undefined;
      const raw = sent?.messageId ?? sent?.message_id ?? sent?.id ?? null;
      return { assignedMessageId: raw ? raw.replace(/^<|>$/g, "") : null };
    } catch (err) {
      if (attempt === 0) {
        await new Promise((r) => setTimeout(r, 750));
        continue;
      }
      console.error(
        `email send failed after retry ${context}:`,
        err instanceof Error ? err.message : String(err),
      );
      return null;
    }
  }
  return null;
}

export interface BeatMail {
  campaignId: string;
  campaignSlug: string;
  campaignName: string;
  tick: number;
  playerId: string;
  toEmail: string;
  headline: string;
  prose: string;
  prompt: string;
  recap?: string[];
  /** Set when the DM acted for this player last tick, so we can say so plainly. */
  actedForYou?: string | null;
}

/**
 * Send one player their beat, and record the binding that lets their reply
 * resolve without them doing anything but hitting reply.
 */
export async function sendBeat(env: Env, mail: BeatMail): Promise<{ code: string } | null> {
  const domain = env.MAIL_DOMAIN;
  const code = shortCode();
  const id = messageId(domain);
  const replyTo = `${INBOX_LOCAL}@${domain}`;
  const subject = buildSubject(mail.campaignName, mail.tick, code, mail.headline);
  const chronicle = `${env.PUBLIC_ORIGIN}/c/${encodeURIComponent(mail.campaignSlug)}`;

  const recapText = mail.recap?.length
    ? `\n\nWhile you were away:\n${mail.recap.map((r) => `  · ${r}`).join("\n")}`
    : "";
  const autoText = mail.actedForYou
    ? `\n\n(You were away last turn, so we had your character ${mail.actedForYou}. Nothing was risked.)`
    : "";

  const text =
    `${mail.prose}${recapText}${autoText}\n\n` +
    `— ${mail.prompt}\n\n` +
    `Just reply to this email. Reply whenever suits you; nothing bad happens if you don't.\n` +
    `Chronicle: ${chronicle}\n`;

  const html =
    `<div style="font:16px/1.6 Georgia,serif;max-width:34em;margin:0 auto;color:#1c1a17">` +
    paragraphs(mail.prose) +
    (mail.recap?.length
      ? `<p style="margin:1.5em 0 .4em;font-weight:600">While you were away</p><ul style="margin:0 0 1em;padding-left:1.2em">` +
        mail.recap.map((r) => `<li>${escapeHtml(r)}</li>`).join("") +
        `</ul>`
      : "") +
    (mail.actedForYou
      ? `<p style="margin:1em 0;padding:.7em 1em;background:#f4f1ea;border-radius:6px;font-size:.92em">` +
        `You were away last turn, so we had your character ${escapeHtml(mail.actedForYou)}. Nothing was risked.</p>`
      : "") +
    `<hr style="border:0;border-top:1px solid #ddd8cf;margin:1.6em 0">` +
    `<p style="margin:0 0 .6em;font-weight:600">${escapeHtml(mail.prompt)}</p>` +
    `<p style="margin:0 0 1em;color:#6b6459;font-size:.9em">` +
    `Just reply to this email. Reply whenever suits you — nothing bad happens if you don't.</p>` +
    `<p style="margin:0;font-size:.85em"><a href="${escapeHtml(chronicle)}" style="color:#8a4b2a">Read the chronicle</a></p>` +
    `</div>`;

  // A delivery failure must not stop the tick — the beat is already stored and
  // readable on the web, and the next tick's mail carries the player forward.
  // The `X-Asyncrpg-*` headers are for operators reading raw mail; replies
  // never echo them, so they play no part in binding.
  const result = await sendWithRetry(
    env,
    {
      to: mail.toEmail,
      from: { email: `dm@${domain}`, name: mail.campaignName },
      replyTo,
      subject,
      text,
      html,
      headers: {
        "X-Asyncrpg-Campaign": mail.campaignSlug,
        "X-Asyncrpg-Tick": String(mail.tick),
      },
    },
    `campaign=${mail.campaignId} tick=${mail.tick} player=${mail.playerId}`,
  );
  if (!result) return null;
  const assignedMessageId = result.assignedMessageId;

  try {
    await env.DB.prepare(
      `INSERT INTO reply_bindings (code, message_id, campaign_id, player_id, tick, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        code,
        // When the provider does not hand back a threading id, store a value
        // that is unique but can never match an inbound In-Reply-To. The
        // subject code then carries the binding on its own — degraded, not
        // broken, and honest about which path is live.
        assignedMessageId ?? `unthreaded:${id}`,
        mail.campaignId,
        mail.playerId,
        mail.tick,
        // Generous: a player who replies to a three-week-old mail should still
        // land, and the tick check happens separately.
        Date.now() + 90 * 24 * 60 * 60 * 1000,
        new Date().toISOString(),
      )
      .run();
  } catch (err) {
    // Without a binding the reply still works via sender match alone; it just
    // loses the tick association. Log it: a binding table that is silently
    // never written looks identical to one that is working.
    console.error(
      `reply binding insert failed campaign=${mail.campaignId} tick=${mail.tick}:`,
      err instanceof Error ? err.message : String(err),
    );
    return { code };
  }
  return { code };
}

export function reviewNoticeSubject(campaignName: string, tick: number): string {
  return `[${campaignName}] Turn ${tick} is ready for you`;
}

export interface ReviewNotice {
  campaignName: string;
  campaignSlug: string;
  tick: number;
  prose: string;
  closesAt: number;
  origin: string;
}

/**
 * Where the DM goes to review a held beat.
 *
 * Deliberately the campaign page and not a `/review` sub-route: the app's
 * router matches `#/c/<slug>` exactly (`public/app.js`), so a trailing segment
 * falls through to the campaign list and the DM lands nowhere useful. The
 * review desk is not a separate screen anyway — it renders inline on the
 * campaign page for whoever holds the seat, so this link already arrives at it.
 */
function reviewUrl(opts: ReviewNotice): string {
  return `${opts.origin}/#/c/${encodeURIComponent(opts.campaignSlug)}`;
}

export function reviewNoticeBody(opts: ReviewNotice): string {
  const closes = new Date(opts.closesAt).toUTCString();
  return [
    `Turn ${opts.tick} of ${opts.campaignName} has resolved. Nobody has seen it yet.`,
    ``,
    opts.prose,
    ``,
    `———`,
    ``,
    `Read it, rewrite it, or send it as it stands:`,
    reviewUrl(opts),
    ``,
    `If you do nothing it publishes on its own at ${closes}, so the story never`,
    `waits on you.`,
  ].join("\n");
}

/**
 * The HTML part of the same notice.
 *
 * The prose here is a beat *nobody has reviewed yet* — model output, quoted
 * back at the one person with authority over it. It goes through the same
 * escaping every other untrusted string in this file does.
 */
export function reviewNoticeHtml(opts: ReviewNotice): string {
  const url = reviewUrl(opts);
  return (
    `<div style="font:16px/1.6 Georgia,serif;max-width:34em;margin:0 auto;color:#1c1a17">` +
    `<p style="margin:0 0 1em;color:#6b6459;font-size:.9em">Turn ${opts.tick} of ` +
    `${escapeHtml(opts.campaignName)} has resolved. Nobody has seen it yet.</p>` +
    paragraphs(opts.prose) +
    `<hr style="border:0;border-top:1px solid #ddd8cf;margin:1.6em 0">` +
    `<p style="margin:0 0 .6em"><a href="${escapeHtml(url)}" style="color:#8a4b2a">` +
    `Read it, rewrite it, or send it as it stands</a></p>` +
    `<p style="margin:0;color:#6b6459;font-size:.9em">If you do nothing it publishes on its own at ` +
    `${escapeHtml(new Date(opts.closesAt).toUTCString())}, so the story never waits on you.</p>` +
    `</div>`
  );
}

/**
 * Mail the DM that a beat is held.
 *
 * Best-effort by construction: the window closes on the alarm whether or not
 * this arrives, so a mail failure costs a notification, never a turn. It writes
 * no `reply_bindings` row on purpose — this is not a turn prompt, and a binding
 * would file the DM's reply as their character's action for the very turn they
 * are being asked to review. For the same reason it sets no `replyTo`: replies
 * land on the from address rather than the inbound game inbox.
 */
export async function sendReviewNotice(
  env: Env,
  opts: {
    campaignSlug: string;
    campaignName: string;
    tick: number;
    toEmail: string;
    prose: string;
    closesAt: number;
  },
): Promise<void> {
  const notice: ReviewNotice = { ...opts, origin: env.PUBLIC_ORIGIN };
  await sendWithRetry(
    env,
    {
      to: opts.toEmail,
      from: { email: `dm@${env.MAIL_DOMAIN}`, name: opts.campaignName },
      subject: reviewNoticeSubject(opts.campaignName, opts.tick),
      text: reviewNoticeBody(notice),
      html: reviewNoticeHtml(notice),
      headers: {
        "X-Asyncrpg-Campaign": opts.campaignSlug,
        "X-Asyncrpg-Tick": String(opts.tick),
      },
    },
    `review-notice campaign=${opts.campaignSlug} tick=${opts.tick}`,
  );
}

export async function sendMagicLink(env: Env, toEmail: string, token: string): Promise<boolean> {
  const url = `${env.PUBLIC_ORIGIN}/auth/callback?t=${encodeURIComponent(token)}`;
  try {
    await env.EMAIL.send({
      to: toEmail,
      from: { email: `dm@${env.MAIL_DOMAIN}`, name: "asyncrpg" },
      subject: "Your sign-in link",
      text: `Sign in:\n\n${url}\n\nThis link works once and expires in 20 minutes.\nIf you didn't ask for it, ignore this email.\n`,
      html:
        `<div style="font:16px/1.6 Georgia,serif;max-width:30em;margin:0 auto">` +
        `<p><a href="${escapeHtml(url)}" style="color:#8a4b2a">Sign in to asyncrpg</a></p>` +
        `<p style="color:#6b6459;font-size:.9em">This link works once and expires in 20 minutes. ` +
        `If you didn't ask for it, ignore this email.</p></div>`,
    });
    return true;
  } catch {
    return false;
  }
}
