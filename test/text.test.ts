import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { IdList } from "articulated";
import { TextState } from "../src/text.ts";

import {
  createClient,
  createServer,
  decodeClientCheckpoint,
  decodeServerCheckpoint,
  decodeServerCommit,
  decodeSnapshot,
  defineDocument,
  list,
  text,
  value,
  type ClientBatch,
  type DocumentOperation,
  type DocumentSnapshot,
  type TextDeleteOperation,
  type TextInsertOperation,
  type TextOperation,
} from "../src/index.ts";

const Note = defineDocument({
  title: value("Draft"),
  tags: list<string>(),
  body: text(),
});

type NoteOperation = DocumentOperation<typeof Note.definition>;
type NoteBatch = ClientBatch<NoteOperation>;

function setup(clientId = "client-1") {
  const batches: NoteBatch[] = [];
  const doc = createClient(Note, {
    clientId,
    onBatch: (batch) => batches.push(batch),
  });
  return { batches, doc };
}

describe("text runtime", () => {
  it("saves only the surrogate boundaries needed to preserve visible elements", () => {
    for (const elements of [[], ["A", "😀", "🦊"], ["\ud83d"], ["\ude00"],
      ["A", "😀", "\ud83d", "\ude00", "\ud800", "\udc00", "\ude00", "\ud83d"]]) {
      let state = TextState.empty();
      for (const [counter, element] of elements.entries()) state = state.insert({
        type: "text/insert", path: "body", before: counter === 0 ? null : { bunchId: "seed", counter: counter - 1 },
        id: { bunchId: "seed", counter }, value: element,
      });
      const saved = state.save();
      assert.ok(Object.isFrozen(saved) && Object.isFrozen(saved.idList));
      assert.equal(saved.value, elements.join(""));
      if (elements.length === 8) {
        assert.deepEqual(saved.surrogateBoundaries, [4, 6]);
        assert.ok(Object.isFrozen(saved.surrogateBoundaries));
      } else {
        assert.equal(Object.hasOwn(saved, "surrogateBoundaries"), false);
        assert.equal(JSON.stringify(saved), JSON.stringify({ idList: saved.idList, value: elements.join("") }));
      }
      const restored = TextState.load(saved);
      assert.deepEqual([...restored.values()], elements);
      assert.equal(restored.length, elements.length);
      assert.ok(state.visibleEquals(restored));
    }
  });

  it("updates surrogate boundaries after deletions while retaining tombstones", () => {
    const base = TextState.empty().insert({ type: "text/insert", path: "body", before: null,
      id: { bunchId: "seed", counter: 0 }, value: "A😀\ud83dX\ude00" });
    const remove = (state: TextState, counter: number, count = 1) => state.delete({
      type: "text/delete", path: "body", ranges: [{ start: { bunchId: "seed", counter }, count }],
    });
    const joined = remove(base, 3);
    assert.deepEqual(joined.save().surrogateBoundaries, [4]);
    assert.deepEqual([...TextState.load(joined.save()).values()], ["A", "😀", "\ud83d", "\ude00"]);
    const shifted = remove(TextState.load(joined.save()), 0, 2);
    assert.deepEqual(shifted.save().surrogateBoundaries, [1]);
    const lone = remove(TextState.load(shifted.save()), 2);
    assert.equal(Object.hasOwn(lone.save(), "surrogateBoundaries"), false);
    assert.deepEqual([...TextState.load(lone.save()).values()], ["\ude00"]);
    assert.ok(lone.save().idList.some((range) => range.isDeleted));
    assert.deepEqual(base.save(), { idList: base.save().idList, value: "A😀\ud83dX\ude00" });
  });

  it("restores client and server element boundaries, pending work, retries and late joins", () => {
    const roundTrip = (input: unknown): unknown => JSON.parse(JSON.stringify(input));
    let server = createServer(Note);
    const clientId = server.openClient();
    const { doc: original, batches } = setup(clientId);
    original.transact(() => {
      original.state.body.insert(0, "A😀\ud83dX\ude00");
      original.state.body.delete(3);
    });
    const first = server.receive(batches[0]!);
    original.receive(decodeServerCommit(Note, roundTrip(first.commit)));
    original.state.body.insert(original.state.body.length, "\ud800");
    original.state.body.insert(original.state.body.length, "\udc00");
    const clientSave = decodeClientCheckpoint(Note, roundTrip(original.checkpoint()));
    const serverSave = decodeServerCheckpoint(Note, roundTrip(server.checkpoint()));
    assert.deepEqual(clientSave.snapshot.data.body.surrogateBoundaries, [4]);
    assert.equal(clientSave.pendingBatches.length, 2);
    const emitted: NoteBatch[] = [];
    const restored = createClient(Note, { clientId, checkpoint: clientSave, onBatch: (batch) => emitted.push(batch) });
    server = createServer(Note, { checkpoint: serverSave });
    assert.deepEqual(restored.checkpoint(), clientSave);
    assert.deepEqual([...restored.state.body], [...original.state.body]);
    assert.equal(emitted.length, 0);
    assert.deepEqual(server.receive(batches[0]!), { ...first, replayed: true });
    const late = createClient(Note, { clientId: server.openClient(),
      snapshot: decodeSnapshot(Note, roundTrip(server.snapshot())), onBatch() {} });
    while (restored.checkpoint().pendingBatches.length !== 0) {
      const receipt = server.receive(restored.checkpoint().pendingBatches[0]!);
      for (const doc of [restored, late]) doc.receive(decodeServerCommit(Note, roundTrip(receipt.commit)));
    }
    assert.deepEqual([...restored.state.body], ["A", "😀", "\ud83d", "\ude00", "\ud800", "\udc00"]);
    assert.deepEqual([...late.state.body], [...restored.state.body]);
    assert.deepEqual(restored.checkpoint().snapshot, server.snapshot());
    assert.deepEqual(restored.checkpoint().lastBunchSeqs, clientSave.lastBunchSeqs);
    assert.equal(restored.replayConflict, null);
    restored.state.body.delete(2);
    const deletion = emitted.at(-1)!;
    assert.equal(deletion.seq, clientSave.lastLocalSeq + 1);
    const commit = server.receive(deletion).commit;
    restored.receive(commit);
    for (const next of server.commitsSince(late.checkpoint().snapshot.serverSeq)!) late.receive(next);
    assert.deepEqual([...late.state.body], [...restored.state.body]);
    restored.state.body.insert(restored.state.body.length, "🦊");
    assert.ok(restored.checkpoint().lastBunchSeqs.body > clientSave.lastBunchSeqs.body);
    const last = server.receive(emitted.at(-1)!).commit;
    restored.receive(last); late.receive(last);
    assert.deepEqual(restored.checkpoint().snapshot, server.snapshot());
    assert.deepEqual([...late.state.body], [...restored.state.body]);
  });

  it("compares final Unicode targets across bunches, overlaps and cancelled insertions", () => {
    const seed: TextInsertOperation = { type: "text/insert", path: "body", before: null,
      id: { bunchId: "base", counter: 0 }, value: "A😀BC" };
    const base = TextState.empty().insert(seed);
    assert.ok(base.visibleEqualsAt(TextState.load(base.save()), [seed]));
    assert.equal(base.visibleEqualsAt(TextState.load({ ...base.save(), value: "A🦊BC" }), [seed]), false);
    const insert: TextInsertOperation = { type: "text/insert", path: "body",
      before: { bunchId: "base", counter: 1 }, id: { bunchId: "temporary", counter: 0 }, value: "🦊Q" };
    const cancel: TextDeleteOperation = { type: "text/delete", path: "body", ranges: [
      { start: insert.id, count: 1 }, { start: insert.id, count: 2 },
    ] };
    const cancelled = base.insert(insert).delete(cancel);
    assert.ok(base.visibleEqualsAt(cancelled, [insert, cancel]));
    assert.ok(base.visibleEquals(cancelled));
    const restored = TextState.load(cancelled.save());
    assert.ok(cancelled.visibleEqualsAt(restored, [cancel]));
    assert.ok(cancelled.visibleEqualsAt(cancelled, []));

    const deletion: TextDeleteOperation = { type: "text/delete", path: "body", ranges: [
      { start: { bunchId: "base", counter: 1 }, count: 2 }, ...cancel.ranges,
    ] };
    const replacement: TextInsertOperation = { ...insert, id: { bunchId: "replacement", counter: 0 },
      before: { bunchId: "base", counter: 0 }, value: "😀B" };
    const replaced = cancelled.delete(deletion).insert(replacement);
    assert.equal(replaced.toString(), cancelled.toString());
    assert.equal(cancelled.visibleEqualsAt(replaced, [deletion, replacement]), false);
    assert.equal(cancelled.visibleEquals(replaced), false);
    assert.equal(base.visibleEqualsAt(base.insert(insert), [insert]), false);
    assert.equal(base.toString(), "A😀BC");
  });

  it("stops targeted Text comparison at the first differing ID", (t) => {
    const base = TextState.empty().insert({ type: "text/insert", path: "body", before: null,
      id: { bunchId: "base", counter: 0 }, value: "A😀B" });
    const deletion: TextDeleteOperation = { type: "text/delete", path: "body",
      ranges: [{ start: { bunchId: "base", counter: 2 }, count: 1 }] };
    const insertion: TextInsertOperation = { type: "text/insert", path: "body",
      before: { bunchId: "base", counter: 1 }, id: { bunchId: "next", counter: 0 }, value: "B" };
    const operations: readonly TextOperation[] = [deletion, insertion];
    const next = base.delete(deletion).insert(insertion);
    const has = t.mock.method(IdList.prototype, "has");
    assert.equal(base.visibleEqualsAt(next, operations), false);
    assert.equal(has.mock.calls.length, 2);
    has.mock.restore();
    assert.equal(base.toString(), next.toString());
  });

  it("rejects rounded range overflow atomically in typed receive and policy output", () => {
    for (const mode of ["typed", "policy"] as const) {
      let overflow = true;
      const server = createServer(Note, mode === "policy" ? {
        resolve: ({ batch }) => batch.operations.map((operation) =>
          operation.type === "text/insert" ? { ...operation, id: {
            ...operation.id, counter: overflow ? Number.MAX_SAFE_INTEGER : Number.MAX_SAFE_INTEGER - 1,
          } } : operation),
      } : {});
      const clientId = server.openClient();
      const batch = (counter: number): NoteBatch => ({ clientId, seq: 1, operations: [
        { type: "value/set", path: "title", value: "Ready" },
        { type: "text/insert", path: "body", before: null,
          id: { bunchId: JSON.stringify([clientId, "body", 1]), counter }, value: "A😀" },
      ] });
      const before = server.checkpoint();
      assert.throws(() => server.receive(batch(mode === "typed" ? Number.MAX_SAFE_INTEGER : 0)));
      assert.deepEqual(server.checkpoint(), before);

      const observer = createClient(Note, { clientId: "observer", onBatch() {} });
      const clientBefore = observer.checkpoint();
      let changes = 0;
      observer.on("change", () => changes++);
      assert.throws(() => observer.receive({ serverSeq: 1, source: { clientId, seq: 1 },
        operations: batch(Number.MAX_SAFE_INTEGER).operations,
      }));
      assert.deepEqual(observer.checkpoint(), clientBefore);
      assert.equal(changes, 0);

      overflow = false;
      const receipt = server.receive(batch(mode === "typed" ? Number.MAX_SAFE_INTEGER - 1 : 0));
      assert.equal(receipt.commit.serverSeq, 1);
      observer.receive(receipt.commit);
      assert.equal(observer.state.body.toString(), "A😀");
      assert.equal(changes, 1);
      const checkpoint = decodeServerCheckpoint(Note, server.checkpoint());
      const restored = createServer(Note, { checkpoint });
      assert.deepEqual(restored.snapshot(), server.snapshot());
      assert.equal(restored.snapshot().data.body.value, "A😀");

      const saved = server.checkpoint();
      assert.throws(() => server.receive({ clientId, seq: 2, operations: [
        { type: "value/set", path: "title", value: "Broken" },
        { type: "text/delete", path: "body", ranges: [{
          start: { bunchId: JSON.stringify([clientId, "body", 1]), counter: Number.MAX_SAFE_INTEGER }, count: 2,
        }] },
      ] }));
      assert.deepEqual(server.checkpoint(), saved);
      assert.equal(server.receive({ clientId, seq: 2, operations: [{ type: "text/delete", path: "body",
        ranges: [{ start: { bunchId: JSON.stringify([clientId, "body", 1]), counter: Number.MAX_SAFE_INTEGER }, count: 1 }],
      }] }).commit.serverSeq, 2);
      assert.equal(server.snapshot().data.body.value, "A");
    }
  });

  it("retains state identity for tombstone-only deletes after validating every target", () => {
    const state = TextState.empty().insert({ type: "text/insert", path: "body", before: null,
      id: { bunchId: "base", counter: 0 }, value: "A😀B" });
    const operation: TextDeleteOperation = { type: "text/delete", path: "body",
      ranges: [{ start: { bunchId: "base", counter: 1 }, count: 1 }] };
    const deleted = state.delete(operation);
    const saved = deleted.save();
    assert.strictEqual(deleted.delete(operation), deleted);
    assert.throws(() => deleted.delete({ ...operation, ranges: [
      ...operation.ranges, { start: { bunchId: "missing", counter: 0 }, count: 1 },
    ] }));
    assert.deepEqual(deleted.save(), saved);
    const changed = deleted.delete({ ...operation, ranges: [
      ...operation.ranges, { start: { bunchId: "base", counter: 2 }, count: 1 },
    ] });
    assert.notStrictEqual(changed, deleted);
    assert.equal(changed.toString(), "A");
    assert.equal(state.toString(), "A😀B");
  });

  it("isolates Unicode bulk branches and round-trips tombstones", () => {
    const base = TextState.empty().insert({ type: "text/insert", path: "body", before: null,
      id: { bunchId: "base", counter: 0 }, value: "A😀BC" });
    const saved = base.save();
    const left = base.insert({ type: "text/insert", path: "body",
      before: { bunchId: "base", counter: 1 }, id: { bunchId: "left", counter: 0 }, value: "🦊é" });
    const right = base.delete({ type: "text/delete", path: "body",
      ranges: [{ start: { bunchId: "base", counter: 1 }, count: 1 }] });
    const deleted = left.delete({ type: "text/delete", path: "body", ranges: [
      { start: { bunchId: "base", counter: 2 }, count: 2 },
      { start: { bunchId: "left", counter: 0 }, count: 1 },
    ] });
    assert.equal(base.toString(), "A😀BC");
    assert.equal(left.toString(), "A😀🦊éBC");
    assert.equal(right.toString(), "ABC");
    assert.equal(deleted.toString(), "A😀é");
    assert.equal(deleted.length, 4);
    assert.deepEqual(base.save(), saved);
    const restored = TextState.load(deleted.save());
    assert.deepEqual(restored.save(), deleted.save());
    assert.ok(deleted.visibleEquals(restored));
    assert.equal(restored.insert({ type: "text/insert", path: "body",
      before: { bunchId: "left", counter: 0 }, id: { bunchId: "later", counter: 0 }, value: "Z" }).toString(), "A😀Zé");
    assert.equal(deleted.toString(), "A😀é");
  });

  it("rejects late invalid range targets before mutating persistent storage", () => {
    const state = TextState.load({ idList: [
      { bunchId: "base", startCounter: 0, count: 2, isDeleted: false },
      { bunchId: "base", startCounter: 3, count: 1, isDeleted: false },
    ], value: "A😀Z" });
    const saved = state.save();
    assert.throws(() => state.insert({ type: "text/insert", path: "body", before: null,
      id: { bunchId: "base", counter: 2 }, value: "BQ" }));
    assert.throws(() => state.delete({ type: "text/delete", path: "body", ranges: [
      { start: { bunchId: "base", counter: 0 }, count: 1 },
      { start: { bunchId: "missing", counter: 0 }, count: 1 },
    ] }));
    assert.throws(() => state.delete({ type: "text/delete", path: "body",
      ranges: [{ start: { bunchId: "base", counter: 1 }, count: 3 }] }));
    assert.deepEqual(state.save(), saved);
    assert.equal(state.toString(), "A😀Z");
    assert.equal(state.delete({ type: "text/delete", path: "body",
      ranges: [{ start: { bunchId: "base", counter: 3 }, count: 1 }] }).toString(), "A😀");
    assert.deepEqual(state.save(), saved);
  });

  it("edits and iterates Unicode code points with validated no-ops", () => {
    const { batches, doc } = setup();
    let changes = 0;
    doc.on("change", () => changes++);

    const initialLength: number = doc.state.body.length;
    assert.equal(initialLength, 0);
    assert.equal(doc.state.body.toString(), "");

    doc.state.body.insert(0, "A😀B");
    assert.equal(doc.state.body.length, 3);
    assert.equal(doc.state.body.toString(), "A😀B");
    assert.deepEqual([...doc.state.body.values()], ["A", "😀", "B"]);
    assert.deepEqual([...doc.state.body], ["A", "😀", "B"]);

    const insert = batches[0]!.operations[0];
    assert.equal(insert?.type, "text/insert");
    if (insert?.type === "text/insert") {
      assert.ok(Object.isFrozen(insert));
      assert.ok(Object.isFrozen(insert.id));
    }

    doc.state.body.delete(1);
    assert.equal(doc.state.body.toString(), "AB");
    const deletion = batches[1]!.operations[0];
    assert.equal(deletion?.type, "text/delete");
    if (deletion?.type === "text/delete") {
      assert.ok(Object.isFrozen(deletion));
      assert.ok(Object.isFrozen(deletion.ranges));
      assert.ok(Object.isFrozen(deletion.ranges[0]));
      assert.ok(Object.isFrozen(deletion.ranges[0]?.start));
    }

    doc.state.body.insert(2, "");
    doc.state.body.delete(2, 0);
    assert.equal(batches.length, 2);
    assert.equal(changes, 2);

    assert.throws(() => doc.state.body.insert(3, "x"), /out of bounds/i);
    assert.throws(() => doc.state.body.delete(2), /out of bounds/i);
    assert.throws(() => doc.state.body.delete(0, -1), /Invalid delete count/);
    assert.throws(() => doc.state.body.delete(1, 2), /out of bounds/i);
    assert.throws(() => doc.state.body.delete(0.5, 0), /out of bounds/i);
    assert.equal(batches.length, 2);
    assert.equal(doc.state.body.toString(), "AB");
  });

  it("groups mixed collections and rolls back a failed transaction", () => {
    const { batches, doc } = setup();
    let changes = 0;
    doc.on("change", () => changes++);

    doc.transact(() => {
      doc.state.title.value = "Ready";
      doc.state.tags.push("text");
      doc.state.body.insert(0, "Hello 😀");
    });

    assert.equal(batches.length, 1);
    assert.deepEqual(
      batches[0]!.operations.map((operation) => operation.type),
      ["value/set", "list/insert", "text/insert"]
    );
    assert.equal(changes, 1);
    assert.equal(doc.state.body.toString(), "Hello 😀");

    assert.throws(() => {
      doc.transact(() => {
        doc.state.title.value = "Broken";
        doc.state.tags.delete(0);
        doc.state.body.delete(0, 6);
        throw new Error("stop");
      });
    }, /stop/);

    assert.equal(batches.length, 1);
    assert.equal(changes, 1);
    assert.equal(doc.state.title.value, "Ready");
    assert.deepEqual(doc.state.tags.toArray(), ["text"]);
    assert.equal(doc.state.body.toString(), "Hello 😀");
  });

  it("bulk-inserts consecutive ids and compresses delete targets into ranges", () => {
    const { batches, doc } = setup();

    doc.state.body.insert(0, "ab");
    const firstInsert = batches[0]!.operations[0];
    assert.equal(firstInsert?.type, "text/insert");
    if (firstInsert?.type === "text/insert") {
      assert.equal(firstInsert.id.counter, 0);
      // oxlint-disable-next-line typescript/no-misused-spread -- Text deliberately uses Unicode code points, not grapheme clusters.
      assert.equal([...firstInsert.value].length, 2);
    }

    const compression = setup("compression-client");
    compression.doc.state.body.insert(0, "abc");
    compression.doc.state.body.delete(0, 3);
    const compressionInsert = compression.batches[0]!.operations[0];
    const compressedDeletion = compression.batches[1]!.operations[0];
    assert.equal(compressionInsert?.type, "text/insert");
    assert.equal(compressedDeletion?.type, "text/delete");
    if (
      compressionInsert?.type === "text/insert" &&
      compressedDeletion?.type === "text/delete"
    ) {
      assert.deepEqual(compressedDeletion.ranges, [
        { start: compressionInsert.id, count: 3 },
      ]);
    }

    doc.state.body.insert(1, "X");
    doc.state.body.delete(0, 3);

    const deletion = batches[2]!.operations[0];
    assert.equal(deletion?.type, "text/delete");
    if (deletion?.type === "text/delete") {
      assert.deepEqual(
        deletion.ranges.map(({ start, count }) => ({
          bunchId: start.bunchId,
          counter: start.counter,
          count,
        })),
        [
          { bunchId: '["client-1","body",1]', counter: 0, count: 1 },
          { bunchId: '["client-1","body",2]', counter: 0, count: 1 },
          { bunchId: '["client-1","body",1]', counter: 1, count: 1 },
        ]
      );
    }
    assert.equal(doc.state.body.toString(), "");
  });

  it("acknowledges, rejects, and transforms optimistic text mutations", () => {
    type Decision = "accept" | "reject" | "uppercase";
    let decision: Decision = "accept";
    const server = createServer(Note, {
      resolve: ({ batch }) => {
        if (decision === "reject") return [];
        if (decision === "uppercase") {
          return batch.operations.map((operation) =>
            operation.type === "text/insert"
              ? { ...operation, value: operation.value.toUpperCase() }
              : operation
          );
        }
        return batch.operations;
      },
    });
    assert.equal(server.openClient(), "client-1");
    const { batches, doc } = setup();
    const serverChanges: string[] = [];
    doc.on("change", (event) => {
      if (event.origin === "server") {
        serverChanges.push(doc.state.body.toString());
      }
    });

    doc.state.body.insert(0, "a");
    doc.receive(server.receive(batches[0]!).commit);
    assert.deepEqual(serverChanges, []);

    decision = "reject";
    doc.state.body.insert(1, "b");
    doc.receive(server.receive(batches[1]!).commit);
    assert.equal(doc.state.body.toString(), "a");

    doc.state.body.delete(0);
    doc.receive(server.receive(batches[2]!).commit);
    assert.equal(doc.state.body.toString(), "a");

    decision = "uppercase";
    doc.state.body.insert(1, "c");
    doc.receive(server.receive(batches[3]!).commit);
    assert.equal(doc.state.body.toString(), "aC");
    assert.deepEqual(serverChanges, ["a", "a", "aC"]);
  });

  it("replays insertion after a deleted anchor and hydrates its tombstone", () => {
    const server = createServer(Note);
    assert.equal(server.openClient(), "client-1");
    assert.equal(server.openClient(), "client-2");
    assert.equal(server.openClient(), "client-3");
    const client1Batches: NoteBatch[] = [];
    const client2Batches: NoteBatch[] = [];
    const client1 = createClient(Note, {
      clientId: "client-1",
      onBatch: (batch) => client1Batches.push(batch),
    });
    const client2 = createClient(Note, {
      clientId: "client-2",
      onBatch: (batch) => client2Batches.push(batch),
    });

    client1.state.body.insert(0, "A");
    const baseCommit = server.receive(client1Batches[0]!).commit;
    client1.receive(baseCommit);
    client2.receive(baseCommit);

    client1.state.body.insert(1, "B");
    client2.state.body.delete(0);

    const deleteCommit = server.receive(client2Batches[0]!).commit;
    client1.receive(deleteCommit);
    client2.receive(deleteCommit);
    assert.equal(client1.state.body.toString(), "B");
    assert.equal(client2.state.body.toString(), "");

    const snapshot = server.snapshot();
    const lateClient = createClient(Note, {
      clientId: "client-3",
      snapshot,
      onBatch: () => {},
    });
    assert.equal(lateClient.state.body.toString(), "");
    assert.equal(snapshot.data.body.idList[0]?.isDeleted, true);

    const insertCommit = server.receive(client1Batches[1]!).commit;
    client1.receive(insertCommit);
    client2.receive(insertCommit);
    lateClient.receive(insertCommit);

    assert.equal(insertCommit.serverSeq, 3);
    assert.equal(client1.state.body.toString(), "B");
    assert.equal(client2.state.body.toString(), "B");
    assert.equal(lateClient.state.body.toString(), "B");
  });

  it("round-trips frozen Unicode snapshots and validates value length", () => {
    const server = createServer(Note);
    assert.equal(server.openClient(), "client-1");
    assert.equal(server.openClient(), "client-2");
    assert.equal(server.openClient(), "client-3");
    const { batches, doc } = setup();
    doc.state.body.insert(0, "A😀");
    doc.receive(server.receive(batches[0]!).commit);

    const snapshot = server.snapshot();
    assert.equal(snapshot.data.body.value, "A😀");
    assert.ok(Object.isFrozen(snapshot.data.body));
    assert.ok(Object.isFrozen(snapshot.data.body.idList));
    assert.ok(Object.isFrozen(snapshot.data.body.idList[0]));

    const hydrated = createClient(Note, {
      clientId: "client-2",
      snapshot,
      onBatch: () => {},
    });
    assert.equal(hydrated.state.body.length, 2);
    assert.equal(hydrated.state.body.toString(), "A😀");

    const invalidSnapshot = {
      ...snapshot,
      data: {
        ...snapshot.data,
        body: { ...snapshot.data.body, value: "A" },
      },
    } as DocumentSnapshot<typeof Note.definition>;
    assert.throws(
      () =>
        createClient(Note, {
          clientId: "client-3",
          snapshot: invalidSnapshot,
          onBatch: () => {},
        }),
      /present ids but 1 code points/
    );
  });

  it("rejects invalid server text operations without consuming sequences", () => {
    const server = createServer(Note);
    assert.equal(server.openClient(), "client-1");
    assert.equal(server.openClient(), "client-2");
    assert.equal(server.openClient(), "client-3");
    const id1 = { bunchId: JSON.stringify(["client-1", "body", 1]), counter: 0 };
    const id2 = { bunchId: JSON.stringify(["client-2", "body", 1]), counter: 0 };
    const missing = { bunchId: "missing", counter: 0 };
    const receive = (
      clientId: string,
      seq: number,
      operations: readonly NoteOperation[]
    ) => server.receive({ clientId, seq, operations }).commit;

    assert.throws(
      () =>
        receive("client-1", 1, [
          {
            type: "text/insert",
            path: "body",
            before: null,
            id: id1,
            value: "",
          },
        ]),
      /must not be empty/
    );
    assert.throws(
      () =>
        receive("client-1", 1, [
          {
            type: "text/insert",
            path: "body",
            before: missing,
            id: id1,
            value: "a",
          },
        ]),
      /Unknown text insertion anchor/
    );

    const firstCommit = receive("client-1", 1, [
      {
        type: "text/insert",
        path: "body",
        before: null,
        id: id1,
        value: "a",
      },
    ]);
    assert.equal(firstCommit.serverSeq, 1);

    const wrongKind = {
      type: "text/insert",
      path: "title",
      before: null,
      id: { bunchId: JSON.stringify(["client-2", "title", 1]), counter: 0 },
      value: "x",
    } as unknown as NoteOperation; // oxlint-disable-line typescript/no-unsafe-type-assertion -- Deliberately invalid typed input tests runtime validation; do not decode away the failure under test.
    assert.throws(
      () => receive("client-2", 1, [wrongKind]),
      /does not match document path/
    );
    const valueOnText = {
      type: "value/set",
      path: "body",
      value: "invalid",
    } as unknown as NoteOperation; // oxlint-disable-line typescript/no-unsafe-type-assertion -- Deliberately invalid typed input tests runtime validation; do not decode away the failure under test.
    assert.throws(
      () => receive("client-2", 1, [valueOnText]),
      /does not match document path/
    );
    assert.throws(
      () =>
        receive("client-1", 2, [
          {
            type: "text/insert",
            path: "body",
            before: null,
            id: id1,
            value: "duplicate",
          },
        ]),
      /Duplicate text element id/
    );
    assert.throws(
      () =>
        receive("client-2", 1, [
          { type: "text/delete", path: "body", ranges: [] },
        ]),
      /must not be empty/
    );
    assert.throws(
      () =>
        receive("client-2", 1, [
          {
            type: "text/delete",
            path: "body",
            ranges: [{ start: id1, count: 0 }],
          },
        ]),
      /positive safe integer/
    );
    assert.throws(
      () =>
        receive("client-2", 1, [
          {
            type: "text/delete",
            path: "body",
            ranges: [{ start: missing, count: 1 }],
          },
        ]),
      /Unknown text element id/
    );

    const mutableOperation: TextInsertOperation<"body"> = {
      type: "text/insert",
      path: "body",
      before: null,
      id: id2,
      value: "b",
    };
    const secondCommit = receive("client-2", 1, [mutableOperation]);
    id2.counter = 99;

    assert.equal(secondCommit.serverSeq, 2);
    const accepted = secondCommit.operations[0];
    assert.equal(accepted?.type, "text/insert");
    if (accepted?.type === "text/insert") {
      assert.equal(accepted.id.counter, 0);
      assert.ok(Object.isFrozen(accepted.id));
    }

    const ranges = [{ start: id1, count: 1 }];
    const deleteOperation: TextDeleteOperation<"body"> = {
      type: "text/delete",
      path: "body",
      ranges,
    };
    const deleteCommit = receive("client-1", 2, [deleteOperation]);
    ranges[0]!.count = 99;
    assert.equal(deleteCommit.serverSeq, 3);
    const acceptedDelete = deleteCommit.operations[0];
    assert.equal(acceptedDelete?.type, "text/delete");
    if (acceptedDelete?.type === "text/delete") {
      assert.equal(acceptedDelete.ranges[0]?.count, 1);
      assert.ok(Object.isFrozen(acceptedDelete.ranges));
      assert.ok(Object.isFrozen(acceptedDelete.ranges[0]));
      assert.ok(Object.isFrozen(acceptedDelete.ranges[0]?.start));
    }

    const repeatedDelete = receive("client-3", 1, [
      {
        type: "text/delete",
        path: "body",
        ranges: [{ start: id1, count: 1 }],
      },
    ]);
    assert.equal(repeatedDelete.serverSeq, 4);
  });
});
