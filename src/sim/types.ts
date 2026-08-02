/**
 * The canonical world model.
 *
 * Everything here is plain data with typed, bounded fields. Nothing in this
 * file is free text that the simulation needs to reason about — prose is a
 * *rendering* of this state, never a substitute for it. That constraint is
 * what lets a campaign stay coherent across months of play: the baron who was
 * snubbed in tick 3 is a row with an `attitudes` entry, not a sentence in a
 * summary that will eventually be compacted away.
 */

export type CampaignId = string;
export type PlayerId = string;

/** Prefixed ids: `rgn_`, `stl_`, `fac_`, `npc_`, `thr_`, `chr_`. */
export type EntityId = string;

// ─── World geography ─────────────────────────────────────────────────────

export const TERRAINS = [
  "coast",
  "marsh",
  "forest",
  "hills",
  "mountains",
  "plains",
  "waste",
  "underground",
] as const;
export type Terrain = (typeof TERRAINS)[number];

export interface Region {
  id: EntityId;
  name: string;
  terrain: Terrain;
  /** 0–100. Rises with unresolved threats; gates travel and scouting. */
  danger: number;
  controllingFactionId: EntityId | null;
  neighborIds: EntityId[];
}

export interface Settlement {
  id: EntityId;
  name: string;
  regionId: EntityId;
  population: number;
  /** 0–100. Drives trade, recruitment, and how much a faction wants it. */
  prosperity: number;
  /** 0–100. Resists sieges and raids. */
  defense: number;
  /** 0–100. High unrest invites revolt and faction opportunism. */
  unrest: number;
  controllingFactionId: EntityId | null;
  razed: boolean;
}

// ─── Factions ────────────────────────────────────────────────────────────

export const FACTION_KINDS = [
  "noble_house",
  "merchant_guild",
  "cult",
  "warband",
  "order",
  "syndicate",
] as const;
export type FactionKind = (typeof FACTION_KINDS)[number];

export const AGENDA_KINDS = [
  "seize_settlement",
  "enrich",
  "fortify",
  "undermine_rival",
  "court_favor",
  "hunt_threat",
  "expand_influence",
] as const;
export type AgendaKind = (typeof AGENDA_KINDS)[number];

export interface Agenda {
  kind: AgendaKind;
  /** Settlement, faction, or threat the agenda is aimed at. */
  targetId: EntityId | null;
  /** 0–100. At 100 the agenda resolves and reshapes the world. */
  progress: number;
  /** 1–10. Multiplies per-tick progress. */
  urgency: number;
}

export interface Faction {
  id: EntityId;
  name: string;
  kind: FactionKind;
  /** 0–100. Military and political weight. */
  power: number;
  /** 0–100. Funds agendas; depleted by war, grown by prosperity. */
  treasury: number;
  seatSettlementId: EntityId | null;
  agenda: Agenda;
  /** −100 (blood feud) … +100 (allied), keyed by faction id. */
  relations: Record<EntityId, number>;
  defunct: boolean;
}

// ─── People ──────────────────────────────────────────────────────────────

export interface Npc {
  id: EntityId;
  name: string;
  role: string;
  factionId: EntityId | null;
  locationId: EntityId | null;
  alive: boolean;
  traits: string[];
  /**
   * −100 (nemesis) … +100 (devoted), keyed by character id.
   *
   * This is the memory that makes long campaigns feel earned. It decays toward
   * zero only very slowly, and never past a remembered extreme.
   */
  attitudes: Record<EntityId, number>;
  /** 0–100. How widely known this person is. */
  renown: number;
}

export const ATTRIBUTES = ["might", "wits", "grace", "spirit"] as const;
export type Attribute = (typeof ATTRIBUTES)[number];

export const PRESENCE = ["present", "drifting", "offscreen"] as const;
/**
 * `drifting` — missed 1–2 ticks; the DM takes a low-risk action for them.
 * `offscreen` — missed 3+; narratively sidelined, excluded from quorum.
 * Neither state ever costs the player anything mechanically.
 */
export type Presence = (typeof PRESENCE)[number];

export interface Character {
  id: EntityId;
  playerId: PlayerId;
  name: string;
  concept: string;
  /** 1–5 each. */
  attributes: Record<Attribute, number>;
  /** 0–5, sparse. */
  skills: Record<string, number>;
  /**
   * Short behavioral phrases ("never leaves a debt unpaid"). Used to pick an
   * in-character action when a player is drifting, so the auto-action reads as
   * *them* rather than as a generic NPC.
   */
  tendencies: string[];
  /** −100…+100 toward NPCs and factions. */
  bonds: Record<EntityId, number>;
  /**
   * 0–100. The only "advancement" axis, and it is deliberately not a level:
   * you become *known for* things. A player who misses 30 ticks has fewer
   * chronicle entries but is not mechanically behind anyone.
   */
  renown: number;
  /** Transient states like "wounded" or "hunted". Never applied for absence. */
  conditions: string[];
  locationId: EntityId | null;
  presence: Presence;
  /** Tick of this character's last player-authored action. */
  lastActedTick: number;
}

