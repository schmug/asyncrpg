/**
 * The chronicle — the artifact a group references and retells.
 *
 * Server-rendered and readable with JavaScript disabled, because the whole
 * point is that you can send someone a link. Everything interpolated here is
 * either player-authored or model-authored, so everything is escaped.
 */

import { renownLabel } from "../sim/character";
import { escapeHtml } from "../email/outbound";
import type { Env } from "../env";

interface CampaignRow {
  id: string;
  slug: string;
  name: string;
}

interface BeatRow {
  tick: number;
  prose: string;
  source: string;
  created_at: string;
}

interface EventRow {
  tick: number;
  kind: string;
  summary: string;
  significance: number;
}

interface EntityRow {
  entity_id: string;
  kind: string;
  name: string;
  data: string;
}

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
.beat{background:var(--card);border:1px solid var(--rule);border-radius:10px;
  padding:1.15rem 1.25rem;margin:0 0 1.3rem}
.beat .t{font:600 .74rem/1 system-ui,sans-serif;letter-spacing:.07em;text-transform:uppercase;
  color:var(--accent);margin:0 0 .6rem;display:flex;gap:.6rem;align-items:center;flex-wrap:wrap}
.beat p{margin:0 0 .85rem;white-space:pre-wrap}
.beat p:last-child{margin-bottom:0}
.tag{font:500 .66rem/1 system-ui,sans-serif;color:var(--muted);border:1px solid var(--rule);
  border-radius:99px;padding:.24rem .5rem;text-transform:none;letter-spacing:.02em}
ol.tl{list-style:none;margin:0;padding:0;border-left:2px solid var(--rule)}
ol.tl li{padding:.42rem 0 .42rem 1rem;position:relative}
ol.tl li::before{content:"";position:absolute;left:-5px;top:.95rem;width:8px;height:8px;
  border-radius:50%;background:var(--rule)}
ol.tl li.big::before{background:var(--accent);width:10px;height:10px;left:-6px}
ol.tl .n{font:600 .7rem/1 system-ui,sans-serif;color:var(--muted);margin-right:.5rem}
.grid{display:grid;gap:.7rem;grid-template-columns:repeat(auto-fill,minmax(13rem,1fr))}
.card{background:var(--card);border:1px solid var(--rule);border-radius:8px;padding:.75rem .85rem}
.card .n{font-weight:600;margin:0 0 .2rem}
.card .d{color:var(--muted);font-size:.83rem;margin:0}
footer{margin-top:3.5rem;padding-top:1.1rem;border-top:1px solid var(--rule);
  color:var(--muted);font-size:.82rem}
