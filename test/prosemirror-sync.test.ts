import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { baseKeymap, setBlockType, toggleMark, wrapIn } from "prosemirror-commands";
import { keymap } from "prosemirror-keymap";
import { liftListItem, sinkListItem, splitListItem, wrapInList } from "prosemirror-schema-list";
import { EditorState } from "prosemirror-state";

import { createClient, createUndoManager } from "../packages/articollab/src/index.ts";
import {
  basicMapping, isComposing, redo, resolveSelection, selectionCursors, setRemoteSelections, textSync, textToDoc, undo,
} from "../packages/articollab/src/prosemirror/index.ts";
import { editorSchema, end, json, network, Note } from "./prosemirror-helpers.ts";

const nodes = editorSchema.nodes, marks = editorSchema.marks;
const networks: ReturnType<typeof network>[] = [];
const open = () => { const made = network(); networks.push(made); return made; };
after(() => { for (const each of networks) each.destroy(); });

/** The editor shows exactly the standard shape of the writer's Text. */
function showsText(w: ReturnType<ReturnType<typeof network>["writer"]>) {
  assert.equal(json(w.state), JSON.stringify(textToDoc(w.doc.state.body, editorSchema).toJSON()));
}
const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

describe("ProseMirror sync", () => {
  it("writes typing, marks and paragraph types to the Text, one batch per transaction", () => {
    const { writer } = open();
    const a = writer();
    a.type("Title");
    a.run(setBlockType(nodes.heading!, { level: 1 }));
    a.run(baseKeymap.Enter!);
    a.type("hello world");
    assert.equal(a.outbox.length, 4);
    a.select(8, 13); // "hello"
    a.run(toggleMark(marks.strong!));
    a.select(end(a.state) - 5, end(a.state));
    a.run(toggleMark(marks.link!, { href: "https://example.com" }));
    assert.equal(a.outbox.length, 6);
    assert.deepEqual(plain(a.doc.state.body.toDelta()), [
      { insert: "Title\n" }, { insert: "hello", attributes: { bold: true } }, { insert: " " },
      { insert: "world", attributes: { link: "https://example.com" } },
    ]);
    assert.deepEqual(a.doc.state.body.blocks().map(({ attributes }) => attributes), [{ heading: 1 }, {}]);
    showsText(a);
  });

  it("writes lists, nesting, quotes and code blocks, and keeps the standard shape", () => {
    const { writer } = open();
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
    a.state.doc.forEach((node) => { types.push(node.type.name); });
    assert.deepEqual(types, ["bullet_list", "blockquote"]);
    showsText(a);

    const b = writer();
    b.type("let x = 1;");
    b.run(setBlockType(nodes.code_block!));
    b.run(baseKeymap.Enter!); // A new line inside the code block
    b.type("x++");
    assert.equal(b.doc.state.body.toString(), "let x = 1;\nx++");
    assert.deepEqual(b.doc.state.body.blocks().map(({ attributes }) => attributes), [{ code: true }, { code: true }]);
    assert.equal(b.state.doc.childCount, 1, "one code block");
  });

  it("puts a second paragraph in a list item back into the standard shape", () => {
    const { writer } = open();
    const a = writer();
    a.type("item");
    a.run(wrapInList(nodes.bullet_list!));
    // Split the paragraph inside the item, which the standard shape does not have.
    a.run(baseKeymap.Enter!);
    a.type("next");
    assert.equal(a.doc.state.body.toString(), "item\nnext");
    showsText(a);
  });

  it("converges two writers through the server and keeps each one's selection on its text", () => {
    const { writer, sync } = open();
    const a = writer(), b = writer();
    a.type("first");
    a.run(baseKeymap.Enter!);
    a.type("second");
    sync();
    assert.equal(json(a.state), json(b.state));
    b.select(3); // "fi|rst"
    a.select(1);
    a.type(">> "); // A types before B's caret
    a.run(wrapInList(nodes.ordered_list!));
    b.select(end(b.state));
    b.run(toggleMark(marks.em!));
    b.type("!");
    b.select(3);
    sync();
    assert.equal(json(a.state), json(b.state));
    assert.equal(a.doc.state.body.toString(), ">> first\nsecond!");
    assert.deepEqual(a.doc.state.body.blocks().map(({ attributes }) => attributes), [{ list: "ordered" }, {}]);
    // B's caret stays between "fi" and "rst", now further right and inside a list item.
    const caret = b.state.selection.from;
    assert.equal(b.state.doc.textBetween(caret - 5, caret), ">> fi");
  });

  it("converges when one writer indents an item and another types in it, in either order", () => {
    for (const indentFirst of [true, false]) {
      const { writer, sync } = open();
      const a = writer(), b = writer();
      a.type("one");
      a.run(wrapInList(nodes.bullet_list!));
      a.run(splitListItem(nodes.list_item!));
      a.type("two");
      sync();
      a.run(sinkListItem(nodes.list_item!));
      b.select(end(b.state));
      b.type(" more");
      if (indentFirst) { a.send(); b.send(); } else { b.send(); a.send(); }
      a.receive(); b.receive();
      assert.equal(json(a.state), json(b.state), `indentFirst=${indentFirst}`);
      assert.equal(a.doc.state.body.toString(), "one\ntwo more");
      assert.deepEqual(a.doc.state.body.blocks().map(({ attributes }) => attributes), [{ list: "bullet" }, { indent: 1, list: "bullet" }]);
    }
  });

  it("follows undo, redo and a link the server drops, with undo and redo as commands", () => {
    const { writer, sync } = open();
    const a = writer();
    const history = createUndoManager(a.doc, { captureTimeout: 0 });
    a.type("Title");
    a.run(setBlockType(nodes.heading!, { level: 2 }));
    assert.equal(a.run(undo(history)), true);
    assert.equal(a.state.doc.firstChild?.type.name, "paragraph");
    assert.equal(a.run(redo(history)), true);
    assert.equal(a.state.doc.firstChild?.type.name, "heading");
    assert.equal(a.run(redo(history)), false, "nothing to redo");
    a.select(1, 6);
    a.run(toggleMark(marks.link!, { href: "javascript:alert(1)" }));
    assert.equal(a.state.doc.rangeHasMark(1, 6, marks.link!), true);
    sync();
    assert.equal(a.state.doc.rangeHasMark(1, 6, marks.link!), false);
    showsText(a);
  });

  it("refuses local edits while the writer cannot edit, and leaves the editor as it was", () => {
    let allowed = false;
    const { writer } = open();
    const a = writer({ canEdit: () => allowed });
    a.type("x");
    a.run(setBlockType(nodes.heading!, { level: 1 }));
    assert.equal(a.state.doc.textContent, "");
    assert.equal(a.state.doc.firstChild?.type.name, "paragraph");
    assert.equal(a.outbox.length, 0);
    allowed = true;
    a.type("x");
    assert.equal(a.doc.state.body.toString(), "x");
  });

  it("shows the Text when the editor starts from something else, and takes a keymap with undo", () => {
    const doc = createClient(Note, { clientId: "a", onBatch() {} });
    doc.state.body.insert(0, "from the Text");
    doc.state.body.formatBlocks(0, 0, "heading", 2);
    const history = createUndoManager(doc, { captureTimeout: 0 });
    const plugin = textSync(doc, "body", { history });
    const { EditorView } = open();
    const view = new EditorView(document.createElement("div"), {
      state: EditorState.create({ schema: editorSchema, plugins: [plugin, keymap({ "Mod-z": undo(history) })] }),
    });
    assert.equal(json(view.state), JSON.stringify(textToDoc(doc.state.body, editorSchema).toJSON()));
    assert.equal(view.state.doc.firstChild?.type.name, "heading");
    view.dispatch(view.state.tr.insertText("!", 14));
    assert.equal(doc.state.body.toString(), "from the Text!");
    view.destroy();
    // Detached: changes to the Text no longer reach the editor.
    doc.state.body.insert(0, ">");
    assert.equal(view.state.doc.textContent, "from the Text!");
  });

  it("leaves paragraph attributes the mapping does not use as they are", () => {
    const doc = createClient(Note, { clientId: "a", onBatch() {} });
    doc.state.body.insert(0, "one\ntwo");
    doc.state.body.formatBlocks(0, 0, "indent", 2); // Not a list item, so the editor has no place for it.
    const { lists: _lists, ...shape } = basicMapping;
    const { EditorView } = open();
    const view = new EditorView(document.createElement("div"), {
      state: EditorState.create({ schema: editorSchema, plugins: [textSync(doc, "body", { mapping: shape })] }),
    });
    view.dispatch(view.state.tr.insertText("!", 4));
    view.dispatch(view.state.tr.setBlockType(1, 1, editorSchema.nodes.heading!, { level: 1 }));
    assert.equal(doc.state.body.toString(), "one!\ntwo");
    assert.deepEqual(doc.state.body.blocks().map(({ attributes }) => attributes), [{ heading: 1, indent: 2 }, {}]);
    view.destroy();
  });

  it("keeps a code block language this editor cannot show, and splits at a hard break", () => {
    const { writer } = open();
    const a = writer();
    a.doc.state.body.insert(0, "let x;");
    a.doc.state.body.formatBlocks(0, 0, "code", "js");
    assert.equal(a.state.doc.firstChild?.type.name, "code_block");
    a.select(end(a.state));
    a.type(" // ok");
    assert.deepEqual(a.doc.state.body.blocks().map(({ attributes }) => attributes), [{ code: "js" }]);
    a.run(setBlockType(nodes.paragraph!));
    a.run((state, dispatch) => { dispatch?.(state.tr.replaceSelectionWith(nodes.hard_break!.create())); return true; });
    a.type("next");
    assert.equal(a.doc.state.body.toString(), "let x; // ok\nnext");
    assert.deepEqual(a.doc.state.body.blocks().map(({ attributes }) => attributes), [{}, {}]);
    showsText(a);
  });

  it("refuses an editor that loads another copy of prosemirror-model", async () => {
    // The same package under another URL is another module instance, as a second install would be.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The same file as prosemirror-model.
    const copy = await import(import.meta.resolve("prosemirror-model") + "?copy") as typeof import("prosemirror-model");
    const schema = new copy.Schema({ nodes: { doc: { content: "paragraph+" }, paragraph: { content: "text*" }, text: {} } });
    const doc = createClient(Note, { clientId: "a", onBatch() {} });
    assert.throws(() => EditorState.create({ schema, plugins: [textSync(doc, "body", { mapping: { paragraph: "paragraph", marks: {} } })] }),
      /another copy of prosemirror-model or prosemirror-state/);
  });

  it("refuses a path that is not a Text", () => {
    const doc = createClient(Note, { clientId: "a", onBatch() {} });
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- A wrong path on purpose.
    assert.throws(() => textSync(doc, "title" as "body"), /Unknown collection path: title/);
  });
});

