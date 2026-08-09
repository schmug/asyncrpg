/**
 * Outbound mail.
 *
 * Two rules govern everything here:
 *   1. Every message carries a stable `Message-ID` we record, so the reply
 *      binds back to (campaign, player, tick) with no work from the player.
 *   2. Anything written by a player or a model is escaped before it reaches
 *      the HTML part. Narrative prose is untrusted content by definition.
 */

import type { EmailSendMessage, Env } from "../env";
import { dossierPath, type Mention, type MentionScan, type Segment } from "../lore/mentions";
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

/**
 * A faint underline reads as *reference*; a coloured link reads as *call to
 * action*, and the only call to action in a beat is "reply". The accent
 * "Read the chronicle" link stays the one loud link in the message.
 *
 * The colour is restated here rather than inherited from the wrapping `<div>`,
 * even though it is the same value. Outlook desktop renders mail through Word,
 * which ignores `color:inherit` — mention anchors would fall back to default
 * hyperlink blue there, up to eight of them, which is precisely the
 * link-density look the cap of `MAX_MENTIONS` exists to avoid. The two
 * `text-decoration-*` properties are unsupported by Word as well, but they
 * degrade to a plain underline, which is the intended effect anyway.
 */
const LINK_STYLE =
  "color:#1c1a17;text-decoration:underline;text-decoration-color:#c9b9a5;text-underline-offset:2px";

/**
 * Escape each segment on its own, then join.
 *
 * Tokenizing happens on raw prose (see `scanProse`), so a match can never
 * straddle an escape sequence and nothing is escaped twice.
 */
function renderSegments(segments: Segment[], slug: string, origin: string): string {
  return segments
    .map((s) => {
      const escaped = escapeHtml(s.value);
      if (s.type === "text") return escaped;
      const href = escapeHtml(`${origin}${dossierPath(slug, s.mention.id)}`);
      return `<a href="${href}" style="${LINK_STYLE}">${escaped}</a>`;
    })
    .join("");
}

/**
 * Assemble the linked body first, split it into paragraphs after.
 *
 * That order is safe only because an anchor can never contain a newline, and
 * that is a guarantee this module does not establish for itself: `candidates()`
 * in `src/lore/mentions.ts` refuses to make a name containing a line break
 * linkable (see `LINE_BREAK` there), so no mention segment can span a `\n{2,}`
 * boundary. Without that rule an entity named "Ashen\n\nCoil" splits into
 * `<p>Then <a …>Ashen</p><p>Coil</a> arrived.</p>` — the value is still
 * escaped, but the nesting is broken. If that rule is ever relaxed, this
 * function has to split first and re-derive segment offsets per paragraph.
 *
 * `segments` is null when the caller supplied no scan, and empty when the scan
 * found nothing to split (empty prose). Both fall back to escaping `text`
 * whole, which is byte-for-byte what a single text segment produces, so all
 * three routes render the same bytes.
 */
function paragraphs(
  text: string,
  segments: Segment[] | null,
  slug: string,
  origin: string,
): string {
  const body = segments?.length ? renderSegments(segments, slug, origin) : escapeHtml(text);
  return body
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 1em">${p.replace(/\n/g, "<br>")}</p>`)
    .join("\n");
}

/**
 * The plain-text who's-who. Same list, same order as the HTML one — a
 * text-only reader gets the identical affordance, spelled out as URLs.
 *
 * An empty blurb loses the dash with it: `blurbFor` answers "" for a malformed
 * row, and a dangling " — " reads as a rendering bug to the one person who
 * would notice.
 */
function whosWhoText(mentions: Mention[], slug: string, origin: string): string {
  if (!mentions.length) return "";
  const lines = mentions
    .map(
      (m) =>
        `  · ${m.name}${m.blurb ? ` — ${m.blurb}` : ""}\n    ${origin}${dossierPath(slug, m.id)}`,
    )
    .join("\n");
  return `\nWho's who in this turn:\n${lines}\n`;
}

function whosWhoHtml(mentions: Mention[], slug: string, origin: string): string {
  if (!mentions.length) return "";
  return (
    `<p style="margin:1.6em 0 .4em;font-weight:600;font-size:.85em">Who's who in this turn</p>` +
    `<ul style="margin:0 0 1em;padding-left:1.2em;font-size:.85em;color:#6b6459">` +
    mentions
      .map((m) => {
        const href = escapeHtml(`${origin}${dossierPath(slug, m.id)}`);
        return (
          `<li style="margin:0 0 .3em">` +
          `<a href="${href}" style="color:#8a4b2a">${escapeHtml(m.name)}</a>` +
          (m.blurb ? ` — ${escapeHtml(m.blurb)}` : "") +
          `</li>`
        );
      })
      .join("") +
    `</ul>`
  );
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
  /** Offscreen players get a gentler sign-off — they are not being asked. */
  offscreen?: boolean;
  /** Set when the DM acted for this player last tick, so we can say so plainly. */
  actedForYou?: string | null;
  /**
   * Entities named in this beat, and the prose pre-split around them.
   * Optional: when absent the mail renders exactly as it did before linking
   * existed, which is what makes the zero-mention path provably unchanged.
   */
  scan?: MentionScan;
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
  const mentions = mail.scan?.mentions ?? [];
  const origin = env.PUBLIC_ORIGIN;

  const recapText = mail.recap?.length
    ? `\n\nWhile you were away:\n${mail.recap.map((r) => `  · ${r}`).join("\n")}`
    : "";
  const autoText = mail.actedForYou
    ? `\n\n(You were away last turn, so we had your character ${mail.actedForYou}. Nothing was risked.)`
    : "";

  const text =
    `${mail.prose}${recapText}${autoText}\n\n` +
    `— ${mail.prompt}\n\n` +
    (mail.offscreen
      ? `Reply whenever you want to pick it back up. There is no hurry and nothing to catch up on.\n`
      : `Just reply to this email. Reply whenever suits you; nothing bad happens if you don't.\n`) +
    `Chronicle: ${chronicle}\n` +
    // Below the prompt and the reply line in both parts, so the who's-who never
    // competes with the call to action.
    whosWhoText(mentions, mail.campaignSlug, origin);

  const html =
    `<div style="font:16px/1.6 Georgia,serif;max-width:34em;margin:0 auto;color:#1c1a17">` +
    paragraphs(mail.prose, mail.scan?.segments ?? null, mail.campaignSlug, origin) +
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
    (mail.offscreen
      ? `Reply whenever you want to pick it back up. There is no hurry and nothing to catch up on.</p>`
      : `Just reply to this email. Reply whenever suits you — nothing bad happens if you don't.</p>`) +
    `<p style="margin:0;font-size:.85em"><a href="${escapeHtml(chronicle)}" style="color:#8a4b2a">Read the chronicle</a></p>` +
    whosWhoHtml(mentions, mail.campaignSlug, origin) +
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
    // A held beat has no mention scan yet, so the prose renders unlinked —
    // null segments fall back to escaping the text whole.
    paragraphs(opts.prose, null, opts.campaignSlug, opts.origin) +
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
