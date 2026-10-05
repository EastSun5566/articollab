import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createClient,
  createServer,
  defineDocument,
  list,
  text,
  value,
  type ClientBatch,
  type DocumentOperation,
  type DocumentSnapshot,
  type TextDeleteOperation,
  type TextInsertOperation,
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
    const id1 = { bunchId: "one", counter: 0 };
    const id2 = { bunchId: "two", counter: 0 };
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
      id: id2,
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
        receive("client-2", 1, [
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
