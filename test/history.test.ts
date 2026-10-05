import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createClient,
  createServer,
  decodeServerCheckpoint,
  decodeServerCommit,
  defineDocument,
  list,
  text,
  value as valueSchema,
  WireDecodeError,
  type ClientBatch,
  type DocumentOperation,
  type ServerCheckpoint,
  type ServerCommit,
} from "../src/index.ts";

const Board = defineDocument({ count: valueSchema(0), items: list<string>(), body: text() });
type BoardOperation = DocumentOperation<typeof Board.definition>;
type BoardBatch = ClientBatch<BoardOperation>;
type BoardCommit = ServerCommit<BoardOperation>;
type BoardCheckpoint = ServerCheckpoint<typeof Board.definition>;

function makeBatch(clientId: string, seq: number, count = seq): BoardBatch {
  return { clientId, seq, operations: [{ type: "value/set", path: "count", value: count }] };
}

function sequences(commits: readonly BoardCommit[] | null): number[] | null {
  return commits?.map((commit) => commit.serverSeq) ?? null;
}

function assertCheckpointError(input: unknown, path: string): void {
  assert.throws(() => decodeServerCheckpoint(Board, input), (error: unknown) => {
    assert.ok(error instanceof WireDecodeError);
    assert.equal(error.path, path);
    return true;
  });
  assert.throws(
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Deliberately invalid typed input tests runtime validation; do not decode away the failure under test.
    () => createServer(Board, { checkpoint: input as BoardCheckpoint, historyLimit: 0 }),
    WireDecodeError
  );
}

