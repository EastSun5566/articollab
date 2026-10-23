import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { EditorSelection, type TransactionSpec } from "@codemirror/state";
import { createClient, createServer, defineDocument, text, value, type ClientBatch,
  type DocumentOperation } from "../../../dist/index.js";
import { createTextBinding } from "../binding.js";
import { textEdits } from "../changes.js";

const Note = defineDocument({ body: text(), count: value(0) });
type Batch = ClientBatch<DocumentOperation<typeof Note.definition>>;

function fixture() {
  const server = createServer(Note);
  const batches: Batch[] = [];
  const doc = createClient(Note, { clientId: server.openClient(), onBatch(batch) { batches.push(batch); } });
  let updates = 0, allowed = true;
  const errors: unknown[] = [];
  const binding = createTextBinding(doc, {
    update() { updates++; }, canEdit: () => allowed, onError(error) { errors.push(error); },
  });
  function edit(spec: TransactionSpec) { binding.dispatch([binding.state.update(spec)]); }
  function check() {
    assert.deepEqual(binding.elements, Array.from(doc.state.body));
    assert.equal(binding.state.doc.toString(), doc.state.body.toString());
  }
  return { server, doc, batches, binding, edit, check, errors,
    get updates() { return updates; }, set allowed(next: boolean) { allowed = next; },
  };
}

