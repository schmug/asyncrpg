/**
 * Free text in, typed action out.
 *
 * This is the model's second and last job. Its output is a *proposal*: a verb
 * and the name of a thing. Both are validated here — the verb against a fixed
 * enum, the name against entities that actually exist in this world. A model
 * that hallucinates "the Duke of Nowhere" produces an action with no target,
 * not a new NPC.
 *
 * There is a keyword parser underneath that handles the common cases with no
 * inference at all, so email play keeps working with the API key removed.
 */

import Anthropic from "@anthropic-ai/sdk";
import { ACTION_KINDS } from "../sim/types";
import type { ActionKind, EntityId, WorldState } from "../sim/types";
import type { DmConfig } from "./narrate";

export interface ParsedIntent {
  kind: ActionKind;
  targetId: EntityId | null;
  /** Third-person summary used in the chronicle line. */
  intent: string;
  source: "model" | "keywords";
}

const INTENT_SCHEMA = {
  type: "object",
  properties: {
    kind: { type: "string", enum: [...ACTION_KINDS] },
    targetName: {
      type: "string",
      description:
        "Exact name of the person, faction, settlement, region, or threat being acted on. " +
        "Empty string if the action has no specific target.",
    },
    intent: {
      type: "string",
      description:
        "What the character does, in third person, under 12 words. E.g. 'presses the steward about the missing grain'.",
    },
  },
  required: ["kind", "targetName", "intent"],
  additionalProperties: false,
} as const;

/**
 * Verb hints for the no-inference path. Ordered by specificity — the first
 * matching group wins, so "attack the bandits" resolves to `confront` rather
 * than matching a stray "the" somewhere.
 */
const KEYWORDS: [ActionKind, RegExp][] = [
  ["confront", /\b(attack|fight|confront|charge|strike|kill|challenge|ambush|drive off)\b/i],
  ["parley", /\b(talk|speak|ask|persuade|negotiate|convince|plead|bargain with|parley|greet)\b/i],
  ["investigate", /\b(investigate|search|examine|look into|inspect|study the|question|dig into)\b/i],
  ["scout", /\b(scout|survey|range|patrol|track|follow the|reconnoit)\b/i],
  ["travel", /\b(travel|go to|head|ride|walk|journey|set out|leave for|return to)\b/i],
  ["trade", /\b(trade|buy|sell|barter|haggle|deal|supplies|market)\b/i],
  ["aid", /\b(help|aid|heal|tend|assist|feed|shelter|comfort|rescue)\b/i],
  ["guard", /\b(guard|defend|watch|protect|stand watch|hold the|fortify)\b/i],
  ["perform", /\b(sing|play|perform|dance|tell a|entertain|recite)\b/i],
  ["study", /\b(read|research|study|learn|consult|recall|remember|pore over)\b/i],
];

/** Every named entity a player could plausibly refer to. */
function nameIndex(state: WorldState): Map<string, EntityId> {
  const index = new Map<string, EntityId>();
  const add = (name: string, id: EntityId) => {
    const key = name.toLowerCase().trim();
    if (key.length >= 3 && !index.has(key)) index.set(key, id);
  };
  for (const n of Object.values(state.npcs)) if (n.alive) add(n.name, n.id);
  for (const f of Object.values(state.factions)) if (!f.defunct) add(f.name, f.id);
  for (const s of Object.values(state.settlements)) if (!s.razed) add(s.name, s.id);
  for (const r of Object.values(state.regions)) add(r.name, r.id);
  for (const t of Object.values(state.threats)) if (!t.resolved && t.revealed) add(t.name, t.id);
  return index;
}

/**
 * Resolve a name to an id. Exact match first, then a containment match so
 * "the steward Kestrel" finds "Kestrel Ashfoot". Returns null rather than
 * guessing when nothing matches — an unresolved target is handled gracefully
 * by action resolution and is far better than pointing at the wrong entity.
 */
