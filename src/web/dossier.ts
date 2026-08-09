/**
 * One entity, and where it has appeared.
 *
 * The page is a re-index of the chronicle, not a window into canon. It renders
 * identity facts and the summaries of events already in the read model —
 * never an agenda, a relation value, or a raw 0-100 field. A reader learns
 * that a region is dangerous, not that its danger is 52.
 *
 * Everything interpolated is model- or player-adjacent, so everything is
 * escaped.
 */

import { escapeHtml } from "../email/outbound";
import type { Env } from "../env";
import { blurbFor, type LinkableKind } from "../lore/mentions";
import type { WorldState } from "../sim/types";

interface CampaignRow {
  id: string;
  slug: string;
  name: string;
}

interface EntityRow {
  entity_id: string;
  kind: string;
  name: string;
  data: string;
}

interface EventRow {
  tick: number;
  summary: string;
  significance: number;
}

/**
 * The chronicle's grid calls factions "Powers". Here they are "A faction":
 * `power` is a raw 0-100 field on the very same row, and a heading that
 * collides with a withheld field name makes the disclosure rule impossible to
 * assert and easy to violate by accident.
 */
const KIND_LABEL: Record<string, string> = {
  region: "A land",
  settlement: "A place",
  faction: "A faction",
  npc: "A person",
  threat: "A trouble",
};

const CSS = `
:root{--bg:#f6f3ec;--ink:#22201c;--muted:#6d665b;--rule:#ddd6c9;--accent:#8a4b2a;--card:#fffdf8}
@media (prefers-color-scheme:dark){:root{--bg:#16150f;--ink:#ece6da;--muted:#9a9284;--rule:#332f26;--accent:#d99a6f;--card:#1e1c15}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);
  font:17px/1.65 Iowan Old Style,Palatino,Georgia,serif;-webkit-text-size-adjust:100%}
.wrap{max-width:40rem;margin:0 auto;padding:2rem 1.15rem 5rem}
header{border-bottom:2px solid var(--rule);padding-bottom:1.1rem;margin-bottom:2rem}
h1{font-size:2rem;line-height:1.15;margin:0 0 .3rem;letter-spacing:-.01em}
.sub{color:var(--muted);font-size:.9rem;margin:0}
h2{font-size:.78rem;text-transform:uppercase;letter-spacing:.09em;color:var(--muted);
  margin:2.6rem 0 .9rem;font-weight:700;font-family:system-ui,sans-serif}
ol.tl{list-style:none;margin:0;padding:0;border-left:2px solid var(--rule)}
ol.tl li{padding:.42rem 0 .42rem 1rem;position:relative}
ol.tl li::before{content:"";position:absolute;left:-5px;top:.95rem;width:8px;height:8px;
  border-radius:50%;background:var(--rule)}
ol.tl li.big::before{background:var(--accent);width:10px;height:10px;left:-6px}
ol.tl .n{font:600 .7rem/1 system-ui,sans-serif;color:var(--muted);margin-right:.5rem}
footer{margin-top:3.5rem;padding-top:1.1rem;border-top:1px solid var(--rule);
  color:var(--muted);font-size:.82rem}
a{color:var(--accent)}
.empty{color:var(--muted);font-style:italic}
`;

function page(campaign: CampaignRow, title: string, inner: string, status = 200): Response {
  const back = `/c/${encodeURIComponent(campaign.slug)}`;
  const html =
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">` +
    `<title>${escapeHtml(title)} — ${escapeHtml(campaign.name)}</title>` +
    `<meta name="robots" content="noindex">` +
    `<style>${CSS}</style></head><body><div class="wrap">` +
    inner +
    `<footer><a href="${escapeHtml(back)}">Back to the chronicle</a></footer>` +
    `</div></body></html>`;
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=60" },
  });
}

/**
 * A link in a *sent* email is permanent, so a missing entity gets a page that
 * explains itself and offers a way onward rather than a bare 404 body.
 */
function notRecorded(campaign: CampaignRow): Response {
  return page(
    campaign,
    "Not recorded",
    `<header><h1>Not recorded</h1>` +
      `<p class="sub">This entry hasn't been written into the chronicle yet.</p></header>`,
    404,
  );
}

const BUCKET: Record<string, string> = {
  faction: "factions",
  npc: "npcs",
  settlement: "settlements",
  region: "regions",
  threat: "threats",
};

/**
 * Drop one projected row into the `WorldState` shape `blurbFor` expects.
 *
 * `entities.data` is a TEXT column: it can be half-written, pre-migration, or
 * simply not JSON. Anything that is not a plain object is treated as an absent
 * row.
 *
 * A row that *does* parse but carries nothing is the more dangerous case, and
 * it is handled upstream: `blurbFor` declines to describe a row whose absent
 * fields would otherwise become claims — an NPC with no `alive` is not dead, a
 * settlement with no `population` is not a hamlet. Either way the cost is the
 * subtitle and nothing else: the name, the timeline, and the way back all
 * still render.
 */
function place(state: WorldState, row: EntityRow): Record<string, unknown> | null {
  const bucket = BUCKET[row.kind];
  if (!bucket) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.data);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const data = parsed as Record<string, unknown>;
  (state as unknown as Record<string, Record<string, unknown>>)[bucket]![row.entity_id] = data;
  return data;
}

