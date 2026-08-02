// asyncrpg web client.
//
// Deliberately dependency-free and small: the email channel is the product's
// main surface, and this needs to load fast on a phone on bad signal.
// Everything user- or model-authored is inserted with textContent, never
// innerHTML — the DM's prose is untrusted content.

const $ = (id) => document.getElementById(id);
const views = ["view-signin", "view-home", "view-invite", "view-campaign"];

function show(id) {
  for (const v of views) $(v).hidden = v !== id;
}

function say(message, kind = "") {
  const el = $("status");
  el.textContent = message;
  el.className = `status ${kind}`.trim();
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...options,
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON error page */
  }
  if (!res.ok) throw new Error(body?.error ?? `Request failed (${res.status})`);
  return body;
}

function relative(ms) {
  if (!ms) return "not scheduled";
  const delta = ms - Date.now();
  if (delta <= 0) return "any moment now";
  const mins = Math.round(delta / 60000);
  if (mins < 60) return `in ${mins} minute${mins === 1 ? "" : "s"}`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `in ${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.round(hours / 24);
  return `in ${days} day${days === 1 ? "" : "s"}`;
}

let currentSlug = null;

// ─── sign in ───────────────────────────────────────────────────────────────

$("signin-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.target.querySelector("button");
  const email = $("email").value.trim();
  if (!email) return say("Enter your email address.", "err");
  button.disabled = true;
  try {
    const out = await api("/api/auth/request", {
      method: "POST",
      body: JSON.stringify({ email }),
    });
    say(out.message, "ok");
  } catch (err) {
    say(err.message, "err");
  } finally {
    button.disabled = false;
  }
});

$("signout").addEventListener("click", async () => {
  await api("/api/auth/logout", { method: "POST" }).catch(() => {});
  location.href = "/";
});

// ─── home ──────────────────────────────────────────────────────────────────

function renderHome(data) {
  const list = $("campaign-list");
  list.textContent = "";
  if (!data.campaigns.length) {
    const li = document.createElement("li");
    li.textContent = "No campaigns yet. Start one below.";
    li.className = "meta";
    list.append(li);
    $("create-details").open = true;
  }
  for (const c of data.campaigns) {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.href = `#/c/${encodeURIComponent(c.slug)}`;
    a.textContent = c.name;
    const meta = document.createElement("p");
    meta.className = "meta";
    meta.textContent = `${c.character_name} · turn ${c.tick} · next ${relative(c.deadline_at)}`;
    li.append(a, meta);
    list.append(li);
  }
  show("view-home");
}

$("create-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.target.querySelector("button");
  const name = $("c-name").value.trim();
  const slug = $("c-slug").value.trim().toLowerCase();
  const cadence = $("c-cadence").value;
  button.disabled = true;
  say("Generating a world and eighty years of its history…");
  try {
    const out = await api("/api/campaigns", {
      method: "POST",
      body: JSON.stringify({ name, slug, cadence }),
    });
    say(`Created. You are ${out.character.characterName}.`, "ok");
    location.hash = `#/c/${encodeURIComponent(out.slug)}`;
  } catch (err) {
    say(err.message, "err");
  } finally {
    button.disabled = false;
  }
});

$("c-name").addEventListener("input", () => {
  const slug = $("c-slug");
  if (slug.dataset.touched === "1") return;
  slug.value = $("c-name")
    .value.toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 31);
});
$("c-slug").addEventListener("input", () => {
  $("c-slug").dataset.touched = "1";
});

// ─── a campaign ────────────────────────────────────────────────────────────

function renderCampaign(data) {
  const c = data.campaign;
  currentSlug = c.slug;
  $("c-title").textContent = c.name;
  $("c-where").textContent = `${c.place} — ${c.season} of year ${c.year}. ${c.situation}`;

  const clock = $("c-clock");
  clock.textContent = "";
  const line1 = document.createElement("div");
  const turn = document.createElement("strong");
  turn.textContent = `Turn ${c.tick}`;
  line1.append(turn, document.createTextNode(` · resolves ${relative(c.deadlineAt)}`));
  const line2 = document.createElement("div");
  line2.textContent =
    `${c.quorum.have} of ${c.quorum.active} have acted — ` +
    `${c.quorum.need} needed to move early.`;
  clock.append(line1, line2);

  const me = c.cast.find((m) => m.hasPending);
  $("action-label").textContent = data.prompt ?? "What do you do?";
  $("action").value = "";
  $("action").placeholder = me
    ? "You've already sent a turn. Writing again replaces it."
    : "Write what your character does, in your own words.";

  const cast = $("c-cast");
  cast.textContent = "";
  for (const m of c.cast) {
    const li = document.createElement("li");
    const name = document.createElement("strong");
    name.textContent = m.name;
    const pill = document.createElement("span");
    pill.className = `pill ${m.presence === "present" ? "here" : "away"}`;
    pill.textContent =
      m.presence === "present" ? "here" : m.presence === "drifting" ? "drifting" : "away";
    const meta = document.createElement("p");
    meta.className = "meta";
    meta.textContent =
      `${m.concept} · ${m.standing}` +
      (m.conditions.length ? ` · ${m.conditions.join(", ")}` : "") +
      (m.hasPending ? " · turn submitted" : "");
    li.append(name, pill, meta);
    cast.append(li);
  }

  // Letters go to other players, so the recipient list is everyone but you.
  const to = $("letter-to");
  to.textContent = "";
  for (const m of c.cast) {
    if (m.characterId === `chr_${data.playerId}`) continue;
    const option = document.createElement("option");
    option.value = m.characterId;
    option.textContent = m.name;
    to.append(option);
  }
  $("letter-details").hidden = to.options.length === 0;

  // Only the host can invite, so only the host is offered it.
  $("invite-box").hidden = !data.isHost;

  $("c-chronicle").href = `/c/${encodeURIComponent(c.slug)}`;
  show("view-campaign");
}

