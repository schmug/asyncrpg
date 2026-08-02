/**
 * Deterministic world drift — what happens whether or not anyone shows up.
 *
 * The same rules generate a campaign's pre-play history and every live tick
 * afterwards, so the world's past and its present obey identical physics. That
 * is what makes a discovered ruin feel like it was actually ruined by
 * something, and it is also why absence is safe: the world is never *waiting*
 * on a player, so a player can never be blamed for its state.
 *
 * Pure: no I/O, no clock, no `Math.random()`. State is mutated in place on a
 * caller-owned copy; the caller decides whether to keep it.
 */

import { EventLog } from "./events";
import { clamp } from "./invariants";
import { NameForge } from "./names";
import type { Rng } from "./prng";
import { AGENDA_KINDS, FACTION_KINDS, THREAT_KINDS } from "./types";
import type { Agenda, AgendaKind, Faction, Season, WorldState } from "./types";

const SEASON_ORDER: Season[] = ["spring", "summer", "autumn", "winter"];

/** Threat severity thresholds. */
const REVEAL_AT = 30;
const HARM_AT = 55;
const CRISIS_AT = 90;

function livingFactions(state: WorldState): Faction[] {
  return Object.values(state.factions).filter((f) => !f.defunct);
}

function heldSettlements(state: WorldState, factionId: string) {
  return Object.values(state.settlements).filter(
    (s) => !s.razed && s.controllingFactionId === factionId,
  );
}

function relation(a: Faction, bId: string): number {
  return a.relations[bId] ?? 0;
}

function setRelation(state: WorldState, aId: string, bId: string, value: number): void {
  if (aId === bId) return;
  const a = state.factions[aId];
  const b = state.factions[bId];
  if (!a || !b) return;
  const v = clamp(Math.round(value), -100, 100);
  // Relations are kept symmetric. Asymmetric diplomacy is a richer model but
  // doubles the state a reader has to hold; symmetry keeps the chronicle legible.
  a.relations[bId] = v;
  b.relations[aId] = v;
}

/** Choose a fresh agenda appropriate to the faction's situation. */
export function pickAgenda(state: WorldState, faction: Faction, rng: Rng): Agenda {
  const rivals = livingFactions(state).filter(
    (f) => f.id !== faction.id && relation(faction, f.id) < 0,
  );
  const held = heldSettlements(state, faction.id);
  const covetable = Object.values(state.settlements).filter(
    (s) => !s.razed && s.controllingFactionId !== faction.id,
  );
  const liveThreats = Object.values(state.threats).filter((t) => !t.resolved && t.revealed);

  const weights: [AgendaKind, number][] = [
    ["seize_settlement", covetable.length > 0 ? 3 + faction.power / 25 : 0],
    ["enrich", faction.treasury < 50 ? 4 : 1],
    ["fortify", held.length > 0 && faction.treasury > 30 ? 2 : 0],
    ["undermine_rival", rivals.length > 0 ? 3 : 0],
    ["court_favor", 2],
    ["hunt_threat", liveThreats.length > 0 ? 2 + liveThreats.length : 0],
    ["expand_influence", 2],
  ];
  // A faction with nothing available still needs a valid agenda.
  if (weights.every(([, w]) => w <= 0)) weights.push(["court_favor", 1]);

  const kind = rng.weighted(weights);
  let targetId: string | null = null;
  switch (kind) {
    case "seize_settlement":
      targetId = covetable.length ? rng.pick(covetable).id : null;
      break;
    case "undermine_rival":
      targetId = rivals.length ? rng.pick(rivals).id : null;
      break;
    case "hunt_threat":
      targetId = liveThreats.length ? rng.pick(liveThreats).id : null;
      break;
    case "fortify":
      targetId = held.length ? rng.pick(held).id : null;
      break;
    default:
      targetId = null;
  }
  // Guard: an agenda kind whose target evaporated degrades to an untargeted one.
  if (targetId === null && (kind === "seize_settlement" || kind === "undermine_rival" || kind === "hunt_threat")) {
    return { kind: "court_favor", targetId: null, progress: 0, urgency: rng.int(1, 6) };
  }
  return { kind, targetId, progress: 0, urgency: rng.int(2, 9) };
}

