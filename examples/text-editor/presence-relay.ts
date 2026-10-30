import type { IncomingMessage, ServerResponse } from "node:http";
import { decodeCursor, type Cursor } from "../../src/index.ts";

const BODY_LIMIT = 4 * 1024;
const ENTRY_LIMIT = 64;
const CLIENT_ID_LIMIT = 128;
/** Writers republish at least this often, so entries from closed pages disappear. */
const ENTRY_TTL = 15_000;

interface PresenceEntry {
  readonly clientId: string;
  readonly seq: number;
  readonly selection: { readonly from: Cursor; readonly to: Cursor } | null;
}

function json(response: ServerResponse, status: number, value: unknown): void {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(value));
}

async function readBody(request: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- IncomingMessage emits Buffers here: no string encoding is configured.
    const bytes: Buffer = chunk as Buffer;
    size += bytes.length;
    if (size > BODY_LIMIT) return null;
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, size).toString("utf8");
}

function record(input: unknown, fields: readonly string[]): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new Error("Expected an object");
  const keys = Object.keys(input);
  if (keys.length !== fields.length || !fields.every((field) => keys.includes(field))) throw new Error("Unexpected fields");
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Checked to be a plain object with exactly these fields.
  return input as Record<string, unknown>;
}

function decodePresence(input: unknown): Omit<PresenceEntry, "seq"> {
  const { clientId, selection } = record(input, ["clientId", "selection"]);
  if (typeof clientId !== "string" || clientId.length === 0 || clientId.length > CLIENT_ID_LIMIT) {
    throw new Error("Invalid client ID");
  }
  if (selection === null) return { clientId, selection };
  const { from, to } = record(selection, ["from", "to"]);
  return { clientId, selection: { from: decodeCursor(from), to: decodeCursor(to) } };
}

/**
 * Example-only in-memory relay for cursor presence. It keeps the latest selection per client for 15 seconds
 * and is not saved, authenticated or tied to open writer sessions: any caller can claim any client ID.
 */
export function createPresenceRelay(options: { readonly now?: () => number } = {}) {
  const now = options.now ?? Date.now;
  const entries = new Map<string, { readonly entry: PresenceEntry; readonly updatedAt: number }>();
  let seq = 0;

  async function receive(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
      request.resume();
      json(response, 415, { error: "Expected application/json" });
      return;
    }
    const message = await readBody(request);
    if (message === null) {
      request.resume();
      response.setHeader("Connection", "close");
      json(response, 413, { error: "Presence body exceeds 4 KiB" });
      return;
    }
    let presence: Omit<PresenceEntry, "seq">;
    try { presence = decodePresence(JSON.parse(message)); }
    catch { json(response, 400, { error: "Invalid presence JSON or cursor" }); return; }
    entries.delete(presence.clientId); // Re-insert so iteration order is least recently updated first.
    entries.set(presence.clientId, { entry: Object.freeze({ ...presence, seq: ++seq }), updatedAt: now() });
    for (const clientId of entries.keys()) {
      if (entries.size <= ENTRY_LIMIT) break;
      entries.delete(clientId);
    }
    response.writeHead(204, { "Cache-Control": "no-store" });
    response.end();
  }

  return {
    /** Handles `/presence` and returns true, or returns false for every other route. */
    handle(request: IncomingMessage, response: ServerResponse): boolean {
      if (new URL(request.url ?? "/", "http://127.0.0.1").pathname !== "/presence") return false;
      if (request.method === "GET") {
        const cutoff = now() - ENTRY_TTL;
        for (const [clientId, { updatedAt }] of entries) if (updatedAt < cutoff) entries.delete(clientId);
        json(response, 200, { entries: [...entries.values()].map(({ entry }) => entry) });
      } else if (request.method === "POST") {
        void receive(request, response).catch(() => {
          request.resume();
          if (response.headersSent) response.destroy();
          else json(response, 500, { error: "Internal server error" });
        });
      } else {
        request.resume();
        response.setHeader("Allow", "GET, POST");
        json(response, 405, { error: "Method not allowed" });
      }
      return true;
    },
  };
}
