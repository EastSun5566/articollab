import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CollectionConflictError,
  counterMap,
  createClient,
  createServer,
  decodeServerCheckpoint,
  decodeServerLogEntry,
  defineDocument,
  list,
  text,
  value,
  WireDecodeError,
  type ClientBatch,
  type ClientDocument,
  type DocumentOperation,
  type ServerLogEntry,
} from "../packages/articollab/src/index.ts";

const Board = defineDocument({
  count: value(0),
  items: list<string>(),
  body: text({ marks: { bold: { expand: "after" } }, blocks: { heading: {} } }),
  votes: counterMap(),
});
type Shape = typeof Board.definition;
type Batch = ClientBatch<DocumentOperation<Shape>>;
type Entry = ServerLogEntry<Shape>;

/** A JSON round trip, as a store would save and load it. */
const stored = (input: unknown): unknown => JSON.parse(JSON.stringify(input));

/** Caps the count at 10: transforms some batches and leaves others unchanged. */
function resolve({ batch }: { batch: Batch }) {
  return batch.operations.map((operation) =>
    operation.type === "value/set" && operation.value > 10 ? { ...operation, value: 10 } : operation);
}

describe("Server log entries", () => {
  it("records opened and closed sessions and new batches, but not retries, failures or repeated closes", () => {
    const server = createServer(Board);
    const entries: Entry[] = [];
    const stop = server.on("entry", (entry) => { entries.push(entry); });
    const a = server.openClient();
    const batch: Batch = { clientId: a, seq: 1, operations: [{ type: "value/set", path: "count", value: 3 }] };
    const { commit } = server.receive(batch);
    server.receive(batch); // A retry.
    assert.throws(() => server.receive({ clientId: a, seq: 3, operations: [] })); // A gap.
    const rejected = server.reject({ clientId: a, seq: 2, operations: [{ type: "value/set", path: "count", value: 4 }] });
    server.closeClient(a);
    server.closeClient(a);
    stop();
    server.openClient();

    assert.deepEqual(entries.map((entry) => entry.type), ["open", "batch", "batch", "close"]);
    assert.deepEqual(entries[0], { type: "open", clientId: a });
    assert.deepEqual(entries[1], { type: "batch", batch, commit });
    assert.equal(entries[1]?.type === "batch" && entries[1].commit, commit, "the commit the receipt returned");
    assert.deepEqual(entries[2]?.type === "batch" && entries[2].commit, rejected.commit);
    assert.deepEqual(entries[3], { type: "close", clientId: a });
    assert.ok(entries.every((entry) => Object.isFrozen(entry)));
  });

  it("restores the same server from any checkpoint and the entries after it", () => {
    for (const seed of [1, 7, 42, 2026]) restoreEverywhere(seed, 200);
  });

  it("decodes entries strictly", () => {
    const fails = (input: unknown, path: string) => assert.throws(() => decodeServerLogEntry(Board, input), (error: unknown) =>
      error instanceof WireDecodeError && error.path === path);
    fails({ type: "open", clientId: "alice" }, "/clientId");
    fails({ type: "open", clientId: "client-1", extra: 1 }, "/extra");
    fails({ type: "move", clientId: "client-1" }, "/type");
    const batch = { clientId: "client-1", seq: 1, operations: [{ type: "value/set", path: "count", value: 1 }] };
    fails({ type: "batch", batch, commit: { serverSeq: 1, source: { clientId: "client-1", seq: 2 }, operations: [] } }, "/commit/source");
    fails({ type: "batch", batch, commit: { serverSeq: 1, source: { clientId: "client-1", seq: 1 }, operations: [{ type: "value/set", path: "nope", value: 1 }] } },
      "/commit/operations/0/path");
    assert.deepEqual(decodeServerLogEntry(Board, { type: "close", clientId: "client-2" }), { type: "close", clientId: "client-2" });
  });

  it("refuses a log that does not follow from the state before it", () => {
    const open = (clientId: string) => ({ type: "open" as const, clientId });
    const batch = (seq: number, serverSeq: number, count = seq) => ({
      type: "batch" as const,
      batch: { clientId: "client-1", seq, operations: [{ type: "value/set" as const, path: "count" as const, value: count }] },
      commit: { serverSeq, source: { clientId: "client-1", seq }, operations: [{ type: "value/set" as const, path: "count" as const, value: count }] },
    });
    const refuses = (log: readonly Entry[], message: RegExp | (new (...args: never[]) => Error)) =>
      assert.throws(() => createServer(Board, { log }), message);
    refuses([open("client-2")], /out of order/);
    refuses([open("client-1"), { type: "close", clientId: "client-2" }], /not open/);
    refuses([batch(1, 1)], /not open/);
    refuses([open("client-1"), batch(2, 1)], /skips a batch/);
    refuses([open("client-1"), batch(1, 2)], /server sequence 2, not 1/);
    assert.throws(() => createServer(Board, { maxClients: 1, log: [open("client-1"), open("client-2")] }), /exceeds maxClients/);
    const unknownTarget: Entry = {
      type: "batch",
      batch: { clientId: "client-1", seq: 1, operations: [{ type: "value/set", path: "count", value: 1 }] },
      commit: { serverSeq: 1, source: { clientId: "client-1", seq: 1 },
        operations: [{ type: "list/delete", path: "items", id: { bunchId: '["client-9","items",1]', counter: 0 } }] },
    };
    refuses([open("client-1"), unknownTarget], CollectionConflictError);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- A wrong type on purpose.
    assert.throws(() => createServer(Board, { log: {} as never }), TypeError);
    // A log may start from a new server, without a checkpoint.
    const server = createServer(Board, { log: [open("client-1"), batch(1, 1, 5)] });
    assert.equal(server.snapshot().data.count, 5);
    assert.deepEqual(server.listClients(), [{ clientId: "client-1", lastSeq: 1, lastServerSeq: 1 }]);
  });
});

