import type { ServerCommit } from "../index.ts";
import type { JsonValue } from "../schema.ts";
import type { SyncAction } from "./http-handler.ts";

/**
 * The part of a server-side WebSocket that `SyncHandler.accept` uses. Sockets from `ws`, Bun, Deno
 * and Cloudflare Workers fit with a small wrapper.
 */
export interface SyncSocket {
  send(message: string): void;
  close(code?: number, reason?: string): void;
  /** Bytes queued but not yet sent, where the runtime reports it; past 4 MiB the socket is closed with 1013. */
  readonly bufferedAmount?: number;
}

/** One socket accepted by `SyncHandler.accept`. */
export interface SyncConnection {
  /** Handles one received message: text, or the same text as UTF-8 bytes. */
  message(data: string | ArrayBuffer | ArrayBufferView): void;
  /** The socket closed: ends its subscription and clears the presence states it sent. */
  close(): void;
}

/** Something a subscriber receives, formatted by its transport. */
export type PushEvent =
  | { readonly type: "commits"; readonly commits: readonly ServerCommit[]; readonly last: number }
  | { readonly type: "presence"; readonly clientId: string; readonly state: JsonValue | null }
  | { readonly type: "gap" }
  | { readonly type: "ping" };

/** An event stream or a subscribed socket. */
export interface Subscriber {
  /** The last server sequence pushed. */
  sent: number;
  readonly closed: boolean;
  /** Returns false when it cannot take more; the caller then closes it. */
  push(event: PushEvent): boolean;
  close(): void;
}

/** A transport-neutral answer: an HTTP response, or a socket reply. */
export interface Reply {
  readonly status: number;
  readonly body?: unknown;
}

export type Allow = (action: SyncAction, clientId?: string) => Promise<boolean>;

export const failure = (status: number, message: string): Reply => ({ status, body: { error: message } });

/** What `createSyncHandler` shares between its HTTP routes and its sockets. */
export interface SyncCore {
  readonly maxMessageSize: number;
  readonly heartbeatInterval: number;
  readonly maxBufferedBytes: number;
  readonly rejections: boolean;
  readonly presence: boolean;
  readonly failed: boolean;
  /** Binds `authorize` to a request. */
  allow(request: Request): Allow;
  register(allow: Allow): Promise<Reply>;
  write(kind: "submit" | "reject", input: unknown, allow: Allow): Promise<Reply>;
  catchUp(watermark: number, allow: Allow): Promise<Reply>;
  publish(clientId: string, state: unknown, allow: Allow, owner?: object): Promise<Reply>;
  /** Admits the subscriber `create` makes; an error reply, or undefined once it is receiving. */
  subscribe(watermark: number, allow: Allow, create: () => Subscriber): Promise<Reply | undefined>;
  /** Removes a closed subscriber. */
  drop(subscriber: Subscriber): void;
  /** Clears the presence states `owner` sent that no one has sent since. */
  release(owner: object): void;
  /** Tracks an open socket, failed when checkpoint storage fails; returns the untrack function. */
  track(socket: { fail(): void }): () => void;
}

