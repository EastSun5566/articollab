import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { baseKeymap, setBlockType, toggleMark, wrapIn } from "prosemirror-commands";
import { liftListItem, sinkListItem, splitListItem, wrapInList } from "prosemirror-schema-list";
import { TextSelection, type Command, type EditorState } from "prosemirror-state";
import { createClient, createServer, createUndoManager, type ClientBatch, type DocumentOperation } from "articollab";
import { createRichTextBinding } from "../binding.js";
import { buildDoc, textLines } from "../flat.js";
import { editorSchema, keepSafeLinks, Note } from "../schema.js";

type Batch = ClientBatch<DocumentOperation<typeof Note.definition>>;
const nodes = editorSchema.nodes, marks = editorSchema.marks;

/** A server, and writers whose batches and commits move only when a test says so. */
function network() {
  const server = createServer(Note, { resolve: keepSafeLinks });
  const writers: { send(): void; receive(): void }[] = [];
  function writer(options: Partial<Parameters<typeof createRichTextBinding>[1]> = {}) {
    const outbox: Batch[] = [];
    const doc = createClient(Note, { clientId: server.openClient(), onBatch: (batch) => outbox.push(batch) });
    let seen = 0;
    const binding = createRichTextBinding(doc, { update() {}, canEdit: () => true, onError(error) { throw error; }, ...options });
    const entry = {
      doc, binding, outbox,
      /** Runs a ProseMirror command as the user would. */
      run(command: Command) { assert.equal(command(binding.state, (tr) => { binding.dispatch(tr); }), true); },
      type(text: string) { binding.dispatch(binding.state.tr.insertText(text)); },
      select(from: number, to = from) {
        binding.dispatch(binding.state.tr.setSelection(TextSelection.create(binding.state.doc, from, to)));
      },
      send() { for (const batch of outbox.splice(0)) server.receive(batch); },
      receive() { for (const commit of server.commitsSince(seen) ?? []) { doc.receive(commit); seen = commit.serverSeq; } },
    };
    writers.push(entry);
    return entry;
  }
  /** Sends everything, then delivers every commit to every writer. */
  const sync = () => { for (const each of writers) each.send(); for (const each of writers) each.receive(); };
  return { writer, sync };
}

const json = (state: EditorState) => JSON.stringify(state.doc.toJSON());
const end = (state: EditorState) => TextSelection.atEnd(state.doc).from;

