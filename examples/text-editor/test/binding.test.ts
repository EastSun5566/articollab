import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { EditorSelection, type TransactionSpec } from "@codemirror/state";
import { createClient, createServer, defineDocument, text, value, type ClientBatch,
  type DocumentOperation } from "../../../dist/index.js";
import { blockLines, createTextBinding, formatRanges, remoteRanges } from "../binding.js";
import { Note as RichNote } from "../schema.js";
import { createMirror, editorOffset, elementIndexAt, textEdits } from "../changes.js";

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

  it("leaves the editor alone when another writer changes another path", (t) => {
    const f = fixture(); t.after(() => f.binding.destroy());
    f.edit({ changes: { from: 0, insert: "Hello" } });
    const { peer, deliver } = withPeer(f);
    peer.state.count.value = 7;
    deliver();
    const updates = f.updates;
    assert.equal(f.binding.state.doc.toString(), "Hello");
    assert.deepEqual([f.doc.state.count.value, f.batches.length, f.updates], [7, 0, updates], "no echo and no editor update");
    f.check();
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
    assert.throws(() => textEdits(createMirror(["A"]), { beforeLength: 2, afterLength: 0, changes: [] }));
    assert.throws(() => textEdits(createMirror(["A"]), { beforeLength: 1, afterLength: 0, changes: [] }));
    assert.throws(() => textEdits(createMirror(["A"]), {
      beforeLength: 1, afterLength: 1, changes: [{ index: 2, deleteCount: 0, insert: ["B"] }],
    }));
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

  it("maps remote Text edits through wide elements without a full mirror", (t) => {
    const f = fixture(); t.after(() => f.binding.destroy());
    let seed = 7;
    function random(bound: number) { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) % bound; }
    const values = ["A", "😀", "中", "\ud83d", "\ude00", "𝄞x", "e\u0301", "😀😀"];
    const body = f.doc.state.body;
    for (let step = 0; step < 300; step++) {
      // Programmatic edits arrive through Text.observe, sometimes several per notification.
      f.doc.transact(() => {
        for (let edit = random(3) + 1; edit > 0; edit--) {
          const index = random(body.length + 1);
          if (random(3) === 0 && index < body.length) body.delete(index, 1 + random(Math.min(3, body.length - index)));
          else body.insert(index, values[random(values.length)]!);
        }
      });
      f.check();
      if (step % 5 === 0) {
        // Interleave local edits at UTF-16 offsets, including inside surrogate pairs.
        const length = f.binding.state.doc.length;
        const from = random(length + 1), to = from + random(Math.min(4, length - from) + 1);
        f.edit({ changes: { from, to, insert: values[random(values.length)]! } });
        f.check();
      }
    }
    assert.deepEqual(f.errors, []);
  });
});

/** A second writer without an editor, plus delivery of every pending batch to both documents. */
function withPeer(f: ReturnType<typeof fixture>) {
  const peerBatches: Batch[] = [];
  const peer = createClient(Note, { clientId: f.server.openClient(), onBatch(batch) { peerBatches.push(batch); } });
  function deliver(): void {
    for (const batch of [...f.batches.splice(0), ...peerBatches.splice(0)]) {
      const { commit } = f.server.receive(batch);
      f.doc.receive(commit); peer.receive(commit);
    }
  }
  return { peer, deliver };
}
const slice = (f: ReturnType<typeof fixture>) => f.binding.state.field(remoteRanges).map(({ label, from, to }) =>
  ({ label, text: f.binding.state.doc.sliceString(from, to), at: to }));

