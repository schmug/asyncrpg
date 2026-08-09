/**
 * Downtime — something to do between ticks, for people who want to do more.
 *
 * The design constraint that shapes all of this: **doing more must never make
 * your character mechanically stronger than someone who does less.** If
 * downtime raised attributes or skills, then skipping it would be a penalty,
 * and the no-penalty promise would be a lie told in slower motion.
 *
 * That constraint originally stopped at attributes and skills, and it was not
 * far enough. `train` raised renown and `network` moved both a character's
 * bond and the NPC's reciprocal attitude — and all three feed `difficultyFor`.
 * So an optional activity was a mechanical edge, which makes skipping it a
 * mechanical cost. Worse, `restoreStanding` could not undo the NPC's half of a
 * relationship, so a returning player stayed permanently behind.
 *
 * Downtime now moves exactly two things: **knowledge** (`research` can reveal
 * a threat, which is information the whole table gets, not a personal bonus)
 * and **conditions** (`recover` clears what the world did to you, which is
 * removing a minus rather than adding a plus).
 *
 * Everything else it produces is *story*: a line in the chronicle, a fact the
 * narrator is handed, something to write a journal entry about. An engaged
 * player ends up more present in the telling. They do not end up harder to
 * beat.
 *
 * Resolves immediately, deterministically, with no inference call.
 */

import { EventLog } from "./events";

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
      // Deliberately changes nothing.
      //
      // This used to raise renown, on the reasoning that practising in public
      // is how people come to know your name. But renown is a mechanical input
      // to `difficultyFor`, so that made an *optional* activity into a real
      // advantage — and therefore made skipping it a real cost, which is the
      // promise inverted. A player with a spare ten minutes was buying an edge
      // over a player without one.
      //
      // What downtime buys is presence in the story: this shows up in the
      // chronicle and gives the narrator something to write about. That is the
      // whole of it, and it is what the product has always claimed.
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
        // Also deliberately changes nothing. This used to move both the NPC's
        // attitude and the character's bond, and both feed `difficultyFor` —
        // so the player who networked every week arrived at every negotiation
        // with a standing edge, and `restoreStanding` could not undo it,
        // because it never touched the NPC's side of the relationship at all.
        //
        // Who you spent time with is a fact about the story, and the narrator
        // is told about it. It is not a bonus.
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
