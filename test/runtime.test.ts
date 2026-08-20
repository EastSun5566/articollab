import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createClient,
  defineDocument,
  value,
  type ChangeEvent,
  type ClientBatch,
  type DocumentOperation,
  type ServerCommit,
} from "../src/index.ts";

const Counter = defineDocument({
  count: value(0),
});

type CounterOperation = DocumentOperation<typeof Counter.definition>;
type CounterCommit = ServerCommit<CounterOperation>;

function setup() {
  const batches: ClientBatch<CounterOperation>[] = [];
  const doc = createClient(Counter, {
    clientId: "client-1",
    onBatch: (batch) => batches.push(batch),
  });
  return { batches, doc };
}

if (false) {
  const { doc } = setup();
  // @ts-expect-error Transactions must not continue after an await.
  doc.transact(async () => {});
}

describe("client runtime", () => {
  it("infers the schema state and emits one batch for a mutation", () => {
    const { batches, doc } = setup();
    const initialCount: number = doc.state.count.value;
    assert.equal(initialCount, 0);

    const changes: number[] = [];
    doc.on("change", () => changes.push(doc.state.count.value));

    doc.state.count.value = 1;

    assert.equal(doc.state.count.value, 1);
    assert.deepEqual(batches, [
      {
        clientId: "client-1",
        seq: 1,
        operations: [{ type: "value/set", path: "count", value: 1 }],
      },
    ]);
    assert.deepEqual(changes, [1]);
  });

  it("groups transaction operations into one batch and one change", () => {
    const { batches, doc } = setup();
    let changes = 0;
    doc.on("change", () => changes++);

    const result = doc.transact(() => {
      doc.state.count.value = 2;
      doc.state.count.set(3);
      return "result";
    });

    assert.equal(result, "result");
    assert.equal(doc.state.count.value, 3);
    assert.equal(batches.length, 1);
    assert.deepEqual(batches[0]?.operations, [
      { type: "value/set", path: "count", value: 2 },
      { type: "value/set", path: "count", value: 3 },
    ]);
    assert.equal(changes, 1);
  });

  it("does nothing for an empty transaction", () => {
    const { batches, doc } = setup();
    let changes = 0;
    doc.on("change", () => changes++);

    doc.transact(() => {});

    assert.deepEqual(batches, []);
    assert.equal(changes, 0);
  });

  it("unsubscribes change listeners", () => {
    const { doc } = setup();
    let changes = 0;
    const unsubscribe = doc.on("change", () => changes++);

    doc.state.count.value = 1;
    unsubscribe();
    doc.state.count.value = 2;

    assert.equal(changes, 1);
  });

  it("sends reentrant listener mutations in batch order", () => {
    const { batches, doc } = setup();
    let mutateAgain = true;
    doc.on("change", (event) => {
      if (event.origin === "local" && mutateAgain) {
        mutateAgain = false;
        doc.state.count.value = 2;
      }
    });

    doc.state.count.value = 1;

    assert.equal(doc.state.count.value, 2);
    assert.deepEqual(
      batches.map((batch) => batch.seq),
      [1, 2]
    );
  });

  it("rolls back a failed transaction without emitting", () => {
    const { batches, doc } = setup();
    let changes = 0;
    doc.on("change", () => changes++);

    assert.throws(() => {
      doc.transact(() => {
        doc.state.count.value = 2;
        throw new Error("stop");
      });
    }, /stop/);

    assert.equal(doc.state.count.value, 0);
    assert.deepEqual(batches, []);
    assert.equal(changes, 0);
  });

  it("rejects server commits during a transaction", () => {
    const { batches, doc } = setup();

    assert.throws(() => {
      doc.transact(() => {
        doc.state.count.value = 1;
        doc.receive({
          serverSeq: 1,
          source: { clientId: "client-2", seq: 1 },
          operations: [{ type: "value/set", path: "count", value: 9 }],
        });
      });
    }, /Cannot receive a server commit during a transaction/);

    assert.equal(doc.state.count.value, 0);
    assert.deepEqual(batches, []);

    doc.receive({
      serverSeq: 1,
      source: { clientId: "client-2", seq: 1 },
      operations: [{ type: "value/set", path: "count", value: 9 }],
    });
    assert.equal(doc.state.count.value, 9);
  });

  it("applies a remote server commit", () => {
    const { doc } = setup();
    const changes: ChangeEvent<CounterOperation>[] = [];
    doc.on("change", (event) => changes.push(event));

    const commit: CounterCommit = {
      serverSeq: 1,
      source: { clientId: "client-2", seq: 1 },
      operations: [{ type: "value/set", path: "count", value: 4 }],
    };
    doc.receive(commit);

    assert.equal(doc.state.count.value, 4);
    assert.deepEqual(changes, [{ origin: "server", commit }]);
  });

  it("replays pending batches until their own commits arrive", () => {
    const { doc } = setup();
    const serverChanges: number[] = [];
    doc.on("change", (event) => {
      if (event.origin === "server") {
        serverChanges.push(doc.state.count.value);
      }
    });

    doc.state.count.value = 1;
    doc.state.count.value = 2;

    doc.receive({
      serverSeq: 1,
      source: { clientId: "client-2", seq: 1 },
      operations: [{ type: "value/set", path: "count", value: 9 }],
    });
    assert.equal(doc.state.count.value, 2);

    doc.receive({
      serverSeq: 2,
      source: { clientId: "client-1", seq: 1 },
      operations: [{ type: "value/set", path: "count", value: 1 }],
    });
    doc.receive({
      serverSeq: 3,
      source: { clientId: "client-1", seq: 2 },
      operations: [{ type: "value/set", path: "count", value: 2 }],
    });

    assert.equal(doc.state.count.value, 2);
    assert.deepEqual(serverChanges, []);

    doc.receive({
      serverSeq: 4,
      source: { clientId: "client-2", seq: 2 },
      operations: [{ type: "value/set", path: "count", value: 3 }],
    });

    assert.equal(doc.state.count.value, 3);
    assert.deepEqual(serverChanges, [3]);
  });

  it("rolls back a rejected optimistic batch", () => {
    const { doc } = setup();
    const serverChanges: number[] = [];
    doc.on("change", (event) => {
      if (event.origin === "server") {
        serverChanges.push(doc.state.count.value);
      }
    });

    doc.state.count.value = 1;
    doc.receive({
      serverSeq: 1,
      source: { clientId: "client-1", seq: 1 },
      operations: [],
    });

    assert.equal(doc.state.count.value, 0);
    assert.deepEqual(serverChanges, [0]);
  });

  it("uses a transformed server result for an own batch", () => {
    const { doc } = setup();

    doc.state.count.value = 1;
    doc.receive({
      serverSeq: 1,
      source: { clientId: "client-1", seq: 1 },
      operations: [{ type: "value/set", path: "count", value: 5 }],
    });

    assert.equal(doc.state.count.value, 5);
  });

  it("rejects out-of-order commits without changing reconciliation state", () => {
    const { doc } = setup();

    assert.throws(
      () =>
        doc.receive({
          serverSeq: 2,
          source: { clientId: "client-2", seq: 1 },
          operations: [{ type: "value/set", path: "count", value: 2 }],
        }),
      /Expected server sequence 1/
    );
    assert.equal(doc.state.count.value, 0);

    doc.state.count.value = 1;
    assert.throws(
      () =>
        doc.receive({
          serverSeq: 1,
          source: { clientId: "client-1", seq: 2 },
          operations: [],
        }),
      /does not match the next pending batch/
    );
    assert.equal(doc.state.count.value, 1);

    doc.receive({
      serverSeq: 1,
      source: { clientId: "client-1", seq: 1 },
      operations: [{ type: "value/set", path: "count", value: 1 }],
    });
    assert.throws(
      () =>
        doc.receive({
          serverSeq: 1,
          source: { clientId: "client-2", seq: 1 },
          operations: [],
        }),
      /Expected server sequence 2/
    );
  });

  it("rejects an empty client id", () => {
    assert.throws(
      () => createClient(Counter, { clientId: "", onBatch: () => {} }),
      /clientId must not be empty/
    );
  });
});