describe("ProseMirror sync of large documents", () => {
  it("reads only the changed part of the Text, for a local keystroke and a remote one", () => {
    const { writer, sync } = open();
    const a = writer(), b = writer();
    const paragraph = "lorem ipsum dolor sit amet ".repeat(4);
    a.doc.state.body.insert(0, Array.from({ length: 500 }, () => paragraph).join("\n"));
    a.doc.state.body.formatBlocks(0, 0, "heading", 1);
    sync();
    assert.ok(b.doc.state.body.length > 50_000);
    assert.equal(json(a.state), json(b.state));
    const reads: [string, number | undefined, number | undefined][] = [];
    for (const body of [a.doc.state.body, b.doc.state.body]) {
      const toDelta = body.toDelta.bind(body), blocks = body.blocks.bind(body);
      Object.assign(body, {
        toDelta(index?: number, count?: number) { reads.push(["toDelta", index, count]); return toDelta(index, count); },
        blocks(index?: number, count?: number) { reads.push(["blocks", index, count]); return blocks(index, count); },
      });
    }
    a.select(25_000);
    a.type("X");
    a.run(toggleMark(marks.strong!));
    a.type("Y");
    sync();
    assert.ok(reads.length > 0);
    for (const [name, index, count] of reads) {
      assert.ok(index !== undefined && count !== undefined && count < 1_000, `${name}(${index}, ${count})`);
    }
    assert.equal(json(a.state), json(b.state));
    showsText(b);
  });
});