const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** Serves one socket with the same operations as the HTTP routes. */
export function acceptSocket(core: SyncCore, socket: SyncSocket, request: Request): SyncConnection {
  const allowed = core.allow(request);
  /** Identifies this socket as the sender of presence states. */
  const owner = {};
  let open = true;
  let subscriber: Subscriber | undefined;
  /** Bumped by every subscribe and unsubscribe, so only the latest subscribe opens. */
  let generation = 0;

  function end(): void {
    if (!open) return;
    open = false;
    untrack();
    subscriber?.close();
    core.release(owner);
  }
  function shut(code: number, reason: string): void {
    if (!open) return;
    end();
    try { socket.close(code, reason); } catch { /* Already closing. */ }
  }
  function send(value: unknown): boolean {
    if (!open) return false;
    if ((socket.bufferedAmount ?? 0) > core.maxBufferedBytes) { shut(1013, "Send queue full"); return false; }
    try { socket.send(JSON.stringify(value)); return true; }
    catch { shut(1011, "Send failed"); return false; }
  }
  const untrack = core.track({ fail: () => { shut(1011, "Checkpoint storage failed"); } });
  if (core.failed) shut(1011, "Checkpoint storage failed");

  function subscription(watermark: number, live: boolean): Subscriber {
    let active = live;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const created: Subscriber = {
      sent: watermark,
      get closed() { return !active; },
      push(event) {
        if (!active) return false;
        return send(event.type === "commits" ? { type: "commits", commits: event.commits } : event);
      },
      close() {
        if (!active) return;
        active = false;
        if (heartbeat !== undefined) clearInterval(heartbeat);
        if (subscriber === created) subscriber = undefined;
        core.drop(created);
      },
    };
    if (!live) return created;
    subscriber = created;
    if (core.heartbeatInterval > 0) heartbeat = setInterval(() => { created.push({ type: "ping" }); }, core.heartbeatInterval);
    return created;
  }

  async function handle(input: Record<string, unknown>, id: number): Promise<Reply | undefined> {
    const size = Object.keys(input).length;
    switch (input.type) {
      case "register":
        return size === 2 ? core.register(allowed) : failure(400, "Expected { id, type }");
      case "submit":
      case "reject":
        if (input.type === "reject" && !core.rejections) return failure(404, "Unknown message type");
        return size === 3 && "batch" in input ? core.write(input.type, input.batch, allowed) : failure(400, "Expected { id, type, batch }");
      case "commits":
        return size === 3 && isNonNegativeInteger(input.since) ? core.catchUp(input.since, allowed) : failure(400, "Expected { id, type, since }");
      case "subscribe": {
        if (size !== 3 || !isNonNegativeInteger(input.since)) return failure(400, "Expected { id, type, since }");
        const since = input.since;
        const mine = ++generation;
        subscriber?.close();
        let opened = false;
        const reply = await core.subscribe(since, allowed, () => {
          const created = subscription(since, open && mine === generation);
          // The reply goes before any push, as an event stream's headers do.
          if (!created.closed) opened = send({ id, status: 200 });
          return created;
        });
        // A later subscribe or unsubscribe replaced this one before it opened.
        return reply ?? (opened ? undefined : { status: 204 });
      }
      case "unsubscribe":
        if (size !== 2) return failure(400, "Expected { id, type }");
        generation++;
        subscriber?.close();
        return { status: 204 };
      case "presence": {
        if (!core.presence) return failure(404, "Unknown message type");
        if (size !== 4 || typeof input.clientId !== "string" || !("state" in input)) {
          return failure(400, "Expected { id, type, clientId, state }");
        }
        const reply = await core.publish(input.clientId, input.state, allowed, owner);
        // The socket may have closed while authorize ran, after its states were cleared.
        if (!open) core.release(owner);
        return reply;
      }
      default:
        return failure(404, "Unknown message type");
    }
  }

  return {
    message(data) {
      if (!open) return;
      if (core.failed) { shut(1011, "Checkpoint storage failed"); return; }
      const limit = core.maxMessageSize;
      let text: string;
      if (typeof data === "string") {
        // UTF-16 length is a lower bound on UTF-8 bytes, and a third of an upper bound.
        if (data.length > limit || (data.length * 3 > limit && encoder.encode(data).byteLength > limit)) {
          shut(1009, "Message too large");
          return;
        }
        text = data;
      } else {
        const bytes = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
        if (bytes.byteLength > limit) { shut(1009, "Message too large"); return; }
        try { text = decoder.decode(bytes); } catch { shut(1007, "Expected UTF-8 text"); return; }
      }
      let input: unknown;
      try { input = JSON.parse(text); } catch { shut(1008, "Expected a JSON message"); return; }
      if (!isRecord(input) || !isNonNegativeInteger(input.id) || typeof input.type !== "string") {
        shut(1008, "Expected { id, type }");
        return;
      }
      const id = input.id;
      void handle(input, id).then(
        (reply) => { if (reply !== undefined) send({ id, ...reply }); },
        () => { send({ id, ...failure(500, "Internal server error") }); }
      );
    },
    close: end,
  };
}
