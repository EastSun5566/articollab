import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createClient, createServer, createUndoManager, decodeClientBatch, defineDocument, list, map, text, value,
  PayloadValidationError, type ClientBatch, type DocumentOperation, type JsonValue, type StandardSchemaV1,
} from "../src/index.ts";

/** A hand-written Standard Schema: `check` returns an issue message, or undefined to accept. */
function schema<T extends JsonValue>(check: (input: unknown) => string | undefined): StandardSchemaV1<T> {
  return {
    "~standard": {
      version: 1,
      vendor: "test",
      validate(input) {
        const message = check(input);
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Accepted input is the schema's type.
        return message === undefined ? { value: input as T } : { issues: [{ message, path: [] }] };
      },
    },
  };
}
const shortString = schema<string>((input) => typeof input === "string" && input.length <= 5 ? undefined : "Expected at most 5 characters");
const smallNumber = schema<number>((input) => typeof input === "number" && input < 10 ? undefined : "Expected less than 10");

const Validated = defineDocument({
  count: value(0, smallNumber),
  items: list(shortString),
  tags: map(shortString),
  body: text(),
});
const Loose = defineDocument({ count: value(0), items: list<string>(), tags: map<string>(), body: text() });
const json = (input: unknown): unknown => JSON.parse(JSON.stringify(input));

function rejects(action: () => void, path: readonly (string | number)[], message: string): void {
  assert.throws(action, (error) => {
    assert.ok(error instanceof PayloadValidationError);
    assert.ok(error instanceof TypeError);
    assert.deepEqual([error.path, error.issues.map((issue) => issue.message)], [path, [message]]);
    assert.match(error.message, new RegExp(`^Invalid payload at /${path.join("/")}: ${message}$`));
    return true;
  });
}

describe("Payload schemas", () => {
  it("rejects invalid local writes before they change anything", () => {
    const server = createServer(Validated);
    const batches: ClientBatch<DocumentOperation<typeof Validated.definition>>[] = [];
    const doc = createClient(Validated, { clientId: server.openClient(), onBatch(batch) { batches.push(batch); } });
    doc.state.items.push("ok");
    rejects(() => { doc.state.count.set(12); }, ["count"], "Expected less than 10");
    rejects(() => { doc.state.items.push("too long"); }, ["items"], "Expected at most 5 characters");
    rejects(() => { doc.state.items.insert(0, "too long"); }, ["items"], "Expected at most 5 characters");
    rejects(() => { doc.state.items.set(0, "too long"); }, ["items"], "Expected at most 5 characters");
    rejects(() => { doc.state.tags.set("k", "too long"); }, ["tags", "k"], "Expected at most 5 characters");
    rejects(() => { doc.transact(() => { doc.state.items.push("fine"); doc.state.items.push("too long"); }); },
      ["items"], "Expected at most 5 characters");
    assert.deepEqual([doc.state.count.value, doc.state.items.toArray(), doc.state.tags.toObject()], [0, ["ok"], {}]);
    assert.deepEqual(batches.map(({ seq }) => seq), [1], "no batch for rejected writes");
    doc.state.tags.set("k", "fine");
    assert.deepEqual(batches.map(({ seq }) => seq), [1, 2]);
    for (const batch of batches) doc.receive(server.receive(batch).commit);
    assert.deepEqual(server.snapshot().data.tags, { k: "fine" });
  });

  it("validates a value's initial value and requires a synchronous Standard Schema", () => {
    assert.throws(() => value(12, smallNumber), PayloadValidationError);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Exercises an untyped call.
    assert.throws(() => list({ validate() {} } as never), /Standard Schema v1/);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Exercises an untyped call.
    assert.throws(() => map(null as never), /Standard Schema v1/);
    const asynchronous: StandardSchemaV1<string> = {
      "~standard": { version: 1, vendor: "test", validate: async (input) => ({ value: String(input) }) },
    };
    const doc = createClient(defineDocument({ items: list(asynchronous) }), { clientId: "c", onBatch() {} });
    assert.throws(() => { doc.state.items.push("x"); }, /must validate synchronously/);
    assert.deepEqual(doc.state.items.toArray(), []);
  });

  it("keeps the written value, never the schema's output", () => {
    const trimmed: StandardSchemaV1<string> = {
      "~standard": { version: 1, vendor: "test", validate: (input) => ({ value: String(input).trim() }) },
    };
    const doc = createClient(defineDocument({ items: list(trimmed) }), { clientId: "c", onBatch() {} });
    doc.state.items.push("  padded  ");
    assert.deepEqual(doc.state.items.toArray(), ["  padded  "]);
  });

  it("rejects an invalid incoming batch on the server, which can then reject it", () => {
    const server = createServer(Validated);
    const loose = createClient(Loose, { clientId: server.openClient(), onBatch() {} });
    loose.state.items.push("far too long");
    // Decoding checks structure only; payloads are checked where they would be applied.
    const batch = decodeClientBatch(Validated, json(loose.checkpoint().pendingBatches[0]));
    const before = server.checkpoint();
    rejects(() => server.receive(batch), ["items"], "Expected at most 5 characters");
    assert.deepEqual(server.checkpoint(), before, "state, sequences and history are unchanged");
    assert.deepEqual(server.reject(batch).commit.operations, []);
    assert.equal(server.snapshot().serverSeq, 1);
  });

  it("checks incoming payloads before the resolver sees them", () => {
    let resolverCalls = 0;
    const server = createServer(Validated, {
      resolve: ({ batch }) => { resolverCalls++; return batch.operations.filter((operation) => operation.type !== "list/insert"); },
    });
    const loose = createClient(Loose, { clientId: server.openClient(), onBatch() {} });
    loose.state.items.push("far too long");
    const batch = decodeClientBatch(Validated, json(loose.checkpoint().pendingBatches[0]));
    rejects(() => server.receive(batch), ["items"], "Expected at most 5 characters");
    assert.equal(resolverCalls, 0, "a policy only ever sees valid payloads");
  });

  it("validates a resolver's output before applying it", () => {
    const server = createServer(Validated, {
      resolve: ({ batch }) => batch.operations.map((operation) =>
        operation.type === "value/set" ? { ...operation, value: operation.value * 10 } : operation),
    });
    const doc = createClient(Validated, { clientId: server.openClient(), onBatch() {} });
    doc.state.count.set(3);
    const before = server.checkpoint();
    rejects(() => server.receive(doc.checkpoint().pendingBatches[0]!), ["count"], "Expected less than 10");
    assert.deepEqual(server.checkpoint(), before);
  });

  it("validates what undo writes back", () => {
    let floor = 0;
    const atLeastFloor = schema<number>((input) => typeof input === "number" && input >= floor ? undefined : `Expected at least ${floor}`);
    const doc = createClient(defineDocument({ count: value(0, atLeastFloor) }), { clientId: "c", onBatch() {} });
    const history = createUndoManager(doc, { captureTimeout: 0 });
    doc.state.count.set(5);
    floor = 1;
    rejects(() => history.undo(), ["count"], "Expected at least 1");
    assert.deepEqual([doc.state.count.value, history.canUndo], [5, true], "the step is kept");
  });
});
