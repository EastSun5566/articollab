import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createClient, createServer, decodeClientCheckpoint, decodeServerCommit,
  defineDocument, list, text, value, WireDecodeError,
  type ClientBatch, type ClientCheckpoint, type DocumentOperation,
} from "../src/index.ts";

const Board = defineDocument({ count: value(0), items: list<string>(), body: text() });
type BoardBatch = ClientBatch<DocumentOperation<typeof Board.definition>>;
type BoardCheckpoint = ClientCheckpoint<typeof Board.definition>;

function roundTrip(checkpoint: BoardCheckpoint): BoardCheckpoint {
  return decodeClientCheckpoint(Board, JSON.parse(JSON.stringify(checkpoint)));
}

function assertInvalid(input: unknown, path: string): void {
  const matches = (error: unknown): boolean => {
    assert.ok(error instanceof WireDecodeError);
    assert.equal(error.path, path);
    return true;
  };
  assert.throws(() => decodeClientCheckpoint(Board, input), matches);
  assert.throws(() => createClient(Board, {
    clientId: "a", checkpoint: input as BoardCheckpoint,
    onBatch: () => assert.fail("restore must not send"),
  }), matches);
}

function assertDeepFrozen(input: unknown): void {
  if (input === null || typeof input !== "object") return;
  assert.ok(Object.isFrozen(input));
  for (const child of Object.values(input)) assertDeepFrozen(child);
}