describe("Remote selections", () => {
  it("maps element indices and UTF-16 offsets both ways around wide and split elements", () => {
    const mirror = createMirror(["a", "😀", "b", "\ud83d", "\ude00", "c"]);
    for (let index = 0; index <= 6; index++) assert.equal(elementIndexAt(mirror, editorOffset(mirror, index)), index);
    assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7].map((offset) => elementIndexAt(mirror, offset)), [0, 1, 1, 2, 3, 4, 5, 6]);
  });

  it("turns the editor selection into cursors: a caret binds left, a range keeps its edges", (t) => {
    const f = fixture(); t.after(() => f.binding.destroy());
    f.edit({ changes: { from: 0, insert: "a😀b\ud83d" } });
    f.edit({ changes: { from: 5, insert: "\ude00c" } });
    f.edit({ selection: EditorSelection.cursor(3) });
    const caret = f.binding.selectionCursors();
    assert.equal(caret.from, caret.to);
    assert.equal(caret.from.bind, "left");
    assert.equal(f.doc.state.body.cursorIndex(caret.from), 2);
    f.edit({ selection: EditorSelection.range(1, 6) });
    const range = f.binding.selectionCursors();
    assert.deepEqual([range.from.bind, range.to.bind], ["right", "left"]);
    assert.deepEqual([f.doc.state.body.cursorIndex(range.from), f.doc.state.body.cursorIndex(range.to)], [1, 5]);
    assert.deepEqual(f.errors, []);
  });

  it("draws resolved selections in UTF-16 and re-resolves after remote edits, local edits and deletions", (t) => {
    const f = fixture(); t.after(() => f.binding.destroy());
    const { peer, deliver } = withPeer(f);
    f.edit({ changes: { from: 0, insert: "Hello 😀 world" } });
    deliver();
    const selection = { from: peer.state.body.cursorAt(8, "right"), to: peer.state.body.cursorAt(13) };
    const statuses = f.binding.setRemote([{ label: "P", selection: structuredClone(selection) }]);
    assert.deepEqual(statuses, [{ label: "P", resolved: true, from: 8, to: 13 }]);
    assert.deepEqual(f.binding.state.field(remoteRanges), [{ label: "P", from: 9, to: 14 }]);
    peer.state.body.insert(13, "!");
    peer.state.body.insert(8, "new ");
    deliver();
    assert.equal(f.binding.state.doc.toString(), "Hello 😀 new world!");
    assert.deepEqual(slice(f), [{ label: "P", text: "world", at: 18 }], "edge insertions stay outside");
    f.edit({ changes: { from: 0, insert: "¡" } });
    assert.deepEqual(slice(f), [{ label: "P", text: "world", at: 19 }]);
    peer.state.body.delete(12, 5); // The peer has not received "¡" yet.
    deliver();
    assert.equal(f.binding.state.doc.toString(), "¡Hello 😀 new !");
    assert.deepEqual(slice(f), [{ label: "P", text: "", at: 14 }], "a deleted selection collapses");
    assert.deepEqual(f.errors, []);
  });

  it("hides positions anchored in unreceived text until the commit arrives", (t) => {
    const f = fixture(); t.after(() => f.binding.destroy());
    const { peer, deliver } = withPeer(f);
    f.edit({ changes: { from: 0, insert: "ab" } });
    deliver();
    peer.state.body.insert(1, "XY");
    const caret = peer.state.body.cursorAt(3);
    assert.deepEqual(f.binding.setRemote([{ label: "P", selection: { from: caret, to: caret } }]), [{ label: "P", resolved: false }]);
    assert.deepEqual(f.binding.state.field(remoteRanges), []);
    deliver();
    assert.equal(f.binding.state.doc.toString(), "aXYb");
    assert.deepEqual(slice(f), [{ label: "P", text: "", at: 3 }]);
    f.binding.setRemote([]);
    assert.deepEqual(f.binding.state.field(remoteRanges), []);
    assert.deepEqual(f.errors, []);
  });
});

function bind(doc: Parameters<typeof createTextBinding>[0]) {
  return createTextBinding(doc, { update() {}, canEdit: () => true, onError(error) { throw error; } });
}
function ranges(binding: ReturnType<typeof bind>) {
  return binding.state.field(formatRanges).map(({ from, to, attributes }) => [from, to, attributes]);
}

describe("Text editor formatting", () => {
  type RichBatch = ClientBatch<DocumentOperation<typeof RichNote.definition>>;
  function rich() {
    const server = createServer(RichNote);
    const outbox: RichBatch[] = [];
    const writer = () => {
      const doc = createClient(RichNote, { clientId: server.openClient(), onBatch(batch) { outbox.push(batch); } });
      let seen = 0;
      return { doc, deliver() {
        for (const commit of server.commitsSince(seen) ?? []) { doc.receive(commit); seen = commit.serverSeq; }
      } };
    };
    const a = writer(), b = writer();
    /** Submits every batch, then delivers every commit to both writers. */
    const sync = () => { for (const batch of outbox.splice(0)) server.receive(batch); a.deliver(); b.deliver(); };
    return { a, b, sync };
  }

  it("starts from the Text's marks and follows remote formatting in UTF-16 offsets", (t) => {
    const { a, b, sync } = rich();
    a.doc.state.body.insert(0, "😀 bold link");
    a.doc.state.body.format(2, 4, "bold", true);
    sync();
    const binding = bind(b.doc); t.after(() => binding.destroy());
    assert.deepEqual(ranges(binding), [[3, 7, { bold: true }]]);
    a.doc.state.body.format(7, 4, "link", "https://example.com");
    a.doc.state.body.format(0, 1, "italic", true);
    sync();
    assert.deepEqual(ranges(binding), [[0, 2, { italic: true }], [3, 7, { bold: true }],
      [8, 12, { link: "https://example.com" }]]);
  });

  it("formats typed text as the marks' expand rules say", (t) => {
    const { a, sync } = rich();
    const binding = bind(a.doc); t.after(() => binding.destroy());
    binding.dispatch([binding.state.update({ changes: { from: 0, insert: "bold link" } })]);
    a.doc.state.body.format(0, 4, "bold", true);
    a.doc.state.body.format(5, 4, "link", "https://example.com");
    binding.dispatch([binding.state.update({ changes: { from: 4, insert: "er" } })]); // "bolder link"
    binding.dispatch([binding.state.update({ changes: { from: 11, insert: "s" } })]); // "bolder links"
    assert.deepEqual(ranges(binding), [[0, 6, { bold: true }], [7, 11, { link: "https://example.com" }]]);
    sync();
    assert.deepEqual(ranges(binding), [[0, 6, { bold: true }], [7, 11, { link: "https://example.com" }]]);
  });

  it("toggles a mark on the selection", (t) => {
    const { a } = rich();
    const binding = bind(a.doc); t.after(() => binding.destroy());
    binding.dispatch([binding.state.update({ changes: { from: 0, insert: "one two" } })]);
    assert.equal(binding.toggleMark("bold", true), false, "nothing selected");
    binding.dispatch([binding.state.update({ selection: EditorSelection.single(0, 3) })]);
    binding.toggleMark("bold", true);
    assert.deepEqual(a.doc.state.body.toDelta(), [{ insert: "one", attributes: { bold: true } }, { insert: " two" }]);
    binding.dispatch([binding.state.update({ selection: EditorSelection.single(0, 7) })]);
    binding.toggleMark("bold", true); // Not all bold yet: bold everywhere.
    assert.deepEqual(ranges(binding), [[0, 7, { bold: true }]]);
    binding.toggleMark("bold", true); // All bold: removed.
    assert.deepEqual(ranges(binding), []);
  });
});