describe("Rich text binding", () => {
  it("writes typing, marks and paragraph types to the Text, one batch per transaction", () => {
    const { writer } = network();
    const a = writer();
    a.type("Title");
    a.run(setBlockType(nodes.heading!, { level: 1 }));
    a.run(baseKeymap.Enter!);
    a.type("hello world");
    assert.equal(a.outbox.length, 4);
    a.select(8, 13); // "hello"
    a.run(toggleMark(marks.strong!));
    a.select(end(a.binding.state) - 5, end(a.binding.state));
    a.run(toggleMark(marks.link!, { href: "https://example.com" }));
    assert.equal(a.outbox.length, 6);
    assert.deepEqual(JSON.parse(JSON.stringify(a.doc.state.body.toDelta())), [
      { insert: "Title\n" }, { insert: "hello", attributes: { bold: true } }, { insert: " " },
      { insert: "world", attributes: { link: "https://example.com" } },
    ]);
    assert.deepEqual(a.doc.state.body.blocks().map(({ attributes }) => attributes), [{ heading: 1 }, {}]);
  });

  it("writes lists, nesting, quotes and code blocks", () => {
    const { writer } = network();
    const a = writer();
    a.type("one");
    a.run(wrapInList(nodes.bullet_list!));
    a.run(splitListItem(nodes.list_item!));
    a.type("nested");
    a.run(sinkListItem(nodes.list_item!));
    a.run(splitListItem(nodes.list_item!));
    a.run(liftListItem(nodes.list_item!));
    a.run(liftListItem(nodes.list_item!)); // Out of the list
    a.type("quoted");
    a.run(wrapIn(nodes.blockquote!));
    assert.equal(a.doc.state.body.toString(), "one\nnested\nquoted");
    assert.deepEqual(a.doc.state.body.blocks().map(({ attributes }) => attributes),
      [{ list: "bullet" }, { indent: 1, list: "bullet" }, { quote: true }]);
    const types: string[] = [];
    a.binding.state.doc.forEach((node) => { types.push(node.type.name); });
    assert.deepEqual(types, ["bullet_list", "blockquote"]);

    const b = writer();
    b.type("let x = 1;");
    b.run(setBlockType(nodes.code_block!));
    b.run(baseKeymap.Enter!); // A new line inside the code block
    b.type("x++");
    assert.equal(b.doc.state.body.toString(), "let x = 1;\nx++");
    assert.deepEqual(b.doc.state.body.blocks().map(({ attributes }) => attributes), [{ code: true }, { code: true }]);
    assert.equal(b.binding.state.doc.childCount, 1, "one code block");
  });

  it("converges two writers through the server and keeps each one's selection on its text", () => {
    const { writer, sync } = network();
    const a = writer(), b = writer();
    a.type("first");
    a.run(baseKeymap.Enter!);
    a.type("second");
    sync();
    assert.equal(json(a.binding.state), json(b.binding.state));
    b.select(3); // "fi|rst"
    a.select(1);
    a.type(">> "); // A types before B's caret
    a.run(wrapInList(nodes.ordered_list!));
    b.select(end(b.binding.state));
    b.run(toggleMark(marks.em!));
    b.type("!");
    b.select(3);
    sync();
    assert.equal(json(a.binding.state), json(b.binding.state));
    assert.equal(a.doc.state.body.toString(), ">> first\nsecond!");
    assert.deepEqual(a.doc.state.body.blocks().map(({ attributes }) => attributes), [{ list: "ordered" }, {}]);
    // B's caret stays between "fi" and "rst", now further right and inside a list item.
    const caret = b.binding.state.selection.from;
    assert.equal(b.binding.state.doc.textBetween(caret - 5, caret), ">> fi");
  });

  it("converges when one writer indents an item and another types in it, in either order", () => {
    for (const indentFirst of [true, false]) {
      const { writer, sync } = network();
      const a = writer(), b = writer();
      a.type("one");
      a.run(wrapInList(nodes.bullet_list!));
      a.run(splitListItem(nodes.list_item!));
      a.type("two");
      sync();
      a.run(sinkListItem(nodes.list_item!));
      b.select(end(b.binding.state));
      b.type(" more");
      if (indentFirst) { a.send(); b.send(); } else { b.send(); a.send(); }
      a.receive(); b.receive();
      assert.equal(json(a.binding.state), json(b.binding.state), `indentFirst=${indentFirst}`);
      assert.equal(a.doc.state.body.toString(), "one\ntwo more");
      assert.deepEqual(a.doc.state.body.blocks().map(({ attributes }) => attributes), [{ list: "bullet" }, { indent: 1, list: "bullet" }]);
    }
  });

  it("follows undo, redo and a link the server drops", () => {
    const { writer, sync } = network();
    const a = writer();
    const history = createUndoManager(a.doc, { captureTimeout: 0 });
    a.type("Title");
    a.run(setBlockType(nodes.heading!, { level: 2 }));
    history.undo();
    assert.equal(a.binding.state.doc.firstChild?.type.name, "paragraph");
    history.redo();
    assert.equal(a.binding.state.doc.firstChild?.type.name, "heading");
    a.select(1, 6);
    a.run(toggleMark(marks.link!, { href: "javascript:alert(1)" }));
    assert.equal(a.binding.state.doc.rangeHasMark(1, 6, marks.link!), true);
    sync();
    assert.equal(a.binding.state.doc.rangeHasMark(1, 6, marks.link!), false);
  });
});

/** The editor shows exactly the standard shape of the writer's Text. */
function showsText(w: { binding: { state: EditorState }, doc: { state: { body: Parameters<typeof textLines>[0] } } }) {
  assert.equal(json(w.binding.state), JSON.stringify(buildDoc(editorSchema, textLines(w.doc.state.body)).toJSON()));
}
/** Starts a composition and shows `candidates`, each replacing the one before, from `at` (or over `to`). */
function draft(w: ReturnType<ReturnType<typeof network>["writer"]>, at: number, candidates: string[], to = at) {
  // An input method composes at the selection; moving it would drop stored marks.
  const { from, to: head } = w.binding.state.selection;
  if (!w.binding.composing && (from !== at || head !== to)) w.select(at, to);
  w.binding.startComposition();
  let last = to;
  for (const candidate of candidates) {
    const tr = w.binding.state.tr.insertText(candidate, at, last);
    w.binding.dispatch(tr.setSelection(TextSelection.create(tr.doc, at + candidate.length)));
    last = at + candidate.length;
  }
}