a{color:var(--accent)}
.empty{color:var(--muted);font-style:italic}
`;

const KIND_LABEL: Record<string, string> = {
  region: "Lands",
  settlement: "Places",
  faction: "Powers",
  npc: "People",
  threat: "Troubles",
  character: "The party",
};

export async function renderChronicle(env: Env, campaign: CampaignRow): Promise<Response> {
  const [beats, events, entities, journals, letters, history] = await Promise.all([
    env.DB.prepare(
      "SELECT tick, prose, source, created_at FROM beats WHERE campaign_id = ? ORDER BY tick DESC LIMIT 25",
    )
      .bind(campaign.id)
      .all<BeatRow>(),
    // Tick 0 is the generated pre-play history — decades of it. Mixed into the
    // live timeline it drowns everything the group actually did, which is the
    // opposite of what a chronicle is for. Queried and rendered separately.
    env.DB.prepare(
      `SELECT tick, kind, summary, significance FROM events
       WHERE campaign_id = ? AND tick > 0 AND significance >= 55
       ORDER BY tick DESC, significance DESC LIMIT 60`,
    )
      .bind(campaign.id)
      .all<EventRow>(),
    env.DB.prepare(
      "SELECT entity_id, kind, name, data FROM entities WHERE campaign_id = ? ORDER BY kind, name",
    )
      .bind(campaign.id)
      .all<EntityRow>(),
    env.DB.prepare(
      `SELECT j.tick, j.title, j.body, COALESCE(e.name, 'Someone') AS who
       FROM journals j LEFT JOIN entities e
         ON e.campaign_id = j.campaign_id AND e.entity_id = j.character_id
       WHERE j.campaign_id = ? ORDER BY j.tick DESC, j.rowid DESC LIMIT 20`,
    )
      .bind(campaign.id)
      .all<{ tick: number; title: string; body: string; who: string }>(),
    env.DB.prepare(
      `SELECT l.tick, l.body,
              COALESCE(f.name, 'Someone') AS sender,
              COALESCE(t.name, 'someone') AS recipient
       FROM letters l
       LEFT JOIN entities f ON f.campaign_id = l.campaign_id AND f.entity_id = l.from_character
       LEFT JOIN entities t ON t.campaign_id = l.campaign_id AND t.entity_id = l.to_character
       WHERE l.campaign_id = ? ORDER BY l.tick DESC, l.rowid DESC LIMIT 20`,
    )
      .bind(campaign.id)
      .all<{ tick: number; body: string; sender: string; recipient: string }>(),
    env.DB.prepare(
      `SELECT tick, kind, summary, significance FROM events
       WHERE campaign_id = ? AND tick = 0 AND significance >= 70
       ORDER BY significance DESC LIMIT 12`,
    )
      .bind(campaign.id)
      .all<EventRow>(),
  ]);

  const beatRows = beats.results ?? [];
  const eventRows = events.results ?? [];
  const entityRows = entities.results ?? [];

  const beatHtml = beatRows.length
    ? beatRows
        .map(
          (b) =>
            `<article class="beat"><p class="t">Tick ${b.tick}` +
            (b.source === "templated" ? `<span class="tag">recorded without narration</span>` : "") +
            `</p>` +
            b.prose
              .split(/\n{2,}/)
              .map((p) => `<p>${escapeHtml(p)}</p>`)
              .join("") +
            `</article>`,
        )
        .join("")
    : `<p class="empty">Nothing has happened yet. The first turn has not resolved.</p>`;

  const timelineHtml = eventRows.length
    ? `<ol class="tl">` +
      eventRows
        .map(
          (e) =>
            `<li class="${e.significance >= 75 ? "big" : ""}">` +
            `<span class="n">t${e.tick}</span>${escapeHtml(e.summary)}</li>`,
        )
        .join("") +
      `</ol>`
    : `<p class="empty">No turning points yet — the story is still young.</p>`;

  const historyRows = history.results ?? [];
  const historyHtml = historyRows.length
    ? `<h2>Before you arrived</h2>` +
      `<p class="empty">Generated history. None of the party was there for any of it.</p>` +
      `<ol class="tl">` +
      historyRows.map((e) => `<li><span class="n">—</span>${escapeHtml(e.summary)}</li>`).join("") +
      `</ol>`
    : "";

  const byKind = new Map<string, EntityRow[]>();
  for (const e of entityRows) {
    if (!byKind.has(e.kind)) byKind.set(e.kind, []);
    byKind.get(e.kind)!.push(e);
  }

  /**
   * The living come first, and the dead are remembered rather than listed.
   *
   * Over a long campaign most NPCs are dead — 26 of 28 in one demo world — so a
   * flat "People" grid becomes a graveyard with two survivors in it, which is
   * both useless for finding who to talk to and a poor read.
   */
  const alive = (rows: EntityRow[], kind: string): EntityRow[] => {
    if (kind !== "npc") return rows;
    return rows.filter((e) => {
      try {
        return (JSON.parse(e.data) as { alive?: boolean }).alive !== false;
      } catch {
        return true;
      }
    });
  };
  const notableDead = (byKind.get("npc") ?? [])
    .map((e) => {
      try {
        return { e, d: JSON.parse(e.data) as { alive?: boolean; renown?: number } };
      } catch {
        return null;
      }
    })
    .filter((x): x is { e: EntityRow; d: { alive?: boolean; renown?: number } } =>
      x !== null && x.d.alive === false,
    )
    .sort((a, b) => (b.d.renown ?? 0) - (a.d.renown ?? 0))
    .slice(0, 8);

  const dossiers = ["character", "faction", "npc", "settlement", "threat", "region"]
    .filter((kind) => byKind.has(kind))
    .map((kind) => {
      const cards = alive(byKind.get(kind)!, kind)
        .slice(0, 40)
        .map((e) => {
          let detail = "";
          try {
            const d = JSON.parse(e.data) as Record<string, unknown>;
            detail = describe(kind, d);
          } catch {
            detail = "";
          }
          return (
            `<div class="card"><p class="n">${escapeHtml(e.name)}</p>` +
            `<p class="d">${escapeHtml(detail)}</p></div>`
          );
        })
        .join("");
      if (!cards) return "";
      return `<h2>${escapeHtml(KIND_LABEL[kind] ?? kind)}</h2><div class="grid">${cards}</div>`;
    })
    .join("");

  const rememberedHtml = notableDead.length
    ? `<h2>Remembered</h2><div class="grid">` +
      notableDead
        .map(
          ({ e, d }) =>
            `<div class="card"><p class="n">${escapeHtml(e.name)}</p>` +
            `<p class="d">${escapeHtml(String((JSON.parse(e.data) as { role?: string }).role ?? ""))} · ` +
            `${escapeHtml(renownLabel(Math.round(d.renown ?? 0)))} in life</p></div>`,
        )
        .join("") +
      `</div>`
    : "";

  // Side material earns a place in the artifact — writing a private scene that
  // nobody can ever read back would make the feature pointless.
  const journalRows = journals.results ?? [];
  const journalHtml = journalRows.length
    ? `<h2>Private scenes</h2>` +
      journalRows
        .map(
          (j) =>
            `<article class="beat"><p class="t">${escapeHtml(j.who)} · tick ${j.tick}` +
            (j.title ? ` <span class="tag">${escapeHtml(j.title)}</span>` : "") +
            `</p>` +
            j.body
              .split(/\n{2,}/)
              .map((p) => `<p>${escapeHtml(p)}</p>`)
              .join("") +
            `</article>`,
        )
        .join("")
    : "";

  const letterRows = letters.results ?? [];
  const letterHtml = letterRows.length
    ? `<h2>Correspondence</h2>` +
      letterRows
        .map(
          (l) =>
            `<article class="beat"><p class="t">${escapeHtml(l.sender)} to ${escapeHtml(l.recipient)} · tick ${l.tick}</p>` +
            l.body
              .split(/\n{2,}/)
              .map((p) => `<p>${escapeHtml(p)}</p>`)
              .join("") +
            `</article>`,
        )
        .join("")
    : "";

  const title = `${campaign.name} — chronicle`;
  const html =
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">` +
    `<title>${escapeHtml(title)}</title>` +
    `<meta name="description" content="The chronicle of ${escapeHtml(campaign.name)}, an asynchronous tabletop campaign.">` +
    `<meta property="og:title" content="${escapeHtml(title)}">` +
    `<style>${CSS}</style></head><body><div class="wrap">` +
    `<header><h1>${escapeHtml(campaign.name)}</h1>` +
    `<p class="sub">A chronicle in ${beatRows.length} recorded turn${beatRows.length === 1 ? "" : "s"}.</p></header>` +
    `<h2>Turns</h2>${beatHtml}` +
    `<h2>Turning points</h2>${timelineHtml}` +
    journalHtml +
    letterHtml +
    dossiers +
    rememberedHtml +
    historyHtml +
    `<footer>Generated by a simulation, narrated as it went. ` +
    `<a href="/">asyncrpg</a></footer>` +
    `</div></body></html>`;

  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=60",
    },
  });
}

function describe(kind: string, d: Record<string, unknown>): string {
  const n = (k: string): number => (typeof d[k] === "number" ? Math.round(d[k] as number) : 0);
  switch (kind) {
    case "character":
      return `${String(d.concept ?? "")} · ${renownLabel(n("renown"))}${
        Array.isArray(d.conditions) && d.conditions.length ? ` · ${(d.conditions as string[]).join(", ")}` : ""
      }${d.presence === "offscreen" ? " · away" : d.presence === "drifting" ? " · drifting" : ""}`;
    case "faction":
      return d.defunct
        ? "broken and scattered"
        : `${String(d.kind ?? "").replace(/_/g, " ")} · power ${n("power")} · treasury ${n("treasury")}`;
    case "npc":
      return `${String(d.role ?? "")}${d.alive === false ? " · dead" : ""} · ${renownLabel(n("renown"))}`;
    case "settlement":
      return d.razed
        ? "abandoned"
        : `pop. ${n("population")} · prosperity ${n("prosperity")} · unrest ${n("unrest")}`;
    case "threat":
      return d.resolved ? "ended" : `severity ${n("severity")}`;
    case "region":
      return `${String(d.terrain ?? "")} · danger ${n("danger")}`;
    default:
      return "";
  }
}
