import {
  decodeClientBatch,
  type ClientBatch,
  type DocumentOperation,
  type DocumentSchema,
  type SchemaShape,
  type ServerCheckpoint,
  type ServerDocument,
} from "../index.ts";
import { jsonEquals, validateJsonValue } from "../json.ts";
import { integerOption } from "../options.ts";
import { checkPayload, type PayloadSchema } from "../payload.ts";
import type { JsonValue } from "../schema.ts";
import {
  acceptSocket,
  failure,
  type Allow,
  type PushEvent,
  type Reply,
  type Subscriber,
  type SyncConnection,
  type SyncCore,
  type SyncSocket,
} from "./socket-handler.ts";

export type SyncAction = "register" | "submit" | "reject" | "catchUp" | "presence";

export interface SyncHandlerPresenceOptions {
  /** Validates each writer's state; invalid ones are answered with 400. */
  readonly schema?: PayloadSchema;
  /** Milliseconds a state lives without being sent again. Default 30000. */
  readonly ttl?: number;
}

export interface SyncHandlerOptions<S extends SchemaShape> {
  /**
   * Persists the server after it opens a session or processes a new batch, before responding.
   * If it fails, the handler answers 503 until it is recreated from the last saved checkpoint.
   */
  readonly saveCheckpoint?: (checkpoint: ServerCheckpoint<S>) => void | Promise<void>;
  /** Decides whether the request may perform `action`, for `clientId` when the request names one. */
  readonly authorize?: (
    request: Request,
    context: { readonly action: SyncAction; readonly clientId?: string }
  ) => boolean | Promise<boolean>;
  /** Enables `POST rejections`, which cancels pending work. Default false. */
  readonly allowRejections?: boolean;
  /** Maximum request body or socket message size in bytes. Default 1 MiB. */
  readonly maxBodySize?: number;
  /** Milliseconds between heartbeats on event streams and subscribed sockets. Default 15000. */
  readonly heartbeatInterval?: number;
  /** Maximum event streams and socket subscriptions open at once; more are answered with 503. Default 1000. */
  readonly maxEventStreams?: number;
  /**
   * Enables `POST presence` and socket `presence` messages: writers' ephemeral states, kept in
   * memory only and pushed to every subscriber until they are cleared, expire, or the socket that
   * sent them closes.
   */
  readonly presence?: SyncHandlerPresenceOptions;
}

/** A Fetch API handler that also serves WebSockets and can push commits made outside it. */
export interface SyncHandler {
  (request: Request): Promise<Response>;
  /**
   * Serves one WebSocket with the same server, queue and presence as the HTTP routes. `request` is
   * the upgrade request, passed to `authorize` for every message. Pass each received message to the
   * returned connection's `message()`, and call its `close()` when the socket closes.
   */
  accept(socket: SyncSocket, request: Request): SyncConnection;
  /**
   * Sends commits that were applied to the server without this handler, such as by a direct
   * `server.receive()`, to open event streams and sockets. Call it after those commits are saved.
   */
  notify(): Promise<void>;
}

function routeMethod(route: string): "GET" | "POST" | undefined {
  switch (route) {
    case "clients": case "batches": case "rejections": case "presence": return "POST";
    case "commits": case "events": return "GET";
    default: return undefined;
  }
}

function json(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}
const error = (status: number, message: string, headers?: HeadersInit) => {
  const response = json(status, { error: message });
  new Headers(headers).forEach((value, name) => { response.headers.set(name, value); });
  return response;
};

/** Reads at most `limit` bytes; null when the body is larger. */
async function readBody(request: Request, limit: number): Promise<string | null> {
  if (request.body === null) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel(); return null; }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

const WATERMARK = /^(0|[1-9]\d*)$/;
const MAX_EVENT_STREAM_BUFFER_BYTES = 4 * 1024 * 1024;
const STORAGE_FAILED = "Checkpoint storage failed; restart this host";

/** Formats a push event as one server-sent event. */
function eventFrame(event: PushEvent): string {
  switch (event.type) {
    case "commits": return `event: commits\nid: ${event.last}\ndata: ${JSON.stringify(event.commits)}\n\n`;
    case "presence": return `event: presence\ndata: ${JSON.stringify({ clientId: event.clientId, state: event.state })}\n\n`;
    case "gap": return "event: gap\ndata: null\n\n";
    default: return ": ping\n\n";
  }
}