describe("ProseMirror sync of input method compositions", () => {
  it("keeps candidates in the editor and writes the confirmed text as one batch", () => {
    const { writer } = open();
    const a = writer();
    a.type("AB");
    a.select(2);
    const batches = a.outbox.length;
    a.compose(["ㄏ", "ㄏㄠ", "ㄏㄠˇ"]);
    assert.equal(isComposing(a.view), true);
    assert.equal(selectionCursors(a.state), undefined, "no selection to share while composing");
    assert.equal(a.state.doc.textContent, "AㄏㄠˇB");
    assert.equal(a.doc.state.body.toString(), "AB");
    a.compose(["好"]);
    assert.equal(a.outbox.length, batches);
    a.finish();
    a.finish();
    assert.equal(a.doc.state.body.toString(), "A好B");
    assert.equal(a.outbox.length, batches + 1);
    showsText(a);
    assert.equal(a.doc.state.body.cursorIndex(selectionCursors(a.state)!.from), 2);
  });

  it("merges changes from elsewhere that arrived during the composition, and shows them after it", () => {
    const unsent: string[] = [];
    const { writer, sync } = open();
    const a = writer({ onUnsentComposition(value) { unsent.push(value); } }), b = writer();
    a.type("ABC\nnext"); sync();
    a.select(2, 3); // Replaces "B".
    a.compose(["ㄏ", "ㄏㄠ"]);
    b.doc.state.body.insert(0, "X"); // Before the paragraph's text.
    b.doc.state.body.delete(2, 1); // The "B" the composition replaces.
    b.doc.state.body.insert(b.doc.state.body.length - 5, "Y"); // After "C".
    b.doc.state.body.insert(b.doc.state.body.length, "!"); // Another paragraph.
    sync();
    assert.equal(a.state.doc.textContent, "AㄏㄠCnext", "the composing editor waits");
    a.compose(["好"]);
    const batches = a.outbox.length;
    a.finish();
    assert.deepEqual(unsent, []);
    assert.equal(a.doc.state.body.toString(), "XA好CY\nnext!");
    assert.equal(a.outbox.length, batches + 1);
    showsText(a);
    assert.equal(a.doc.state.body.cursorIndex(selectionCursors(a.state)!.from), 3);
    sync();
    assert.equal(json(b.state), json(a.state));
  });

  it("gives typed-over marks to the confirmed text, with or without changes from elsewhere", () => {
    for (const incoming of [false, true]) {
      const { writer, sync } = open();
      const a = writer(), b = writer();
      a.type("AB"); sync();
      a.run(toggleMark(marks.strong!)); // Stored for the next text.
      a.compose(["ㄏ", "好"]);
      if (incoming) { b.doc.state.body.insert(0, "Z"); sync(); }
      a.finish();
      assert.deepEqual(plain(a.doc.state.body.toDelta()),
        [{ insert: incoming ? "ZAB" : "AB" }, { insert: "好", attributes: { bold: true } }]);
      showsText(a);
    }
  });

  it("writes nothing for a cancelled composition, or one the writer can no longer send", () => {
    let allowed = true;
    const unsent: string[] = [];
    const { writer, sync } = open();
    const a = writer({ canEdit: () => allowed, onUnsentComposition(value) { unsent.push(value); } }), b = writer();
    a.type("AB"); sync();
    const batches = a.outbox.length;
    a.compose(["ㄏ", "ㄏㄠ"]);
    b.doc.state.body.insert(2, "X"); sync();
    a.finish(true);
    assert.equal(a.doc.state.body.toString(), "ABX");
    showsText(a);
    assert.deepEqual(unsent, []);

    a.select(2);
    a.compose(["ㄏ", "好"]);
    allowed = false;
    a.finish();
    assert.equal(a.doc.state.body.toString(), "ABX");
    showsText(a);
    assert.deepEqual(unsent, ["好"]);
    assert.equal(a.outbox.length, batches);
  });

  it("makes the confirmed text its own undo step, and refuses undo while composing", () => {
    const { writer } = open();
    let history: ReturnType<typeof createUndoManager> | undefined;
    const a = writer((doc) => ({ history: history = createUndoManager(doc, { captureTimeout: 60_000 }) }));
    if (history === undefined) throw new Error("No undo manager");
    a.type("A"); a.type("B");
    a.compose(["ㄏ"]);
    assert.equal(a.run(undo(history)), false);
    a.compose(["好"]);
    a.finish();
    a.type("C");
    assert.equal(a.doc.state.body.toString(), "AB好C");
    history.undo();
    assert.equal(a.doc.state.body.toString(), "AB好");
    history.undo();
    assert.equal(a.doc.state.body.toString(), "AB");
    showsText(a);
  });

  it("follows the browser's composition events", async () => {
    const { writer } = open();
    const a = writer();
    a.type("AB");
    a.view.dom.dispatchEvent(new window.CompositionEvent("compositionstart"));
    assert.equal(a.binding.composing, true);
    a.view.dispatch(a.state.tr.insertText("好"));
    assert.equal(a.doc.state.body.toString(), "AB");
    a.view.dom.dispatchEvent(new window.CompositionEvent("compositionend"));
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(a.binding.composing, false);
    assert.equal(a.doc.state.body.toString(), "AB好");
  });
});

