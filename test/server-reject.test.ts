import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";

import {
  createClient, createServer, decodeClientBatch, decodeClientCheckpoint, decodeServerCheckpoint,
  type ClientBatch, type DocumentOperation, type ServerReceipt,
} from "../src/index.ts";
import { Board } from "../examples/resume.ts";
import { rejectPending } from "../examples/reject-pending.ts";

type Mutable<T> = T extends object ? { -readonly [K in keyof T]: Mutable<T[K]> } : T;

type Shape = typeof Board.definition;
type Batch = ClientBatch<DocumentOperation<Shape>>;

function setup(clientId = "a") {
  const batches: Batch[] = [];
  const doc = createClient(Board, { clientId, onBatch: (batch) => batches.push(batch) });
  return { doc, batches };
}

function countBatch(clientId: string, seq: number, value = seq): Batch {
  return { clientId, seq, operations: [{ type: "value/set", path: "count", value }] };
}

function dependentEdits(doc: ReturnType<typeof setup>["doc"]): void {
  doc.transact(() => {
    doc.state.count.value = 1;
    doc.state.items.push("A");
    doc.state.body.insert(0, "😀");
  });
  doc.transact(() => { doc.state.items.push("B"); doc.state.body.insert(1, "B"); });
  doc.state.count.value = 9;
}

