import assert from "node:assert/strict";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";

import {
  createClient,
  createServer,
  decodeClientBatch,
  decodeClientCheckpoint,
  decodeServerCommit,
  decodeSnapshot,
  type ClientBatch,
  type ClientCheckpoint,
  type DocumentOperation,
  type ServerCheckpoint,
  type ServerDocument,
} from "../src/index.ts";
import { Board } from "./resume.ts";

type Shape = typeof Board.definition;
type Batch = ClientBatch<DocumentOperation<Shape>>;
const BODY_LIMIT = 1024 * 1024;

function json(response: ServerResponse, status: number, value: unknown): void {
  if (response.destroyed || response.writableEnded) return;
  const message = JSON.stringify(value);
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(message);
}

async function readBody(request: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  // Keep the socket alive on early exit so the caller can finish a 413 response.
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    const bytes: Buffer = chunk;
    size += bytes.length;
    if (size > BODY_LIMIT) return null;
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, size).toString("utf8");
}

/** Example-only localhost HTTP routes for one Board, without subscriptions. */
export async function startHttpExampleServer(
  server: ServerDocument<Shape>,
  options: { readonly saveServerCheckpoint?: (checkpoint: ServerCheckpoint<Shape>) => undefined } = {}
) {
  options.saveServerCheckpoint?.(server.checkpoint()); // Bootstrap before opening a socket.
  let failed = false;
  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    function reject(status: number, message: string): void {
      request.resume(); // Discard unread bodies without buffering them.
      json(response, status, { error: message });
    }

    if (failed) { reject(503, "Checkpoint storage failed; restart this host"); return; }

    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const method = url.pathname === "/batches" ? "POST" : "GET";
    if (!["/snapshot", "/batches", "/commits"].includes(url.pathname)) {
      reject(404, "Unknown route");
      return;
    }
    if (request.method !== method) {
      response.setHeader("Allow", method);
      reject(405, "Method not allowed");
      return;
    }
    if (url.pathname === "/snapshot") {
      json(response, 200, server.snapshot());
      return;
    }
    if (url.pathname === "/commits") {
      const since = url.searchParams.getAll("since");
      if (since.length !== 1 || !/^(0|[1-9]\d*)$/.test(since[0]!)) {
        reject(400, "Expected one non-negative decimal watermark");
        return;
      }
      const watermark = Number(since[0]);
      if (!Number.isSafeInteger(watermark) || watermark > server.snapshot().serverSeq) {
        reject(400, "Invalid catch-up watermark");
        return;
      }
      json(response, 200, server.commitsSince(watermark));
      return;
    }
    if (request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
      reject(415, "Expected application/json");
      return;
    }
    const message = await readBody(request);
    // A different request may have failed to save while this body was arriving.
    if (failed) { reject(503, "Checkpoint storage failed; restart this host"); return; }
    if (message === null) {
      response.setHeader("Connection", "close");
      reject(413, "Batch body exceeds 1 MiB");
      return;
    }
    let batch: Batch;
    try {
      batch = decodeClientBatch(Board, JSON.parse(message));
    } catch {
      reject(400, "Invalid batch JSON or wire data");
      return;
    }
    let replayed: boolean;
    try {
      ({ replayed } = server.receive(batch)); // Total order is this synchronous call order, not request arrival.
    } catch {
      reject(409, "Batch could not be applied");
      return;
    }
    if (!replayed) {
      try {
        options.saveServerCheckpoint?.(server.checkpoint());
      } catch {
        failed = true; // The advanced in-memory server must never be served again.
        reject(500, "Checkpoint could not be saved");
        return;
      }
    }
    response.writeHead(204, { "Cache-Control": "no-store" });
    response.end(); // Submission success is not a client acknowledgement.
  }

  const http = createHttpServer((request, response) => {
    void handle(request, response).catch(() => {
      request.resume();
      if (response.headersSent) response.destroy();
      else json(response, 500, { error: "Internal server error" });
    });
  });
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(0, "127.0.0.1", () => { http.off("error", reject); resolve(); });
  });
  const address = http.address();
  assert.ok(address !== null && typeof address !== "string");
  let closing: Promise<void> | undefined;
  return {
    url: "http://127.0.0.1:" + address.port,
    close(): Promise<void> {
      return closing ??= new Promise<void>((resolve, reject) => {
        http.close((error) => { if (error) reject(error); else resolve(); });
        http.closeAllConnections(); // Close only this host's sockets, including incomplete requests.
      });
    },
  };
}