describe("Rich text composition", () => {
  it("keeps candidates in the editor and writes the confirmed text as one batch", () => {
    const { writer } = network();
    const a = writer();
    a.type("AB");
    const batches = a.outbox.length;
    draft(a, 2, ["ㄏ", "ㄏㄠ", "ㄏㄠˇ"]);
    assert.equal(a.binding.composing, true);
    assert.equal(a.binding.state.doc.textContent, "AㄏㄠˇB");
    assert.equal(a.doc.state.body.toString(), "AB");
    draft(a, 2, ["好"], 5); // A duplicate start keeps the first base.
    assert.equal(a.outbox.length, batches);
    a.binding.finishComposition();
    a.binding.finishComposition();
    assert.equal(a.doc.state.body.toString(), "A好B");
    assert.equal(a.outbox.length, batches + 1);
    showsText(a);
    assert.equal(a.doc.state.body.cursorIndex(a.binding.selectionCursors().from), 2);
  });

  it("merges changes from elsewhere that arrived during the composition, and shows them after it", () => {
    const { writer, sync } = network();
    const unsent: string[] = [];
    const a = writer({ onUnsentComposition(text) { unsent.push(text); } }), b = writer();
    a.type("ABC\nnext"); sync();
    draft(a, 2, ["ㄏ", "ㄏㄠ"], 3); // Replaces "B".
    b.doc.state.body.insert(0, "X"); // Before the paragraph's text.
    b.doc.state.body.delete(2, 1); // The "B" the composition replaces.
    b.doc.state.body.insert(b.doc.state.body.length - 5, "Y"); // After "C".
    b.doc.state.body.insert(b.doc.state.body.length, "!"); // Another paragraph.
    sync();
    assert.equal(a.binding.state.doc.textContent, "AㄏㄠCnext", "the composing editor waits");
    a.binding.dispatch(a.binding.state.tr.insertText("好", 2, 4));
    const batches = a.outbox.length;
    a.binding.finishComposition();
    assert.deepEqual(unsent, []);
    assert.equal(a.doc.state.body.toString(), "XA好CY\nnext!");
    assert.equal(a.outbox.length, batches + 1);
    showsText(a);
    assert.equal(a.doc.state.body.cursorIndex(a.binding.selectionCursors().from), 3);
    sync();
    assert.equal(json(b.binding.state), json(a.binding.state));
  });

  it("gives typed-over marks to the confirmed text, with or without changes from elsewhere", () => {
    for (const incoming of [false, true]) {
      const { writer, sync } = network();
      const a = writer(), b = writer();
      a.type("AB"); sync();
      a.run(toggleMark(marks.strong!)); // Stored for the next text.
      draft(a, 3, ["ㄏ", "好"]);
      if (incoming) { b.doc.state.body.insert(0, "Z"); sync(); }
      a.binding.finishComposition();
      assert.deepEqual(JSON.parse(JSON.stringify(a.doc.state.body.toDelta())),
        [{ insert: incoming ? "ZAB" : "AB" }, { insert: "好", attributes: { bold: true } }]);
      showsText(a);
    }
  });

  it("writes nothing for a cancelled composition, or one the writer can no longer send", () => {
    let allowed = true;
    const unsent: string[] = [];
    const { writer, sync } = network();
    const a = writer({ canEdit: () => allowed, onUnsentComposition(text) { unsent.push(text); } }), b = writer();
    a.type("AB"); sync();
    const batches = a.outbox.length;
    draft(a, 2, ["ㄏ", "ㄏㄠ"]);
    b.doc.state.body.insert(2, "X"); sync();
    a.binding.finishComposition(true);
    assert.equal(a.doc.state.body.toString(), "ABX");
    showsText(a);
    assert.deepEqual(unsent, []);

    draft(a, 2, ["ㄏ", "好"]);
    allowed = false;
    a.binding.finishComposition();
    assert.equal(a.doc.state.body.toString(), "ABX");
    showsText(a);
    assert.deepEqual(unsent, ["好"]);
    assert.equal(a.outbox.length, batches);
  });

  it("makes the confirmed text its own undo step", () => {
    let history: ReturnType<typeof createUndoManager> | undefined;
    const { writer } = network();
    const a = writer({ onCompositionBoundary() { history?.stopCapturing(); } });
    history = createUndoManager(a.doc, { captureTimeout: 60_000 });
    a.type("A"); a.type("B");
    draft(a, 3, ["ㄏ", "好"]);
    a.binding.finishComposition();
    a.type("C");
    assert.equal(a.doc.state.body.toString(), "AB好C");
    history.undo();
    assert.equal(a.doc.state.body.toString(), "AB好");
    history.undo();
    assert.equal(a.doc.state.body.toString(), "AB");
    showsText(a);
  });
});