function resolveAgenda(
  state: WorldState,
  faction: Faction,
  log: EventLog,
  rng: Rng,
  forge: NameForge,
): void {
  const a = faction.agenda;
  const yearNote = `${state.year}`;

  switch (a.kind) {
    case "seize_settlement": {
      const target = a.targetId ? state.settlements[a.targetId] : undefined;
      if (!target || target.razed) break;
      const defender = target.controllingFactionId
        ? state.factions[target.controllingFactionId]
        : undefined;
      const attack = faction.power + rng.int(0, 30);
      const defend = target.defense * 0.6 + (defender ? defender.power * 0.5 : 0) + rng.int(0, 20);

      if (attack > defend) {
        const previous = target.controllingFactionId;
        target.controllingFactionId = faction.id;
        target.unrest = clamp(target.unrest + rng.int(15, 35), 0, 100);
        target.prosperity = clamp(target.prosperity - rng.int(5, 20), 0, 100);
        faction.power = clamp(faction.power + rng.int(3, 9), 0, 100);
        faction.treasury = clamp(faction.treasury - rng.int(5, 15), 0, 100);
        if (defender) {
          defender.power = clamp(defender.power - rng.int(5, 12), 0, 100);
          setRelation(state, faction.id, defender.id, relation(faction, defender.id) - rng.int(25, 45));
        }
        log.add("settlement_changed_hands", `In ${yearNote}, ${faction.name} took ${target.name}${defender ? ` from ${defender.name}` : ""}.`, {
          actorId: faction.id,
          targetIds: [target.id, ...(previous ? [previous] : [])],
          regionId: target.regionId,
          significance: 78,
          data: { year: state.year, from: previous, to: faction.id },
        });
        // Total defeat: a faction that loses its last holding is finished.
        if (defender && heldSettlements(state, defender.id).length === 0) {
          defender.defunct = true;
          defender.seatSettlementId = null;
          log.add("agenda_resolved", `${defender.name} lost its last holding and broke apart.`, {
            actorId: defender.id,
            significance: 85,
            data: { year: state.year },
          });
        }
      } else {
        faction.power = clamp(faction.power - rng.int(3, 10), 0, 100);
        faction.treasury = clamp(faction.treasury - rng.int(5, 12), 0, 100);
        if (defender) setRelation(state, faction.id, defender.id, relation(faction, defender.id) - rng.int(10, 25));
        log.add("agenda_resolved", `${faction.name}'s move on ${target.name} failed.`, {
          actorId: faction.id,
          targetIds: [target.id],
          regionId: target.regionId,
          significance: 48,
          data: { year: state.year },
        });
      }
      break;
    }

    case "enrich": {
      const gain = rng.int(8, 22);
      faction.treasury = clamp(faction.treasury + gain, 0, 100);
      for (const s of heldSettlements(state, faction.id)) {
        s.prosperity = clamp(s.prosperity + rng.int(0, 5), 0, 100);
      }
      log.add("agenda_resolved", `${faction.name} turned a profitable season.`, {
        actorId: faction.id,
        significance: 24,
        data: { year: state.year, gain },
      });
      break;
    }

    case "fortify": {
      const target = a.targetId ? state.settlements[a.targetId] : undefined;
      if (!target) break;
      target.defense = clamp(target.defense + rng.int(8, 20), 0, 100);
      faction.treasury = clamp(faction.treasury - rng.int(5, 14), 0, 100);
      log.add("agenda_resolved", `${faction.name} strengthened the walls of ${target.name}.`, {
        actorId: faction.id,
        targetIds: [target.id],
        regionId: target.regionId,
        significance: 30,
        data: { year: state.year },
      });
      break;
    }

    case "undermine_rival": {
      const rival = a.targetId ? state.factions[a.targetId] : undefined;
      if (!rival || rival.defunct) break;
      rival.power = clamp(rival.power - rng.int(4, 12), 0, 100);
      rival.treasury = clamp(rival.treasury - rng.int(3, 10), 0, 100);
      setRelation(state, faction.id, rival.id, relation(faction, rival.id) - rng.int(15, 30));
      const open = relation(faction, rival.id) <= -70;
      log.add(open ? "war_declared" : "agenda_resolved", open
        ? `${faction.name} and ${rival.name} came to open war.`
        : `${faction.name} moved against ${rival.name} in the dark.`, {
        actorId: faction.id,
        targetIds: [rival.id],
        significance: open ? 80 : 44,
        data: { year: state.year },
      });
      break;
    }

    case "court_favor": {
      const others = livingFactions(state).filter((f) => f.id !== faction.id);
      if (others.length === 0) break;
      const friend = rng.pick(others);
      const before = relation(faction, friend.id);
      setRelation(state, faction.id, friend.id, before + rng.int(10, 25));
      const peace = before < -40 && relation(faction, friend.id) >= -40;
      log.add(peace ? "peace_made" : "agenda_resolved", peace
        ? `${faction.name} and ${friend.name} set down their feud.`
        : `${faction.name} courted the goodwill of ${friend.name}.`, {
        actorId: faction.id,
        targetIds: [friend.id],
        significance: peace ? 66 : 22,
        data: { year: state.year },
      });
      break;
    }

    case "hunt_threat": {
      const threat = a.targetId ? state.threats[a.targetId] : undefined;
      if (!threat || threat.resolved) break;
      const effort = faction.power + rng.int(0, 40);
      if (effort > threat.severity + 30) {
        threat.severity = 0;
        threat.resolved = true;
        faction.power = clamp(faction.power + rng.int(2, 7), 0, 100);
        log.add("threat_resolved", `${faction.name} put an end to ${threat.name}.`, {
          actorId: faction.id,
          targetIds: [threat.id],
          regionId: threat.regionId,
          significance: 74,
          data: { year: state.year },
        });
      } else {
        threat.severity = clamp(threat.severity - rng.int(0, 10), 0, 100);
        faction.power = clamp(faction.power - rng.int(2, 8), 0, 100);
        log.add("agenda_resolved", `${faction.name} bled against ${threat.name} and fell back.`, {
          actorId: faction.id,
          targetIds: [threat.id],
          regionId: threat.regionId,
          significance: 46,
          data: { year: state.year },
        });
      }
      break;
    }

    case "expand_influence": {
      faction.power = clamp(faction.power + rng.int(3, 9), 0, 100);
      const candidates = Object.values(state.npcs).filter((n) => n.alive && n.factionId === null);
      if (candidates.length > 0 && rng.chance(0.5)) {
        const recruit = rng.pick(candidates);
        recruit.factionId = faction.id;
        recruit.role = forge.role(rng, faction.kind);
        log.add("npc_rose", `${recruit.name} took service with ${faction.name} as ${recruit.role}.`, {
          actorId: recruit.id,
          targetIds: [faction.id],
          significance: 34,
          data: { year: state.year },
        });
      } else {
        log.add("agenda_resolved", `${faction.name} widened its reach.`, {
          actorId: faction.id,
          significance: 20,
          data: { year: state.year },
        });
      }
      break;
    }
  }
}