describe("ProseMirror remote selections", () => {
  it("draws other writers' selections where their text is, and moves them with changes", () => {
    const { writer, sync } = open();
    const a = writer(), b = writer();
    a.type("hello world"); sync();
    b.select(7, 12); // "world"
    const shared = selectionCursors(b.state)!;
    assert.deepEqual(resolveSelection(a.state, shared), { from: 7, to: 12 });
    assert.deepEqual(setRemoteSelections(a.view, [{ label: "B", selection: shared }]), [{ label: "B", resolved: true }]);
    const drawn = () => a.remote.getState(a.state)!.decorations.find().map(({ from, to }) => [from, to]);
    assert.deepEqual(drawn(), [[7, 12], [12, 12]]);
    assert.equal(a.view.dom.querySelector(".articollab-caret")?.getAttribute("data-label"), "B");
    a.select(1);
    a.type(">> "); // A local edit before it maps it.
    assert.deepEqual(drawn(), [[10, 15], [15, 15]]);
    b.select(1);
    b.type("¡"); sync(); // A change from elsewhere places it from its cursors.
    assert.deepEqual(drawn(), [[11, 16], [16, 16]]);
    // A selection in text this writer has not received yet.
    b.select(end(b.state));
    b.type(" again");
    b.select(end(b.state) - 5, end(b.state));
    assert.deepEqual(setRemoteSelections(a.view, [{ label: "B", selection: selectionCursors(b.state)! }]), [{ label: "B", resolved: false }]);
    assert.deepEqual(drawn(), []);
  });
});