/**
 * `blurbFor` reads a whole `WorldState`; the page has one projected row. Build
 * the smallest state that answers correctly, so there is exactly one
 * implementation of how an entity is described.
 *
 * The referenced rows matter: an NPC's blurb names their faction and where
 * they are, and "steward" alone is a much worse answer to "who is this?" than
 * "steward of The Ashen Coil, at Vresford" — which is the whole point of the
 * page. One extra query buys that.
 *
 * Returns `""` for anything it cannot describe. The caller must read that as
 * *omit the subtitle*, never as an empty element or the word "undefined".
 */
async function blurbFromRow(env: Env, campaignId: string, row: EntityRow): Promise<string> {
  const state = {
    factions: {},
    npcs: {},
    settlements: {},
    regions: {},
    threats: {},
  } as unknown as WorldState;

  const data = place(state, row);
  if (!data) return "";

  const refs = [
    ...new Set(
      [data.factionId, data.locationId, data.seatSettlementId, data.regionId].filter(
        (v): v is string => typeof v === "string" && v.length > 0,
      ),
    ),
  ];
  if (refs.length) {
    try {
      const related = await env.DB.prepare(
        `SELECT entity_id, kind, name, data FROM entities
         WHERE campaign_id = ? AND entity_id IN (${refs.map(() => "?").join(",")})`,
      )
        .bind(campaignId, ...refs)
        .all<EntityRow>();
      for (const r of related.results ?? []) place(state, r);
    } catch {
      // A thinner blurb beats a 500 on a link that has already been mailed.
    }
  }

  return blurbFor(row.kind as LinkableKind, row.entity_id, state);
}

export async function renderDossier(
  env: Env,
  campaign: CampaignRow,
  entityId: string,
): Promise<Response> {
  const entity = await env.DB.prepare(
    "SELECT entity_id, kind, name, data FROM entities WHERE campaign_id = ? AND entity_id = ?",
  )
    .bind(campaign.id, entityId)
    .first<EntityRow>();

  // An unrevealed threat is never projected, so it lands here — deliberately
  // indistinguishable from an id that never existed.
  if (!entity) return notRecorded(campaign);

  // `region_id` is matched only when the entity *is* the region. A settlement
  // would otherwise inherit every event anywhere in its region, and its page
  // would stop being about it.
  const isRegion = entity.kind === "region";

  // `EXISTS` rather than a join against `json_each`: a join returns the row
  // once per matching element, so an event naming the same id twice — both
  // parties to a broken pact — would be listed twice.
  const scope = `(actor_id = ?2
                  OR EXISTS (SELECT 1 FROM json_each(events.target_ids) WHERE value = ?2)
                  OR (?3 = 1 AND region_id = ?2))`;

  let live: EventRow[] = [];
  let history: EventRow[] = [];
  try {
    const [liveRes, historyRes] = await Promise.all([
      env.DB.prepare(
        `SELECT tick, summary, significance FROM events
         WHERE campaign_id = ?1 AND tick > 0 AND ${scope}
         ORDER BY tick DESC, significance DESC LIMIT 40`,
      )
        .bind(campaign.id, entityId, isRegion ? 1 : 0)
        .all<EventRow>(),
      // Tick 0 is generated pre-play history — decades of it. Mixed into the
      // live timeline it drowns what the group actually did, so it gets its own
      // block, matching the chronicle (`src/web/chronicle.ts:93`).
      env.DB.prepare(
        `SELECT tick, summary, significance FROM events
         WHERE campaign_id = ?1 AND tick = 0 AND ${scope}
         ORDER BY significance DESC LIMIT 12`,
      )
        .bind(campaign.id, entityId, isRegion ? 1 : 0)
        .all<EventRow>(),
    ]);
    live = liveRes.results ?? [];
    history = historyRes.results ?? [];
  } catch {
    // Identity is still worth serving. A 500 here would break a link that has
    // already been mailed out.
    live = [];
    history = [];
  }

  const timeline = (rows: EventRow[], showTick: boolean): string =>
    `<ol class="tl">` +
    rows
      .map(
        (e) =>
          `<li class="${e.significance >= 75 ? "big" : ""}">` +
          `<span class="n">${showTick ? `t${e.tick}` : "—"}</span>${escapeHtml(e.summary)}</li>`,
      )
      .join("") +
    `</ol>`;

  // An empty blurb omits the subtitle rather than rendering `· ` against
  // nothing — spec §10. A malformed row costs the description, not the page.
  const blurb = await blurbFromRow(env, campaign.id, entity);
  const inner =
    `<header><h1>${escapeHtml(entity.name)}</h1>` +
    `<p class="sub">${escapeHtml(KIND_LABEL[entity.kind] ?? "An entry")}` +
    (blurb ? ` · ${escapeHtml(blurb)}` : "") +
    `</p></header>` +
    `<h2>What the chronicle records</h2>` +
    (live.length ? timeline(live, true) : `<p class="empty">Nothing recorded yet in play.</p>`) +
    (history.length ? `<h2>Before you arrived</h2>` + timeline(history, false) : "");

  return page(campaign, entity.name, inner);
}