/**
 * Write the canonical one-line description of where the party stands.
 *
 * Deterministic and derived purely from world state, so replaying a tick
 * reproduces it exactly and no model output can leak into the state the next
 * tick reads. The narrator may describe the same scene far more beautifully;
 * that prose lives in the beat, which is a read model, not in the world.
 */
export function describeScene(state: WorldState): void {
  const region = state.regions[state.scene.regionId];
  const town = state.scene.settlementId ? state.settlements[state.scene.settlementId] : undefined;
  const where = town && !town.razed ? town.name : (region?.name ?? "the road");

  const threat = Object.values(state.threats)
    .filter((t) => !t.resolved && t.revealed && t.regionId === state.scene.regionId)
    .sort((a, b) => b.severity - a.severity)[0];

  const clauses: string[] = [`${where} in the ${state.season} of year ${state.year}`];

  if (town && !town.razed) {
    if (town.unrest >= 65) clauses.push("the town is close to trouble");
    else if (town.prosperity < 30) clauses.push("the market has thinned to almost nothing");
    else if (town.prosperity > 70) clauses.push("trade is good");
  } else if (town?.razed) {
    clauses.push("nothing here is lived in any more");
  }

  if (threat) {
    clauses.push(
      threat.severity >= HARM_AT
        ? `${threat.name} is taking a real toll`
        : `${threat.name} is spoken of`,
    );
  }
  if (region && region.danger >= 55) clauses.push("the roads are not safe");

  state.scene.situation = `${clauses.join(". ")}.`.slice(0, 200);
}