describe("server history", () => {
  it("returns complete frozen catch-up results and validates watermarks", () => {
    const server = createServer(Board, { historyLimit: 3 });
    assert.deepEqual(server.commitsSince(0), []);
    assert.ok(Object.isFrozen(server.commitsSince(0)));
    for (let seq = 1; seq <= 4; seq++) server.receive(makeBatch("a", seq));
    assert.equal(server.commitsSince(0), null);
    assert.deepEqual(sequences(server.commitsSince(1)), [2, 3, 4]);
    assert.deepEqual(sequences(server.commitsSince(2)), [3, 4]);
    assert.deepEqual(sequences(server.commitsSince(3)), [4]);
    assert.deepEqual(server.commitsSince(4), []);
    assert.ok(Object.isFrozen(server.commitsSince(1)));
    assert.strictEqual(server.commitsSince(3)![0], server.checkpoint().history[2]);
    const before = server.checkpoint();
    for (const invalid of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 5]) {
      assert.throws(() => server.commitsSince(invalid), /watermark/);
      assert.deepEqual(server.checkpoint(), before);
    }
  });

  it("defaults to 1000 commits, supports capacity one and disables history at zero", () => {
    const server = createServer(Board);
    for (let seq = 1; seq <= 1001; seq++) server.receive(makeBatch("a", seq));
    assert.equal(server.checkpoint().history.length, 1000);
    assert.equal(server.commitsSince(0), null);
    assert.equal(server.commitsSince(1)!.length, 1000);
    for (const historyLimit of [0, 1]) {
      const document = createServer(Board, { historyLimit });
      const first = document.receive(makeBatch("a", 1));
      document.receive(makeBatch("b", 1));
      assert.equal(document.checkpoint().history.length, historyLimit);
      assert.equal(document.commitsSince(0), null);
      assert.deepEqual(sequences(document.commitsSince(1)), historyLimit === 0 ? null : [2]);
      assert.deepEqual(document.commitsSince(2), []);
      assert.strictEqual(document.receive(makeBatch("a", 1)).commit, first.commit);
    }
    for (const historyLimit of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, null, "2"]) {
      assert.throws(
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Deliberately invalid typed input tests runtime validation; do not decode away the failure under test.
        () => createServer(Board, { historyLimit: historyLimit as number }),
        /historyLimit/
      );
    }
  });

  it("records policy outcomes once and keeps history atomic on receive failures", () => {
    let mode: "accept" | "reject" | "transform" | "throw" | "invalid" | "non-array" | "reentrant" = "accept";
    let calls = 0;
    const observed: BoardCheckpoint[] = [];
    const server = createServer(Board, {
      historyLimit: 2,
      resolve: ({ batch, snapshot }): readonly BoardOperation[] => {
        calls++;
        assert.deepEqual(server.snapshot(), snapshot);
        const checkpoint = server.checkpoint();
        assert.deepEqual(server.commitsSince(Math.max(0, snapshot.serverSeq - 2)), checkpoint.history);
        observed.push(checkpoint);
        if (mode === "throw") throw new Error("policy failed");
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Deliberately invalid typed input tests runtime validation; do not decode away the failure under test.
        if (mode === "non-array") return null as unknown as BoardOperation[];
        if (mode === "reentrant") server.receive(batch);
        if (mode === "invalid") {
          return [{ type: "list/delete", path: "items", id: { bunchId: "unknown", counter: 0 } }];
        }
        if (mode === "reject") return [];
        if (mode === "transform") return [{ type: "value/set", path: "count", value: 5 }];
        return batch.operations;
      },
    });
    server.receive(makeBatch("a", 1));
    mode = "reject";
    const rejected = server.receive(makeBatch("a", 2));
    mode = "transform";
    const transformed = server.receive(makeBatch("a", 3));
    assert.deepEqual(server.commitsSince(1), [rejected.commit, transformed.commit]);
    assert.deepEqual(rejected.commit.operations, []);
    assert.equal(server.snapshot().data.count, 5);
    const checkpoint = server.checkpoint();
    assert.equal(server.receive(makeBatch("a", 3)).replayed, true);
    assert.equal(calls, 3);
    assert.deepEqual(server.checkpoint(), checkpoint);
    assert.deepEqual(observed.map((entry) => entry.snapshot.serverSeq), [0, 1, 2]);
    for (const failure of ["throw", "invalid", "non-array", "reentrant"] as const) {
      mode = failure;
      assert.throws(() => server.receive(makeBatch("a", 4)));
      assert.deepEqual(server.checkpoint(), checkpoint);
    }
    assert.throws(() => server.receive(makeBatch("a", 5)), /Expected client sequence/);
    assert.throws(() => server.receive(makeBatch("a", 3, 99)), /Retry batch differs/);
    assert.deepEqual(server.checkpoint(), checkpoint);
    mode = "accept";
    assert.equal(server.receive(makeBatch("a", 4)).commit.serverSeq, 4);
    assert.deepEqual(sequences(server.commitsSince(2)), [3, 4]);
  });

  it("catches up remote commits and an own acknowledgement with pending replay", () => {
    const server = createServer(Board);
    const aBatches: BoardBatch[] = [];
    const bBatches: BoardBatch[] = [];
    const a = createClient(Board, { clientId: "a", onBatch: (batch) => aBatches.push(batch) });
    const b = createClient(Board, { clientId: "b", onBatch: (batch) => bBatches.push(batch) });
    a.state.count.value = 10;
    a.state.items.push("pending"); // Remains pending after the first own commit.
    b.state.body.insert(0, "Hi 😀");
    const remote = server.receive(bBatches[0]!).commit;
    b.receive(remote);
    b.state.count.value = 2;
    const secondRemote = server.receive(bBatches[1]!).commit;
    b.receive(secondRemote);
    const own = server.receive(aBatches[0]!);
    b.receive(own.commit);
    const retry = server.receive(aBatches[0]!);
    assert.equal(retry.replayed, true);
    const commits = server.commitsSince(0)!;
    const views: number[] = [];
    let watermark = 0;
    for (const commit of commits) {
      a.receive(decodeServerCommit(Board, JSON.parse(JSON.stringify(commit))));
      watermark = commit.serverSeq;
      views.push(a.state.count.value);
      assert.deepEqual(a.state.items.toArray(), ["pending"]);
    }
    assert.deepEqual(views, [10, 10, 10]);
    assert.equal(watermark, retry.commit.serverSeq); // Retry is already included; do not deliver twice.
    const listCommit = server.receive(aBatches[1]!).commit;
    a.receive(listCommit);
    b.receive(listCommit);
    assert.equal(a.state.count.value, b.state.count.value);
    assert.equal(a.state.body.toString(), b.state.body.toString());
    assert.deepEqual(a.state.items.toArray(), b.state.items.toArray());
    assert.deepEqual(server.commitsSince(listCommit.serverSeq), []);
  });

  it("keeps returned history and checkpoints point-in-time", () => {
    const server = createServer(Board, { historyLimit: 2 });
    const first = server.receive(makeBatch("a", 1)).commit;
    const history = server.commitsSince(0)!;
    const checkpoint = server.checkpoint();
    assert.ok(Object.isFrozen(checkpoint.history));
    assert.ok(Object.isFrozen(history));
    assert.notStrictEqual(history, checkpoint.history);
    assert.strictEqual(history[0], first);
    server.receive(makeBatch("a", 2));
    server.receive(makeBatch("a", 3));
    assert.deepEqual(history, [first]);
    assert.deepEqual(checkpoint.history, [first]);
    assert.equal(checkpoint.snapshot.serverSeq, 1);
    assert.equal(server.commitsSince(0), null);
  });

  it("restores and resizes only retained history without changing retry results", () => {
    const server = createServer(Board, { historyLimit: 3 });
    for (let seq = 1; seq <= 5; seq++) server.receive(makeBatch("a", seq));
    const checkpoint = decodeServerCheckpoint(Board, JSON.parse(JSON.stringify(server.checkpoint())));
    assert.deepEqual(sequences(checkpoint.history), [3, 4, 5]);
    for (const historyLimit of [undefined, 0, 1, 10]) {
      const restored = createServer(Board, {
        checkpoint,
        ...(historyLimit === undefined ? {} : { historyLimit }),
      });
      const expected = historyLimit === 0 ? [] : historyLimit === 1 ? [5] : [3, 4, 5];
      assert.deepEqual(sequences(restored.checkpoint().history), expected);
      assert.deepEqual(restored.snapshot(), checkpoint.snapshot);
      assert.equal(restored.receive(makeBatch("a", 5)).replayed, true);
      assert.deepEqual(sequences(restored.checkpoint().history), expected);
      assert.equal(restored.commitsSince(1), null);
      assert.equal(restored.receive(makeBatch("a", 6)).commit.serverSeq, 6);
    }
    const withoutHistory = { ...checkpoint, history: [] };
    const restored = createServer(Board, { checkpoint: withoutHistory });
    assert.equal(restored.commitsSince(4), null);
    assert.deepEqual(restored.commitsSince(5), []);
    restored.receive(makeBatch("a", 6));
    assert.deepEqual(sequences(restored.commitsSince(5)), [6]);
    assert.equal(restored.commitsSince(4), null);
    assert.deepEqual(createServer(Board).checkpoint().history, []);
  });
});