// ─── Threats ─────────────────────────────────────────────────────────────

export const THREAT_KINDS = [
  "blight",
  "raiders",
  "plague",
  "famine",
  "haunting",
  "schism",
  "beast",
] as const;
export type ThreatKind = (typeof THREAT_KINDS)[number];

export interface Threat {
  id: EntityId;
  name: string;
  kind: ThreatKind;
  regionId: EntityId;
  /** 0–100. Crosses thresholds to reveal itself, then to start doing harm. */
  severity: number;
  /** Severity added per tick while unresolved. */
  growthRate: number;
  revealed: boolean;
  resolved: boolean;
}

// ─── Events ──────────────────────────────────────────────────────────────

export const EVENT_KINDS = [
  "genesis",
  "agenda_advanced",
  "agenda_resolved",
  "settlement_changed_hands",
  "settlement_razed",
  "war_declared",
  "peace_made",
  "threat_emerged",
  "threat_escalated",
  "threat_resolved",
  "npc_died",
  "npc_rose",
  "prosperity_shift",
  "unrest_shift",
  "revolt",
  "player_action",
  "downtime_action",
  "letter_sent",
  "journal_entry",
  "character_joined",
  "character_offscreen",
  "character_returned",
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export interface WorldEvent {
  id: string;
  tick: number;
  kind: EventKind;
  actorId: EntityId | null;
  targetIds: EntityId[];
  regionId: EntityId | null;
  /**
   * Deterministic, templated one-line description generated by the sim itself.
   *
   * This is *not* a placeholder for the LLM's prose — it is the authoritative
   * record of what happened, and it is what the narrator falls back to when
   * inference is unavailable or over budget. The chronicle is readable with
   * the LLM entirely switched off.
   */
  summary: string;
  /** 0–100. Drives prominence in the chronicle. */
  significance: number;
  data: Record<string, unknown>;
}

// ─── Scene & state ───────────────────────────────────────────────────────

export interface Scene {
  regionId: EntityId;
  settlementId: EntityId | null;
  /** Templated situation line; the narrator dresses it, the sim owns it. */
  situation: string;
  /** 0–100. Rises with local threat severity and unrest. */
  tension: number;
}

export const SEASONS = ["spring", "summer", "autumn", "winter"] as const;
export type Season = (typeof SEASONS)[number];

export interface WorldState {
  campaignId: CampaignId;
  /** Monotonic. Tick 0 is genesis. */
  tick: number;
  year: number;
  season: Season;
  regions: Record<EntityId, Region>;
  settlements: Record<EntityId, Settlement>;
  factions: Record<EntityId, Faction>;
  npcs: Record<EntityId, Npc>;
  threats: Record<EntityId, Threat>;
  characters: Record<EntityId, Character>;
  scene: Scene;
}

// ─── Player actions ──────────────────────────────────────────────────────

export const ACTION_KINDS = [
  "parley",
  "investigate",
  "aid",
  "confront",
  "travel",
  "scout",
  "trade",
  "perform",
  "study",
  "guard",
] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

/** Downtime resolves on sim rules alone, between ticks, at no narrative cost. */
export const DOWNTIME_KINDS = ["craft", "research", "train", "network", "recover"] as const;
export type DowntimeKind = (typeof DOWNTIME_KINDS)[number];

export interface PlayerAction {
  id: string;
  characterId: EntityId;
  playerId: PlayerId;
  tick: number;
  kind: ActionKind;
  targetId: EntityId | null;
  /** Exactly what the player wrote. Preserved verbatim for the chronicle. */
  rawText: string;
  /** One-line normalized intent extracted from `rawText`. */
  intent: string;
  via: "email" | "web" | "auto";
  /** True when the DM acted for a drifting player. Always surfaced to readers. */
  auto: boolean;
}

export const OUTCOMES = [
  "critical_success",
  "success",
  "partial",
  "failure",
  "critical_failure",
] as const;
export type Outcome = (typeof OUTCOMES)[number];

export interface ActionResolution {
  action: PlayerAction;
  outcome: Outcome;
  roll: number;
  total: number;
  difficulty: number;
  events: WorldEvent[];
}

/** Result of one deterministic tick. */
export interface TickResult {
  state: WorldState;
  events: WorldEvent[];
  resolutions: ActionResolution[];
}
