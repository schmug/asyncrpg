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
import { verifyReplyCode } from "./token";

interface Binding {
  campaign_id: string;
  player_id: string;
  tick: number;
}

/**
 * Message-ID first, then subject code. Both are cheap indexed lookups.
 *
 * A code supplied by the sender must also authenticate the binding it found:
 * it is an HMAC over the (campaign, player, tick) it claims, so a code that
 * has been edited — to name an earlier tick, or another player — no longer
 * verifies and is treated as absent rather than as proof.
 */
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
    if (
      row &&
      (await verifyReplyCode(env.EMAIL_TOKEN_SECRET, code, {
        campaignId: row.campaign_id,
        playerId: row.player_id,
        tick: row.tick,
      }))
    ) {
      return row;
    }
  }
  return null;
}

/**
 * Record what the handler decided about a message.
 *
 * A reply that does not become a turn and a reply that never arrived look
 * identical from outside — both are silence. This is what tells them apart,
 * and it is the difference between "Email Routing is misconfigured" and "we
 * rejected it for a reason the sender was told but nobody kept".
 *
 * Best-effort and never awaited on the critical path: bookkeeping about mail
 * must not be able to reject mail.
 */
async function recordInbound(
  env: Env,
  entry: {
    to: string;
    from: string;
    subject: string;
    disposition: "accepted" | "rejected" | "loopback";
    reason: string;
    campaignId?: string;
  },
): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO inbound_log (id, to_address, from_address, subject, disposition, reason, campaign_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        `in_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
        entry.to.slice(0, 200),
        entry.from.slice(0, 200),
        entry.subject.slice(0, 200),
        entry.disposition,
        entry.reason.slice(0, 300),
        entry.campaignId ?? "",
        new Date().toISOString(),
      )
      .run();
  } catch (err) {
    console.error("inbound_log write failed", err);
  }
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
    ctx.waitUntil(
      recordInbound(env, {
        to: message.to,
        from: message.from,
        subject: "",
        disposition: "rejected",
        reason: "unreadable MIME",
      }),
    );
    message.setReject("Could not read that message.");
    return;
  }

  /** Reject, and keep the reason where an operator can find it later. */
  const reject = (told: string, reason: string, campaignId?: string): void => {
    ctx.waitUntil(
      recordInbound(env, {
        to: message.to,
        from: message.from || (headerFrom ?? ""),
        subject: subject ?? "",
        disposition: "rejected",
        reason,
        campaignId,
      }),
    );
    message.setReject(told);
  };

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
    ctx.waitUntil(
      recordInbound(env, {
        to: message.to,
        from: message.from,
        subject: subject ?? "",
        disposition: "loopback",
        reason: "verification loopback",
      }),
    );
    return;
  }

  const text = stripQuotedReply(body).slice(0, 8000);
  const code = codeFromSubject(subject);
  const binding = await bindingFor(env, referencedMessageIds({ inReplyTo, references }), code);

  if (!isInboxAddress(localPart(message.to))) {
    reject("That address is not accepting mail.", "not the inbox address");
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
    reject("This address is not registered to play.", "sender not a registered player");
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
      reject("You are not in a campaign yet.", "player has no memberships");
      return;
    } else {
      reject(
        "Reply to one of your campaign emails so we know which story you mean.",
        "ambiguous: player is in several campaigns and gave no binding",
      );
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
    reject("This address is not a player in that campaign.", "sender not a member of the bound campaign", campaignId);
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
      reject(
        `That reply is from turn ${binding.tick} and the story is on turn ${now}. ` +
          `Reply to the most recent email so your action fits where everyone actually is.`,
        `stale reply: binding tick ${binding.tick} vs current ${now}`,
        campaignId,
      );
      return;
    }
  }

  // If a binding named a player, it must be the same person. A forwarded beat
  // must not let its recipient act as the player it was addressed to.
  if (binding && binding.player_id !== sender.id) {
    reject("This reply does not belong to you.", "binding names a different player (forwarded beat)", campaignId);
    return;
  }
  if (binding && !sameAddress(message.from, sender.email) && !sameAddress(headerFrom, sender.email)) {
    reject("Sender mismatch.", "sender does not match the bound player address", campaignId);
    return;
  }

  if (text.trim().length === 0) {
    reject("That reply had no action in it.", "no usable text after quote stripping", campaignId);
    return;
  }

  const stub = env.CAMPAIGN.get(env.CAMPAIGN.idFromName(campaignId));
  // Submitting may resolve the tick, which narrates and fans out mail. Do not
  // hold the SMTP transaction open for that.
  ctx.waitUntil(
    stub
      .submitAction(sender.id, text, "email")
      .then((result) =>
        recordInbound(env, {
          to: message.to,
          from: message.from || (headerFrom ?? ""),
          subject: subject ?? "",
          disposition: result.accepted ? "accepted" : "rejected",
          reason: result.accepted ? "submitted" : (result.reason ?? "campaign refused it"),
          campaignId: campaignId!,
        }),
      )
      .catch(async (err) => {
        // The one failure the sender is never told about, because the SMTP
        // transaction is long over by the time it happens.
        console.error("inbound submit failed", err);
        await recordInbound(env, {
          to: message.to,
          from: message.from || (headerFrom ?? ""),
          subject: subject ?? "",
          disposition: "rejected",
          reason: `submission threw: ${err instanceof Error ? err.message : String(err)}`,
          campaignId: campaignId!,
        });
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
