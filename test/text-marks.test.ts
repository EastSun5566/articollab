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
} from "../packages/articollab/src/index.ts";

const Href: PayloadSchema<string> = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value) => typeof value === "string" && /^https?:/.test(value)
      ? { value }
      : { issues: [{ message: "Expected an http(s) URL" }] },
  },
};

const Doc = defineDocument({
  body: text({
    marks: {
      bold: { expand: "after" },
      italic: { expand: "both" },
      link: { expand: "none", payload: Href },
      note: { expand: "before" },
    },
  }),
});
const Plain = defineDocument({ body: text() });

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
      /** Submits every pending batch. */
      send() { for (const batch of outbox.splice(0)) server.receive(batch); },
      /** Delivers every commit not yet received. */
      sync() {
        for (const commit of server.commitsSince(delivered) ?? []) { doc.receive(commit); delivered = commit.serverSeq; }
      },
    };
  }
  return { server, writer };
}

function delta(doc: { state: { body: { toDelta(): readonly unknown[] } } }): unknown {
  return JSON.parse(JSON.stringify(doc.state.body.toDelta()));
}

describe("Text marks", () => {
  it("formats a range, reads it back and removes it with null", () => {
    const { writer } = network();
    const { doc } = writer();
    doc.state.body.insert(0, "Hello world");
    doc.state.body.format(6, 5, "bold", true);
    assert.deepEqual(doc.state.body.attributesAt(5), {});
    assert.deepEqual(doc.state.body.attributesAt(6), { bold: true });
    assert.deepEqual(delta(doc), [{ insert: "Hello " }, { insert: "world", attributes: { bold: true } }]);
    doc.state.body.format(0, 7, "bold", null);
    // Read single elements first: they are computed without the whole-Text pass toDelta makes.
    assert.deepEqual([doc.state.body.attributesAt(6), doc.state.body.attributesAt(7)], [{}, { bold: true }]);
    assert.deepEqual(delta(doc), [{ insert: "Hello w" }, { insert: "orld", attributes: { bold: true } }]);
    doc.state.body.format(0, 11, "link", "https://a");
    doc.state.body.format(6, 5, "link", "https://b"); // inside the first link, which therefore stays
    assert.deepEqual([doc.state.body.attributesAt(0), doc.state.body.attributesAt(6)],
      [{ link: "https://a" }, { link: "https://b" }]);
    assert.ok(Object.isFrozen(doc.state.body.toDelta()) && Object.isFrozen(doc.state.body.attributesAt(8)));
  });

  it("applies each key's expand rule to text typed at the range's edges", () => {
    const expected = { bold: [false, true], italic: [true, true], link: [false, false], note: [true, false] } as const;
    for (const key of ["bold", "italic", "link", "note"] as const) {
      const [before, after] = expected[key];
      const { writer } = network();
      const { doc } = writer();
      doc.state.body.insert(0, "abc");
      doc.state.body.format(1, 1, key, key === "link" ? "https://b" : true);
      doc.state.body.insert(1, "X"); // aXbc: right before the range
      doc.state.body.insert(3, "Y"); // aXbYc: right after it
      const has = (index: number) => Object.hasOwn(doc.state.body.attributesAt(index), key);
      assert.deepEqual([has(1), has(2), has(3)], [before, true, after], key);
      assert.equal(has(0) || has(4), false, key);
    }
  });

  it("keeps a range on its characters while others insert around it, in either order", () => {
    for (const formatFirst of [true, false]) {
      const { writer } = network();
      const a = writer(), b = writer(), c = writer();
      a.doc.state.body.insert(0, "Hello world");
      a.send();
      for (const peer of [a, b, c]) peer.sync();
      a.doc.state.body.format(6, 5, "bold", true);
      a.doc.state.body.format(6, 5, "link", "https://w");
      b.doc.state.body.insert(6, "big ");
      c.doc.state.body.insert(11, "!");
      if (formatFirst) { a.send(); b.send(); c.send(); } else { b.send(); c.send(); a.send(); }
      for (const peer of [a, b, c]) {
        peer.sync();
        assert.equal(peer.doc.state.body.toString(), "Hello big world!");
        assert.deepEqual(delta(peer.doc), [
          { insert: "Hello big " },
          { insert: "world", attributes: { bold: true, link: "https://w" } },
          { insert: "!", attributes: { bold: true } },
        ], `formatFirst=${formatFirst}`);
      }
    }
  });

  it("lets the mark the server applied last win, and shows a pending mark until then", () => {
    for (const boldFirst of [true, false]) {
      const { writer } = network();
      const a = writer(), b = writer();
      a.doc.state.body.insert(0, "Hello world");
      a.send();
      a.sync(); b.sync();
      a.doc.state.body.format(0, 11, "bold", true);
      b.doc.state.body.format(6, 5, "bold", null);
      if (boldFirst) { a.send(); b.send(); } else { b.send(); a.send(); }
      if (!boldFirst) {
        a.sync();
        // B's commit arrived first, but A's own pending mark still shows on top of it.
        assert.deepEqual(delta(a.doc), [{ insert: "Hello world", attributes: { bold: true } }]);
      }
      a.sync(); b.sync();
      for (const peer of [a, b]) {
        assert.deepEqual(delta(peer.doc), boldFirst
          ? [{ insert: "Hello ", attributes: { bold: true } }, { insert: "world" }]
          : [{ insert: "Hello world", attributes: { bold: true } }]);
      }
    }
  });

  it("keeps a mark whose anchors were deleted, and never extends a closed mark over new text", () => {
    const { writer } = network();
    const a = writer(), b = writer();
    a.doc.state.body.insert(0, "Hello world");
    a.send();
    a.sync(); b.sync();
    a.doc.state.body.format(6, 5, "bold", true);
    a.doc.state.body.format(6, 5, "link", "https://w");
    b.doc.state.body.delete(6, 3); // "Hello ld": the marks' first anchor is gone
    a.send(); b.send();
    a.sync(); b.sync();
    for (const peer of [a, b]) {
      assert.deepEqual(delta(peer.doc), [{ insert: "Hello " }, { insert: "ld", attributes: { bold: true, link: "https://w" } }]);
    }
    b.doc.state.body.delete(6, 2);
    b.doc.state.body.insert(6, "xyz");
    b.send();
    a.sync(); b.sync();
    // Typed where the marked text was, after the space: before every tombstone, so outside both marks.
    for (const peer of [a, b]) assert.deepEqual(delta(peer.doc), [{ insert: "Hello xyz" }]);
  });

  it("reports a change when a remote commit only formats", () => {
    const { writer } = network();
    const a = writer(), b = writer();
    a.doc.state.body.insert(0, "Hello");
    a.send(); a.sync(); b.sync();
    let changes = 0;
    a.doc.on("change", (event) => { if (event.origin === "server") changes++; });
    b.doc.state.body.format(0, 5, "bold", true);
    b.send(); a.sync();
    assert.equal(changes, 1);
    b.doc.state.body.format(0, 5, "bold", true);
    b.send(); a.sync();
    assert.equal(changes, 1, "a mark that changes nothing is silent");
  });

  it("rolls back a mark the server's resolver drops and reports it as transformed", () => {
    const { writer } = network({
      resolve: ({ batch }) => batch.operations.filter((operation) => !(operation.type === "text/mark" && operation.key === "link")),
    });
    const a = writer();
    a.doc.state.body.insert(0, "site");
    a.send(); a.sync();
    const dropped: { readonly type: string }[] = [];
    a.doc.on("transform", (event) => { dropped.push(...event.dropped); });
    a.doc.state.body.format(0, 4, "link", "https://site");
    assert.deepEqual(a.doc.state.body.attributesAt(0), { link: "https://site" });
    a.send(); a.sync();
    assert.deepEqual(a.doc.state.body.attributesAt(0), {});
    assert.equal(dropped.length, 1);
    assert.equal(dropped[0]!.type, "text/mark");
  });

  it("saves marks in snapshots, drops marks a later mark covers, and saves plain Text as before", () => {
    const { server, writer } = network();
    const a = writer();
    a.doc.state.body.insert(0, "Hello world");
    a.doc.state.body.format(0, 5, "bold", true);
    a.doc.state.body.format(0, 11, "bold", null); // covers the first
    a.doc.state.body.format(0, 11, "italic", true);
    a.doc.state.body.format(2, 3, "italic", null); // inside the italic mark, which stays
    a.send(); a.sync();
    const saved = server.checkpoint();
    const marks = saved.snapshot.data.body.marks ?? [];
    assert.deepEqual(marks.map((mark) => [mark.key, mark.value]), [["bold", null], ["italic", true], ["italic", null]]);
    const restored = createClient(Doc, { clientId: "reader", snapshot: decodeSnapshot(Doc, JSON.parse(JSON.stringify(saved.snapshot))),
      onBatch: () => {} });
    assert.deepEqual(delta(restored), delta(a.doc));
    const fromCheckpoint = createServer(Doc, { checkpoint: decodeServerCheckpoint(Doc, JSON.parse(JSON.stringify(saved))) });
    assert.deepEqual(fromCheckpoint.checkpoint().snapshot.data.body, saved.snapshot.data.body);

    const plain = createServer(Plain);
    const reader = createClient(Plain, { clientId: plain.openClient(), onBatch: (batch) => { plain.receive(batch); } });
    reader.state.body.insert(0, "abc");
    assert.deepEqual(Object.keys(plain.checkpoint().snapshot.data.body), ["idList", "value"]);
  });

  it("validates marks locally, on the wire and on the server", () => {
    const { server, writer } = network();
    const a = writer();
    a.doc.state.body.insert(0, "abc");
    const body = a.doc.state.body;
    // @ts-expect-error -- Not a mark of this Text.
    assert.throws(() => body.format(0, 1, "underline", true), /Unknown mark/);
    assert.throws(() => body.format(0, 1, "link", "javascript:alert(1)"), PayloadValidationError);
    assert.throws(() => body.format(2, 2, "bold", true), RangeError);
    // @ts-expect-error -- Not a number.
    assert.throws(() => body.format("0", 1, "bold", true), TypeError);
    const sent = a.outbox.length;
    body.format(1, 0, "bold", true);
    assert.equal(a.outbox.length, sent, "an empty range records nothing");
    a.send();

    const other = server.openClient();
    const mark = (fields: Record<string, unknown>) => ({ clientId: other, seq: 1, operations: [{
      type: "text/mark", path: "body", start: { anchor: null, bind: "left" }, end: { anchor: null, bind: "right" },
      key: "bold", value: true, ...fields }] });
    assert.throws(() => decodeClientBatch(Doc, mark({ key: "underline" })), WireDecodeError);
    assert.throws(() => decodeClientBatch(Plain, mark({})), WireDecodeError);
    assert.throws(() => decodeClientBatch(Doc, mark({ start: { anchor: null, bind: "up" } })), WireDecodeError);
    assert.throws(() => server.receive(decodeClientBatch(Doc, mark({ key: "link", value: "ftp://x" }))), PayloadValidationError);
    assert.throws(() => server.receive(decodeClientBatch(Doc, mark({
      start: { anchor: { bunchId: "nobody", counter: 0 }, bind: "right" } }))), CollectionConflictError);
    assert.throws(() => server.receive(decodeClientBatch(Doc, mark({
      start: { anchor: null, bind: "right" }, end: { anchor: null, bind: "left" } }))), /start must come before its end/);
    // A mark that covers no visible text yet is still a range: text typed into it is formatted.
    server.receive(decodeClientBatch(Doc, mark({})));
    a.sync();
    assert.deepEqual(delta(a.doc), [{ insert: "abc", attributes: { bold: true } }]);
  });

  it("reports format changes to observers, including inserted runs, but not for plain Text", () => {
    const { writer } = network();
    const a = writer(), b = writer();
    a.doc.state.body.insert(0, "Hello world");
    a.send(); a.sync(); b.sync();
    const events: TextChangeEvent[] = [];
    const stop = a.doc.state.body.observe((event) => events.push(event));
    a.doc.state.body.format(6, 5, "bold", true);
    assert.deepEqual(JSON.parse(JSON.stringify(events.splice(0))), [{ beforeLength: 11, afterLength: 11, changes: [],
      formats: [{ index: 6, count: 5, attributes: { bold: true } }] }]);
    a.doc.state.body.insert(11, "!");
    assert.deepEqual(JSON.parse(JSON.stringify(events.splice(0))), [{ beforeLength: 11, afterLength: 12,
      changes: [{ index: 11, deleteCount: 0, insert: ["!"] }], formats: [{ index: 11, count: 1, attributes: { bold: true } }] }]);
    b.doc.state.body.format(0, 5, "italic", true);
    b.send(); a.send(); a.sync();
    assert.deepEqual(events.splice(0).map((event) => JSON.parse(JSON.stringify(event.formats)) as unknown),
      [[{ index: 0, count: 5, attributes: { italic: true } }]]);
    stop();

    const plain = createServer(Plain);
    const reader = createClient(Plain, { clientId: plain.openClient(), onBatch: () => {} });
    const plainEvents: TextChangeEvent[] = [];
    reader.state.body.observe((event) => plainEvents.push(event));
    reader.state.body.insert(0, "abc");
    assert.equal(Object.hasOwn(plainEvents[0]!, "formats"), false);
  });
});
