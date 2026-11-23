import { validateJsonValue } from "../json.ts";
import { checkPayload, type PayloadSchema } from "../payload.ts";
import type { JsonValue } from "../schema.ts";

export interface SyncPresenceOptions<P extends JsonValue = JsonValue> {
  /** Validates this writer's state before it is sent, and peers' states as they arrive. */
  readonly schema?: PayloadSchema<P>;
  /** Milliseconds between re-sends of this writer's state, which keep it from expiring. Default 10000. */
  readonly republishInterval?: number;
}

/** Ephemeral per-writer state, such as a name and a selection, shared with the other writers. */
export interface SyncPresence<P extends JsonValue = JsonValue> {
  /** This writer's state; null when it shares none. */
  readonly state: P | null;
  /** The other writers' states by client ID, as the push channel last delivered them. */
  readonly peers: ReadonlyMap<string, P>;
  /**
   * Shares `state`, or stops sharing with null. Sending is best-effort and retried by the re-sends.
   * Once the client is stopped or failed, a valid state is ignored.
   */
  set(state: P | null): void;
  /** Called whenever `peers` changes. Returns an unsubscribe function. */
  on(event: "change", listener: (peers: ReadonlyMap<string, P>) => void): () => void;
}

/** The sync client's side of presence: what it shares, and what the push channel reports. */
export interface PresenceController<P extends JsonValue> {
  readonly api: SyncPresence<P>;
  /** A new push stream opened: the server will send every current state again. */
  opened(): void;
  /** One `{ clientId, state }` update from the push stream. */
  received(update: unknown): void;
  /** The push stream ended: nothing it reported is current any more. */
  closed(): void;
  /** Leaves, best-effort, and stops re-sending. */
  stop(): void;
}

/** Throws unless `state` is JSON that `schema` accepts. */
function checkState(schema: PayloadSchema | undefined, state: unknown): asserts state is JsonValue {
  validateJsonValue(state, ["presence"]);
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- validateJsonValue has just accepted it as JSON.
  checkPayload(schema, state as JsonValue, ["presence"]);
}

export function createPresence<P extends JsonValue>(
  options: SyncPresenceOptions<P>,
  clientId: string,
  publish: (state: P | null) => Promise<void>
): PresenceController<P> {
  const republishInterval = options.republishInterval ?? 10_000;
  if (typeof republishInterval !== "number") throw new TypeError("presence.republishInterval must be a number");
  if (!Number.isSafeInteger(republishInterval) || republishInterval <= 0) {
    throw new RangeError("presence.republishInterval must be a positive safe integer");
  }
  const { schema } = options;
  let state: P | null = null;
  let peers: ReadonlyMap<string, P> = new Map();
  const listeners = new Set<(peers: ReadonlyMap<string, P>) => void>();
  let queued: { readonly state: P | null } | undefined;
  let sending = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;

  /** Sends the newest queued state; while a send is in flight only the newest is kept. */
  function send(next: P | null): void {
    queued = { state: next };
    if (sending) return;
    sending = true;
    void (async () => {
      while (queued !== undefined) {
        const { state: current } = queued;
        queued = undefined;
        try { await publish(current); } catch { /* Best-effort: the next re-send tries again. */ }
      }
      sending = false;
    })();
  }
  function rearm(): void {
    if (timer !== undefined) clearInterval(timer);
    timer = state === null || stopped ? undefined : setInterval(() => { if (state !== null) send(state); }, republishInterval);
  }
  function emit(next: ReadonlyMap<string, P>): void {
    peers = next;
    for (const listener of [...listeners]) listener(peers);
  }

  return {
    api: {
      get state() { return state; },
      get peers() { return peers; },
      set(next) {
        if (next !== null) checkState(schema, next);
        // A stopped or failed client has left; editors may still report selections afterwards.
        if (stopped) return;
        state = next;
        send(next);
        rearm();
      },
      on(event, listener) {
        if (event !== "change") throw new Error(`Unknown event: ${String(event)}`);
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      },
    },
    opened() {
      if (peers.size > 0) emit(new Map());
      // A restarted server forgot this writer; tell it again rather than wait for the next re-send.
      if (state !== null && !stopped) send(state);
    },
    received(update) {
      if (typeof update !== "object" || update === null || Array.isArray(update)) return;
      const { clientId: peer, state: peerState } = update as { readonly clientId?: unknown; readonly state?: unknown };
      if (typeof peer !== "string" || peer === clientId) return;
      if (peerState === null) {
        if (!peers.has(peer)) return;
        const next = new Map(peers);
        next.delete(peer);
        emit(next);
        return;
      }
      // A peer on another version may send a state this writer's schema rejects: skip only that one.
      try { checkState(schema, peerState); } catch { return; }
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Checked against this writer's schema above.
      emit(new Map(peers).set(peer, peerState as P));
    },
    closed() {
      if (peers.size > 0) emit(new Map());
    },
    stop() {
      if (stopped) return;
      stopped = true;
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
      if (state !== null) { state = null; send(null); }
      listeners.clear();
    },
  };
}
