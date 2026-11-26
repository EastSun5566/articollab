import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CollectionConflictError,
  createClient,
  createServer,
  decodeClientBatch,
  decodeServerCheckpoint,
  decodeSnapshot,
  defineDocument,
  PayloadValidationError,
  text,
  WireDecodeError,
  type ClientBatch,
  type CreateServerOptions,
  type DocumentOperation,
  type PayloadSchema,
  type TextChangeEvent,
} from "../src/index.ts";

const Level: PayloadSchema<number> = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value) => value === 1 || value === 2 ? { value } : { issues: [{ message: "Expected 1 or 2" }] },
  },
};

const Doc = defineDocument({
  body: text({ marks: { bold: { expand: "after" } }, blocks: { heading: { payload: Level }, list: {} } }),
});
const Marked = defineDocument({ body: text({ marks: { bold: { expand: "after" } } }) });

type Shape = typeof Doc.definition;
type Batch = ClientBatch<DocumentOperation<Shape>>;

/** A server and writers whose batches and commits move only when a test says so. */
function network(options: CreateServerOptions<Shape> = {}) {
  const server = createServer(Doc, options);
  function writer() {
    const outbox: Batch[] = [];
    const doc = createClient(Doc, { clientId: server.openClient(), onBatch: (batch) => outbox.push(batch) });
    let delivered = 0;
    return {
      doc,
      outbox,
      send() { for (const batch of outbox.splice(0)) server.receive(batch); },
      sync() {
        for (const commit of server.commitsSince(delivered) ?? []) { doc.receive(commit); delivered = commit.serverSeq; }
      },
    };
  }
  return { server, writer };
}

const blocks = (doc: { state: { body: { blocks(): readonly unknown[] } } }) =>
  JSON.parse(JSON.stringify(doc.state.body.blocks())) as unknown;

