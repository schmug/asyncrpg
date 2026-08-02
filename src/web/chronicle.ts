/**
 * The chronicle — the artifact a group references and retells.
 *
 * Server-rendered and readable with JavaScript disabled, because the whole
 * point is that you can send someone a link. Everything interpolated here is
 * either player-authored or model-authored, so everything is escaped.
 */

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
  const [beats, events, entities] = await Promise.all([
    env.DB.prepare(
      "SELECT tick, prose, source, created_at FROM beats WHERE campaign_id = ? ORDER BY tick DESC LIMIT 25",
    )
      .bind(campaign.id)
      .all<BeatRow>(),
    env.DB.prepare(
      `SELECT tick, kind, summary, significance FROM events
       WHERE campaign_id = ? AND significance >= 55 ORDER BY tick DESC, significance DESC LIMIT 60`,
    )
      .bind(campaign.id)
      .all<EventRow>(),
    env.DB.prepare(
      "SELECT entity_id, kind, name, data FROM entities WHERE campaign_id = ? ORDER BY kind, name",
    )
      .bind(campaign.id)
      .all<EntityRow>(),
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
    : `<p class="empty">No turning points recorded yet.</p>`;

  const byKind = new Map<string, EntityRow[]>();
  for (const e of entityRows) {
    if (!byKind.has(e.kind)) byKind.set(e.kind, []);
    byKind.get(e.kind)!.push(e);
  }

  const dossiers = ["character", "faction", "npc", "settlement", "threat", "region"]
    .filter((kind) => byKind.has(kind))
    .map((kind) => {
      const cards = byKind
        .get(kind)!
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
      return `<h2>${escapeHtml(KIND_LABEL[kind] ?? kind)}</h2><div class="grid">${cards}</div>`;
    })
    .join("");

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
    dossiers +
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
      return `${String(d.concept ?? "")} · renown ${n("renown")}${
        Array.isArray(d.conditions) && d.conditions.length ? ` · ${(d.conditions as string[]).join(", ")}` : ""
      }${d.presence === "offscreen" ? " · away" : d.presence === "drifting" ? " · drifting" : ""}`;
    case "faction":
      return d.defunct
        ? "broken and scattered"
        : `${String(d.kind ?? "").replace(/_/g, " ")} · power ${n("power")} · treasury ${n("treasury")}`;
    case "npc":
      return `${String(d.role ?? "")}${d.alive === false ? " · dead" : ""} · known ${n("renown")}`;
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
