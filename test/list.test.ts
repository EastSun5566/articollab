import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createClient,
  createServer,
  defineDocument,
  list,
  value,
  type ClientBatch,
  type DocumentOperation,
  type DocumentSnapshot,
  type ListInsertOperation,
} from "../src/index.ts";

const Board = defineDocument({
  title: value("Draft"),
  items: list<string>(),
});

type BoardOperation = DocumentOperation<typeof Board.definition>;
type BoardBatch = ClientBatch<BoardOperation>;

function setup(clientId = "client-1") {
  const batches: BoardBatch[] = [];
  const doc = createClient(Board, {
    clientId,
    onBatch: (batch) => batches.push(batch),
  });
  return { batches, doc };
}

describe("list runtime", () => {
  it("provides typed optimistic list operations and validates indexes", () => {
    const { batches, doc } = setup();
    let changes = 0;
    doc.on("change", () => changes++);

    doc.state.items.push("b");
    doc.state.items.insert(0, "a");
    doc.state.items.delete(1);

    const first: string = doc.state.items.get(0);
    assert.equal(first, "a");
    assert.equal(doc.state.items.length, 1);
    assert.deepEqual(doc.state.items.toArray(), ["a"]);
    assert.deepEqual([...doc.state.items.values()], ["a"]);
    assert.deepEqual([...doc.state.items], ["a"]);
    assert.deepEqual(
      batches.map((batch) => batch.operations[0]?.type),
      ["list/insert", "list/insert", "list/delete"]
    );
    assert.equal(changes, 3);

    const firstOperation = batches[0]!.operations[0];
    assert.equal(firstOperation?.type, "list/insert");
    if (firstOperation?.type === "list/insert") {
      assert.ok(Object.isFrozen(firstOperation));
      assert.ok(Object.isFrozen(firstOperation.id));
    }

    assert.throws(() => doc.state.items.get(1), /out of bounds/i);
    assert.throws(() => doc.state.items.insert(2, "x"), /out of bounds/i);
    assert.throws(() => doc.state.items.delete(1), /out of bounds/i);
    assert.equal(batches.length, 3);
    assert.equal(changes, 3);
    assert.deepEqual(doc.state.items.toArray(), ["a"]);
  });

  it("groups mixed collections and rolls back a failed transaction", () => {
    const { batches, doc } = setup();
    let changes = 0;
    doc.on("change", () => changes++);

    doc.transact(() => {
      doc.state.title.value = "Ready";
      doc.state.items.push("a");
      doc.state.items.insert(0, "b");
    });

    assert.equal(batches.length, 1);
    assert.deepEqual(
      batches[0]!.operations.map((operation) => operation.type),
      ["value/set", "list/insert", "list/insert"]
    );
    assert.equal(changes, 1);
    assert.equal(doc.state.title.value, "Ready");
    assert.deepEqual(doc.state.items.toArray(), ["b", "a"]);

    assert.throws(() => {
      doc.transact(() => {
        doc.state.title.value = "Broken";
        doc.state.items.delete(0);
        throw new Error("stop");
      });
    }, /stop/);

    assert.equal(batches.length, 1);
    assert.equal(changes, 1);
    assert.equal(doc.state.title.value, "Ready");
    assert.deepEqual(doc.state.items.toArray(), ["b", "a"]);
  });

  it("acknowledges and rejects optimistic list mutations", () => {
    const { batches, doc } = setup();
    const serverChanges: string[][] = [];
    doc.on("change", (event) => {
      if (event.origin === "server") {
        serverChanges.push(doc.state.items.toArray());
      }
    });

    doc.state.items.push("a");
    doc.receive({
      serverSeq: 1,
      source: { clientId: "client-1", seq: 1 },
      operations: batches[0]!.operations,
    });
    assert.deepEqual(serverChanges, []);

    doc.state.items.push("b");
    doc.receive({
      serverSeq: 2,
      source: { clientId: "client-1", seq: 2 },
      operations: [],
    });
    assert.deepEqual(doc.state.items.toArray(), ["a"]);

    doc.state.items.delete(0);
    doc.receive({
      serverSeq: 3,
      source: { clientId: "client-1", seq: 3 },
      operations: [],
    });
    assert.deepEqual(doc.state.items.toArray(), ["a"]);
    assert.deepEqual(serverChanges, [["a"], ["a"]]);
  });

  it("replays an insertion after a deleted anchor and hydrates its tombstone", () => {
    const server = createServer(Board);
    const client1Batches: BoardBatch[] = [];
    const client2Batches: BoardBatch[] = [];
    const client1 = createClient(Board, {
      clientId: "client-1",
      onBatch: (batch) => client1Batches.push(batch),
    });
    const client2 = createClient(Board, {
      clientId: "client-2",
      onBatch: (batch) => client2Batches.push(batch),
    });

    client1.state.items.push("base");
    const baseCommit = server.receive(client1Batches[0]!);
    client1.receive(baseCommit);
    client2.receive(baseCommit);

    client1.state.items.push("after");
    client2.state.items.delete(0);

    const deleteCommit = server.receive(client2Batches[0]!);
    client1.receive(deleteCommit);
    client2.receive(deleteCommit);
    assert.deepEqual(client1.state.items.toArray(), ["after"]);
    assert.deepEqual(client2.state.items.toArray(), []);

    const snapshot = server.snapshot();
    const lateClient = createClient(Board, {
      clientId: "client-3",
      snapshot,
      onBatch: () => {},
    });
    assert.deepEqual(lateClient.state.items.toArray(), []);
    assert.equal(snapshot.data.items.idList[0]?.isDeleted, true);

    const insertCommit = server.receive(client1Batches[1]!);
    client1.receive(insertCommit);
    client2.receive(insertCommit);
    lateClient.receive(insertCommit);

    assert.equal(insertCommit.serverSeq, 3);
    assert.deepEqual(client1.state.items.toArray(), ["after"]);
    assert.deepEqual(client2.state.items.toArray(), ["after"]);
    assert.deepEqual(lateClient.state.items.toArray(), ["after"]);
  });

  it("freezes and validates list snapshot data", () => {
    const server = createServer(Board);
    const { batches, doc } = setup();
    doc.state.items.push("a");
    const commit = server.receive(batches[0]!);
    doc.receive(commit);

    const snapshot = server.snapshot();
    assert.deepEqual(snapshot.data.items.values, ["a"]);
    assert.ok(Object.isFrozen(snapshot.data.items));
    assert.ok(Object.isFrozen(snapshot.data.items.idList));
    assert.ok(Object.isFrozen(snapshot.data.items.idList[0]));
    assert.ok(Object.isFrozen(snapshot.data.items.values));

    const invalidSnapshot = {
      ...snapshot,
      data: {
        ...snapshot.data,
        items: { ...snapshot.data.items, values: [] },
      },
    } as DocumentSnapshot<typeof Board.definition>;
    assert.throws(
      () =>
        createClient(Board, {
          clientId: "client-2",
          snapshot: invalidSnapshot,
          onBatch: () => {},
        }),
      /present ids but 0 values/
    );
  });

  it("rejects invalid server list operations atomically", () => {
    const server = createServer(Board);
    const id1 = { bunchId: "one", counter: 0 };
    const id2 = { bunchId: "two", counter: 0 };
    const missing = { bunchId: "missing", counter: 0 };
    const receive = (
      clientId: string,
      seq: number,
      operations: readonly BoardOperation[]
    ) => server.receive({ clientId, seq, operations });

    const wrongKind = {
      type: "list/insert",
      path: "title",
      before: null,
      id: id1,
      value: "x",
    } as unknown as BoardOperation;
    assert.throws(
      () => receive("wrong-kind", 1, [wrongKind]),
      /does not match document path/
    );

    assert.throws(
      () =>
        receive("client-1", 1, [
          {
            type: "list/insert",
            path: "items",
            before: missing,
            id: id1,
            value: "a",
          },
        ]),
      /Unknown list insertion anchor/
    );

    const firstCommit = receive("client-1", 1, [
      {
        type: "list/insert",
        path: "items",
        before: null,
        id: id1,
        value: "a",
      },
    ]);
    assert.equal(firstCommit.serverSeq, 1);

    assert.throws(
      () =>
        receive("client-2", 1, [
          {
            type: "list/insert",
            path: "items",
            before: null,
            id: id1,
            value: "duplicate",
          },
        ]),
      /Duplicate list element id/
    );
    assert.throws(
      () =>
        receive("client-2", 1, [
          { type: "list/delete", path: "items", id: missing },
        ]),
      /Unknown list element id/
    );

    const mutableOperation: ListInsertOperation<"items", string> = {
      type: "list/insert",
      path: "items",
      before: null,
      id: id2,
      value: "b",
    };
    const secondCommit = receive("client-2", 1, [mutableOperation]);
    id2.counter = 99;

    assert.equal(secondCommit.serverSeq, 2);
    const accepted = secondCommit.operations[0];
    assert.equal(accepted?.type, "list/insert");
    if (accepted?.type === "list/insert") {
      assert.equal(accepted.id.counter, 0);
      assert.ok(Object.isFrozen(accepted.id));
    }

    const deleteCommit = receive("client-1", 2, [
      { type: "list/delete", path: "items", id: id1 },
    ]);
    const repeatedDelete = receive("client-3", 1, [
      { type: "list/delete", path: "items", id: id1 },
    ]);
    assert.equal(deleteCommit.serverSeq, 3);
    assert.equal(repeatedDelete.serverSeq, 4);
  });

  it("resolves list rejection and mixed transaction transformation end to end", () => {
    type Decision = "accept" | "reject" | "title-only";
    let decision: Decision = "accept";
    const server = createServer(Board, {
      resolve: ({ batch, snapshot }) => {
        const itemCount: number = snapshot.data.items.values.length;
        assert.ok(itemCount >= 0);
        if (decision === "reject") return [];
        if (decision === "title-only") {
          return batch.operations.filter(
            (operation) => operation.type === "value/set"
          );
        }
        return batch.operations;
      },
    });
    const { batches, doc } = setup();

    doc.state.items.push("base");
    doc.receive(server.receive(batches[0]!));
    assert.deepEqual(doc.state.items.toArray(), ["base"]);

    decision = "reject";
    doc.state.items.push("rejected");
    const rejectedInsert = server.receive(batches[1]!);
    doc.receive(rejectedInsert);
    assert.deepEqual(rejectedInsert.operations, []);
    assert.deepEqual(doc.state.items.toArray(), ["base"]);

    doc.state.items.delete(0);
    const rejectedDelete = server.receive(batches[2]!);
    doc.receive(rejectedDelete);
    assert.deepEqual(rejectedDelete.operations, []);
    assert.deepEqual(doc.state.items.toArray(), ["base"]);

    decision = "title-only";
    doc.transact(() => {
      doc.state.title.value = "Ready";
      doc.state.items.push("omitted");
    });
    const transformed = server.receive(batches[3]!);
    doc.receive(transformed);

    assert.deepEqual(
      transformed.operations.map((operation) => operation.type),
      ["value/set"]
    );
    assert.equal(doc.state.title.value, "Ready");
    assert.deepEqual(doc.state.items.toArray(), ["base"]);
    assert.equal(server.snapshot().serverSeq, 4);
  });

  it("validates transformed list operations before consuming sequences", () => {
    let returnWrongKind = true;
    const server = createServer(Board, {
      resolve: ({ batch }) => {
        if (!returnWrongKind) return batch.operations;
        return [
          {
            type: "list/insert",
            path: "title",
            before: null,
            id: { bunchId: "policy", counter: 0 },
            value: "invalid",
          },
        ] as unknown as readonly BoardOperation[];
      },
    });
    const batch: BoardBatch = {
      clientId: "client-1",
      seq: 1,
      operations: [{ type: "value/set", path: "title", value: "Ready" }],
    };

    assert.throws(
      () => server.receive(batch),
      /does not match document path/
    );
    assert.equal(server.snapshot().serverSeq, 0);

    returnWrongKind = false;
    const commit = server.receive(batch);
    assert.equal(commit.serverSeq, 1);
    assert.equal(server.snapshot().data.title, "Ready");
  });
});