describe("Text editor state bridge", () => {
  it("edits ASCII, Chinese, emoji, combining characters and line breaks without changing CR", (t) => {
    const f = fixture(); t.after(() => f.binding.destroy());
    for (const input of ["Hello", "中文😀", "e\u0301", "\nline\r\nend", "\ud83d", "\ude00"]) {
      const before = f.batches.length;
      f.edit({ changes: { from: f.binding.state.doc.length, insert: input } });
      f.check();
      assert.equal(f.batches.length, before + 1);
    }
    assert.equal(f.doc.state.body.toString(), "Hello中文😀e\u0301\nline\r\nend😀");
    assert.deepEqual(f.binding.elements.slice(-2), ["\ud83d", "\ude00"]);
    assert.deepEqual(f.errors, []);
  });

  it("expands a change inside a surrogate pair into a complete element replacement", (t) => {
    const f = fixture(); t.after(() => f.binding.destroy());
    f.edit({ changes: { from: 0, insert: "A😀B" } });
    f.edit({ changes: { from: 2, insert: "x" } });
    f.check();
    assert.deepEqual(f.binding.elements, ["A", "\ud83d", "x", "\ude00", "B"]);
    assert.equal(f.batches[1]!.operations.length, 2);
    assert.equal(f.batches[1]!.operations[0]!.type, "text/delete");
    f.edit({ changes: { from: 2, to: 3 } });
    f.check();
    assert.deepEqual(f.binding.elements, ["A", "\ud83d", "\ude00", "B"]);
  });

  it("merges overlapping expanded ranges and applies multiple regions as one batch", (t) => {
    const f = fixture(); t.after(() => f.binding.destroy());
    f.edit({ changes: { from: 0, insert: "😀 middle 😀" } });
    f.edit({ changes: [{ from: 0, to: 1, insert: "H" }, { from: 1, to: 2, insert: "L" },
      { from: 11, to: 12, insert: "!" }] });
    f.check();
    assert.equal(f.batches.length, 2);
    assert.equal(f.doc.state.body.toString(), "HL middle \ud83d!");
    assert.equal(f.batches[1]!.operations.length, 4);
    f.edit({ changes: { from: 0, to: f.binding.state.doc.length, insert: "😀" } });
    // Separate editor ranges overlap after expanding the second into the emoji.
    f.edit({ changes: [{ from: 0, insert: "L" }, { from: 1, insert: "R" }] });
    f.check();
    assert.deepEqual(f.binding.elements, ["L", "\ud83d", "R", "\ude00"]);
  });

  it("preserves untouched separately inserted surrogate elements during unrelated edits", (t) => {
    const f = fixture(); t.after(() => f.binding.destroy());
    f.doc.state.body.insert(0, "\ud83d");
    f.doc.state.body.insert(1, "\ude00");
    f.edit({ changes: { from: 2, insert: "!" } });
    f.check();
    assert.deepEqual(f.binding.elements, ["\ud83d", "\ude00", "!"]);
  });

  it("does not create batches for selection-only, empty or same-content transactions", (t) => {
    const f = fixture(); t.after(() => f.binding.destroy());
    f.edit({ changes: { from: 0, insert: "AB" } });
    const saved = f.doc.checkpoint();
    f.edit({ selection: EditorSelection.cursor(1) });
    f.edit({});
    f.edit({ changes: { from: 0, to: 2, insert: "AB" } });
    f.check();
    assert.deepEqual(f.doc.checkpoint(), saved);
    assert.equal(f.batches.length, 1);
  });

  it("applies observer edits in old-document UTF-16 coordinates and maps selection", (t) => {
    const f = fixture(); t.after(() => f.binding.destroy());
    f.doc.state.body.insert(0, "A😀BC");
    f.edit({ selection: EditorSelection.cursor(5) });
    f.doc.transact(() => {
      f.doc.state.body.delete(1);
      f.doc.state.body.insert(1, "中");
      f.doc.state.body.insert(4, "!");
    });
    f.check();
    assert.equal(f.binding.state.doc.toString(), "A中BC!");
    assert.equal(f.binding.state.selection.main.head, 4); // Default mapping stays before the final insertion.
    assert.equal(f.batches.length, 2); // No observer echo.
  });

  it("keeps same-string element-boundary updates out of the editor", (t) => {
    const f = fixture(); t.after(() => f.binding.destroy());
    f.doc.state.body.insert(0, "😀");
    const before = f.updates;
    f.doc.transact(() => {
      f.doc.state.body.delete(0);
      f.doc.state.body.insert(0, "\ud83d");
      f.doc.state.body.insert(1, "\ude00");
    });
    f.check();
    assert.equal(f.updates, before);
    assert.deepEqual(f.binding.elements, ["\ud83d", "\ude00"]);
  });

  it("keeps an accepted own ack silent and preserves later pending edits", (t) => {
    const f = fixture(); t.after(() => f.binding.destroy());
    f.edit({ changes: { from: 0, insert: "A" } });
    f.edit({ changes: { from: 1, insert: "😀" } });
    const before = f.updates;
    f.doc.receive(f.server.receive(f.batches[0]!).commit);
    f.check();
    assert.equal(f.updates, before);
    assert.deepEqual(f.doc.checkpoint().pendingBatches.map((batch) => batch.seq), [2]);
  });

  it("does not materialize or checkpoint Text for incremental edits", (t) => {
    const f = fixture(); t.after(() => f.binding.destroy());
    const materialize = mock.method(f.doc.state.body, "toString", () => { throw new Error("Unexpected materialization"); });
    const checkpoint = mock.method(f.doc, "checkpoint", () => { throw new Error("Unexpected checkpoint"); });
    f.edit({ changes: { from: 0, insert: "Hello😀" } });
    f.doc.state.body.delete(0);
    assert.equal(f.binding.state.doc.toString(), "ello😀");
    assert.equal(materialize.mock.callCount(), 0);
    assert.equal(checkpoint.mock.callCount(), 0);
  });

  it("blocks programmatic edits while locked without poisoning later work", (t) => {
    const f = fixture(); t.after(() => f.binding.destroy());
    f.allowed = false;
    assert.throws(() => f.edit({ changes: { from: 0, insert: "x" } }));
    assert.equal(f.batches.length, 0);
    assert.deepEqual(f.errors, []);
    f.allowed = true;
    f.edit({ changes: { from: 0, insert: "ok" } });
    f.check();
  });

  it("preserves a completed mutation and the first callback error", () => {
    const failure = new Error("UI update failed"), later = new Error("error reporting failed");
    const server = createServer(Note), batches: Batch[] = [];
    const doc = createClient(Note, { clientId: server.openClient(), onBatch(batch) { batches.push(batch); } });
    let errors = 0;
    const binding = createTextBinding(doc, {
      update() { throw failure; }, canEdit: () => true,
      onError(error) { assert.equal(error, failure); errors++; throw later; },
    });
    assert.throws(() => binding.dispatch([binding.state.update({ changes: { from: 0, insert: "kept" } })]), (error) => error === failure);
    assert.equal(doc.state.body.toString(), "kept");
    assert.equal(doc.checkpoint().pendingBatches.length, 1);
    assert.throws(() => doc.state.body.insert(4, "!"), (error) => error === failure);
    assert.equal(doc.state.body.toString(), "kept!"); // Observer failures do not roll back.
    assert.equal(errors, 1);
    binding.destroy(); binding.destroy();
    doc.state.body.insert(5, "more"); // Unsubscribed.
    assert.throws(() => binding.dispatch([binding.state.update({})]));
  });

  it("keeps pending when onBatch fails before the observer or editor can update", () => {
    const failure = new Error("outbound callback failed");
    const server = createServer(Note);
    const doc = createClient(Note, { clientId: server.openClient(), onBatch() { throw failure; } });
    let updates = 0;
    const errors: unknown[] = [];
    const binding = createTextBinding(doc, {
      update() { updates++; }, canEdit: () => true, onError(error) { errors.push(error); },
    });
    assert.throws(() => binding.dispatch([binding.state.update({ changes: { from: 0, insert: "kept" } })]), (error) => error === failure);
    assert.equal(updates, 0);
    assert.equal(binding.state.doc.length, 0);
    assert.equal(doc.state.body.toString(), "kept");
    assert.equal(doc.checkpoint().pendingBatches.length, 1);
    assert.deepEqual(errors, [failure]);
    binding.destroy();
  });

  it("validates observer baselines instead of applying a partial malformed diff", () => {
    assert.throws(() => textEdits(["A"], { beforeLength: 2, afterLength: 0, changes: [] }));
    assert.throws(() => textEdits(["A"], { beforeLength: 1, afterLength: 0, changes: [] }));
  });

  it("matches editor content through deterministic UTF-16 edits at arbitrary offsets", (t) => {
    const f = fixture(); t.after(() => f.binding.destroy());
    let seed = 42;
    function random(bound: number) { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) % bound; }
    const values = ["A", "😀", "中", "\ud83d", "\ude00", "\r\n", "e\u0301", ""];
    for (let step = 0; step < 200; step++) {
      const length = f.binding.state.doc.length;
      const from = random(length + 1), to = from + random(length - from + 1);
      const transaction = f.binding.state.update({ changes: { from, to, insert: values[random(values.length)]! } });
      const expected = transaction.newDoc.toString();
      f.binding.dispatch([transaction]);
      f.check();
      assert.equal(f.doc.state.body.toString(), expected, `step ${step}`);
    }
  });
});