/**
 * Runs a random workload of writers, transformed and rejected batches, retries, new and closed
 * sessions. Then restores from every saved checkpoint with the entries recorded after it, and
 * compares the result with the live server.
 */
function restoreEverywhere(seed: number, steps: number): void {
  let state = seed >>> 0;
  const pick = (n: number) => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state % n; };
  const maxHistory = 5;
  const server = createServer(Board, { resolve, maxHistory });
  const log: unknown[] = [];
  server.on("entry", (entry) => { log.push(stored(entry)); });
  const saved: { checkpoint: unknown; at: number }[] = [{ checkpoint: stored(server.checkpoint()), at: 0 }];
  const writers: { doc: ClientDocument<Shape>; outbox: Batch[]; last?: Batch }[] = [];
  function open() {
    const outbox: Batch[] = [];
    const doc = createClient(Board, { clientId: server.openClient(), snapshot: server.snapshot(), onBatch: (batch) => { outbox.push(batch); } });
    writers.push({ doc, outbox });
  }
  open();
  for (let step = 0; step < steps; step++) {
    const writer = writers[pick(writers.length)];
    const action = pick(12);
    if (writer === undefined || action === 0) { open(); continue; }
    const { doc } = writer;
    if (action === 1 && writers.length > 1 && writer.outbox.length === 0) {
      server.closeClient(doc.checkpoint().clientId);
      writers.splice(writers.indexOf(writer), 1);
    } else if (action <= 5 && doc.replayConflict === null) {
      const body = doc.state.body, items = doc.state.items;
      switch (pick(6)) {
        case 0: doc.state.count.value = pick(20); break;
        case 1: items.insert(pick(items.length + 1), `item ${step}`); break;
        case 2: if (items.length > 0) items.delete(pick(items.length)); break;
        case 3: body.insert(pick(body.length + 1), "ab\n"); break;
        case 4: if (body.length > 1) body.format(0, 1 + pick(body.length - 1), "bold", pick(2) === 0 ? true : null); break;
        default: doc.state.votes.add(`card-${pick(3)}`, 1 + pick(2)); break;
      }
    } else if (action <= 8) {
      const batch = writer.outbox.shift();
      if (batch === undefined) continue;
      try {
        if (pick(4) === 0) server.reject(batch); else server.receive(batch);
        writer.last = batch;
      } catch (error) {
        assert.ok(error instanceof CollectionConflictError, String(error));
        server.reject(batch);
        writer.last = batch;
      }
    } else if (action === 9 && writer.last !== undefined) {
      server.receive(writer.last); // A retry records nothing.
    } else if (action === 10) {
      saved.push({ checkpoint: stored(server.checkpoint()), at: log.length });
    } else {
      const commits = server.commitsSince(doc.checkpoint().snapshot.serverSeq);
      if (commits === null) {
        // History moved on: a new writer replaces this one.
        writers.splice(writers.indexOf(writer), 1);
        continue;
      }
      for (const commit of commits) doc.receive(commit);
    }
  }

  const expected = JSON.stringify(server.checkpoint());
  const watermark = server.snapshot().serverSeq;
  for (const { checkpoint, at } of saved) {
    const restored = createServer(Board, {
      resolve, maxHistory, checkpoint: decodeServerCheckpoint(Board, checkpoint),
      log: log.slice(at).map((entry) => decodeServerLogEntry(Board, entry)),
    });
    assert.equal(JSON.stringify(restored.checkpoint()), expected, `seed ${seed}, checkpoint at entry ${at}`);
    for (const since of [watermark, Math.max(0, watermark - 3), Math.max(0, watermark - maxHistory - 1)]) {
      assert.deepEqual(restored.commitsSince(since), server.commitsSince(since));
    }
    for (const writer of writers) {
      if (writer.last === undefined) continue;
      assert.deepEqual(restored.receive(writer.last), server.receive(writer.last), "a retry returns the same commit");
    }
  }
  assert.ok(log.length > steps / 10 && saved.length > 1, `seed ${seed} exercised the log`);
}
