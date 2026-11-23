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
  /** Maximum request body size in bytes. Default 1 MiB. */
  readonly maxBodySize?: number;
  /** Milliseconds between heartbeat comments on event streams. Default 15000. */
  readonly heartbeatInterval?: number;
  /** Maximum open event streams; more are answered with 503. Default 1000. */
  readonly maxEventStreams?: number;
  /**
   * Enables `POST presence`: writers' ephemeral states, kept in memory only and pushed to every
   * event stream as `presence` events until they are cleared or expire.
   */
  readonly presence?: SyncHandlerPresenceOptions;
}

/** A Fetch API handler that can also push commits made outside it to open event streams. */
export interface SyncHandler {
  (request: Request): Promise<Response>;
  /**
   * Sends commits that were applied to the server without this handler, such as by a direct
   * `server.receive()`, to open event streams. Call it after those commits are saved.
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

interface EventStream {
  /** The last server sequence queued for delivery. */
  sent: number;
  send(text: string): boolean;
  close(): void;
}

/**
 * A Fetch API handler for the routes `createHttpTransport` uses. It matches the last path segment,
 * so mount it under any prefix. It does not authenticate: use `authorize` to bind requests to writers.
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
  /** Writers' current presence, in memory only. */
  const presence = new Map<string, { readonly state: JsonValue; expiresAt: number }>();
  let sweeper: ReturnType<typeof setInterval> | undefined;
  const encoder = new TextEncoder();
  const streams = new Set<EventStream>();
  let failed = false;
  // Writes, their saves and every read of commits run one at a time, so no unsaved commit is served.
  let queue: Promise<unknown> = Promise.resolve();

  function serialize<T>(work: () => Promise<T> | T): Promise<T> {
    const result = queue.then(work);
    queue = result.catch(() => {});
    return result;
  }
  function closeStreams(): void {
    for (const stream of [...streams]) stream.close();
  }
  async function saved(): Promise<boolean> {
    try { await options.saveCheckpoint?.(server.checkpoint()); return true; }
    catch { failed = true; closeStreams(); return false; }
  }
  /** Sends each stream the saved commits it has not sent; runs inside the queue. */
  function broadcast(): void {
    for (const stream of [...streams]) {
      const commits = server.commitsSince(stream.sent);
      if (commits === null) { stream.send("event: gap\ndata: null\n\n"); stream.close(); continue; }
      const last = commits.at(-1);
      if (last === undefined) continue;
      if (stream.send(`event: commits\nid: ${last.serverSeq}\ndata: ${JSON.stringify(commits)}\n\n`)) {
        stream.sent = last.serverSeq;
      } else {
        // Finish after the queued frames so the client can catch up from what it received.
        stream.close();
      }
    }
  }
  const presenceFrame = (clientId: string, state: JsonValue | null) =>
    `event: presence\ndata: ${JSON.stringify({ clientId, state })}\n\n`;
  function broadcastPresence(clientId: string, state: JsonValue | null): void {
    const frame = presenceFrame(clientId, state);
    for (const stream of [...streams]) if (!stream.send(frame)) stream.close();
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
  function setPresence(clientId: string, state: JsonValue | null): void {
    const previous = presence.get(clientId);
    if (state === null) {
      if (previous === undefined) return;
      presence.delete(clientId);
      broadcastPresence(clientId, null);
    } else {
      presence.set(clientId, { state, expiresAt: Date.now() + presenceTtl });
      // A re-send of the same state only extends it.
      if (previous === undefined || !jsonEquals(previous.state, state)) broadcastPresence(clientId, state);
    }
    if (presence.size > 0 && sweeper === undefined) {
      sweeper = setInterval(sweep, Math.max(1, Math.floor(presenceTtl / 3)));
      // Presence alone must not keep a Node.js process alive.
      if (typeof sweeper === "object" && "unref" in sweeper) sweeper.unref();
    } else if (presence.size === 0 && sweeper !== undefined) { clearInterval(sweeper); sweeper = undefined; }
  }

  async function allowed(request: Request, action: SyncAction, clientId?: string): Promise<boolean> {
    if (options.authorize === undefined) return true;
    return await options.authorize(request, clientId === undefined ? { action } : { action, clientId });
  }

  function openStream(request: Request, watermark: number): Response {
    let stream: EventStream | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        let open = true;
        const close = (): void => {
          if (!open) return;
          open = false;
          if (stream !== undefined) streams.delete(stream);
          if (heartbeat !== undefined) clearInterval(heartbeat);
          request.signal.removeEventListener("abort", close);
          try { controller.close(); } catch { /* The reader already went away. */ }
        };
        const send = (text: string): boolean => {
          const remaining = controller.desiredSize;
          // UTF-16 length is a lower bound on UTF-8 bytes, so skip encoding if already too large.
          if (!open || remaining === null || text.length > remaining) return false;
          try {
            const bytes = encoder.encode(text);
            if (bytes.byteLength > remaining) return false;
            controller.enqueue(bytes);
            return true;
          } catch {
            close();
            return false;
          }
        };
        stream = { sent: watermark, send, close };
        streams.add(stream);
        request.signal.addEventListener("abort", close);
        // Abort may have happened before authorization or while waiting in the queue.
        if (request.signal.aborted) { close(); return; }
        if (heartbeatInterval > 0) heartbeat = setInterval(() => { send(": ping\n\n"); }, heartbeatInterval);
      },
      cancel() { stream?.close(); },
    }, new ByteLengthQueuingStrategy({ highWaterMark: MAX_EVENT_STREAM_BUFFER_BYTES }));
    // Commits already saved past the watermark go first; an uncovered watermark ends the stream.
    broadcast();
    // Then everyone's current presence, which the client rebuilds from on every new stream.
    for (const [clientId, { state }] of presence) {
      if (stream !== undefined && !stream.send(presenceFrame(clientId, state))) { stream.close(); break; }
    }
    return new Response(body, { status: 200, headers: {
      "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no",
    } });
  }

  async function handle(request: Request): Promise<Response> {
    if (failed) return error(503, "Checkpoint storage failed; restart this host");
    const url = new URL(request.url);
    const route = url.pathname.slice(url.pathname.lastIndexOf("/") + 1);
    const method = routeMethod(route);
    if (method === undefined || (route === "rejections" && options.allowRejections !== true) ||
      (route === "presence" && options.presence === undefined)) {
      return error(404, "Unknown route");
    }
    if (request.method !== method) return error(405, "Method not allowed", { Allow: method });

    if (route === "commits" || route === "events") {
      const since = url.searchParams.getAll("since");
      if (since.length !== 1 || !WATERMARK.test(since[0]!)) return error(400, "Expected one non-negative decimal watermark");
      let watermark = Number(since[0]);
      // A reconnecting EventSource resumes after the last event it received.
      const resumed = request.headers.get("last-event-id");
      if (route === "events" && resumed !== null && WATERMARK.test(resumed)) watermark = Math.max(watermark, Number(resumed));
      if (!Number.isSafeInteger(watermark)) return error(400, "Invalid catch-up watermark");
      if (!(await allowed(request, "catchUp"))) return error(403, "Forbidden");
      return serialize(() => {
        if (failed) return error(503, "Checkpoint storage failed; restart this host");
        // Admission and stream creation share this queue, so concurrent requests cannot exceed the limit.
        if (route === "events" && streams.size >= maxEventStreams) return error(503, "Too many event streams");
        // Read inside the queue: a write that is still saving cannot have its commit served.
        let commits: ReturnType<typeof server.commitsSince>;
        try { commits = server.commitsSince(watermark); } catch { return error(400, "Invalid catch-up watermark"); }
        return route === "commits" ? json(200, commits) : openStream(request, watermark);
      });
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
      const { clientId } = input;
      const state = input.state;
      if (state !== null) {
        try {
          validateJsonValue(state, ["state"]);
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- validateJsonValue has just accepted it as JSON.
          checkPayload(options.presence?.schema, state as JsonValue, ["state"]);
        } catch { return error(400, "Invalid presence state"); }
      }
      if (!(await allowed(request, "presence", clientId))) return error(403, "Forbidden");
      if (!server.listClients().some((session) => session.clientId === clientId)) return error(409, "Unknown client session");
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Checked to be JSON above.
      setPresence(clientId, state as JsonValue | null);
      return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
    }

    if (route === "clients") {
      if (input === null || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== 0) {
        return error(400, "Expected an empty registration object");
      }
      if (!(await allowed(request, "register"))) return error(403, "Forbidden");
      return serialize(async () => {
        if (failed) return error(503, "Checkpoint storage failed; restart this host");
        let clientId: string;
        try { clientId = server.openClient(); } catch { return error(409, "Client session could not be opened"); }
        if (!(await saved())) return error(500, "Checkpoint could not be saved");
        return json(201, { clientId, snapshot: server.snapshot() });
      });
    }

    let batch: ClientBatch<DocumentOperation<S>>;
    try { batch = decodeClientBatch(schema, input); } catch { return error(400, "Invalid batch"); }
    const reject = route === "rejections";
    if (!(await allowed(request, reject ? "reject" : "submit", batch.clientId))) return error(403, "Forbidden");
    return serialize(async () => {
      if (failed) return error(503, "Checkpoint storage failed; restart this host");
      let replayed: boolean;
      try { ({ replayed } = reject ? server.reject(batch) : server.receive(batch)); }
      catch { return error(409, "Batch could not be applied"); }
      if (!replayed) {
        if (!(await saved())) return error(500, "Checkpoint could not be saved");
        broadcast(); // Still inside the queue: only saved commits are pushed.
      }
      // Acceptance is not an acknowledgement: the writer confirms it through catch-up.
      return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
    });
  }

  const handler = async (request: Request): Promise<Response> => {
    try { return await handle(request); }
    catch { return error(500, "Internal server error"); }
  };
  return Object.assign(handler, {
    notify: () => serialize(() => { if (failed) closeStreams(); else broadcast(); }),
  });
}
