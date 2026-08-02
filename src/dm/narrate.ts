/**
 * The dungeon master's voice.
 *
 * The model has **no authority over world state**. It receives resolved facts
 * and returns prose. It cannot introduce a faction, kill an NPC, move the
 * party, or change a number — because nothing it returns is ever written back
 * into the simulation except two bounded strings (the beat's prose and a
 * one-line scene description), and both are length-checked before use.
 *
 * The spec called for validating proposed state deltas. Removing the delta
 * channel entirely is strictly stronger: there is no illegal write to catch,
 * because there is no write. What the model says happened and what the sim
 * recorded cannot diverge, because the sim is what it was told.
 *
 * Every failure path — no key, network error, malformed output, exhausted
 * budget — falls through to deterministic templated prose. A tick always
 * produces something readable.
 */

import Anthropic from "@anthropic-ai/sdk";
import { templatedBeat } from "./fallback";
import type { TemplatedBeat } from "./fallback";
import type { ActionResolution, WorldEvent, WorldState } from "../sim/types";

/** Only what narration needs — narrower than the full Worker Env, and testable. */
export interface DmConfig {
  apiKey: string | undefined;
  narrateModel: string;
  cheapModel: string;
}

export interface BudgetGuard {
  /** False when the campaign has spent its allowance; narration degrades. */
  canSpend(campaignId: string): Promise<boolean>;
  record(campaignId: string, inputTokens: number, outputTokens: number): Promise<void>;
}

/** A guard that always allows and records nothing — for tests and local dev. */
export const UNLIMITED_BUDGET: BudgetGuard = {
  canSpend: async () => true,
  record: async () => {},
};

export type NarrationSource = "model" | "templated";

export interface Beat extends TemplatedBeat {
  source: NarrationSource;
  /** Present when the model was used; useful for cost dashboards and the critic. */
  usage?: { inputTokens: number; outputTokens: number; model: string };
  /** Set when the model was attempted and did not produce usable prose. */
  degradedReason?: string;
}

const BEAT_SCHEMA = {
  type: "object",
  properties: {
    prose: {
      type: "string",
      description:
        "The beat, as prose the players read. Second person plural for the party. " +
        "Narrate only what the FACTS section says happened. 150-350 words.",
    },
    situation: {
      type: "string",
      description: "One sentence describing where the party now stands. Under 140 characters.",
    },
  },
  required: ["prose", "situation"],
  // Structured outputs require this, and the schema language does not support
  // minLength/maxLength — length is enforced in code below instead.
  additionalProperties: false,
} as const;

const SYSTEM = `You are the narrator of a long-running, play-by-email tabletop RPG.

You are given FACTS: everything that happened this turn, already resolved by a
simulation. Your only job is to render those facts as prose the group will enjoy
reading and want to retell.

Hard rules:
- Narrate ONLY what the FACTS state. Do not invent people, places, factions,
  deaths, or outcomes. If a fact is absent, it did not happen.
- Never contradict a fact, soften a failure, or upgrade a partial success.
- Never decide what a player's character does next. Ending a beat by having a
  character commit to an action steals the player's turn.
- Refer to people and places by exactly the names given.
- A player marked "away" had their action chosen for them. Narrate it lightly
  and without drama; never make it a defining moment for that character.

Voice: concrete, unhurried, physical. Weather, hands, money, tiredness. Trust
the reader. No stage directions, no headers, no bullet points, no meta
commentary about the game or the turn structure.`;