describe("client checkpoint", () => {
  it("saves typed fresh defaults and freezes owned containers", () => {
    const doc = createClient(Board, {
      clientId: "a", onBatch: () => assert.fail("construction must not send"),
    });
    const checkpoint = doc.checkpoint();
    const allocations: Readonly<{ items: number; body: number }> = checkpoint.lastBunchSeqs;
    assert.deepEqual(allocations, { items: 0, body: 0 });
    // @ts-expect-error Value paths do not have bunch allocations.
    void checkpoint.lastBunchSeqs.count;
    assert.deepEqual(checkpoint, {
      clientId: "a", snapshot: createServer(Board).snapshot(),
      lastLocalSeq: 0, pendingBatches: [], lastBunchSeqs: { items: 0, body: 0 },
    });
    assertDeepFrozen(checkpoint);
    const Counter = defineDocument({ count: value(0) });
    const counter = createClient(Counter, { clientId: "value-only", onBatch: () => {} });
    assert.deepEqual(counter.checkpoint().lastBunchSeqs, {});
    assert.equal(createClient(Counter, {
      clientId: "value-only",
      checkpoint: decodeClientCheckpoint(Counter, JSON.parse(JSON.stringify(counter.checkpoint()))),
      onBatch: () => {},
    }).state.count.value, 0);
  });

  it("captures authoritative rather than optimistic values and remains point-in-time", () => {
    const observed: BoardCheckpoint[] = [];
    const doc = createClient(Board, {
      clientId: "a", onBatch: (): void => { observed.push(doc.checkpoint()); },
    });
    const fresh = doc.checkpoint();
    doc.transact(() => {
      doc.state.count.value = 1;
      doc.state.items.push("one");
      doc.state.body.insert(0, "A😀");
    });
    const pending = observed[0]!;
    assert.equal(pending.snapshot.data.count, 0);
    assert.deepEqual(pending.snapshot.data.items.values, []);
    assert.equal(pending.snapshot.data.body.value, "");
    assert.equal(pending.pendingBatches[0]!.operations.length, 3);
    assert.equal(pending.lastLocalSeq, 1);
    assert.deepEqual(pending.lastBunchSeqs, { items: 1, body: 1 });
    assertDeepFrozen(pending);
    const server = createServer(Board);
    doc.receive(server.receive(pending.pendingBatches[0]!).commit);
    doc.state.count.value = 2;
    assert.equal(fresh.lastLocalSeq, 0);
    assert.deepEqual(fresh.pendingBatches, []);
    assert.equal(pending.snapshot.serverSeq, 0);
    assert.equal(pending.pendingBatches.length, 1);
    assert.equal(doc.checkpoint().snapshot.data.count, 1);
    assert.equal(doc.checkpoint().pendingBatches[0]!.seq, 2);
  });

  it("silently restores mixed pending batches and continues sequences and IDs", () => {
    const doc = createClient(Board, { clientId: "a", onBatch: () => {} });
    doc.transact(() => {
      doc.state.count.value = 1;
      doc.state.items.push("first");
      doc.state.body.insert(0, "A😀");
    });
    doc.transact(() => {
      doc.state.items.delete(0);
      doc.state.items.push("second");
      doc.state.body.delete(0, 1);
    });
    const checkpoint = roundTrip(doc.checkpoint());
    const sent: BoardBatch[] = [];
    const restored = createClient(Board, {
      clientId: "a", checkpoint, onBatch: (batch) => sent.push(batch),
    });
    let changes = 0;
    restored.on("change", () => changes++);
    assert.equal(sent.length, 0);
    assert.equal(changes, 0);
    assert.equal(restored.state.count.value, 1);
    assert.deepEqual(restored.state.items.toArray(), ["second"]);
    assert.equal(restored.state.body.toString(), "😀");
    assert.deepEqual(restored.checkpoint(), checkpoint);
    restored.transact(() => {
      restored.state.count.value = 2;
      restored.state.items.push("third");
      restored.state.body.insert(1, "B");
    });
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.seq, 3);
    assert.equal(changes, 1);
    assert.deepEqual(restored.checkpoint().lastBunchSeqs, { items: 3, body: 2 });
    assert.equal(restored.checkpoint().pendingBatches.length, 3);
    assert.equal(restored.checkpoint().snapshot.data.body.value, "");
    assert.deepEqual(checkpoint.lastBunchSeqs, { items: 2, body: 1 });
  });

  it("restores acknowledged Unicode state and tombstones without reapplying old batches", () => {
    const batches: BoardBatch[] = [];
    const doc = createClient(Board, { clientId: "a", onBatch: (batch) => batches.push(batch) });
    const server = createServer(Board);
    doc.transact(() => {
      doc.state.items.push("deleted");
      doc.state.body.insert(0, "A😀");
    });
    doc.receive(server.receive(batches[0]!).commit);
    doc.transact(() => {
      doc.state.items.delete(0);
      doc.state.body.delete(0);
    });
    doc.receive(server.receive(batches[1]!).commit);
    const checkpoint = roundTrip(doc.checkpoint());
    assert.equal(checkpoint.lastLocalSeq, 2);
    assert.equal(checkpoint.snapshot.serverSeq, 2);
    assert.deepEqual(checkpoint.pendingBatches, []);
    assert.ok(checkpoint.snapshot.data.items.idList.some((range) => range.isDeleted));
    assert.ok(checkpoint.snapshot.data.body.idList.some((range) => range.isDeleted));
    const sent: BoardBatch[] = [];
    const restored = createClient(Board, {
      clientId: "a", checkpoint, onBatch: (batch) => sent.push(batch),
    });
    assert.deepEqual(restored.state.items.toArray(), []);
    assert.deepEqual([...restored.state.body], ["😀"]);
    restored.transact(() => {
      restored.state.items.push("new");
      restored.state.body.insert(0, "B");
    });
    assert.equal(sent[0]!.seq, 3);
    restored.receive(server.receive(sent[0]!).commit);
    assert.deepEqual(restored.checkpoint().snapshot, server.snapshot());
    assert.deepEqual(restored.checkpoint().lastBunchSeqs, { items: 2, body: 2 });
    assertInvalid({ ...checkpoint, lastBunchSeqs: { items: 0, body: 1 } }, "/lastBunchSeqs/items");
    assertInvalid({ ...checkpoint, lastBunchSeqs: { items: 1, body: 0 } }, "/lastBunchSeqs/body");
  });

  it("preserves rejected and rolled-back ID allocations across restore", () => {
    let reject = true;
    const server = createServer(Board, { resolve: ({ batch }) => reject ? [] : batch.operations });
    const batches: BoardBatch[] = [];
    const doc = createClient(Board, { clientId: "a", onBatch: (batch) => batches.push(batch) });
    doc.transact(() => {
      doc.state.items.push("rejected");
      doc.state.body.insert(0, "rejected");
    });
    doc.receive(server.receive(batches[0]!).commit);
    assert.throws(() => doc.transact(() => {
      doc.state.count.value = 99;
      doc.state.items.push("rolled back");
      doc.state.body.insert(0, "rolled back");
      throw new Error("abort");
    }), /abort/);
    const checkpoint = roundTrip(doc.checkpoint());
    assert.equal(checkpoint.lastLocalSeq, 1);
    assert.deepEqual(checkpoint.pendingBatches, []);
    assert.deepEqual(checkpoint.lastBunchSeqs, { items: 2, body: 2 });
    const restored = createClient(Board, {
      clientId: "a", checkpoint, onBatch: (batch) => batches.push(batch),
    });
    assert.equal(restored.state.count.value, 0);
    assert.deepEqual(restored.state.items.toArray(), []);
    assert.equal(restored.state.body.toString(), "");
    restored.transact(() => {
      restored.state.items.push("accepted");
      restored.state.body.insert(0, "😀");
    });
    const next = batches[1]!;
    assert.equal(next.seq, 2);
    for (const operation of next.operations) {
      assert.ok(operation.type === "list/insert" || operation.type === "text/insert");
      assert.equal(JSON.parse(operation.id.bunchId)[2], 3);
    }
    reject = false;
    restored.receive(server.receive(next).commit);
    assert.deepEqual(restored.checkpoint().snapshot, server.snapshot());
  });

  it("catches up a missed own result while preserving remaining pending work without resending", () => {
    const server = createServer(Board, { resolve: ({ batch }) =>
      batch.clientId === "a" && batch.seq === 1
        ? [{ type: "value/set", path: "count", value: 8 }]
        : batch.operations,
    });
    const aBatches: BoardBatch[] = [], bBatches: BoardBatch[] = [];
    const a = createClient(Board, { clientId: "a", onBatch: (batch) => aBatches.push(batch) });
    const b = createClient(Board, { clientId: "b", onBatch: (batch) => bBatches.push(batch) });
    a.state.count.value = 10;
    a.transact(() => {
      a.state.items.push("pending");
      a.state.body.insert(0, "local");
    });
    const checkpoint = roundTrip(a.checkpoint());
    b.transact(() => {
      b.state.count.value = 20;
      b.state.body.insert(0, "remote");
    });
    b.receive(server.receive(bBatches[0]!).commit);
    const own = server.receive(aBatches[0]!);
    b.receive(own.commit); // a misses both commits.
    const sent: BoardBatch[] = [];
    const restored = createClient(Board, {
      clientId: "a", checkpoint, onBatch: (batch) => sent.push(batch),
    });
    const views: number[] = [];
    for (const commit of server.commitsSince(checkpoint.snapshot.serverSeq)!) {
      restored.receive(decodeServerCommit(Board, JSON.parse(JSON.stringify(commit))));
      views.push(restored.state.count.value);
      assert.deepEqual(restored.state.items.toArray(), ["pending"]);
    }
    assert.deepEqual(views, [10, 8]);
    assert.equal(restored.checkpoint().snapshot.serverSeq, 2);
    assert.deepEqual(restored.checkpoint().pendingBatches.map((batch) => batch.seq), [2]);
    assert.equal(server.receive(aBatches[0]!).replayed, true); // Already in catch-up.
    assert.equal(sent.length, 0);
    const next = server.receive(restored.checkpoint().pendingBatches[0]!).commit;
    restored.receive(next);
    b.receive(next);
    assert.equal(restored.state.count.value, b.state.count.value);
    assert.deepEqual(restored.state.items.toArray(), b.state.items.toArray());
    assert.equal(restored.state.body.toString(), b.state.body.toString());
    assert.deepEqual(restored.checkpoint().pendingBatches, []);
    const withoutHistory = createServer(Board, { checkpoint: server.checkpoint(), historyLimit: 0 });
    const stillPending = createClient(Board, { clientId: "a", checkpoint, onBatch: () => {} });
    assert.equal(withoutHistory.commitsSince(checkpoint.snapshot.serverSeq), null);
    assert.deepEqual(stillPending.checkpoint(), checkpoint);
    restored.state.count.value = 9;
    assert.equal(sent[0]!.seq, 3);
  });

  it("rejects conflicting options and checkpoints during transactions without losing ID progress", () => {
    const doc = createClient(Board, { clientId: "a", onBatch: () => {} });
    const checkpoint = doc.checkpoint();
    assert.throws(() => createClient(Board, {
      clientId: "a", snapshot: checkpoint.snapshot, checkpoint, onBatch: () => {},
    }), /both snapshot and checkpoint/);
    assert.throws(() => createClient(Board, {
      clientId: "other", checkpoint, onBatch: () => {},
    }), /clientId must match/);
    assert.throws(() => doc.transact(() => {
      doc.state.items.push("rolled back");
      doc.checkpoint();
    }), /checkpoint during a transaction/);
    assert.deepEqual(doc.state.items.toArray(), []);
    assert.equal(doc.checkpoint().lastLocalSeq, 0);
    assert.deepEqual(doc.checkpoint().pendingBatches, []);
    assert.equal(doc.checkpoint().lastBunchSeqs.items, 1);
  });

  it("restores exhausted batch sequences and rejects mutations before state or ID changes", () => {
    const max = Number.MAX_SAFE_INTEGER;
    const fresh = createClient(Board, { clientId: "a", onBatch: () => {} }).checkpoint();
    const batches: BoardBatch[] = [];
    const doc = createClient(Board, {
      clientId: "a",
      checkpoint: {
        ...fresh, lastLocalSeq: max - 1,
        snapshot: { ...fresh.snapshot, serverSeq: max - 1 },
      },
      onBatch: (batch) => batches.push(batch),
    });
    doc.state.count.value = 1;
    assert.equal(batches[0]!.seq, max);
    const restored = createClient(Board, {
      clientId: "a", checkpoint: roundTrip(doc.checkpoint()),
      onBatch: () => assert.fail("must not send"),
    });
    for (const client of [doc, restored]) {
      const before = client.checkpoint();
      for (const mutate of [
        () => { client.state.count.value = 2; },
        () => client.state.items.push("invalid"),
        () => client.state.body.insert(0, "invalid"),
        () => client.transact(() => { client.state.count.value = 2; }),
      ]) {
        assert.throws(mutate, /Client sequence exhausted/);
        assert.deepEqual(client.checkpoint(), before);
      }
      client.state.body.insert(0, "");
      client.state.body.delete(0, 0);
      client.transact(() => {});
      assert.deepEqual(client.checkpoint(), before);
      client.receive({
        serverSeq: max, source: { clientId: "a", seq: max },
        operations: batches[0]!.operations,
      });
      assert.equal(client.checkpoint().lastLocalSeq, max);
      assert.deepEqual(client.checkpoint().pendingBatches, []);
      assert.doesNotThrow(() => roundTrip(client.checkpoint()));
    }
  });

  it("preserves exhausted bunch progress without preventing Value edits or deletions", () => {
    const max = Number.MAX_SAFE_INTEGER;
    const base = createClient(Board, { clientId: "a", onBatch: () => {} }).checkpoint();
    const batches: BoardBatch[] = [];
    const doc = createClient(Board, {
      clientId: "a",
      checkpoint: { ...base, lastBunchSeqs: { items: max - 1, body: max - 1 } },
      onBatch: (batch) => batches.push(batch),
    });
    doc.transact(() => {
      doc.state.items.push("last");
      doc.state.body.insert(0, "😀");
    });
    assert.deepEqual(doc.checkpoint().lastBunchSeqs, { items: max, body: max });
    const server = createServer(Board);
    doc.receive(server.receive(batches[0]!).commit);
    const restored = createClient(Board, {
      clientId: "a", checkpoint: roundTrip(doc.checkpoint()),
      onBatch: (batch) => batches.push(batch),
    });
    const before = restored.checkpoint();
    assert.throws(() => restored.state.items.push("new"), /bunch sequence exhausted/);
    assert.throws(() => restored.state.body.insert(1, "new"), /bunch sequence exhausted/);
    assert.deepEqual(restored.checkpoint(), before);
    restored.transact(() => {
      restored.state.count.value = 1;
      restored.state.items.delete(0);
      restored.state.body.delete(0);
    });
    assert.equal(batches[1]!.seq, 2);
    restored.receive(server.receive(batches[1]!).commit);
    assert.deepEqual(restored.checkpoint().snapshot, server.snapshot());
  });
});