/**
 * Refill the world's supply of pressure.
 *
 * Conquest, plague and time all consume the things a story pushes against. Left
 * alone the sim trends monotonically toward one surviving faction, no live
 * threats, and silence. These rules run the other way: vacuums attract new
 * claimants, ruins get resettled by people who did not live through why they
 * were abandoned, and new troubles surface somewhere else.
 */
function renewWorld(state: WorldState, rng: Rng, log: EventLog, forge: NameForge): void {
  const alive = livingFactions(state);
  const unclaimed = Object.values(state.settlements).filter(
    (s) => !s.razed && s.controllingFactionId === null,
  );
  const liveThreats = Object.values(state.threats).filter((t) => !t.resolved);

  // A power vacuum draws a claimant. The fewer factions remain, the likelier —
  // but rare enough that a new name on the map is an event, not background
  // noise. Players should be able to learn who everyone is.
  const vacuumPressure = alive.length <= 1 ? 0.05 : alive.length === 2 ? 0.02 : 0.004;
  if ((unclaimed.length > 0 || alive.length <= 1) && rng.chance(vacuumPressure)) {
    const kind = rng.pick(FACTION_KINDS);
    const id = log.nextId("fac");
    const standing = Object.values(state.settlements).filter((s) => !s.razed);
    // Every settlement can be a ruin at once; there is then nothing to claim.
    const seat = unclaimed.length > 0 ? rng.pick(unclaimed) : standing.length > 0 ? rng.pick(standing) : null;
    if (seat) {
      const born: Faction = {
        id,
        name: forge.faction(rng, kind),
        kind,
        power: rng.int(18, 42),
        treasury: rng.int(15, 45),
        seatSettlementId: seat.id,
        agenda: { kind: "court_favor", targetId: null, progress: 0, urgency: rng.int(3, 9) },
        relations: {},
        defunct: false,
      };
      state.factions[id] = born;
      for (const other of alive) {
        const v = rng.int(-60, 30);
        born.relations[other.id] = v;
        other.relations[id] = v;
      }
      seat.controllingFactionId = id;
      seat.unrest = clamp(seat.unrest + rng.int(5, 20), 0, 100);
      born.agenda = pickAgenda(state, born, rng);
      log.add("npc_rose", `${born.name} rose to fill the silence at ${seat.name}.`, {
        actorId: id,
        targetIds: [seat.id],
        regionId: seat.regionId,
        significance: 68,
        data: { year: state.year, founded: true },
      });
    }
  }

  // New troubles surface. Kept scarce so threats stay meaningful: a world that
  // sprouts a new menace every month teaches players that none of them matter.
  if (liveThreats.length < 3 && rng.chance(liveThreats.length === 0 ? 0.045 : 0.008)) {
    const kind = rng.pick(THREAT_KINDS);
    const id = log.nextId("thr");
    const regionIds = Object.keys(state.regions);
    if (regionIds.length > 0) {
      const regionId = rng.pick(regionIds);
      state.threats[id] = {
        id,
        name: forge.threat(rng, kind),
        kind,
        regionId,
        severity: rng.int(0, 12),
        growthRate: 0.4 + rng.next() * 1.3,
        revealed: false,
        resolved: false,
      };
      // Deliberately silent: a threat that announces itself at severity 3 robs
      // the party of the discovery. It gets an event when it crosses REVEAL_AT.
    }
  }

  // Ruins draw settlers back once the region quiets down.
  const ruins = Object.values(state.settlements).filter((s) => s.razed);
  // The more of the map lies empty, the harder people push to reclaim it.
  if (ruins.length > 0 && rng.chance(Math.min(0.4, 0.05 + 0.05 * ruins.length))) {
    const ruin = rng.pick(ruins);
    const region = state.regions[ruin.regionId];
    const regionThreat = Object.values(state.threats).some(
      (t) => !t.resolved && t.regionId === ruin.regionId && t.severity >= HARM_AT,
    );
    if (region && region.danger < 55 && !regionThreat) {
      ruin.razed = false;
      ruin.population = rng.int(80, 600);
      ruin.prosperity = rng.int(12, 30);
      ruin.defense = rng.int(5, 20);
      ruin.unrest = rng.int(0, 15);
      ruin.controllingFactionId = null;
      log.add("npc_rose", `Settlers moved back into the ruins of ${ruin.name}.`, {
        targetIds: [ruin.id],
        regionId: ruin.regionId,
        significance: 62,
        data: { year: state.year, resettled: true },
      });
    }
  }
}

