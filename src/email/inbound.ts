/**
 * Inbound mail: a reply becomes a turn.
 *
 * Identity requires **two** independent facts to line up:
 *   1. the message binds to a campaign — via the Message-ID we sent (primary,
 *      invisible), the subject code (fallback), or the campaign's own inbox
 *      address (last resort);
 *   2. the envelope sender is a registered member of that campaign.
 *
 * Neither alone is enough. Knowing a campaign address does not let you play,
 * and a forwarded email does not let the recipient act as its original owner.
 */

import PostalMime from "postal-mime";
import type { Env } from "../env";
import { handleLoopback, isLoopbackAddress } from "./loopback";
import {
  codeFromSubject,
  isInboxAddress,
  localPart,
  referencedMessageIds,
  sameAddress,
  stripQuotedReply,
} from "./parse";

interface Binding {
  campaign_id: string;
  player_id: string;
  tick: number;
}

/** Message-ID first, then subject code. Both are cheap indexed lookups. */
async function bindingFor(
  env: Env,
  messageIds: string[],
  code: string | null,
): Promise<Binding | null> {
  for (const id of messageIds.slice(0, 10)) {
    const row = await env.DB.prepare(
      "SELECT campaign_id, player_id, tick FROM reply_bindings WHERE message_id = ? AND expires_at > ?",
    )
      .bind(id, Date.now())
      .first<Binding>();
    if (row) return row;
  }
  if (code) {
    const row = await env.DB.prepare(
      "SELECT campaign_id, player_id, tick FROM reply_bindings WHERE code = ? AND expires_at > ?",
    )
      .bind(code, Date.now())
      .first<Binding>();
    if (row) return row;
  }
  return null;
}