/** Example-only manual sync. The client knows only a URL, never a server object. */
export async function connectHttpExampleClient(
  url: string,
  clientId: string,
  options: {
    readonly fetch?: typeof globalThis.fetch;
    readonly checkpoint?: ClientCheckpoint<Shape>;
    readonly saveClientCheckpoint?: (checkpoint: ClientCheckpoint<Shape>) => undefined;
  } = {}
) {
  const fetch = options.fetch ?? globalThis.fetch;
  let failed = false;
  let failure: unknown;
  function requireUsable(): void { if (failed) throw failure; }
  function stop(error: unknown): void {
    if (!failed) { failed = true; failure = error; }
  }
  async function request(path: string, status: number, init?: RequestInit): Promise<string> {
    requireUsable();
    const response = await fetch(new URL(path, url), init);
    const message = await response.text(); // Consume error responses as well as successful ones.
    requireUsable(); // Local saving may have failed while the request was in flight.
    if (response.status !== status) throw new Error("Unexpected HTTP status: " + response.status);
    return message;
  }
  // Restore before making any request; only fresh clients fetch a snapshot.
  const initial = options.checkpoint === undefined
    ? { snapshot: decodeSnapshot(Board, JSON.parse(await request("/snapshot", 200))) }
    : { checkpoint: options.checkpoint };
  let busy = false;
  let missingHistory = false;
  const doc = createClient(Board, {
    clientId,
    ...initial,
    onBatch() { saveClient(); }, // Pending is already present; save without automatically sending.
  });
  function saveClient(): void {
    requireUsable();
    try { options.saveClientCheckpoint?.(doc.checkpoint()); }
    catch (error) { stop(error); throw failure; }
  }
  saveClient(); // Fresh and restored documents are saved before returning a handle.

  async function catchUp(): Promise<boolean> {
    const watermark = doc.checkpoint().snapshot.serverSeq;
    const input: unknown = JSON.parse(await request("/commits?since=" + watermark, 200));
    if (input === null) { missingHistory = true; return false; }
    if (!Array.isArray(input)) throw new Error("Expected a commit array or null");
    const commits = input.map((entry: unknown) => decodeServerCommit(Board, entry));
    for (const [index, commit] of commits.entries()) {
      if (commit.serverSeq !== watermark + index + 1) {
        throw new Error("Catch-up commits must be consecutive and ordered");
      }
    }
    // Validate the whole prefix first; never sort, skip, or repair a response.
    for (const commit of commits) {
      requireUsable();
      doc.receive(commit);
      saveClient(); // Own acknowledgements need not emit a change.
    }
    return true;
  }

  return {
    doc,
    async sync(): Promise<boolean> {
      requireUsable();
      if (busy) throw new Error("Cannot call sync() concurrently or reentrantly");
      if (missingHistory) return false;
      busy = true;
      try {
        if (!(await catchUp())) return false;
        while (true) {
          requireUsable();
          const batch = doc.checkpoint().pendingBatches[0];
          if (batch === undefined) return true;
          await request("/batches", 204, {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(batch),
          });
          if (!(await catchUp())) return false;
          if (doc.checkpoint().pendingBatches[0]?.seq === batch.seq) {
            throw new Error("Submission completed without acknowledging the pending batch");
          }
        }
      } catch (error) {
        stop(error);
        throw failure;
      } finally {
        busy = false;
      }
    },
  };
}

async function runDemo(): Promise<void> {
  const server = createServer(Board);
  const host = await startHttpExampleServer(server);
  try {
    const lostResponse = new Error("POST response lost after server acceptance");
    let a = await connectHttpExampleClient(host.url, "a", { fetch: async (input, init) => {
      const response = await fetch(input, init);
      if (init?.method === "POST") { await response.text(); throw lostResponse; }
      return response;
    } });
    const b = await connectHttpExampleClient(host.url, "b");
    a.doc.transact(() => {
      a.doc.state.count.value = 1;
      a.doc.state.items.push("Saved");
      a.doc.state.body.insert(0, "Hello 😀");
    });
    a.doc.state.items.push("Still pending"); // A second batch, not yet submitted.
    b.doc.transact(() => {
      b.doc.state.count.value = 2;
      b.doc.state.items.push("Peer");
      b.doc.state.body.insert(0, "!");
    });
    await assert.rejects(a.sync(), (error: unknown) => error === lostResponse);
    const checkpoint = decodeClientCheckpoint(Board, JSON.parse(JSON.stringify(a.doc.checkpoint())));
    assert.equal(checkpoint.pendingBatches.length, 2);
    // Retire the old writer. Catch-up confirms batch 1 before submitting batch 2.
    a = await connectHttpExampleClient(host.url, "a", { checkpoint });
    assert.equal(await a.sync(), true);
    assert.equal(await b.sync(), true);
    assert.equal(await a.sync(), true); // Poll the peer's update; there is no live broadcast.
    a.doc.transact(() => {
      a.doc.state.count.value = 3;
      a.doc.state.items.push("Reconnected");
      a.doc.state.body.insert(a.doc.state.body.length, "!");
    });
    assert.equal(await a.sync(), true);
    assert.equal(await b.sync(), true);
    for (const { doc } of [a, b]) {
      assert.deepEqual(doc.checkpoint().pendingBatches, []);
      assert.deepEqual(doc.checkpoint().snapshot, server.snapshot());
    }
    console.log({ count: a.doc.state.count.value, items: a.doc.state.items.toArray(),
      body: a.doc.state.body.toString(), serverSeq: server.snapshot().serverSeq });
  } finally {
    await host.close();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runDemo();
}
