import assert from "node:assert/strict";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";

import { createServer, type ServerDocument } from "../src/index.ts";
import { connectSync, createHttpTransport, createSyncHandler } from "../src/sync/index.ts";
import { Board } from "./resume.ts";

type Shape = typeof Board.definition;

/** Example-only bridge from node:http to a Fetch API handler. Frameworks such as Hono do this for you. */
export async function serveFetch(handle: (request: Request) => Promise<Response>, port = 0) {
  const http = createHttpServer((incoming: IncomingMessage, outgoing: ServerResponse) => {
    const hasBody = incoming.method !== "GET" && incoming.method !== "HEAD";
    // A client that disconnects aborts the request, which closes an event stream.
    const disconnected = new AbortController();
    outgoing.once("close", () => { disconnected.abort(); });
    const request = new Request(new URL(incoming.url ?? "/", "http://127.0.0.1"), {
      method: incoming.method ?? "GET",
      signal: disconnected.signal,
      headers: Object.entries(incoming.headers).flatMap(([name, header]) =>
        header === undefined ? [] : (Array.isArray(header) ? header : [header]).map((entry): [string, string] => [name, entry])),
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- node:stream/web and the global ReadableStream are the same class with separate typings.
      ...(hasBody ? { body: Readable.toWeb(incoming) as ReadableStream, duplex: "half" } : {}),
    });
    void handle(request).then(async (response) => {
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.flushHeaders();
      if (response.body === null) { outgoing.end(); return; }
      // Stream chunk by chunk: event streams never finish on their own.
      for await (const chunk of response.body) {
        if (outgoing.destroyed) break;
        outgoing.write(chunk);
      }
      outgoing.end();
    }).catch(() => { outgoing.destroy(); });
  });
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(port, "127.0.0.1", () => { http.off("error", reject); resolve(); });
  });
  const address = http.address();
  assert.ok(address !== null && typeof address !== "string");
  return {
    url: `http://127.0.0.1:${address.port}/sync/`,
    close: () => new Promise<void>((resolve, reject) => {
      http.close((error) => { if (error) reject(error); else resolve(); });
      http.closeAllConnections();
    }),
  };
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let elapsed = 0; !condition(); elapsed += 10) {
    if (elapsed > 5000) throw new Error("Timed out waiting for the push channel");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * Two writers synchronize over real HTTP: one loses a response and recovers without duplicating work,
 * then receives the other's edit over the push channel without polling.
 */
export async function runSyncAdapterDemo(server: ServerDocument<Shape> = createServer(Board)) {
  const host = await serveFetch(createSyncHandler(Board, server));
  let loseNextResponse = true;
  const lossy: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    if (loseNextResponse && (input instanceof Request ? input.url : input.toString()).endsWith("/batches")) {
      loseNextResponse = false;
      await response.text();
      throw new Error("Connection reset after the server accepted the batch");
    }
    return response;
  };
  const a = await connectSync(Board, {
    transport: createHttpTransport({ url: host.url, fetch: lossy }), pollInterval: 0, retry: { initialDelay: 10 },
  });
  const b = await connectSync(Board, { transport: createHttpTransport({ url: host.url }), pollInterval: 0 });
  try {
    a.doc.state.items.push("Written by A");
    b.doc.state.items.push("Written by B");
    assert.equal(await a.sync(), false); // The response was lost; A retries after catching up.
    assert.equal(a.status, "retrying");
    assert.equal(await a.sync(), true);
    assert.equal(await b.sync(), true);
    assert.equal(await a.sync(), true);
    assert.deepEqual(a.doc.state.items.toArray(), b.doc.state.items.toArray());

    // Polling is off (pollInterval: 0); A's push channel delivers B's next edit.
    await waitFor(() => a.push === "open");
    b.doc.state.items.push("Pushed to A");
    assert.equal(await b.sync(), true);
    await waitFor(() => a.doc.state.items.length === 3);
    return { items: a.doc.state.items.toArray(), serverSeq: server.snapshot().serverSeq };
  } finally {
    a.stop(); b.stop();
    await host.close();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(await runSyncAdapterDemo());
}
