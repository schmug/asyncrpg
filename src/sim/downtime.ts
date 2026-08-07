/**
 * Downtime — something to do between ticks, for people who want to do more.
 *
 * The design constraint that shapes all of this: **doing more must never make
 * your character mechanically stronger than someone who does less.** If
 * downtime raised attributes or skills, then skipping it would be a penalty,
 * and the no-penalty promise would be a lie told in slower motion.
 *
 * So downtime moves knowledge, relationships, and conditions — never
 * attributes, never skills. You learn things, you become known to people, you
 * recover from what the world did to you. An engaged player ends up with a
 * richer position in the story and more entries in the chronicle; they do not
 * end up with a better character sheet.
 *
 * Resolves immediately, deterministically, with no inference call.
 */

import { EventLog } from "./events";
import { clamp } from "./invariants";
import { Rng, seedFrom } from "./prng";
import { DOWNTIME_KINDS } from "./types";
import type { DowntimeKind, EntityId, WorldEvent, WorldState } from "./types";

export interface DowntimeRequest {
  characterId: EntityId;
  kind: DowntimeKind;
  /** Optional free text: what they are making, who they are seeking out. */
  detail: string;
  targetId: EntityId | null;
}

export interface DowntimeResult {
  ok: boolean;
  /** What the character achieved, in plain language. */
  outcome: string;
  events: WorldEvent[];
  reason?: string;
}

const CRAFTED = [
  "a good knife", "a waxed cloak", "a set of picks", "a folding lantern",
  "a bundle of tinctures", "a copied map", "a length of strong rope",
  "a whistle that carries", "a pair of boots that fit",
];

export function isDowntimeKind(value: string): value is DowntimeKind {
  return (DOWNTIME_KINDS as readonly string[]).includes(value);
}

export function resolveDowntime(
  state: WorldState,
  req: DowntimeRequest,
  log: EventLog,
): DowntimeResult {
  const character = state.characters[req.characterId];
  if (!character) return { ok: false, outcome: "", events: [], reason: "no such character" };

  const rng = new Rng(
    seedFrom(state.campaignId, state.tick, `downtime-${req.characterId}-${req.kind}`),
  );
  const detail = req.detail.trim().slice(0, 200);
  const here = character.locationId ? state.settlements[character.locationId] : undefined;
  let outcome = "";

  switch (req.kind) {
    case "craft": {
      const thing = detail || rng.pick(CRAFTED);
      outcome = `made ${thing}`;
      break;
    }

    case "research": {
      // Knowledge, not power: this can reveal a threat the party has not yet
      // noticed, which changes what they can choose to do — not what they can
      // do it with.
      const hidden = Object.values(state.threats).filter((t) => !t.resolved && !t.revealed);
      const target = req.targetId ? state.threats[req.targetId] : undefined;
      const found = target && !target.resolved ? target : hidden.length ? rng.pick(hidden) : null;
      if (found && !found.revealed) {
        found.revealed = true;
        outcome = `turned up something about ${found.name}`;
        log.add("threat_emerged", `${character.name}'s reading turned up ${found.name}.`, {
          actorId: character.id,
          targetIds: [found.id],
          regionId: found.regionId,
          significance: 58,
          data: { viaDowntime: true },
        });
      } else {
        outcome = detail ? `read up on ${detail}` : "read, and found nothing new";
      }
      break;
    }

    case "train": {
      // Explicitly not a stat gain. Practising in public is how people come to
      // know your name, which is the only thing that accumulates here.
      character.renown = clamp(character.renown + (1 - character.renown / 100) * 2, 0, 100);
      outcome = detail ? `practised ${detail} where people could see` : "practised in the yard";
      break;
    }

    case "network": {
      const local = Object.values(state.npcs).filter(
        (n) => n.alive && (!here || n.locationId === here.id),
      );
      const pool = local.length > 0 ? local : Object.values(state.npcs).filter((n) => n.alive);
      const target = (req.targetId ? state.npcs[req.targetId] : undefined) ?? (pool.length ? rng.pick(pool) : undefined);
      if (target?.alive) {
        const shift = rng.int(3, 9);
        target.attitudes[character.id] = clamp((target.attitudes[character.id] ?? 0) + shift, -100, 100);
        character.bonds[target.id] = clamp((character.bonds[target.id] ?? 0) + shift, -100, 100);
        outcome = `spent time with ${target.name}`;
      } else {
        outcome = "drank alone; nobody worth knowing was about";
      }
      break;
    }

    case "recover": {
      if (character.conditions.length > 0) {
        const cleared = character.conditions.shift()!;
        outcome = `rested, and is no longer ${cleared}`;
      } else {
        outcome = "rested, and needed it less than expected";
      }
      break;
    }
  }

  const event = log.add("downtime_action", `${character.name} ${outcome}.`, {
    actorId: character.id,
    targetIds: req.targetId ? [req.targetId] : [],
    regionId: here?.regionId ?? null,
    // Low by design: downtime is texture between the beats, and flooding the
    // chronicle's turning points with it would bury the actual story.
    significance: 22,
    data: { kind: req.kind, detail, viaDowntime: true },
  });

  return { ok: true, outcome, events: [event] };
}
