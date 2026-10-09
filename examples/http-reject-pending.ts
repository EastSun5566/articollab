import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

import { createServer } from "../src/index.ts";
import { connectHttpExampleClient, startHttpExampleServer } from "./http-sync.ts";
import { Board } from "./resume.ts";

async function runDemo(): Promise<void> {
  const server = createServer(Board, {
    resolve: ({ batch }) => batch.seq === 1 ? [] : batch.operations,
  });
  const host = await startHttpExampleServer(server);
  try {
    const a = await connectHttpExampleClient(host.url);
    const peer = await connectHttpExampleClient(host.url);
    a.doc.transact(() => {
      a.doc.state.count.value = 1;
      a.doc.state.items.push("A");
      a.doc.state.body.insert(0, "😀");
    });
    a.doc.transact(() => {
      a.doc.state.items.push("B");
      a.doc.state.body.insert(1, "B");
    });
    a.doc.state.count.value = 9; // Cancellation also covers this replayable pending batch.
    assert.equal(await a.sync(), false);
    assert.equal(a.doc.replayConflict?.batch.seq, 2);
    assert.equal(await a.rejectPending(), true);
    assert.equal(a.doc.replayConflict, null);
    assert.deepEqual(a.doc.checkpoint().pendingBatches, []);
    assert.equal(await peer.sync(), true);

    a.doc.transact(() => {
      a.doc.state.count.value = 2;
      a.doc.state.items.push("Recovered");
      a.doc.state.body.insert(0, "Hi 😀");
    });
    assert.equal(await a.sync(), true);
    assert.equal(await peer.sync(), true);
    for (const { doc } of [a, peer]) assert.deepEqual(doc.checkpoint().snapshot, server.snapshot());
    console.log({ count: a.doc.state.count.value, items: a.doc.state.items.toArray(),
      body: a.doc.state.body.toString(), serverSeq: server.snapshot().serverSeq });
  } finally {
    await host.close();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runDemo();
}