describe("client checkpoint decoding", () => {
  it("rejects malformed structure and inconsistent metadata at both restore boundaries", () => {
    const doc = createClient(Board, { clientId: "a", onBatch: () => {} });
    doc.state.count.value = 1;
    doc.state.count.value = 2;
    const checkpoint = doc.checkpoint();
    const [first, second] = checkpoint.pendingBatches;
    for (const field of ["clientId", "snapshot", "lastLocalSeq", "pendingBatches", "lastBunchSeqs"]) {
      const missing: Record<string, unknown> = { ...checkpoint };
      delete missing[field];
      assertInvalid(missing, "/" + field);
    }
    const cases: Array<[unknown, string]> = [
      [null, "/"],
      [{ ...checkpoint, extra: true }, "/extra"],
      [{ ...checkpoint, clientId: "" }, "/clientId"],
      [{ ...checkpoint, clientId: 1 }, "/clientId"],
      [{ ...checkpoint, lastLocalSeq: -1 }, "/lastLocalSeq"],
      [{ ...checkpoint, lastLocalSeq: 0.5 }, "/lastLocalSeq"],
      [{ ...checkpoint, lastLocalSeq: Number.MAX_SAFE_INTEGER + 1 }, "/lastLocalSeq"],
      [{ ...checkpoint, lastLocalSeq: 1 }, "/pendingBatches"],
      [{ ...checkpoint, lastLocalSeq: 3 }, "/snapshot/serverSeq"],
      [{ ...checkpoint, pendingBatches: {} }, "/pendingBatches"],
      [{ ...checkpoint, pendingBatches: new Array(2) }, "/pendingBatches"],
      [{ ...checkpoint, pendingBatches: [{ ...first, clientId: "other" }, second] }, "/pendingBatches/0/clientId"],
      [{ ...checkpoint, pendingBatches: [first, { ...second, seq: 3 }] }, "/pendingBatches/1/seq"],
      [{ ...checkpoint, pendingBatches: [second, first] }, "/pendingBatches/0/seq"],
      [{ ...checkpoint, pendingBatches: [{ ...first, operations: [] }, second] }, "/pendingBatches/0/operations"],
      [{ ...checkpoint, lastBunchSeqs: [] }, "/lastBunchSeqs"],
      [{ ...checkpoint, lastBunchSeqs: { items: 0 } }, "/lastBunchSeqs/body"],
      [{ ...checkpoint, lastBunchSeqs: { items: 0, body: 0, count: 0 } }, "/lastBunchSeqs/count"],
      [{ ...checkpoint, lastBunchSeqs: { items: -1, body: 0 } }, "/lastBunchSeqs/items"],
      [{ ...checkpoint, lastBunchSeqs: { items: 0, body: Infinity } }, "/lastBunchSeqs/body"],
      [{ ...checkpoint, snapshot: { ...checkpoint.snapshot, serverSeq: -1 } }, "/snapshot/serverSeq"],
      [{ ...checkpoint, snapshot: { ...checkpoint.snapshot, data: {} } }, "/snapshot/data/count"],
      [{ ...checkpoint, snapshot: { ...checkpoint.snapshot, data: {
        ...checkpoint.snapshot.data, body: { idList: [], value: "mismatch" },
      } } }, "/snapshot/data/body"],
    ];
    for (const [input, path] of cases) assertInvalid(input, path);
  });

  it("validates pending ID namespaces and stateful replay before exposing a client", () => {
    const doc = createClient(Board, { clientId: "a", onBatch: () => {} });
    doc.transact(() => {
      doc.state.items.push("first");
      doc.state.body.insert(0, "A😀");
    });
    const checkpoint = doc.checkpoint();
    const first = checkpoint.pendingBatches[0]!;
    const insert = first.operations[0]!;
    assert.equal(insert.type, "list/insert");
    if (insert.type !== "list/insert") return;
    const withOperation = (operation: unknown) => ({
      ...checkpoint, pendingBatches: [{ ...first, operations: [operation, first.operations[1]] }],
    });
    const unknown = { bunchId: "unknown", counter: 0 };
    const path = "/pendingBatches/0/operations/0";
    assertInvalid(withOperation({ ...insert, before: unknown }), path);
    assertInvalid(withOperation({ type: "list/delete", path: "items", id: unknown }), path);
    for (const bunchId of [
      "foreign",
      JSON.stringify(["other", "items", 1]),
      JSON.stringify(["a", "body", 1]),
      JSON.stringify(["a", "items", 1]) + " ",
      JSON.stringify(["a", "items", 0]),
    ]) {
      assertInvalid(withOperation({ ...insert, id: { ...insert.id, bunchId } }), path + "/id/bunchId");
    }
    assertInvalid({ ...checkpoint, lastBunchSeqs: { items: 0, body: 1 } }, "/lastBunchSeqs/items");
    assertInvalid({ ...checkpoint, lastBunchSeqs: { items: 1, body: 0 } }, "/lastBunchSeqs/body");
    assertInvalid({
      ...checkpoint, lastLocalSeq: 2,
      pendingBatches: [first, { ...first, seq: 2 }],
    }, "/pendingBatches/1/operations/0");
    assertInvalid(withOperation({
      type: "text/insert", path: "items", before: null, id: insert.id, value: "x",
    }), path + "/path");
    assertInvalid({
      ...checkpoint, pendingBatches: [{ ...first, operations: [{
        type: "text/delete", path: "body",
        ranges: [{ start: unknown, count: Number.MAX_SAFE_INTEGER }],
      }] }],
    }, path);
  });

  it("deeply owns snapshot and pending JSON, operation IDs and ranges", () => {
    const Data = defineDocument({
      meta: value<{ flags: { enabled: boolean }; tags: string[] }>({
        flags: { enabled: false }, tags: [],
      }),
      items: list<{ label: string }>(), body: text(),
    });
    const doc = createClient(Data, { clientId: "a", onBatch: () => {} });
    const server = createServer(Data);
    doc.transact(() => {
      doc.state.meta.value = { flags: { enabled: true }, tags: ["saved"] };
      doc.state.items.push({ label: "saved" });
      doc.state.body.insert(0, "A😀");
    });
    doc.receive(server.receive(doc.checkpoint().pendingBatches[0]!).commit);
    doc.transact(() => {
      doc.state.meta.value = { flags: { enabled: false }, tags: ["pending"] };
      doc.state.items.push({ label: "pending" });
      doc.state.body.delete(0);
    });
    const input = JSON.parse(JSON.stringify(doc.checkpoint())) as {
      snapshot: { data: {
        meta: { flags: { enabled: boolean }; tags: string[] };
        items: { values: Array<{ label: string }> };
      } };
      pendingBatches: Array<{ operations: Array<{
        value?: { flags?: { enabled: boolean }; tags?: string[]; label?: string };
        id?: { counter: number };
        ranges?: Array<{ start: { counter: number }; count: number }>;
      }> }>;
    };
    const checkpoint = decodeClientCheckpoint(Data, input);
    assertDeepFrozen(checkpoint);
    const restored = createClient(Data, { clientId: "a", checkpoint, onBatch: () => {} });
    const expected = JSON.stringify(checkpoint);
    input.snapshot.data.meta.flags.enabled = false;
    input.snapshot.data.meta.tags[0] = "changed";
    input.snapshot.data.items.values[0]!.label = "changed";
    input.pendingBatches[0]!.operations[0]!.value!.tags![0] = "changed";
    input.pendingBatches[0]!.operations[1]!.id!.counter = 99;
    input.pendingBatches[0]!.operations[1]!.value!.label = "changed";
    input.pendingBatches[0]!.operations[2]!.ranges![0]!.count = 99;
    input.pendingBatches[0]!.operations[2]!.ranges![0]!.start.counter = 99;
    assert.equal(JSON.stringify(checkpoint), expected);
    assert.deepEqual(restored.state.meta.value.tags, ["pending"]);
    assert.deepEqual(restored.state.items.toArray(), [{ label: "saved" }, { label: "pending" }]);
    assert.equal(restored.state.body.toString(), "😀");
    const bad = { ...checkpoint, pendingBatches: [{
      ...checkpoint.pendingBatches[0], operations: [{
        type: "value/set", path: "meta", value: { flags: { enabled: undefined } },
      }],
    }] };
    assert.throws(() => decodeClientCheckpoint(Data, bad), (error: unknown) => {
      assert.ok(error instanceof WireDecodeError);
      assert.equal(error.path, "/pendingBatches/0/operations/0/value/flags/enabled");
      return true;
    });
  });
});
