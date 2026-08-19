import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createClient,
  defineDocument,
  value,
  type ClientBatch,
  type DocumentOperation,
} from "../src/index.ts";

const Counter = defineDocument({
  count: value(0),
});

type CounterOperation = DocumentOperation<typeof Counter.definition>;

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

  it("rejects an empty client id", () => {
    assert.throws(
      () => createClient(Counter, { clientId: "", onBatch: () => {} }),
      /clientId must not be empty/
    );
  });
});
