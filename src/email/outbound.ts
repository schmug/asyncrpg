/**
 * Outbound mail.
 *
 * Two rules govern everything here:
 *   1. Every message carries a stable `Message-ID` we record, so the reply
 *      binds back to (campaign, player, tick) with no work from the player.
 *   2. Anything written by a player or a model is escaped before it reaches
 *      the HTML part. Narrative prose is untrusted content by definition.
 */

import type { Env } from "../env";
import { buildSubject, INBOX_LOCAL, isUndeliverable } from "./parse";
import { mintReplyCode } from "./token";

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
/** Why a beat did or did not reach its player — the reason matters downstream. */
export type SendResult =
  | { ok: true; code: string }
  | { ok: false; error: string }
  /** Not attempted: the address provably cannot receive mail. Not a failure. */
  | { ok: false; suppressed: true; code: string; error: string };

export async function sendBeat(env: Env, mail: BeatMail): Promise<SendResult> {
  const domain = env.MAIL_DOMAIN;
  // The reply capability for exactly this (campaign, player, tick). See
  // ./token.ts for why it rides the subject line rather than the Reply-To.
  const code = await mintReplyCode(env.EMAIL_TOKEN_SECRET, {
    campaignId: mail.campaignId,
    playerId: mail.playerId,
    tick: mail.tick,
  });
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

  let assignedMessageId: string | null = null;
  let lastError: unknown = null;

  // Never hand a guaranteed hard bounce to the provider. The binding is still
  // written below — reply authentication is about identity, not delivery, and
  // a suppressed send should not silently disable the reply path for a test
  // campaign or leave a gap the smoke suite reads as a regression.
  const suppressed = isUndeliverable(mail.toEmail);
  if (suppressed) {
    console.log(
      `send suppressed for undeliverable address campaign=${mail.campaignId} tick=${mail.tick}`,
    );
  }

  // One retry. Most send failures are transient (rate limit, upstream blip),
  // and the beat is the product's primary channel — dropping it on the first
  // stumble loses a player their turn. A second failure is logged and the
  // player still has the web copy.
  for (let attempt = 0; attempt < 2 && !suppressed; attempt++) {
  try {
    // Cloudflare Email Sending rejects a caller-supplied `Message-ID`
    // ("Only whitelisted headers and X-* headers are accepted"), so the
    // threading id cannot be chosen by us — it is assigned at send time and
    // read back off the response. The `X-Asyncrpg-*` headers below are for
    // operators reading raw mail; replies never echo them, so they play no
    // part in binding.
    const sent = (await env.EMAIL.send({
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
    })) as { messageId?: string; message_id?: string; id?: string } | undefined;

    const raw = sent?.messageId ?? sent?.message_id ?? sent?.id ?? null;
    assignedMessageId = raw ? raw.replace(/^<|>$/g, "") : null;
    lastError = null;
    break;
  } catch (err) {
    lastError = err;
    if (attempt === 0) {
      await new Promise((r) => setTimeout(r, 750));
      continue;
    }
    // A delivery failure must not stop the tick — the beat is already stored
    // and readable on the web, and the next tick's mail carries the player
    // forward. But it must not be *silent*: swallowing this without a log
    // makes a total mail outage invisible, which is the one failure mode that
    // breaks the product's primary channel while every dashboard stays green.
    console.error(
      `email send failed after retry campaign=${mail.campaignId} tick=${mail.tick} player=${mail.playerId}:`,
      err instanceof Error ? err.message : String(err),
    );
    // Hand the reason back rather than a bare null. "Quota exceeded" and "the
    // provider is down" need completely different responses, and a delivery
    // record that cannot tell them apart is a record of the wrong thing.
    // Never thrown: a delivery failure must not stop a tick resolving.
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  }
  if (lastError) return { ok: false, error: String(lastError) };

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
    return suppressed
      ? { ok: false, suppressed: true, code, error: "address cannot receive mail" }
      : { ok: true, code };
  }
  return suppressed
    ? { ok: false, suppressed: true, code, error: "address cannot receive mail" }
    : { ok: true, code };
}

export async function sendMagicLink(
  env: Env,
  toEmail: string,
  token: string,
): Promise<{ ok: true } | { ok: false; error: string; suppressed?: true }> {
  const url = `${env.PUBLIC_ORIGIN}/auth/callback?t=${encodeURIComponent(token)}`;
  if (isUndeliverable(toEmail)) {
    // Same guard as the beat path. A sign-in attempt at a reserved domain is
    // almost always a typo or a test, and either way it is a certain bounce.
    console.log("magic link suppressed for an address that cannot receive mail");
    return { ok: false, error: "address cannot receive mail", suppressed: true };
  }
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
    return { ok: true };
  } catch (err) {
    // This used to be a bare `catch { return false }`, and that made the one
    // path a brand-new user depends on the only one that could fail in total
    // silence. `/api/auth/request` deliberately answers 200 whatever happens,
    // so nobody can use it to discover which addresses have accounts — which
    // means a swallowed error here is invisible from both ends at once: the
    // person sees "a link is on its way" and the operator sees a clean 200.
    //
    // Reported for real on 2026-08-03: a sign-in that produced no email and no
    // log line anywhere. Anti-enumeration is about what the *response* says,
    // not about what we are allowed to know.
    console.error(
      `magic link send failed for ${toEmail.replace(/^(.).*(@.*)$/, "$1***$2")}:`,
      err instanceof Error ? err.message : String(err),
    );
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