function factSheet(
  state: WorldState,
  events: readonly WorldEvent[],
  resolutions: readonly ActionResolution[],
): string {
  const where =
    (state.scene.settlementId && state.settlements[state.scene.settlementId]?.name) ??
    state.regions[state.scene.regionId]?.name ??
    "the road";

  const cast = Object.values(state.characters)
    .filter((c) => c.presence !== "offscreen")
    .map((c) => `- ${c.name} (${c.concept})${c.presence === "drifting" ? " [away]" : ""}` +
      (c.conditions.length ? ` — ${c.conditions.join(", ")}` : ""))
    .join("\n");

  const world = events
    .filter((e) => e.kind !== "player_action")
    .sort((a, b) => b.significance - a.significance)
    .map((e) => `- ${e.summary}`)
    .join("\n");

  const acts = resolutions
    .map((r) => {
      const name = state.characters[r.action.characterId]?.name ?? "someone";
      const said = r.action.rawText.trim();
      return (
        `- ${name} (${r.outcome.replace("_", " ")}${r.action.auto ? ", away" : ""}): ` +
        `${r.events[0]?.summary ?? r.action.intent}` +
        (said && !r.action.auto ? `\n  they wrote: "${said}"` : "")
      );
    })
    .join("\n");

  return [
    `PLACE: ${where}, ${state.season} of year ${state.year}. Tension ${Math.round(state.scene.tension)}/100.`,
    `SITUATION: ${state.scene.situation}`,
    ``,
    `CAST:`,
    cast || "- (nobody present)",
    ``,
    `WHAT THE WORLD DID:`,
    world || "- (nothing of note)",
    ``,
    `WHAT THE PLAYERS DID:`,
    acts || "- (nobody acted)",
  ].join("\n");
}

/** Reject prose that is empty, truncated, or absurdly long before it is stored. */
function usable(prose: unknown, situation: unknown): prose is string {
  return (
    typeof prose === "string" &&
    typeof situation === "string" &&
    prose.trim().length >= 40 &&
    prose.length <= 8000 &&
    situation.trim().length > 0
  );
}

export async function narrateBeat(
  cfg: DmConfig,
  state: WorldState,
  events: readonly WorldEvent[],
  resolutions: readonly ActionResolution[],
  budget: BudgetGuard = UNLIMITED_BUDGET,
): Promise<Beat> {
  const fallback = templatedBeat(state, events, resolutions);

  if (!cfg.apiKey) {
    return { ...fallback, source: "templated", degradedReason: "no ANTHROPIC_API_KEY configured" };
  }
  if (!(await budget.canSpend(state.campaignId))) {
    return { ...fallback, source: "templated", degradedReason: "campaign token budget exhausted" };
  }

  try {
    const client = new Anthropic({ apiKey: cfg.apiKey });
    const response = await client.messages.create({
      model: cfg.narrateModel,
      // Room for adaptive thinking plus the beat itself; well under the
      // ~16k threshold where non-streaming risks an SDK HTTP timeout.
      max_tokens: 6000,
      system: SYSTEM,
      // Narration is a writing task, not a reasoning one — low effort keeps
      // latency and cost down without hurting prose quality.
      output_config: { effort: "low", format: { type: "json_schema", schema: BEAT_SCHEMA } },
      messages: [{ role: "user", content: factSheet(state, events, resolutions) }],
    });

    if (response.stop_reason === "refusal") {
      return { ...fallback, source: "templated", degradedReason: "model declined the request" };
    }

    const text = response.content.find((b) => b.type === "text");
    if (!text || text.type !== "text") {
      return { ...fallback, source: "templated", degradedReason: "no text block in response" };
    }

    const parsed = JSON.parse(text.text) as { prose?: unknown; situation?: unknown };
    if (!usable(parsed.prose, parsed.situation)) {
      return { ...fallback, source: "templated", degradedReason: "model output failed validation" };
    }

    const usage = {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      model: response.model,
    };
    await budget.record(state.campaignId, usage.inputTokens, usage.outputTokens);

    return {
      prose: parsed.prose.trim(),
      // Bounded before it touches state: the model cannot smuggle a wall of
      // text into a field the sim carries forward tick after tick.
      situation: String(parsed.situation).trim().slice(0, 200),
      source: "model",
      usage,
    };
  } catch (err) {
    // Network failure, rate limit, malformed JSON, anything: the tick still
    // resolves. Never let narration take a campaign down.
    return {
      ...fallback,
      source: "templated",
      degradedReason: `narration failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