export function resolveTarget(state: WorldState, name: string): EntityId | null {
  const query = name.toLowerCase().trim();
  if (query.length < 3) return null;
  const index = nameIndex(state);

  const exact = index.get(query);
  if (exact) return exact;

  let best: { id: EntityId; length: number } | null = null;
  for (const [candidate, id] of index) {
    if (query.includes(candidate) || candidate.includes(query)) {
      // Prefer the longest match — "the Grey Blight" should beat "the Grey".
      if (!best || candidate.length > best.length) best = { id, length: candidate.length };
    }
  }
  return best?.id ?? null;
}

/** Deterministic parse. Always succeeds; never as good as the model. */
export function parseIntentKeywords(state: WorldState, text: string): ParsedIntent {
  const trimmed = text.trim();
  let kind: ActionKind = "investigate";
  for (const [candidate, pattern] of KEYWORDS) {
    if (pattern.test(trimmed)) {
      kind = candidate;
      break;
    }
  }

  // Longest named entity mentioned anywhere in the text.
  let targetId: EntityId | null = null;
  let bestLength = 0;
  const lower = trimmed.toLowerCase();
  for (const [name, id] of nameIndex(state)) {
    if (lower.includes(name) && name.length > bestLength) {
      targetId = id;
      bestLength = name.length;
    }
  }

  const firstSentence = trimmed.split(/[.!?\n]/)[0]?.trim() ?? trimmed;
  return {
    kind,
    targetId,
    intent: firstSentence.slice(0, 120) || "does something",
    source: "keywords",
  };
}

export async function parseIntent(
  cfg: DmConfig,
  state: WorldState,
  characterName: string,
  text: string,
): Promise<ParsedIntent> {
  const fallback = parseIntentKeywords(state, text);
  if (!cfg.apiKey || text.trim().length === 0) return fallback;

  try {
    const client = new Anthropic({ apiKey: cfg.apiKey });
    const known = [...nameIndex(state).values()].length;
    const names = [...nameIndex(state).keys()].slice(0, 120).join(", ");

    const response = await client.messages.create({
      model: cfg.cheapModel,
      max_tokens: 500,
      // No `output_config.effort` here: Haiku 4.5 rejects it.
      output_config: { format: { type: "json_schema", schema: INTENT_SCHEMA } },
      system:
        `Classify a tabletop RPG player's written action into one typed action.\n` +
        `Pick the single verb that best matches their primary intent.\n` +
        `For targetName, use an EXACT name from the known-entities list, or "" if none applies. ` +
        `Never invent a name that is not on the list.`,
      messages: [
        {
          role: "user",
          content:
            `Character: ${characterName}\n` +
            `Known entities (${known}): ${names}\n\n` +
            `They wrote:\n"""\n${text.slice(0, 2000)}\n"""`,
        },
      ],
    });

    if (response.stop_reason === "refusal") return fallback;
    const block = response.content.find((b) => b.type === "text");
    if (!block || block.type !== "text") return fallback;

    const parsed = JSON.parse(block.text) as {
      kind?: unknown;
      targetName?: unknown;
      intent?: unknown;
    };

    // The enum is enforced by the schema, but validate anyway — a model is not
    // a trusted source, and an unknown kind would index into ACTION_SPECS as
    // undefined and throw deep inside resolution.
    if (typeof parsed.kind !== "string" || !ACTION_KINDS.includes(parsed.kind as ActionKind)) {
      return fallback;
    }
    const intent =
      typeof parsed.intent === "string" && parsed.intent.trim().length > 0
        ? parsed.intent.trim().slice(0, 120)
        : fallback.intent;

    return {
      kind: parsed.kind as ActionKind,
      targetId:
        typeof parsed.targetName === "string" ? resolveTarget(state, parsed.targetName) : null,
      intent,
      source: "model",
    };
  } catch {
    return fallback;
  }
}
