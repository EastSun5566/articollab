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
}

function routeMethod(route: string): "GET" | "POST" | undefined {
  switch (route) {
    case "clients": case "batches": case "rejections": return "POST";
    case "commits": return "GET";
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

/**
 * A Fetch API handler for the routes `createHttpTransport` uses. It matches the last path segment,
 * so mount it under any prefix. It does not authenticate: use `authorize` to bind requests to writers.
 */
export function createSyncHandler<S extends SchemaShape>(
  schema: DocumentSchema<S>,
  server: ServerDocument<S>,
  options: SyncHandlerOptions<S> = {}
): (request: Request) => Promise<Response> {
  const bodyLimit = options.bodyLimit ?? 1024 * 1024;
  if (!Number.isSafeInteger(bodyLimit) || bodyLimit < 0) throw new TypeError("bodyLimit must be a non-negative safe integer");
  let failed = false;
  // Writes and their saves run one at a time; catch-up waits for them so no unsaved commit is served.
  let writes: Promise<unknown> = Promise.resolve();

  function serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = writes.then(work);
    writes = result.catch(() => {});
    return result;
  }
  async function saved(): Promise<boolean> {
    try { await options.saveCheckpoint?.(server.checkpoint()); return true; }
    catch { failed = true; return false; }
  }
  async function allowed(request: Request, action: SyncAction, clientId?: string): Promise<boolean> {
    if (options.authorize === undefined) return true;
    return await options.authorize(request, clientId === undefined ? { action } : { action, clientId });
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

    if (route === "commits") {
      const since = url.searchParams.getAll("since");
      if (since.length !== 1 || !/^(0|[1-9]\d*)$/.test(since[0]!)) return error(400, "Expected one non-negative decimal watermark");
      const watermark = Number(since[0]);
      if (!(await allowed(request, "catchUp"))) return error(403, "Forbidden");
      await writes; // Never serve a commit before its checkpoint is saved.
      if (failed) return error(503, "Checkpoint storage failed; restart this host");
      if (!Number.isSafeInteger(watermark) || watermark > server.snapshot().serverSeq) return error(400, "Invalid catch-up watermark");
      return json(200, server.commitsSince(watermark));
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
      if (!replayed && !(await saved())) return error(500, "Checkpoint could not be saved");
      // Acceptance is not an acknowledgement: the writer confirms it through catch-up.
      return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
    });
  }

  return async (request) => {
    try { return await handle(request); }
    catch { return error(500, "Internal server error"); }
  };
}
