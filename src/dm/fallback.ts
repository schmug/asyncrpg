/**
 * Templated narration, generated directly from simulation events.
 *
 * This is not a degraded placeholder — it is the floor the whole design stands
 * on. With no API key, no network, or an exhausted budget, a tick still
 * resolves and the group still gets something readable. The language model
 * makes the prose better; it is never what makes the game work.
 *
 * Pure, deterministic, free.
 */

import type { ActionResolution, Character, Outcome, WorldEvent, WorldState } from "../sim/types";

const OUTCOME_LEAD: Record<Outcome, string> = {
  critical_success: "Better than anyone hoped:",
  success: "It works:",
  partial: "Partly:",
  failure: "It does not go well:",
  critical_failure: "It goes badly wrong:",
};

/** Group events into readable paragraphs, most consequential first. */
function worldParagraphs(events: readonly WorldEvent[]): string[] {
  const worldEvents = events
    .filter((e) => e.kind !== "player_action")
    .sort((a, b) => b.significance - a.significance);
  if (worldEvents.length === 0) return [];

  // Anything at 60+ earns its own line; the rest gets folded into one
  // paragraph so a busy tick does not read as a bulleted changelog.
  const major = worldEvents.filter((e) => e.significance >= 60).map((e) => e.summary);
  const minor = worldEvents.filter((e) => e.significance < 60).map((e) => e.summary);

  const out = [...major];
  if (minor.length > 0) out.push(minor.join(" "));
  return out;
}

function actionParagraphs(resolutions: readonly ActionResolution[], state: WorldState): string[] {
  return resolutions.map((r) => {
    const character = state.characters[r.action.characterId];
    const name = character?.name ?? "Someone";
    const said = r.action.rawText.trim();
    const lead = OUTCOME_LEAD[r.outcome];
    const drifting = r.action.auto ? " (acting on their own while away)" : "";

    // Echo the player's own words back when they wrote any. Seeing your
    // sentence in the chronicle is most of what makes a beat feel like yours.
    const quoted = said && !r.action.auto ? ` ${name} wrote: "${said}"` : "";
    return `${lead} ${r.events[0]?.summary ?? `${name} acts.`}${drifting}${quoted}`;
  });
}

export interface TemplatedBeat {
  /** Plain-text prose for the beat. */
  prose: string;
  /** One-line situation for the next scene. */
  situation: string;
}

export function templatedBeat(
  state: WorldState,
  events: readonly WorldEvent[],
  resolutions: readonly ActionResolution[],
): TemplatedBeat {
  const where =
    (state.scene.settlementId && state.settlements[state.scene.settlementId]?.name) ??
    state.regions[state.scene.regionId]?.name ??
    "the road";

  const heading = `${where} — ${state.season} of year ${state.year}`;
  const paragraphs = [...worldParagraphs(events), ...actionParagraphs(resolutions, state)];

  if (paragraphs.length === 0) {
    paragraphs.push("A quiet turn. Nothing that will be remembered happened here.");
  }

  const tension =
    state.scene.tension >= 70
      ? "Something is going to give."
      : state.scene.tension >= 40
        ? "The mood is uneasy."
        : "For now, it holds.";

  return {
    prose: [heading, "", ...paragraphs, "", tension].join("\n"),
    situation: state.scene.situation,
  };
}

/** A short, deterministic prompt line for each player: what is being asked of them. */
export function promptFor(character: Character, state: WorldState): string {
  const where =
    (character.locationId && state.settlements[character.locationId]?.name) ??
    (character.locationId && state.regions[character.locationId]?.name) ??
    "where you stand";
  return `What does ${character.name} do in ${where}?`;
}