const toResponse = ({ status, body }: Reply): Response =>
  body === undefined ? new Response(null, { status, headers: { "Cache-Control": "no-store" } }) : json(status, body);

/**
 * A Fetch API handler for the routes `createHttpTransport` uses, which also serves sockets for
 * `createWebSocketTransport` through `accept`. It matches the last path segment, so mount it under
 * any prefix. It does not authenticate: use `authorize` to bind requests to writers.
 */
export function createSyncHandler<S extends SchemaShape>(
  schema: DocumentSchema<S>,
  server: ServerDocument<S>,
  options: SyncHandlerOptions<S> = {}
): SyncHandler {
  const maxBodySize = integerOption(options.maxBodySize ?? 1024 * 1024, "maxBodySize", 0);
  const heartbeatInterval = integerOption(options.heartbeatInterval ?? 15_000, "heartbeatInterval", 0);
  const maxEventStreams = integerOption(options.maxEventStreams ?? 1000, "maxEventStreams", 0);
  const presenceTtl = options.presence === undefined ? 0 : integerOption(options.presence.ttl ?? 30_000, "presence.ttl", 1);
  /** Writers' current presence, in memory only, with the socket that sent it, if any. */
  const presence = new Map<string, { readonly state: JsonValue; readonly owner: object | undefined; expiresAt: number }>();
  let sweeper: ReturnType<typeof setInterval> | undefined;
  const encoder = new TextEncoder();
  /** Open event streams and subscribed sockets. */
  const subscribers = new Set<Subscriber>();
  const sockets = new Set<{ fail(): void }>();
  let failed = false;
  // Writes, their saves and every read of commits run one at a time, so no unsaved commit is served.
  let queue: Promise<unknown> = Promise.resolve();

  function serialize<T>(work: () => Promise<T> | T): Promise<T> {
    const result = queue.then(work);
    queue = result.catch(() => {});
    return result;
  }
  async function saved(): Promise<boolean> {
    try { await options.saveCheckpoint?.(server.checkpoint()); return true; }
    catch {
      failed = true;
      for (const subscriber of [...subscribers]) subscriber.close();
      for (const socket of [...sockets]) socket.fail();
      return false;
    }
  }
  /** Sends `subscriber` the saved commits it has not received; runs inside the queue. */
  function deliver(subscriber: Subscriber): void {
    const commits = server.commitsSince(subscriber.sent);
    if (commits === null) { subscriber.push({ type: "gap" }); subscriber.close(); return; }
    const last = commits.at(-1);
    if (last === undefined) return;
    if (subscriber.push({ type: "commits", commits, last: last.serverSeq })) subscriber.sent = last.serverSeq;
    // Finish after the queued frames so the client can catch up from what it received.
    else subscriber.close();
  }
  function broadcast(): void {
    for (const subscriber of [...subscribers]) deliver(subscriber);
  }
  function broadcastPresence(clientId: string, state: JsonValue | null): void {
    for (const subscriber of [...subscribers]) {
      if (!subscriber.push({ type: "presence", clientId, state })) subscriber.close();
    }
  }
  /** Removes expired states; runs only while some exist. */
  function sweep(): void {
    const now = Date.now();
    for (const [clientId, entry] of [...presence]) {
      if (entry.expiresAt > now) continue;
      presence.delete(clientId);
      broadcastPresence(clientId, null);
    }
    if (presence.size === 0 && sweeper !== undefined) { clearInterval(sweeper); sweeper = undefined; }
  }
  function setPresence(clientId: string, state: JsonValue | null, owner?: object): void {
    const previous = presence.get(clientId);
    if (state === null) {
      if (previous === undefined) return;
      presence.delete(clientId);
      broadcastPresence(clientId, null);
    } else {
      presence.set(clientId, { state, owner, expiresAt: Date.now() + presenceTtl });
      // A re-send of the same state only extends it.
      if (previous === undefined || !jsonEquals(previous.state, state)) broadcastPresence(clientId, state);
    }
    if (presence.size > 0 && sweeper === undefined) {
      sweeper = setInterval(sweep, Math.max(1, Math.floor(presenceTtl / 3)));
      // Presence alone must not keep a Node.js process alive.
      if (typeof sweeper === "object" && "unref" in sweeper) sweeper.unref();
    } else if (presence.size === 0 && sweeper !== undefined) { clearInterval(sweeper); sweeper = undefined; }
  }

  const core: SyncCore = {
    maxMessageSize: maxBodySize,
    heartbeatInterval,
    maxBufferedBytes: MAX_EVENT_STREAM_BUFFER_BYTES,
    rejections: options.allowRejections === true,
    presence: options.presence !== undefined,
    get failed() { return failed; },
    allow(request) {
      const { authorize } = options;
      return async (action, clientId) => authorize === undefined ||
        await authorize(request, clientId === undefined ? { action } : { action, clientId });
    },
    async register(allowed) {
      if (!(await allowed("register"))) return failure(403, "Forbidden");
      return serialize(async () => {
        if (failed) return failure(503, STORAGE_FAILED);
        let clientId: string;
        try { clientId = server.openClient(); } catch { return failure(409, "Client session could not be opened"); }
        if (!(await saved())) return failure(500, "Checkpoint could not be saved");
        return { status: 201, body: { clientId, snapshot: server.snapshot() } };
      });
    },
    async write(kind, input, allowed) {
      let batch: ClientBatch<DocumentOperation<S>>;
      try { batch = decodeClientBatch(schema, input); } catch { return failure(400, "Invalid batch"); }
      if (!(await allowed(kind, batch.clientId))) return failure(403, "Forbidden");
      return serialize(async () => {
        if (failed) return failure(503, STORAGE_FAILED);
        let replayed: boolean;
        try { ({ replayed } = kind === "reject" ? server.reject(batch) : server.receive(batch)); }
        catch { return failure(409, "Batch could not be applied"); }
        if (!replayed) {
          if (!(await saved())) return failure(500, "Checkpoint could not be saved");
          broadcast(); // Still inside the queue: only saved commits are pushed.
        }
        // Acceptance is not an acknowledgement: the writer confirms it through catch-up.
        return { status: 204 };
      });
    },
    async catchUp(watermark, allowed) {
      if (!(await allowed("catchUp"))) return failure(403, "Forbidden");
      return serialize(() => {
        if (failed) return failure(503, STORAGE_FAILED);
        // Read inside the queue: a write that is still saving cannot have its commit served.
        try { return { status: 200, body: server.commitsSince(watermark) }; }
        catch { return failure(400, "Invalid catch-up watermark"); }
      });
    },
    async publish(clientId, state, allowed, owner) {
      if (state !== null) {
        try {
          validateJsonValue(state, ["state"]);
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- validateJsonValue has just accepted it as JSON.
          checkPayload(options.presence?.schema, state as JsonValue, ["state"]);
        } catch { return failure(400, "Invalid presence state"); }
      }
      if (!(await allowed("presence", clientId))) return failure(403, "Forbidden");
      if (!server.listClients().some((session) => session.clientId === clientId)) return failure(409, "Unknown client session");
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Checked to be JSON above.
      setPresence(clientId, state as JsonValue | null, owner);
      return { status: 204 };
    },
    async subscribe(watermark, allowed, create) {
      if (!(await allowed("catchUp"))) return failure(403, "Forbidden");
      return serialize(() => {
        if (failed) return failure(503, STORAGE_FAILED);
        // Admission and creation share this queue, so concurrent subscribes cannot exceed the limit.
        if (subscribers.size >= maxEventStreams) return failure(503, "Too many event streams");
        try { server.commitsSince(watermark); } catch { return failure(400, "Invalid catch-up watermark"); }
        const subscriber = create();
        if (subscriber.closed) return undefined;
        subscribers.add(subscriber);
        // Commits already saved past the watermark go first; an uncovered watermark ends the subscription.
        deliver(subscriber);
        // Then everyone's current presence, which the client rebuilds from on every new subscription.
        for (const [clientId, { state }] of presence) {
          if (subscriber.closed) break;
          if (!subscriber.push({ type: "presence", clientId, state })) subscriber.close();
        }
        return undefined;
      });
    },
    drop(subscriber) { subscribers.delete(subscriber); },
    release(owner) {
      for (const [clientId, entry] of [...presence]) if (entry.owner === owner) setPresence(clientId, null);
    },
    track(socket) {
      sockets.add(socket);
      return () => { sockets.delete(socket); };
    },
  };

  /** Opens an event stream as a subscriber; the response, or the reason it was refused. */
  async function openStream(request: Request, watermark: number, allowed: Allow): Promise<Response> {
    let response: Response | undefined;
    const refused = await core.subscribe(watermark, allowed, () => {
      let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
      const body = new ReadableStream<Uint8Array>({
        start(started) { controller = started; },
        cancel() { stream.close(); },
      }, new ByteLengthQueuingStrategy({ highWaterMark: MAX_EVENT_STREAM_BUFFER_BYTES }));
      let open = true;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      const send = (text: string): boolean => {
        const remaining = controller?.desiredSize ?? null;
        // UTF-16 length is a lower bound on UTF-8 bytes, so skip encoding if already too large.
        if (!open || remaining === null || text.length > remaining) return false;
        try {
          const bytes = encoder.encode(text);
          if (bytes.byteLength > remaining) return false;
          controller?.enqueue(bytes);
          return true;
        } catch {
          stream.close();
          return false;
        }
      };
      const stream: Subscriber = {
        sent: watermark,
        get closed() { return !open; },
        push: (event) => send(eventFrame(event)),
        close() {
          if (!open) return;
          open = false;
          subscribers.delete(stream);
          if (heartbeat !== undefined) clearInterval(heartbeat);
          request.signal.removeEventListener("abort", onAbort);
          try { controller?.close(); } catch { /* The reader already went away. */ }
        },
      };
      const onAbort = (): void => { stream.close(); };
      request.signal.addEventListener("abort", onAbort);
      response = new Response(body, { status: 200, headers: {
        "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no",
      } });
      // Abort may have happened before authorization or while waiting in the queue.
      if (request.signal.aborted) stream.close();
      else if (heartbeatInterval > 0) heartbeat = setInterval(() => { send(eventFrame({ type: "ping" })); }, heartbeatInterval);
      return stream;
    });
    return refused === undefined && response !== undefined ? response : toResponse(refused ?? failure(500, "Internal server error"));
  }

  async function handle(request: Request): Promise<Response> {
    if (failed) return error(503, STORAGE_FAILED);
    const url = new URL(request.url);
    const route = url.pathname.slice(url.pathname.lastIndexOf("/") + 1);
    const method = routeMethod(route);
    if (method === undefined || (route === "rejections" && options.allowRejections !== true) ||
      (route === "presence" && options.presence === undefined)) {
      return error(404, "Unknown route");
    }
    if (request.method !== method) return error(405, "Method not allowed", { Allow: method });
    const allowed = core.allow(request);

    if (route === "commits" || route === "events") {
      const since = url.searchParams.getAll("since");
      if (since.length !== 1 || !WATERMARK.test(since[0]!)) return error(400, "Expected one non-negative decimal watermark");
      let watermark = Number(since[0]);
      // A reconnecting EventSource resumes after the last event it received.
      const resumed = request.headers.get("last-event-id");
      if (route === "events" && resumed !== null && WATERMARK.test(resumed)) watermark = Math.max(watermark, Number(resumed));
      if (!Number.isSafeInteger(watermark)) return error(400, "Invalid catch-up watermark");
      return route === "commits" ? toResponse(await core.catchUp(watermark, allowed)) : openStream(request, watermark, allowed);
    }

    if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
      return error(415, "Expected application/json");
    }
    const message = await readBody(request, maxBodySize);
    if (message === null) return error(413, `Body exceeds ${maxBodySize} bytes`, { Connection: "close" });
    let input: unknown;
    try { input = JSON.parse(message); } catch { return error(400, "Invalid JSON"); }

    if (route === "presence") {
      if (input === null || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== 2 ||
        !("clientId" in input) || typeof input.clientId !== "string" || !("state" in input)) {
        return error(400, "Expected { clientId, state }");
      }
      return toResponse(await core.publish(input.clientId, input.state, allowed));
    }
    if (route === "clients") {
      if (input === null || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== 0) {
        return error(400, "Expected an empty registration object");
      }
      return toResponse(await core.register(allowed));
    }
    return toResponse(await core.write(route === "rejections" ? "reject" : "submit", input, allowed));
  }

  const handler = async (request: Request): Promise<Response> => {
    try { return await handle(request); }
    catch { return error(500, "Internal server error"); }
  };
  return Object.assign(handler, {
    accept: (socket: SyncSocket, request: Request) => acceptSocket(core, socket, request),
    notify: () => serialize(() => {
      if (!failed) { broadcast(); return; }
      for (const subscriber of [...subscribers]) subscriber.close();
    }),
  });
}
