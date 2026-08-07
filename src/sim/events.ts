import type { EntityId, EventKind, WorldEvent } from "./types";

/**
 * Deterministic event-id allocation.
 *
 * Ids must be stable across replays of the same tick, so they are positional
 * (`t{tick}-{seq}`) rather than random or time-based. The chronicle keys off
 * these, so a replay must produce the same keys or the projection would
 * duplicate rows.
 */
export class EventLog {
  #seq = 0;
  readonly #tick: number;
  readonly #events: WorldEvent[] = [];

  constructor(tick: number) {
    this.#tick = tick;
  }

  add(
    kind: EventKind,
    summary: string,
    opts: {
      actorId?: EntityId | null;
      targetIds?: EntityId[];
      regionId?: EntityId | null;
      significance?: number;
      data?: Record<string, unknown>;
    } = {},
  ): WorldEvent {
    const event: WorldEvent = {
      id: `t${this.#tick}-${this.#seq++}`,
      tick: this.#tick,
      kind,
      actorId: opts.actorId ?? null,
      targetIds: opts.targetIds ?? [],
      regionId: opts.regionId ?? null,
      summary,
      significance: Math.max(0, Math.min(100, Math.round(opts.significance ?? 30))),
      data: opts.data ?? {},
    };
    this.#events.push(event);
    return event;
  }

  get events(): WorldEvent[] {
    return this.#events;
  }

  /**
   * Allocate an id for a newly created entity.
   *
   * Positional on (tick, sequence) rather than derived from collection size.
   * Size-derived ids look fine until something is deleted: once pruning shrinks
   * a collection, `prefix_${length}` starts handing out ids that are still in
   * use, silently overwriting live entities. Tick is monotonic and the counter
   * is per-tick, so these can never collide — and they stay deterministic
   * across replays, which size-derived ids also were not.
   */
  nextId(prefix: string): string {
    return `${prefix}_t${this.#tick}_${this.#idSeq++}`;
  }

  #idSeq = 0;
}
