import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { baseKeymap, setBlockType, toggleMark, wrapIn } from "prosemirror-commands";
import { liftListItem, sinkListItem, splitListItem, wrapInList } from "prosemirror-schema-list";
import { TextSelection, type Command, type EditorState } from "prosemirror-state";
import { createClient, createServer, createUndoManager, type ClientBatch, type DocumentOperation } from "../../../dist/index.js";
import { createRichTextBinding } from "../binding.js";
import { editorSchema, keepSafeLinks, Note } from "../schema.js";

type Batch = ClientBatch<DocumentOperation<typeof Note.definition>>;
const nodes = editorSchema.nodes, marks = editorSchema.marks;

/** A server, and writers whose batches and commits move only when a test says so. */
function network() {
  const server = createServer(Note, { resolve: keepSafeLinks });
  const writers: { send(): void; receive(): void }[] = [];
  function writer() {
    const outbox: Batch[] = [];
    const doc = createClient(Note, { clientId: server.openClient(), onBatch: (batch) => outbox.push(batch) });
    let seen = 0;
    const binding = createRichTextBinding(doc, { update() {}, canEdit: () => true, onError(error) { throw error; } });
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