describe("explicit server rejection", () => {
  it("acknowledges a mixed batch without applying it and records a normal frozen commit", () => {
    const { doc, batches } = setup();
    doc.transact(() => {
      doc.state.count.value = 1;
      doc.state.items.push("A");
      doc.state.body.insert(0, "Hi 😀");
    });
    const server = createServer(Board);
    const before = server.snapshot();
    const receipt: ServerReceipt<DocumentOperation<Shape>> = server.reject(batches[0]!);
    assert.equal(receipt.replayed, false);
    assert.deepEqual(receipt.commit, { serverSeq: 1, source: { clientId: "a", seq: 1 }, operations: [] });
    for (const value of [receipt, receipt.commit, receipt.commit.source, receipt.commit.operations]) {
      assert.ok(Object.isFrozen(value));
    }
    assert.deepEqual(server.snapshot(), { ...before, serverSeq: 1 });
    assert.deepEqual(server.commitsSince(0), [receipt.commit]);
    assert.deepEqual(server.checkpoint().replays[0]!.batch, batches[0]);
    doc.receive(receipt.commit);
    assert.deepEqual(doc.checkpoint().pendingBatches, []);
    assert.deepEqual(doc.checkpoint().snapshot, server.snapshot());
    doc.state.count.value = 2;
    assert.equal(server.receive(batches[1]!).commit.serverSeq, 2);
  });

  it("skips a throwing resolver and does not validate state-dependent List/Text references", () => {
    let calls = 0, fail = false;
    const server = createServer(Board, { resolve: ({ batch }) => {
      calls++;
      if (fail) throw new Error("Policy must not run");
      return batch.operations;
    } });
    const { doc, batches } = setup("seed");
    doc.transact(() => { doc.state.items.push("A"); doc.state.body.insert(0, "AB"); });
    doc.receive(server.receive(batches[0]!).commit);
    const listInsert = batches[0]!.operations[0]!, textInsert = batches[0]!.operations[1]!;
    assert.equal(listInsert.type, "list/insert"); assert.equal(textInsert.type, "text/insert");
    if (listInsert.type !== "list/insert" || textInsert.type !== "text/insert") return;
    // Preserve tombstones as well as the still-visible B.
    doc.transact(() => { doc.state.items.delete(0); doc.state.body.delete(0); });
    server.receive(batches[1]!);
    const before = server.snapshot();
    fail = true;
    const unknown = { bunchId: "unknown", counter: 0 };
    const operations: DocumentOperation<Shape>[] = [
      { type: "list/insert", path: "items", id: unknown, before: unknown, value: "x" },
      { type: "list/insert", path: "items", id: listInsert.id, before: null, value: "x" },
      { type: "list/delete", path: "items", id: unknown },
      { type: "text/insert", path: "body", id: unknown, before: unknown, value: "😀" },
      { type: "text/insert", path: "body", id: textInsert.id, before: null, value: "AB" },
      { type: "text/delete", path: "body", ranges: [{ start: unknown, count: Number.MAX_SAFE_INTEGER }] },
    ];
    for (const [index, operation] of operations.entries()) {
      const batch = decodeClientBatch(Board, { clientId: "rejected-" + index, seq: 1, operations: [operation] });
      assert.equal(server.reject(batch).commit.serverSeq, index + 3);
      assert.deepEqual(server.snapshot().data, before.data);
    }
    assert.equal(calls, 2);
    decodeServerCheckpoint(Board, JSON.parse(JSON.stringify(server.checkpoint())));
  });

  it("replays the original result across both entrypoints instead of changing the decision", () => {
    for (const mode of ["accept", "transform", "reject"] as const) {
      let calls = 0;
      const server = createServer(Board, { resolve: ({ batch }) => {
        calls++;
        return mode === "transform" ? countBatch(batch.clientId, batch.seq, 5).operations : batch.operations;
      } });
      const batch = countBatch("a", 1, 1);
      const first = mode === "reject" ? server.reject(batch) : server.receive(batch);
      const before = server.checkpoint();
      for (const entrypoint of ["reject", "receive", "reject"] as const) {
        const retry = server[entrypoint](decodeClientBatch(Board, JSON.parse(JSON.stringify(batch))));
        assert.equal(retry.replayed, true);
        assert.equal(retry.commit, first.commit);
        assert.deepEqual(server.checkpoint(), before);
      }
      assert.equal(calls, mode === "reject" ? 0 : 1);
      assert.equal(server.snapshot().data.count, mode === "reject" ? 0 : mode === "transform" ? 5 : 1);
    }
  });

  it("keeps sequences, replay cache and history atomic on sequence, payload and copy failures", () => {
    const server = createServer(Board);
    server.reject(countBatch("a", 1));
    const before = server.checkpoint();
    for (const batch of [
      countBatch("a", 1, 99), countBatch("a", 3), countBatch("new", 2),
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Deliberately invalid typed input tests runtime validation; do not decode away the failure under test.
      { ...countBatch("a", 2), operations: [{ type: "bad", path: "count" }] } as unknown as Batch,
    ]) {
      assert.throws(() => server.reject(batch));
      assert.deepEqual(server.checkpoint(), before);
    }
    const next = server.reject(countBatch("a", 2));
    assert.equal(next.commit.serverSeq, 2);
    const after = server.checkpoint();
    for (const entrypoint of ["receive", "reject"] as const) {
      assert.throws(() => server[entrypoint](countBatch("a", 1)), /Expected client sequence 3/);
      assert.deepEqual(server.checkpoint(), after);
    }
    assert.equal(server.receive(countBatch("a", 3)).commit.serverSeq, 3);
  });

  it("owns rejected batch containers, IDs and Text ranges without modifying the caller", () => {
    const { doc, batches } = setup();
    dependentEdits(doc);
    doc.state.body.delete(0, 2);
    const input = JSON.parse(JSON.stringify({ ...batches[0], operations: [
      ...batches[0]!.operations, ...batches[3]!.operations,
    ] })) as Mutable<Batch>; // oxlint-disable-line typescript/no-unsafe-type-assertion -- Known JSON fixture is made mutable to verify ownership or inject corruption; production decoders are tested separately.
    const original = decodeClientBatch(Board, input);
    const server = createServer(Board);
    const receipt = server.reject(input);
    assert.equal(Object.isFrozen(input), false);
    const saved = server.checkpoint().replays[0]!.batch;
    for (const value of [saved, saved.operations, ...saved.operations]) assert.ok(Object.isFrozen(value));
    const insert = saved.operations[1]!, deletion = saved.operations[3]!;
    assert.equal(insert.type, "list/insert"); assert.equal(deletion.type, "text/delete");
    if (insert.type !== "list/insert" || deletion.type !== "text/delete") return;
    assert.ok(input.operations[1]!.type === "list/insert");
    assert.ok(input.operations[3]!.type === "text/delete");
    assert.notEqual(insert.id, input.operations[1]!.id);
    assert.ok(Object.isFrozen(insert.id));
    assert.ok(Object.isFrozen(deletion.ranges));
    assert.ok(Object.isFrozen(deletion.ranges[0]));
    assert.ok(Object.isFrozen(deletion.ranges[0]!.start));
    input.clientId = "changed"; input.seq = 99;
    input.operations[1]!.id.counter = 99;
    input.operations[3]!.ranges[0]!.start.counter = 99;
    input.operations[3]!.ranges[0]!.count = 99;
    input.operations.length = 0;
    assert.deepEqual(saved, original);
    assert.equal(server.receive(original).commit, receipt.commit);
  });

  it("shares the reentrancy guard and releases it after either nested entrypoint fails", () => {
    for (const nested of ["receive", "reject"] as const) {
      let reenter = true;
      const server = createServer(Board, { resolve: ({ batch }) => {
        if (reenter) server[nested](countBatch("nested", 1));
        return batch.operations;
      } });
      const before = server.checkpoint();
      assert.throws(() => server.receive(countBatch("a", 1)), /reentrantly/);
      assert.deepEqual(server.checkpoint(), before);
      assert.equal(server.reject(countBatch("a", 1)).commit.serverSeq, 1);
      reenter = false;
      assert.equal(server.receive(countBatch("a", 2)).commit.serverSeq, 2);
    }
  });

  it("restores explicit rejection, bounded history and retry ownership from JSON", () => {
    const server = createServer(Board, { historyLimit: 2 });
    const accepted = countBatch("a", 1, 7);
    server.receive(accepted);
    const rejected = countBatch("a", 2, 99);
    const result = server.reject(rejected);
    const saved = server.checkpoint();
    server.reject(countBatch("peer", 1));
    assert.equal(saved.snapshot.serverSeq, 2);
    assert.equal(saved.history.length, 2);
    const restored = createServer(Board, {
      checkpoint: decodeServerCheckpoint(Board, JSON.parse(JSON.stringify(saved))),
      resolve() { throw new Error("Retry cannot run policy"); },
    });
    assert.deepEqual(restored.snapshot(), saved.snapshot);
    for (const entrypoint of ["receive", "reject"] as const) {
      assert.deepEqual(restored[entrypoint](rejected), { commit: result.commit, replayed: true });
      assert.deepEqual(restored.checkpoint(), saved);
    }
    assert.equal(restored.reject(countBatch("a", 3)).commit.serverSeq, 3);
    assert.equal(restored.reject(countBatch("new", 1)).commit.serverSeq, 4);
    assert.equal(restored.snapshot().data.count, 7);
    assert.deepEqual(server.commitsSince(1)?.map((commit) => commit.serverSeq), [2, 3]);
    assert.equal(server.commitsSince(0), null);
  });

  it("rejects new batches at global sequence exhaustion but still replays either entrypoint", () => {
    const max = Number.MAX_SAFE_INTEGER;
    const previous = countBatch("a", max - 1, 0);
    const server = createServer(Board, { checkpoint: {
      snapshot: { ...createServer(Board).snapshot(), serverSeq: max - 1 }, history: [],
      replays: [{ batch: previous, commit: {
        serverSeq: max - 1, source: { clientId: "a", seq: max - 1 }, operations: [],
      } }],
    } });
    const last = countBatch("a", max, 1);
    const receipt = server.reject(last);
    const checkpoint = server.checkpoint();
    assert.equal(receipt.commit.serverSeq, max);
    for (const document of [server, createServer(Board, { checkpoint })]) {
      assert.throws(() => document.reject(countBatch("new", 1)), /Server sequence exhausted/);
      assert.deepEqual(document.checkpoint(), checkpoint);
      for (const entrypoint of ["receive", "reject"] as const) {
        assert.deepEqual(document[entrypoint](last), { commit: receipt.commit, replayed: true });
      }
    }
  });
});

