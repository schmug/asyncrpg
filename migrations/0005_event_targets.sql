-- `WorldEvent.targetIds` carries *who an event happened to*. For many event
-- kinds it is the only link to the entity, because `actor_id` is null — a
-- prosperity shift names the settlement as a target and has no actor at all.
--
-- It was populated throughout the sim from the beginning but never projected,
-- so the read model could answer "what did X do" and not "what happened to X".
-- Issue #7.
ALTER TABLE events ADD COLUMN target_ids TEXT NOT NULL DEFAULT '[]';