function lines(binding: ReturnType<typeof bind>) {
  return binding.state.field(blockLines).map(({ from, attributes }) => [from, attributes]);
}

function paragraphNetwork() {
  const server = createServer(RichNote);
  const outbox: ClientBatch<DocumentOperation<typeof RichNote.definition>>[] = [];
  const writer = () => {
    const doc = createClient(RichNote, { clientId: server.openClient(), onBatch(batch) { outbox.push(batch); } });
    let seen = 0;
    return { doc, deliver() {
      for (const commit of server.commitsSince(seen) ?? []) { doc.receive(commit); seen = commit.serverSeq; }
    } };
  };
  const a = writer(), b = writer();
  const sync = () => { for (const batch of outbox.splice(0)) server.receive(batch); a.deliver(); b.deliver(); };
  return { a, b, sync };
}

describe("Text editor paragraphs", () => {
  it("starts from the Text's paragraphs and follows remote changes, splits and joins", (t) => {
    const { a, b, sync } = paragraphNetwork();
    a.doc.state.body.insert(0, "Title\n😀 item");
    a.doc.state.body.formatBlocks(0, 0, "heading", 1);
    sync();
    const binding = bind(b.doc); t.after(() => binding.destroy());
    assert.deepEqual(lines(binding), [[0, { heading: 1 }]]);
    a.doc.state.body.formatBlocks(6, 0, "list", "bullet");
    sync();
    assert.deepEqual(lines(binding), [[0, { heading: 1 }], [6, { list: "bullet" }]]);
    a.doc.state.body.delete(5); // Joins the list item to the title
    sync();
    assert.deepEqual(lines(binding), [[0, { heading: 1 }]]);
  });

  it("continues a list on Enter, ends it on Enter in an empty item, and toggles paragraphs", (t) => {
    const { a } = paragraphNetwork();
    const binding = bind(a.doc); t.after(() => binding.destroy());
    binding.dispatch([binding.state.update({ changes: { from: 0, insert: "one" } })]);
    binding.toggleBlock({ key: "list", value: "bullet" });
    binding.dispatch([binding.state.update({ selection: EditorSelection.cursor(3) })]);
    assert.equal(binding.enter(), true);
    binding.dispatch([binding.state.update({ changes: { from: 4, insert: "two" }, selection: EditorSelection.cursor(7) })]);
    assert.deepEqual(a.doc.state.body.blocks().map(({ attributes }) => attributes), [{ list: "bullet" }, { list: "bullet" }]);
    binding.enter();
    binding.enter(); // An empty item: the list ends instead of another line
    assert.equal(binding.state.doc.toString(), "one\ntwo\n");
    assert.deepEqual(a.doc.state.body.blocks().map(({ attributes }) => attributes), [{ list: "bullet" }, { list: "bullet" }, {}]);
    assert.deepEqual(lines(binding), [[0, { list: "bullet" }], [4, { list: "bullet" }]]);
    binding.dispatch([binding.state.update({ selection: EditorSelection.single(0, 5) })]);
    binding.toggleBlock({ key: "list", value: "bullet" }); // Both items have it: removed from both
    binding.toggleBlock({ key: "heading", value: 2 });
    assert.deepEqual(lines(binding), [[0, { heading: 2 }], [4, { heading: 2 }]]);
  });

  it("moves a heading down with its text on Enter at the paragraph's start", (t) => {
    const { a } = paragraphNetwork();
    const binding = bind(a.doc); t.after(() => binding.destroy());
    binding.dispatch([binding.state.update({ changes: { from: 0, insert: "Title" } })]);
    binding.toggleBlock({ key: "heading", value: 1 });
    binding.dispatch([binding.state.update({ selection: EditorSelection.cursor(0) })]);
    binding.enter();
    assert.equal(binding.state.doc.toString(), "\nTitle");
    assert.deepEqual(a.doc.state.body.blocks().map(({ attributes }) => attributes), [{}, { heading: 1 }]);
    assert.deepEqual(lines(binding), [[1, { heading: 1 }]]);
  });
});
