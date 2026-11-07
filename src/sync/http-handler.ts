import {
  decodeClientBatch,
  type ClientBatch,
  type DocumentOperation,
  type DocumentSchema,
  type SchemaShape,
  type ServerCheckpoint,
  type ServerDocument,
} from "../index.ts";

export type SyncAction = "register" | "submit" | "reject" | "catchUp";

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
  readonly bodyLimit?: number;
  /** Milliseconds between heartbeat comments on event streams. Default 15000. */
  readonly heartbeatInterval?: number;
  /** Maximum open event streams; more are answered with 503. Default 1000. */
  readonly maxEventStreams?: number;
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
    case "clients": case "batches": case "rejections": return "POST";
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

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative safe integer`);
  return value;
}

interface EventStream {
  /** The last server sequence this stream has sent. */
  sent: number;
  send(text: string): void;
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
  const bodyLimit = nonNegativeInteger(options.bodyLimit ?? 1024 * 1024, "bodyLimit");
  const heartbeatInterval = nonNegativeInteger(options.heartbeatInterval ?? 15_000, "heartbeatInterval");
  const maxEventStreams = nonNegativeInteger(options.maxEventStreams ?? 1000, "maxEventStreams");
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
      stream.send(`event: commits\nid: ${last.serverSeq}\ndata: ${JSON.stringify(commits)}\n\n`);
      stream.sent = last.serverSeq;
    }
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
        const send = (text: string): void => {
          if (!open) return;
          try { controller.enqueue(encoder.encode(text)); } catch { close(); }
        };
        stream = { sent: watermark, send, close };
        streams.add(stream);
        request.signal.addEventListener("abort", close);
        if (heartbeatInterval > 0) heartbeat = setInterval(() => { send(": ping\n\n"); }, heartbeatInterval);
      },
      cancel() { stream?.close(); },
    });
    // Commits already saved past the watermark go first; an uncovered watermark ends the stream.
    broadcast();
    return new Response(body, { status: 200, headers: {
      "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no",
    } });
  }

  async function handle(request: Request): Promise<Response> {
    if (failed) return error(503, "Checkpoint storage failed; restart this host");
    const url = new URL(request.url);
    const route = url.pathname.slice(url.pathname.lastIndexOf("/") + 1);
    const method = routeMethod(route);
    if (method === undefined || (route === "rejections" && options.allowRejections !== true)) {
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
      if (route === "events" && streams.size >= maxEventStreams) return error(503, "Too many event streams");
      return serialize(() => {
        if (failed) return error(503, "Checkpoint storage failed; restart this host");
        // Read inside the queue: a write that is still saving cannot have its commit served.
        let commits: ReturnType<typeof server.commitsSince>;
        try { commits = server.commitsSince(watermark); } catch { return error(400, "Invalid catch-up watermark"); }
        return route === "commits" ? json(200, commits) : openStream(request, watermark);
      });
    }

    if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
      return error(415, "Expected application/json");
    }
    const message = await readBody(request, bodyLimit);
    if (message === null) return error(413, `Body exceeds ${bodyLimit} bytes`, { Connection: "close" });
    let input: unknown;
    try { input = JSON.parse(message); } catch { return error(400, "Invalid JSON"); }

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