export async function handleInboundEmail(
  message: ForwardableEmailMessage,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  // `message.raw` is single-use — buffer it before anything else touches it.
  let body = "";
  let subject = message.headers.get("subject");
  let inReplyTo = message.headers.get("in-reply-to");
  let references = message.headers.get("references");
  let messageIdHeader = message.headers.get("message-id");
  let headerFrom = message.headers.get("from");

  try {
    const raw = await new Response(message.raw).arrayBuffer();
    const parsed = await PostalMime.parse(raw);
    body = parsed.text ?? stripTags(parsed.html ?? "");
    subject = parsed.subject ?? subject;
    inReplyTo = parsed.inReplyTo ?? inReplyTo;
    references = parsed.references ?? references;
    messageIdHeader = parsed.messageId ?? messageIdHeader;
    headerFrom = parsed.from?.address ?? headerFrom;
  } catch {
    message.setReject("Could not read that message.");
    return;
  }

  // Mail to the verification loopback is not a player action — it is a beat
  // coming back to us, which the loopback records and answers.
  if (isLoopbackAddress(env, message.to)) {
    ctx.waitUntil(
      handleLoopback(env, {
        to: message.to,
        from: message.from,
        subject: subject ?? "",
        messageId: messageIdHeader ?? "",
        inReplyTo: inReplyTo ?? "",
        body,
        headerFrom: headerFrom ?? "",
        campaignHeader: message.headers.get("x-asyncrpg-campaign"),
      }).catch((err) => console.error("loopback failed", err)),
    );
    return;
  }

  const text = stripQuotedReply(body).slice(0, 8000);
  const code = codeFromSubject(subject);
  const binding = await bindingFor(env, referencedMessageIds({ inReplyTo, references }), code);

  if (!isInboxAddress(localPart(message.to))) {
    message.setReject("That address is not accepting mail.");
    return;
  }

  // Identify the sender.
  //
  // The envelope sender (SMTP MAIL FROM) is the primary signal, but it is not
  // always the human: senders rewrite the return-path for bounce handling.
  // Cloudflare Email Sending does exactly this — mail it sends arrives with
  // `bounces@cf-bounce.<domain>` as the envelope sender — which the live
  // round-trip test caught by having every legitimate reply rejected as an
  // unregistered address. Mailing lists and forwarders rewrite it too.
  //
  // So: envelope sender first, then the header From. Falling back to the
  // header is safe *here specifically* because Cloudflare Email Routing
  // enforces SPF/DKIM/DMARC before a message ever reaches this handler, and
  // DMARC is precisely an alignment check on the header From domain. A message
  // that arrives claiming `From: someone@gmail.com` has already been proven to
  // come from something Gmail authorises. Without that enforcement in front,
  // this fallback would be spoofable and must not be used.
  const candidates = [message.from, headerFrom]
    .map((v) => (v ? (/<([^>]+)>/.exec(v)?.[1] ?? v).trim().toLowerCase() : null))
    .filter((v): v is string => Boolean(v));

  let player: { id: string; email: string } | null = null;
  for (const candidate of candidates) {
    player = await env.DB.prepare("SELECT id, email FROM players WHERE email = ?")
      .bind(candidate)
      .first<{ id: string; email: string }>();
    if (player) break;
  }
  if (!player) {
    message.setReject("This address is not registered to play.");
    return;
  }

  // Which campaign? The binding is authoritative. Failing that, a player who
  // is in exactly one campaign is unambiguous; a player in several has to
  // reply to a beat so the threading header can say which.
  let campaignId = binding?.campaign_id ?? null;
  if (!campaignId) {
    const memberships = await env.DB.prepare(
      "SELECT campaign_id FROM memberships WHERE player_id = ?",
    )
      .bind(player.id)
      .all<{ campaign_id: string }>();
    const rows = memberships.results ?? [];
    if (rows.length === 1) {
      campaignId = rows[0]!.campaign_id;
    } else if (rows.length === 0) {
      message.setReject("You are not in a campaign yet.");
      return;
    } else {
      message.setReject("Reply to one of your campaign emails so we know which story you mean.");
      return;
    }
  }

  const sender = await env.DB.prepare(
    `SELECT p.id, p.email FROM players p
     JOIN memberships m ON m.player_id = p.id AND m.campaign_id = ?
     WHERE p.id = ?`,
  )
    .bind(campaignId, player.id)
    .first<{ id: string; email: string }>();

  if (!sender) {
    message.setReject("This address is not a player in that campaign.");
    return;
  }

  // Replay defense. A binding records the tick its beat described; replying to
  // a three-week-old email would submit an intention formed against a world
  // that no longer exists — the party has moved, the threat has grown, the
  // NPC is dead. Bouncing with a pointer to the current turn is kinder than
  // silently acting on stale intent, and costs nothing but one more reply.
  if (binding) {
    const current = await env.DB.prepare("SELECT tick FROM campaigns WHERE id = ?")
      .bind(campaignId)
      .first<{ tick: number }>();
    const now = current?.tick ?? binding.tick;
    if (binding.tick < now - 1) {
      message.setReject(
        `That reply is from turn ${binding.tick} and the story is on turn ${now}. ` +
          `Reply to the most recent email so your action fits where everyone actually is.`,
      );
      return;
    }
  }

  // If a binding named a player, it must be the same person. A forwarded beat
  // must not let its recipient act as the player it was addressed to.
  if (binding && binding.player_id !== sender.id) {
    message.setReject("This reply does not belong to you.");
    return;
  }
  if (binding && !sameAddress(message.from, sender.email) && !sameAddress(headerFrom, sender.email)) {
    message.setReject("Sender mismatch.");
    return;
  }

  if (text.trim().length === 0) {
    message.setReject("That reply had no action in it.");
    return;
  }

  const stub = env.CAMPAIGN.get(env.CAMPAIGN.idFromName(campaignId));
  // Submitting may resolve the tick, which narrates and fans out mail. Do not
  // hold the SMTP transaction open for that.
  ctx.waitUntil(
    stub.submitAction(sender.id, text, "email").catch((err) => {
      console.error("inbound submit failed", err);
    }),
  );
}

function stripTags(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t]{2,}/g, " ");
}