describe("Text paragraph attributes", () => {
  it("sets attributes on the paragraphs a range touches, and reads them back", () => {
    const { writer } = network();
    const { doc, outbox } = writer();
    const body = doc.state.body;
    body.insert(0, "Title\nfirst\nsecond");
    body.formatBlocks(0, 0, "heading", 1);
    body.formatBlocks(8, 6, "list", "bullet"); // "rst\nse": the second and third paragraphs
    assert.deepEqual(blocks(doc), [
      { index: 0, length: 5, attributes: { heading: 1 } },
      { index: 6, length: 5, attributes: { list: "bullet" } },
      { index: 12, length: 6, attributes: { list: "bullet" } },
    ]);
    assert.deepEqual([body.blockAt(0), body.blockAt(5), body.blockAt(6), body.blockAt(18)],
      [{ heading: 1 }, { heading: 1 }, { list: "bullet" }, { list: "bullet" }]);
    const sent = outbox.length;
    body.formatBlocks(6, 12, "list", "bullet");
    assert.equal(outbox.length, sent, "setting what is already set records nothing");
    body.formatBlocks(6, 6, "list", null); // "first\n" ends at the third paragraph's start: only the second
    assert.deepEqual(body.blockAt(6), {});
    assert.deepEqual(body.blockAt(12), { list: "bullet" });
    assert.ok(Object.isFrozen(body.blocks()) && Object.isFrozen(body.blocks()[0]) && Object.isFrozen(body.blockAt(0)));
  });

  it("keeps a split paragraph's attributes on its first half, and drops a merged paragraph's", () => {
    const { writer } = network();
    const { doc } = writer();
    const body = doc.state.body;
    body.insert(0, "Title\nitem");
    body.formatBlocks(0, 0, "heading", 2);
    body.formatBlocks(6, 0, "list", "bullet");
    body.insert(2, "\n"); // "Ti\ntle\nitem"
    assert.deepEqual(blocks(doc), [{ index: 0, length: 2, attributes: { heading: 2 } },
      { index: 3, length: 3, attributes: {} }, { index: 7, length: 4, attributes: { list: "bullet" } }]);
    body.delete(6); // The line break before "item": it joins "tle"
    assert.deepEqual(blocks(doc), [{ index: 0, length: 2, attributes: { heading: 2 } },
      { index: 3, length: 7, attributes: {} }]);
  });

  it("converges when writers set one paragraph, or one merges it away, in either order", () => {
    for (const firstWins of [true, false]) {
      const { writer } = network();
      const a = writer(), b = writer();
      a.doc.state.body.insert(0, "one\ntwo");
      a.send(); a.sync(); b.sync();
      a.doc.state.body.formatBlocks(4, 0, "heading", 1);
      b.doc.state.body.formatBlocks(4, 0, "heading", 2);
      if (firstWins) { b.send(); a.send(); } else { a.send(); b.send(); }
      a.sync(); b.sync();
      for (const peer of [a, b]) assert.deepEqual(peer.doc.state.body.blockAt(4), { heading: firstWins ? 1 : 2 });

      a.doc.state.body.formatBlocks(4, 0, "list", "bullet");
      b.doc.state.body.delete(3); // Merges "two" into "one"
      if (firstWins) { a.send(); b.send(); } else { b.send(); a.send(); }
      a.sync(); b.sync();
      for (const peer of [a, b]) {
        assert.deepEqual(blocks(peer.doc), [{ index: 0, length: 6, attributes: {} }], `firstWins=${firstWins}`);
      }
    }
  });

  it("reports a change when a remote commit only sets paragraph attributes", () => {
    const { writer } = network();
    const a = writer(), b = writer();
    a.doc.state.body.insert(0, "x");
    a.send(); a.sync(); b.sync();
    let changes = 0;
    a.doc.on("change", (event) => { if (event.origin === "server") changes++; });
    b.doc.state.body.formatBlocks(0, 0, "heading", 1);
    b.send(); a.sync();
    assert.equal(changes, 1);
  });

  it("rolls back paragraph attributes the server's resolver drops", () => {
    const { writer } = network({
      resolve: ({ batch }) => batch.operations.filter((operation) => operation.type !== "text/block"),
    });
    const a = writer();
    a.doc.state.body.insert(0, "x");
    a.send(); a.sync();
    let transformed = 0;
    a.doc.on("transform", () => { transformed++; });
    a.doc.state.body.formatBlocks(0, 0, "heading", 1);
    assert.deepEqual(a.doc.state.body.blockAt(0), { heading: 1 });
    a.send(); a.sync();
    assert.deepEqual(a.doc.state.body.blockAt(0), {});
    assert.equal(transformed, 1);
  });

  it("saves paragraph attributes in snapshots, and saves Text without them as before", () => {
    const { server, writer } = network();
    const a = writer();
    a.doc.state.body.insert(0, "Title\nitem\nplain");
    a.doc.state.body.formatBlocks(0, 0, "heading", 1);
    a.doc.state.body.formatBlocks(6, 0, "list", "bullet");
    a.doc.state.body.format(0, 5, "bold", true);
    a.send(); a.sync();
    const saved = server.checkpoint();
    const data = saved.snapshot.data.body;
    assert.deepEqual(data.blocks?.map(({ id, attributes }) => [id === null, attributes]),
      [[true, { heading: 1 }], [false, { list: "bullet" }]]);
    const reader = createClient(Doc, { clientId: "reader", onBatch: () => {},
      snapshot: decodeSnapshot(Doc, JSON.parse(JSON.stringify(saved.snapshot))) });
    assert.deepEqual(blocks(reader), blocks(a.doc));
    const restored = createServer(Doc, { checkpoint: decodeServerCheckpoint(Doc, JSON.parse(JSON.stringify(saved))) });
    assert.deepEqual(restored.checkpoint().snapshot.data.body, data);

    const marked = createServer(Marked);
    const writer2 = createClient(Marked, { clientId: marked.openClient(), onBatch: (batch) => { marked.receive(batch); } });
    writer2.state.body.insert(0, "a\nb");
    assert.deepEqual(Object.keys(marked.checkpoint().snapshot.data.body), ["idList", "value"]);
    assert.deepEqual(writer2.state.body.blocks(), [{ index: 0, length: 1, attributes: {} }, { index: 2, length: 1, attributes: {} }]);
  });

  it("validates paragraph attributes locally, on the wire and on the server", () => {
    const { server, writer } = network();
    const a = writer();
    a.doc.state.body.insert(0, "ab\ncd");
    const body = a.doc.state.body;
    // @ts-expect-error -- Not a paragraph attribute of this Text.
    assert.throws(() => body.formatBlocks(0, 0, "quote", true), /Unknown block attribute/);
    assert.throws(() => body.formatBlocks(0, 0, "heading", 3), PayloadValidationError);
    assert.throws(() => body.formatBlocks(4, 2, "list", "bullet"), RangeError);
    a.send();

    const other = server.openClient();
    const checkpoint = server.checkpoint().snapshot.data.body;
    const range = checkpoint.idList[0]!;
    const element = (offset: number) => ({ bunchId: range.bunchId, counter: range.startCounter + offset });
    const block = (fields: Record<string, unknown>) => ({ clientId: other, seq: 1, operations: [{
      type: "text/block", path: "body", id: null, key: "list", value: "bullet", ...fields }] });
    assert.throws(() => decodeClientBatch(Doc, block({ key: "quote" })), WireDecodeError);
    assert.throws(() => decodeClientBatch(Marked, block({})), WireDecodeError);
    assert.throws(() => server.receive(decodeClientBatch(Doc, block({ key: "heading", value: 3 }))), PayloadValidationError);
    assert.throws(() => server.receive(decodeClientBatch(Doc, block({ id: { bunchId: "nobody", counter: 0 } }))),
      CollectionConflictError);
    assert.throws(() => server.receive(decodeClientBatch(Doc, block({ id: element(0) }))), /must start at a line break/);
    server.receive(decodeClientBatch(Doc, block({ id: element(2) })));
    a.sync();
    assert.deepEqual(blocks(a.doc), [{ index: 0, length: 2, attributes: {} }, { index: 3, length: 2, attributes: { list: "bullet" } }]);
  });

  it("reports paragraph changes to observers, including new paragraphs, but not for Text without attributes", () => {
    const { writer } = network();
    const a = writer(), b = writer();
    a.doc.state.body.insert(0, "one\ntwo");
    a.send(); a.sync(); b.sync();
    const events: TextChangeEvent[] = [];
    a.doc.state.body.observe((event) => events.push(event));
    a.doc.state.body.insert(3, "\n"); // No paragraph has attributes yet: no blocks field.
    assert.equal(Object.hasOwn(events.at(-1)!, "blocks"), false);
    a.doc.state.body.formatBlocks(5, 0, "list", "bullet");
    assert.deepEqual(JSON.parse(JSON.stringify(events.at(-1)!.blocks)), [{ index: 5, attributes: { list: "bullet" } }]);
    a.doc.state.body.insert(8, "\n"); // "one\n\ntwo\n": a new paragraph at the end
    assert.deepEqual(JSON.parse(JSON.stringify(events.at(-1)!.blocks)), [{ index: 9, attributes: {} }]);
    b.doc.state.body.formatBlocks(0, 0, "heading", 1);
    a.send(); b.send(); a.sync();
    assert.deepEqual(JSON.parse(JSON.stringify(events.at(-1)!.blocks)), [{ index: 0, attributes: { heading: 1 } }]);

    // Once no paragraph has attributes, events stop listing paragraphs again.
    a.doc.state.body.formatBlocks(0, 0, "heading", null);
    a.doc.state.body.delete(4); // Merges the bullet paragraph, "two", away
    a.doc.state.body.insert(0, "\n");
    assert.equal(Object.hasOwn(events.at(-1)!, "blocks"), false);
  });
});