/**
 * Advance the world one step. `historical` marks events as belonging to the
 * generated past rather than to live play, which changes only how they are
 * labelled — never how they are computed.
 */
export function driftWorld(
  state: WorldState,
  rng: Rng,
  log: EventLog,
  forge: NameForge,
  opts: { historical?: boolean } = {},
): void {
  // ─── Calendar ──────────────────────────────────────────────────────────
  const idx = SEASON_ORDER.indexOf(state.season);
  state.season = SEASON_ORDER[(idx + 1) % 4]!;
  if (state.season === "spring") state.year += 1;

  // ─── Faction agendas ───────────────────────────────────────────────────
  const factionRng = rng.fork("factions");
  for (const faction of livingFactions(state)) {
    // Tuned so a faction resolves roughly one agenda every 30–40 ticks. On a
    // weekly cadence that is a major political move every eight months, which
    // is slow enough that players can see one coming and intervene.
    const step = faction.agenda.urgency * (0.28 + faction.power / 260) * (0.5 + factionRng.next());
    faction.agenda.progress = clamp(faction.agenda.progress + step, 0, 100);

    if (faction.agenda.progress >= 100) {
      resolveAgenda(state, faction, log, factionRng, forge);
      if (!faction.defunct) faction.agenda = pickAgenda(state, faction, factionRng);
    } else if (faction.agenda.progress > 60 && factionRng.chance(0.12) && !opts.historical) {
      // Only live play surfaces telegraphing — history would drown in these.
      log.add("agenda_advanced", `Word spreads that ${faction.name} is preparing something.`, {
        actorId: faction.id,
        significance: 18,
        data: { agenda: faction.agenda.kind },
      });
    }

    // Economy: holdings fund the treasury, the treasury sustains power.
    const held = heldSettlements(state, faction.id);
    const income = held.reduce((sum, s) => sum + s.prosperity, 0) / Math.max(1, held.length * 12);
    faction.treasury = clamp(faction.treasury + income - 1.5, 0, 100);
    faction.power = clamp(
      faction.power + (faction.treasury > 60 ? 0.6 : faction.treasury < 20 ? -0.9 : 0),
      0,
      100,
    );
    if (faction.seatSettlementId && !state.settlements[faction.seatSettlementId]) {
      faction.seatSettlementId = held[0]?.id ?? null;
    }
    if (held.length === 0 && !faction.defunct && faction.power < 12) {
      faction.defunct = true;
      faction.seatSettlementId = null;
      log.add("agenda_resolved", `${faction.name} faded out of memory.`, {
        actorId: faction.id,
        significance: 60,
        data: { year: state.year },
      });
    }
  }

  // ─── Threats ───────────────────────────────────────────────────────────
  const threatRng = rng.fork("threats");
  for (const threat of Object.values(state.threats)) {
    if (threat.resolved) continue;
    const before = threat.severity;
    threat.severity = clamp(threat.severity + threat.growthRate * (0.5 + threatRng.next()), 0, 100);

    if (!threat.revealed && threat.severity >= REVEAL_AT) {
      threat.revealed = true;
      log.add("threat_emerged", `${threat.name} could no longer be denied.`, {
        actorId: threat.id,
        regionId: threat.regionId,
        significance: 70,
        data: { year: state.year },
      });
    }
    if (before < HARM_AT && threat.severity >= HARM_AT) {
      log.add("threat_escalated", `${threat.name} began taking a real toll.`, {
        actorId: threat.id,
        regionId: threat.regionId,
        significance: 76,
        data: { year: state.year },
      });
    }
    if (threat.severity >= HARM_AT) {
      const region = state.regions[threat.regionId];
      if (region) region.danger = clamp(region.danger + 1.5, 0, 100);
      for (const s of Object.values(state.settlements)) {
        if (s.regionId !== threat.regionId || s.razed) continue;
        s.prosperity = clamp(s.prosperity - threat.severity / 45, 0, 100);
        s.unrest = clamp(s.unrest + threat.severity / 55, 0, 100);
      }
    }
    // Threats burn out. A plague runs out of people, raiders move on to
    // easier country, a haunting finally gets what it came for. Without this,
    // the only way a threat ever ends is a faction hunting it down — so once
    // the factions are ground down, nothing can ever stop getting worse.
    if (threat.severity >= CRISIS_AT && threatRng.chance(0.025)) {
      threat.severity = 0;
      threat.resolved = true;
      log.add("threat_resolved", `${threat.name} finally spent itself.`, {
        actorId: threat.id,
        regionId: threat.regionId,
        significance: 64,
        data: { year: state.year, burnedOut: true },
      });
      continue;
    }

    if (threat.severity >= CRISIS_AT && threatRng.chance(0.18)) {
      const doomed = Object.values(state.settlements).filter(
        (s) => s.regionId === threat.regionId && !s.razed && s.prosperity < 15,
      );
      if (doomed.length > 0) {
        const lost = threatRng.pick(doomed);
        lost.razed = true;
        lost.population = 0;
        lost.controllingFactionId = null;
        log.add("settlement_razed", `${lost.name} was abandoned to ${threat.name}.`, {
          actorId: threat.id,
          targetIds: [lost.id],
          regionId: lost.regionId,
          significance: 92,
          data: { year: state.year },
        });
      }
    }
  }

  // Regions heal once nothing is actively preying on them. Without this,
  // `danger` only ever climbs, every region eventually becomes uninhabitable,
  // and the map trends irreversibly toward ruins — a world that can only get
  // worse is not one anyone wants to play in for a year.
  for (const region of Object.values(state.regions)) {
    const besieged = Object.values(state.threats).some(
      (t) => !t.resolved && t.regionId === region.id && t.severity >= HARM_AT,
    );
    if (!besieged) {
      const wasDangerous = region.danger >= 55;
      region.danger = clamp(region.danger - 0.9, 0, 100);
      if (wasDangerous && region.danger < 55) {
        log.add("prosperity_shift", `The roads through ${region.name} are passable again.`, {
          regionId: region.id,
          significance: 44,
          data: { year: state.year },
        });
      }
    }
  }

  // ─── Settlements ───────────────────────────────────────────────────────
  const townRng = rng.fork("settlements");
  for (const s of Object.values(state.settlements)) {
    if (s.razed) continue;
    const region = state.regions[s.regionId];
    const lord = s.controllingFactionId ? state.factions[s.controllingFactionId] : undefined;
    const wasProsperity = s.prosperity;
    const wasUnrest = s.unrest;
    const pull = (lord && !lord.defunct ? lord.power / 14 : -1.5) - (region ? region.danger / 22 : 0);
    s.prosperity = clamp(s.prosperity + pull * 0.4 + (townRng.next() - 0.5) * 2, 0, 100);
    s.unrest = clamp(
      s.unrest + (s.prosperity < 30 ? 1.6 : -1.1) + (townRng.next() - 0.5),
      0,
      100,
    );

    // Threshold crossings are the texture a reader notices between the big
    // beats — "the market has thinned" long before "the town revolted".
    const crossed = (from: number, to: number, at: number) =>
      (from < at && to >= at) || (from >= at && to < at);
    if (crossed(wasProsperity, s.prosperity, 30)) {
      log.add(
        "prosperity_shift",
        s.prosperity < 30
          ? `Trade in ${s.name} has thinned to almost nothing.`
          : `${s.name} is trading again after a lean stretch.`,
        { targetIds: [s.id], regionId: s.regionId, significance: 34, data: { year: state.year } },
      );
    }
    if (crossed(wasUnrest, s.unrest, 65)) {
      log.add(
        "unrest_shift",
        s.unrest >= 65
          ? `${s.name} is one bad season from open trouble.`
          : `Tempers in ${s.name} have cooled.`,
        { targetIds: [s.id], regionId: s.regionId, significance: 40, data: { year: state.year } },
      );
    }
    s.population = Math.max(0, Math.round(s.population * (1 + (s.prosperity - 45) / 4000)));
    s.defense = clamp(s.defense - 0.25, 0, 100);

    if (s.unrest >= 85 && townRng.chance(0.22)) {
      const previous = s.controllingFactionId;
      s.unrest = clamp(s.unrest - 45, 0, 100);
      s.controllingFactionId = null;
      s.prosperity = clamp(s.prosperity - 8, 0, 100);
      log.add("revolt", `${s.name} threw out its rulers.`, {
        targetIds: [s.id, ...(previous ? [previous] : [])],
        regionId: s.regionId,
        significance: 72,
        data: { year: state.year, from: previous },
      });
    }
  }

  // ─── People ────────────────────────────────────────────────────────────
  const npcRng = rng.fork("npcs");
  for (const npc of Object.values(state.npcs)) {
    if (!npc.alive) continue;
    const faction = npc.factionId ? state.factions[npc.factionId] : undefined;
    npc.renown = clamp(npc.renown + (faction && !faction.defunct ? (faction.power - 50) / 40 : -0.4), 0, 100);

    // Attitudes soften with time but never forget: strong feelings stay strong.
    for (const [target, value] of Object.entries(npc.attitudes)) {
      const decay = Math.abs(value) > 60 ? 0.15 : 0.5;
      npc.attitudes[target] = clamp(value > 0 ? value - decay : value + decay, -100, 100);
    }

    if (npcRng.chance(0.012)) {
      npc.alive = false;
      log.add("npc_died", `${npc.name} died${faction ? ` in the service of ${faction.name}` : ""}.`, {
        actorId: npc.id,
        significance: clamp(35 + npc.renown / 2, 0, 100),
        data: { year: state.year },
      });
      if (faction && !faction.defunct && npcRng.chance(0.6)) {
        const successor = {
          id: log.nextId("npc"),
          name: forge.person(npcRng),
          role: npc.role,
          factionId: faction.id,
          locationId: npc.locationId,
          alive: true,
          traits: forge.traits(npcRng, npcRng.int(1, 2)),
          attitudes: {} as Record<string, number>,
          renown: clamp(npc.renown / 3, 0, 100),
        };
        state.npcs[successor.id] = successor;
        log.add("npc_rose", `${successor.name} took up the office ${npc.name} left empty.`, {
          actorId: successor.id,
          targetIds: [npc.id, faction.id],
          significance: 38,
          data: { year: state.year },
        });
      }
    }
  }

  // ─── Renewal ───────────────────────────────────────────────────────────
  // Without this the world reaches heat death: factions get conquered, threats
  // get resolved, and by a few hundred ticks nothing is left to push against.
  // An endless campaign needs the world to keep generating pressure, so power
  // vacuums get filled, ruins get resettled, and new troubles surface. This is
  // the difference between a world with a history and a world with an ending.
  renewWorld(state, rng.fork("renewal"), log, forge);

  // ─── Scene ─────────────────────────────────────────────────────────────
  // The scene line is canonical world state, so the simulation writes it.
  // Letting the narrator supply it would hand the model authority over state
  // that the next tick reads back — the exact thing the design forbids.
  describeScene(state);

  const sceneRegion = state.regions[state.scene.regionId];
  const localThreat = Object.values(state.threats)
    .filter((t) => !t.resolved && t.revealed && t.regionId === state.scene.regionId)
    .reduce((m, t) => Math.max(m, t.severity), 0);
  const sceneTown = state.scene.settlementId ? state.settlements[state.scene.settlementId] : undefined;
  state.scene.tension = clamp(
    (sceneRegion?.danger ?? 0) * 0.4 + localThreat * 0.4 + (sceneTown?.unrest ?? 0) * 0.2,
    0,
    100,
  );
}

export { AGENDA_KINDS };