describe("history checkpoint decoding", () => {
  it("rejects invalid containers, discontinuous history, and inconsistent replay sources", () => {
    const server = createServer(Board);
    const a1 = server.receive(makeBatch("a", 1)).commit;
    const b1 = server.receive(makeBatch("b", 1)).commit;
    const a2 = server.receive(makeBatch("a", 2)).commit;
    const b2 = server.receive(makeBatch("b", 2)).commit;
    const checkpoint = server.checkpoint();
    const withHistory = (history: unknown) => ({ ...checkpoint, history });
    const cases: Array<[unknown, string]> = [
      [{ snapshot: checkpoint.snapshot, replays: checkpoint.replays }, "/history"],
      [{ ...checkpoint, extra: true }, "/extra"],
      [withHistory(null), "/history"],
      [withHistory({}), "/history"],
      [withHistory(new Array(4)), "/history"],
      [withHistory([{ ...a1, extra: true }, b1, a2, b2]), "/history/0/extra"],
      [withHistory([{ ...a1, operations: [{ type: "bogus", path: "count" }] }, b1, a2, b2]), "/history/0/operations/0/type"],
      [withHistory([a1, b1, { ...a2, serverSeq: 4 }, b2]), "/history/2/serverSeq"],
      [withHistory([a1, a2, b1, b2]), "/history/1/serverSeq"],
      [withHistory([a1, b1, a2]), "/history/0/serverSeq"],
      [withHistory([{ ...a1, source: { clientId: "missing", seq: 1 } }, b1, a2, b2]), "/history/0/source/clientId"],
      [withHistory([a1, b1, { ...a2, source: { clientId: "a", seq: 3 } }, b2]), "/history/2/source/seq"],
      [withHistory([a1, b1, { ...a2, operations: [] }, b2]), "/history/2"],
      [withHistory([{ ...b2, source: { clientId: "b", seq: 3 } }]), "/history/0"],
      [withHistory([{ ...a2, serverSeq: 4 }]), "/history/0"],
      [withHistory([{ ...b1, serverSeq: 3 }, b2]), "/history/0"],
    ];
    for (const [input, path] of cases) assertCheckpointError(input, path);
    assert.deepEqual(decodeServerCheckpoint(Board, withHistory([a2, b2])).history, [a2, b2]);
    assert.deepEqual(decodeServerCheckpoint(Board, withHistory([])).history, []);
    assert.deepEqual(sequences(createServer(Board, {
      checkpoint: decodeServerCheckpoint(Board, withHistory([a2, b2])),
    }).commitsSince(2)), [3, 4]);
  });

  it("accepts equivalent JSON key order and deeply owns historical payloads, IDs, and ranges", () => {
    const Data = defineDocument({
      payload: valueSchema<{ a: number[]; b: { enabled: boolean } }>({ a: [], b: { enabled: false } }),
      items: list<{ label: string }>(),
      body: text(),
    });
    type DataBatch = ClientBatch<DocumentOperation<typeof Data.definition>>;
    const batches: DataBatch[] = [];
    const doc = createClient(Data, { clientId: "a", onBatch: (batch) => batches.push(batch) });
    const server = createServer(Data);
    doc.transact(() => {
      doc.state.payload.value = { a: [1], b: { enabled: true } };
      doc.state.items.push({ label: "gone" });
      doc.state.body.insert(0, "A😀");
    });
    doc.receive(server.receive(batches[0]!).commit);
    doc.transact(() => {
      doc.state.payload.value = { a: [2], b: { enabled: false } };
      doc.state.items.delete(0);
      doc.state.body.delete(0, 1);
    });
    server.receive(batches[1]!);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Known JSON fixture is made mutable to verify ownership or inject corruption; production decoders are tested separately.
    const input = JSON.parse(JSON.stringify(server.checkpoint())) as {
      history: Array<{ operations: Array<{
        value?: { a?: number[]; b?: { enabled: boolean }; label?: string };
        id?: { counter: number };
        ranges?: Array<{ start: { counter: number }; count: number }>;
      }> }>;
    };
    input.history[1]!.operations[0]!.value = { b: { enabled: false }, a: [2] };
    const checkpoint = decodeServerCheckpoint(Data, input);
    const assertFrozen = (value: unknown): void => {
      if (value === null || typeof value !== "object") return;
      assert.ok(Object.isFrozen(value));
      for (const child of Object.values(value)) assertFrozen(child);
    };
    assertFrozen(checkpoint);
    const expected = JSON.stringify(checkpoint);
    input.history[0]!.operations[0]!.value!.a![0] = 99;
    input.history[0]!.operations[1]!.value!.label = "changed";
    input.history[0]!.operations[1]!.id!.counter = 99;
    input.history[1]!.operations[2]!.ranges![0]!.start.counter = 99;
    input.history[1]!.operations[2]!.ranges![0]!.count = 99;
    assert.equal(JSON.stringify(checkpoint), expected);
    const restored = createServer(Data, { checkpoint });
    assert.equal(restored.snapshot().data.body.value, "😀");
    assert.deepEqual(restored.snapshot().data.items.values, []);
    assert.ok(restored.snapshot().data.body.idList.some((range) => range.isDeleted));
    assert.ok(restored.snapshot().data.items.idList.some((range) => range.isDeleted));
    assert.deepEqual(restored.commitsSince(0), checkpoint.history);
    const late = createClient(Data, {
      clientId: "late", snapshot: restored.snapshot(), onBatch: () => {},
    });
    const next = restored.receive({ clientId: "new", seq: 1, operations: [{
      type: "text/insert", path: "body",
      before: batches[0]!.operations.find((operation) => operation.type === "text/insert")!.id,
      id: { bunchId: "after-tombstone", counter: 0 }, value: "B",
    }] }).commit;
    late.receive(next);
    assert.equal(late.state.body.toString(), restored.snapshot().data.body.value);
  });
});