describe("manual pending rejection example", () => {
  it("unblocks mixed pending work, converges peers and preserves sequences and ID allocation", () => {
    const { doc, batches } = setup(); dependentEdits(doc);
    const peer = setup("b").doc;
    const server = createServer(Board);
    doc.receive(server.reject(batches[0]!).commit);
    assert.equal(doc.replayConflict?.batch.seq, 2);
    const allocations = doc.checkpoint().lastBunchSeqs;
    assert.equal(rejectPending(server, doc), true);
    assert.equal(doc.replayConflict, null);
    assert.deepEqual(doc.checkpoint().pendingBatches, []);
    assert.deepEqual(doc.checkpoint().lastBunchSeqs, allocations);
    assert.deepEqual(doc.checkpoint().snapshot, server.snapshot());
    assert.equal(doc.state.count.value, 0); // The replayable Value suffix was cancelled too.
    const restored = createClient(Board, { clientId: "a", onBatch() {},
      checkpoint: decodeClientCheckpoint(Board, JSON.parse(JSON.stringify(doc.checkpoint()))),
    });
    restored.transact(() => { restored.state.items.push("new"); restored.state.body.insert(0, "😀"); });
    const batch = restored.checkpoint().pendingBatches[0]!;
    assert.equal(batch.seq, 4);
    assert.deepEqual(restored.checkpoint().lastBunchSeqs, { items: allocations.items + 1, body: allocations.body + 1 });
    restored.receive(server.receive(batch).commit);
    for (const commit of server.commitsSince(0)!) peer.receive(commit);
    assert.deepEqual(peer.checkpoint().snapshot, server.snapshot());
    assert.deepEqual(restored.checkpoint().snapshot, server.snapshot());
  });

  it("catches up several lost acknowledgements instead of undoing accepted or transformed effects", () => {
    let calls = 0;
    const server = createServer(Board, { resolve: ({ batch }) => {
      calls++;
      return countBatch(batch.clientId, batch.seq, batch.seq * 10).operations;
    } });
    const { doc, batches } = setup();
    doc.state.count.value = 1; doc.state.count.value = 2; doc.state.count.value = 3;
    server.receive(batches[0]!); server.receive(batches[1]!); // Both acknowledgements are lost.
    const changes: number[] = [];
    doc.on("change", (event) => { if (event.origin === "server") changes.push(event.commit.serverSeq); });
    assert.equal(rejectPending(server, doc), true);
    assert.deepEqual(changes, [3]); // Catch-up's own acks are silent but still remove pending.
    assert.equal(calls, 2);
    assert.equal(server.snapshot().data.count, 20);
    assert.equal(doc.state.count.value, 20);
    assert.deepEqual(doc.checkpoint().pendingBatches, []);
    assert.deepEqual(server.checkpoint().replays[0]!.batch, batches[2]);
    assert.deepEqual(server.checkpoint().replays[0]!.commit.operations, []);
  });

  it("retains listener-created edits during catch-up and while cancelling the original suffix", () => {
    for (const phase of ["catch-up", "reject"] as const) {
      const { doc, batches } = setup();
      const server = createServer(Board);
      if (phase === "catch-up") {
        doc.state.count.value = 1; doc.state.count.value = 2;
        server.receive(batches[0]!);
        const { doc: peer, batches: peerBatches } = setup("peer");
        peer.state.body.insert(0, "remote");
        server.receive(peerBatches[0]!);
      } else {
        dependentEdits(doc);
      }
      const cutoff = doc.checkpoint().lastLocalSeq;
      let edited = false;
      const unsubscribe = doc.on("change", (event) => {
        if (event.origin === "server" && doc.replayConflict === null && !edited) {
          edited = true;
          doc.state.count.value = 100;
        }
      });
      assert.equal(rejectPending(server, doc), true);
      unsubscribe();
      assert.equal(edited, true);
      const pending = doc.checkpoint().pendingBatches;
      assert.deepEqual(pending.map((batch) => batch.seq), [cutoff + 1]);
      assert.equal(doc.state.count.value, 100);
      assert.equal(server.checkpoint().replays.find((entry) => entry.batch.clientId === "a")!.batch.seq, cutoff);
      assert.deepEqual(server.checkpoint().replays.find((entry) => entry.batch.clientId === "a")!.commit.operations, []);
      doc.receive(server.receive(pending[0]!).commit);
      assert.deepEqual(doc.checkpoint().pendingBatches, []);
      assert.equal(server.snapshot().data.count, 100);
    }
  });

  it("does not submit anything or replace pending state when catch-up history is insufficient", () => {
    const server = createServer(Board, { historyLimit: 0 });
    const { doc } = setup(); dependentEdits(doc);
    server.receive(countBatch("peer", 1));
    const clientBefore = doc.checkpoint(), serverBefore = server.checkpoint();
    assert.equal(rejectPending(server, doc), false);
    assert.deepEqual(doc.checkpoint(), clientBefore);
    assert.deepEqual(server.checkpoint(), serverBefore);
  });

  it("preserves a new dependent listener edit even when cancellation makes it blocked", () => {
    const server = createServer(Board);
    const { doc, batches } = setup();
    doc.state.items.push("A");
    server.receive(countBatch("peer", 1)); // Catch-up emits a visible remote Value change.
    const unsubscribe = doc.on("change", (event) => {
      if (event.origin === "server" && event.commit.source.clientId === "peer") doc.state.items.push("B");
    });
    assert.equal(rejectPending(server, doc), true);
    unsubscribe();
    assert.equal(doc.replayConflict?.batch, batches[1]);
    assert.deepEqual(doc.checkpoint().pendingBatches, [batches[1]]);
    assert.equal(server.checkpoint().replays.find((entry) => entry.batch.clientId === "a")!.batch.seq, 1);
    assert.equal(rejectPending(server, doc), true); // A separate explicit decision cancels the new edit.
    assert.equal(doc.replayConflict, null);
    assert.deepEqual(doc.checkpoint().pendingBatches, []);
  });

  it("guards both server and document against reentrant recovery and releases the guard", () => {
    const server = createServer(Board), otherServer = createServer(Board);
    const { doc } = setup(), peer = setup("peer").doc;
    doc.state.count.value = 1;
    doc.transact(() => {
      assert.throws(() => rejectPending(server, doc), /Cannot checkpoint during a transaction/);
    });
    doc.on("change", (event) => {
      if (event.origin !== "server") return;
      assert.throws(() => rejectPending(server, peer), /reentrantly/);
      assert.throws(() => rejectPending(otherServer, doc), /reentrantly/);
    });
    assert.equal(rejectPending(server, doc), true);
    assert.equal(rejectPending(server, peer), true);
    assert.equal(rejectPending(server, doc), true);
  });

  it("preserves completed rejection and remaining pending when a listener throws", () => {
    const server = createServer(Board);
    const { doc, batches } = setup(); dependentEdits(doc);
    const error = new Error("Listener failed");
    const unsubscribe = doc.on("change", (event) => { if (event.origin === "server") throw error; });
    assert.throws(() => rejectPending(server, doc), (actual) => actual === error);
    assert.equal(server.snapshot().serverSeq, 1);
    assert.equal(doc.checkpoint().snapshot.serverSeq, 1);
    assert.equal(doc.replayConflict?.batch.seq, 2);
    assert.deepEqual(doc.checkpoint().pendingBatches, batches.slice(1));
    decodeClientCheckpoint(Board, JSON.parse(JSON.stringify(doc.checkpoint())));
    unsubscribe();
    assert.equal(rejectPending(server, doc), true);
    assert.deepEqual(doc.checkpoint().pendingBatches, []);
  });

  it("has no demo side effects when imported", () => {
    const url = new URL("../examples/reject-pending.ts", import.meta.url).href;
    const result = spawnSync(process.execPath, [
      "--input-type=module", "-e", "await import(" + JSON.stringify(url) + ")",
    ], { encoding: "utf8", timeout: 10_000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  });
});
