import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { createServer } from "../src/index.ts";
import { connectHttpExampleClient, startHttpExampleServer } from "./http-sync.ts";
import { createCheckpointStore } from "./persistent-resume.ts";
import { Board } from "./resume.ts";

async function runDemo(): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "articollab-http-checkpoints-"));
  const hosts: Awaited<ReturnType<typeof startHttpExampleServer>>[] = [];
  try {
    const store = createCheckpointStore(directory);
    async function boot() {
      const checkpoint = store.loadServer();
      const server = createServer(Board, {
        ...(checkpoint === null ? {} : { checkpoint }),
        resolve: ({ batch }) => batch.operations, // Resolver code is supplied again, not serialized.
      });
      const host = await startHttpExampleServer(server, { saveServerCheckpoint: store.saveServer });
      hosts.push(host);
      return { server, host };
    }

    const original = await boot();
    const lostResponse = new Error("POST response lost after saving the server checkpoint");
    const source = await connectHttpExampleClient(original.host.url, {
      saveClientCheckpoint: store.saveClient,
      fetch: async (input, init) => {
        const response = await fetch(input, init);
        if (init?.method === "POST" && !(input instanceof Request ? input.url : input.toString()).endsWith("/clients")) { await response.text(); throw lostResponse; }
        return response;
      },
    });
    const peer = await connectHttpExampleClient(original.host.url, { saveClientCheckpoint: store.saveClient });
    source.doc.transact(() => {
      source.doc.state.count.value = 1;
      source.doc.state.items.push("Saved");
      source.doc.state.body.insert(0, "Hi 😀");
    });
    source.doc.transact(() => {
      source.doc.state.count.value = 2;
      source.doc.state.items.push("Unsent");
      source.doc.state.body.insert(source.doc.state.body.length, "!");
    });
    await assert.rejects(source.sync(), (error: unknown) => error === lostResponse);
    assert.equal(store.loadServer()!.snapshot.serverSeq, 1);
    assert.equal(store.loadClient(source.doc.checkpoint().clientId)!.pendingBatches.length, 2);
    await original.host.close(); // Both old writers are retired before rebuilding from files.

    const restored = await boot();
    const a = await connectHttpExampleClient(restored.host.url, {
      checkpoint: store.loadClient(source.doc.checkpoint().clientId)!, saveClientCheckpoint: store.saveClient,
    });
    const b = await connectHttpExampleClient(restored.host.url, {
      checkpoint: store.loadClient(peer.doc.checkpoint().clientId)!, saveClientCheckpoint: store.saveClient,
    });
    assert.equal(await a.sync(), true); // Catch-up confirms batch 1; only batch 2 is posted.
    assert.equal(await b.sync(), true);
    a.doc.transact(() => {
      a.doc.state.items.push("Reconnected");
      a.doc.state.body.insert(a.doc.state.body.length, "😀");
    });
    assert.equal(await a.sync(), true);
    assert.equal(await b.sync(), true);
    assert.deepEqual(store.loadServer(), restored.server.checkpoint());
    for (const { doc } of [a, b]) {
      const checkpoint = doc.checkpoint();
      assert.deepEqual(checkpoint.pendingBatches, []);
      assert.deepEqual(checkpoint.snapshot, restored.server.snapshot());
      assert.deepEqual(store.loadClient(checkpoint.clientId), checkpoint);
    }
    console.log({ count: a.doc.state.count.value, items: a.doc.state.items.toArray(),
      body: a.doc.state.body.toString(), serverSeq: restored.server.snapshot().serverSeq });
  } finally {
    try { await Promise.all(hosts.map((host) => host.close())); }
    finally { rmSync(directory, { recursive: true, force: true }); }
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runDemo();
}