$("action-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.target.querySelector("button");
  const text = $("action").value.trim();
  if (!text) return say("Write what your character does.", "err");
  button.disabled = true;
  try {
    const out = await api(`/api/campaigns/${encodeURIComponent(currentSlug)}/action`, {
      method: "POST",
      body: JSON.stringify({ text }),
    });
    say(
      out.resolvedNow
        ? "Everyone's in — the turn just resolved. Check your email."
        : "Turn submitted. You'll get an email when the story moves.",
      "ok",
    );
    await load();
  } catch (err) {
    say(err.message, "err");
  } finally {
    button.disabled = false;
  }
});

$("back").addEventListener("click", () => {
  location.hash = "";
});

// ─── invitations ───────────────────────────────────────────────────────────

$("invite-btn").addEventListener("click", async () => {
  const button = $("invite-btn");
  button.disabled = true;
  try {
    const out = await api(`/api/campaigns/${encodeURIComponent(currentSlug)}/invite`, {
      method: "POST",
    });
    const field = $("invite-url");
    field.value = out.url;
    field.hidden = false;
    $("invite-url-label").hidden = false;
    field.focus();
    field.select();
    $("invite-hint").textContent =
      `Send this link to your group. It works for up to 12 people and expires in ${out.expiresInDays} days.`;
    say("Invite link ready — copy it from the box below.", "ok");
  } catch (err) {
    say(err.message, "err");
  } finally {
    button.disabled = false;
  }
});

let inviteToken = null;

async function showInvite(token) {
  inviteToken = token;
  try {
    const out = await api(`/api/invite/${encodeURIComponent(token)}`);
    $("invite-campaign").textContent = `${out.campaign} is waiting for you.`;
    show("view-invite");
  } catch (err) {
    say(err.message, "err");
    show("view-home");
  }
}

$("join-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.target.querySelector("button");
  const name = $("join-name").value.trim();
  if (!name) return say("Give your character a name.", "err");
  button.disabled = true;
  try {
    const out = await api("/api/join", {
      method: "POST",
      body: JSON.stringify({ token: inviteToken, name, concept: $("join-concept").value.trim() }),
    });
    say(`Welcome. You are ${out.character.characterName}.`, "ok");
    location.hash = `#/c/${encodeURIComponent(out.slug)}`;
  } catch (err) {
    say(err.message, "err");
  } finally {
    button.disabled = false;
  }
});

// ─── between turns (optional, never an advantage) ──────────────────────────

/** Shared submit handler: POST a body, report the result, keep the form usable. */
function wireSideForm(formId, path, buildBody, onOk) {
  $(formId).addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = event.target.querySelector("button");
    const body = buildBody();
    if (body === null) return;
    button.disabled = true;
    try {
      const out = await api(`/api/campaigns/${encodeURIComponent(currentSlug)}${path}`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      say(onOk(out), "ok");
      await load();
    } catch (err) {
      say(err.message, "err");
    } finally {
      button.disabled = false;
    }
  });
}

wireSideForm(
  "downtime-form",
  "/downtime",
  () => ({ kind: $("dt-kind").value, detail: $("dt-detail").value.trim() }),
  (out) => `Done — your character ${out.outcome}.`,
);

wireSideForm(
  "letter-form",
  "/letter",
  () => {
    const text = $("letter-body").value.trim();
    if (!text) {
      say("Write something first.", "err");
      return null;
    }
    return { to: $("letter-to").value, body: text };
  },
  (out) => `Letter sent to ${out.to}.`,
);

wireSideForm(
  "journal-form",
  "/journal",
  () => {
    const text = $("journal-body").value.trim();
    if (!text) {
      say("Write something first.", "err");
      return null;
    }
    return { title: $("journal-title").value.trim(), body: text };
  },
  () => "Added to the chronicle.",
);

// ─── routing ───────────────────────────────────────────────────────────────

async function load() {
  try {
    const me = await api("/api/me");
    if (!me.player) throw new Error("signed out");
    $("signout").hidden = false;
    const stashed = sessionStorage.getItem("pendingInvite");
    if (stashed && !location.hash.startsWith("#/join/")) {
      sessionStorage.removeItem("pendingInvite");
      location.hash = `#/join/${stashed}`;
      return;
    }
    const invite = /^#\/join\/([a-f0-9]{16,128})$/.exec(location.hash);
    if (invite) {
      await showInvite(invite[1]);
      return;
    }
    const match = /^#\/c\/([a-z0-9-]{2,31})$/.exec(location.hash);
    if (match) {
      renderCampaign(await api(`/api/campaigns/${encodeURIComponent(match[1])}`));
    } else {
      renderHome(me);
    }
  } catch {
    // An invited visitor who is not signed in yet must not lose the invite:
    // stash it so the link still works after the magic-link round trip.
    const invite = /^#\/join\/([a-f0-9]{16,128})$/.exec(location.hash);
    if (invite) sessionStorage.setItem("pendingInvite", invite[1]);
    $("signout").hidden = true;
    show("view-signin");
  }
}

window.addEventListener("hashchange", () => {
  say("");
  load();
});
load();
