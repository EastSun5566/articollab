import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

import { createClient, createServer, type ClientDocument, type ServerDocument } from "../src/index.ts";
import { Board } from "./resume.ts";

type Shape = typeof Board.definition;
const recovering = new WeakSet<object>();

/** Example-only recovery with manual submission; no other server writes may interleave. */
export function rejectPending(server: ServerDocument<Shape>, doc: ClientDocument<Shape>): boolean {
  if (recovering.has(server) || recovering.has(doc)) {
    throw new Error("Cannot call rejectPending() reentrantly");
  }
  recovering.add(server);
  recovering.add(doc);
  try {
    const checkpoint = doc.checkpoint();
    const cutoff = checkpoint.lastLocalSeq;
    const missed = server.commitsSince(checkpoint.snapshot.serverSeq);
    if (missed === null) return false;
    for (const commit of missed) doc.receive(commit);

    while (true) {
      const batch = doc.checkpoint().pendingBatches[0];
      if (batch === undefined || batch.seq > cutoff) return true;
      const { commit } = server.reject(batch);
      if (commit.serverSeq > doc.checkpoint().snapshot.serverSeq) doc.receive(commit);
      if (doc.checkpoint().pendingBatches[0]?.seq === batch.seq) {
        throw new Error("Rejection completed without acknowledging the pending batch");
      }
    }
  } finally {
    recovering.delete(server);
    recovering.delete(doc);
  }
}

function runDemo(): void {
  const server = createServer(Board);
  const doc = createClient(Board, { clientId: "a", onBatch() {} });
  const peer = createClient(Board, { clientId: "b", onBatch() {} });
  doc.transact(() => {
    doc.state.count.value = 1;
    doc.state.items.push("A");
    doc.state.body.insert(0, "😀");
  });
  doc.transact(() => {
    doc.state.items.push("B");
    doc.state.body.insert(1, "B");
  });
  doc.state.count.value = 9; // Replayable work is part of the explicit cancellation too.
  doc.receive(server.reject(doc.checkpoint().pendingBatches[0]!).commit);
  assert.equal(doc.replayConflict?.batch.seq, 2);
  assert.equal(rejectPending(server, doc), true);
  assert.equal(doc.replayConflict, null);
  assert.deepEqual(doc.checkpoint().pendingBatches, []);

  const missed = server.commitsSince(peer.checkpoint().snapshot.serverSeq);
  assert.ok(missed !== null);
  for (const commit of missed) peer.receive(commit);
  doc.transact(() => {
    doc.state.count.value = 2;
    doc.state.items.push("Recovered");
    doc.state.body.insert(0, "Hi 😀");
  });
  const { commit } = server.receive(doc.checkpoint().pendingBatches[0]!);
  doc.receive(commit);
  peer.receive(commit);
  assert.deepEqual(doc.checkpoint().snapshot, server.snapshot());
  assert.deepEqual(peer.checkpoint().snapshot, server.snapshot());
  console.log({
    blocked: doc.replayConflict !== null,
    count: doc.state.count.value,
    items: doc.state.items.toArray(),
    body: doc.state.body.toString(),
    serverSeq: server.snapshot().serverSeq,
  });
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runDemo();
}
