import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { Window } from "happy-dom";

import { createClient, createServer, createUndoManager, type ClientBatch, type DocumentOperation, type UndoManager } from "../packages/articollab/src/index.ts";
import { Note } from "./prosemirror-helpers.ts";

// A DOM for Tiptap's editor view, which reads it when it is first imported.
const window = new Window();
Object.assign(globalThis, { window, document: window.document, KeyboardEvent: window.KeyboardEvent });
const { Editor } = await import("@tiptap/core");
const { StarterKit } = await import("@tiptap/starter-kit");
const { ArticollabText, selectionCursors, setRemoteSelections, starterKitMapping, textToDoc } = await import("../packages/articollab/src/tiptap/index.ts");
const { TextShape } = await import("../packages/articollab/src/prosemirror/mapping.ts");

/** A note whose Text also has StarterKit's strike and underline marks. */
const { defineDocument, text } = await import("../packages/articollab/src/index.ts");
const TiptapNote = defineDocument({
  body: text({
    marks: { bold: { expand: "after" }, italic: { expand: "after" }, strike: { expand: "after" }, underline: { expand: "after" },
      code: { expand: "after" }, link: { expand: "none" } },
    blocks: { heading: {}, list: {}, indent: {}, quote: {}, code: {} },
  }),
});
type Batch = ClientBatch<DocumentOperation<typeof TiptapNote.definition>>;

const editors: { destroy(): void }[] = [];
after(() => { for (const editor of editors) editor.destroy(); });
const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
const kit = StarterKit.configure({ undoRedo: false, trailingNode: false });

/** A server, and writers with Tiptap editors whose batches move only when `sync()` runs. */
function network() {
  const server = createServer(TiptapNote, {
    // The server keeps only http: and https: links.
    resolve: ({ batch }) => batch.operations.filter((operation) => operation.type !== "text/mark" || operation.key !== "link" ||
      operation.value === null || (typeof operation.value === "string" && /^https?:\/\//.test(operation.value))),
  });
  const writers: { send(): void; receive(): void }[] = [];
  function writer() {
    const outbox: Batch[] = [];
    const doc = createClient(TiptapNote, { clientId: server.openClient(), onBatch: (batch) => outbox.push(batch) });
    const history: UndoManager = createUndoManager(doc, { captureTimeout: 0 });
    const editor = new Editor({ extensions: [kit, ArticollabText.configure({ document: doc, path: "body", history })] });
    editors.push(editor);
    let seen = 0;
    const entry = {
      doc, editor, history, outbox,
      send() { for (const batch of outbox.splice(0)) server.receive(batch); },
      receive() { for (const commit of server.commitsSince(seen) ?? []) { doc.receive(commit); seen = commit.serverSeq; } },
    };
    writers.push(entry);
    return entry;
  }
  const sync = () => { for (const each of writers) each.send(); for (const each of writers) each.receive(); };
  return { writer, sync };
}

/** Presses a key in an editor, as the browser would. */
function press(editor: InstanceType<typeof Editor>, key: string) {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- happy-dom implements the DOM's KeyboardEvent.
  editor.view.dom.dispatchEvent(new window.KeyboardEvent("keydown", { key, ctrlKey: true, bubbles: true }) as unknown as KeyboardEvent);
}
const json = (editor: InstanceType<typeof Editor>) => JSON.stringify(editor.getJSON());
const blocks = (doc: { state: { body: { blocks(): readonly { attributes: object }[] } } }) => doc.state.body.blocks().map(({ attributes }) => attributes);

describe("Tiptap", () => {
  it("writes StarterKit's marks and blocks to the Text, and shows the Text's standard shape", () => {
    const { writer } = network();
    const a = writer();
    a.editor.commands.insertContent("Title");
    a.editor.commands.toggleHeading({ level: 2 });
    a.editor.commands.enter();
    a.editor.commands.insertContent("strike under bold link");
    a.editor.commands.setTextSelection({ from: 8, to: 14 });
    a.editor.commands.toggleStrike();
    a.editor.commands.setTextSelection({ from: 15, to: 20 });
    a.editor.commands.toggleUnderline();
    a.editor.commands.setTextSelection({ from: 21, to: 25 });
    a.editor.commands.toggleBold();
    a.editor.commands.setTextSelection({ from: 26, to: 30 });
    a.editor.commands.setLink({ href: "https://example.com" });
    assert.deepEqual(plain(a.doc.state.body.toDelta()), [
      { insert: "Title\n" }, { insert: "strike", attributes: { strike: true } }, { insert: " " },
      { insert: "under", attributes: { underline: true } }, { insert: " " }, { insert: "bold", attributes: { bold: true } },
      { insert: " " }, { insert: "link", attributes: { link: "https://example.com" } },
    ]);
    assert.deepEqual(blocks(a.doc), [{ heading: 2 }, {}]);
    // Lists, nesting, a hard break and a code block with a language.
    a.editor.commands.setTextSelection(a.editor.state.doc.content.size);
    a.editor.commands.enter();
    a.editor.commands.insertContent("one");
    a.editor.commands.toggleBulletList();
    a.editor.commands.splitListItem("listItem");
    a.editor.commands.insertContent("two");
    a.editor.commands.sinkListItem("listItem");
    a.editor.commands.setHardBreak();
    a.editor.commands.insertContent("three");
    a.editor.commands.liftListItem("listItem");
    a.editor.commands.liftListItem("listItem");
    a.editor.commands.toggleCodeBlock({ language: "js" });
    assert.equal(a.doc.state.body.toString(), "Title\nstrike under bold link\none\ntwo\nthree");
    assert.deepEqual(blocks(a.doc), [{ heading: 2 }, {}, { list: "bullet" }, { indent: 1, list: "bullet" }, { code: "js" }]);
    assert.equal(json(a.editor), JSON.stringify(textToDoc(a.doc.state.body, a.editor.schema, starterKitMapping).toJSON()));
    assert.equal(a.editor.state.doc.lastChild?.attrs.language, "js");
  });

  it("converges two writers, drops a link the server refuses, and undoes with commands and keys", () => {
    const { writer, sync } = network();
    const a = writer(), b = writer();
    a.editor.commands.insertContent("hello world");
    sync();
    assert.equal(json(b.editor), json(a.editor));
    b.editor.commands.setTextSelection(7);
    b.editor.commands.insertContent("big ");
    a.editor.commands.setTextSelection({ from: 1, to: 6 });
    a.editor.commands.setLink({ href: "javascript:alert(1)" });
    a.editor.commands.toggleItalic();
    sync();
    assert.equal(json(b.editor), json(a.editor));
    assert.deepEqual(plain(a.doc.state.body.toDelta()), [{ insert: "hello", attributes: { italic: true } }, { insert: " big world" }]);

    a.editor.commands.setTextSelection(a.editor.state.doc.content.size);
    a.editor.commands.insertContent("!");
    assert.equal(a.editor.can().undo(), true);
    assert.equal(a.editor.commands.undo(), true);
    assert.equal(a.doc.state.body.toString(), "hello big world");
    assert.equal(a.editor.state.doc.textContent, "hello big world");
    assert.equal(a.editor.commands.redo(), true);
    assert.equal(a.editor.state.doc.textContent, "hello big world!");
    press(a.editor, "z");
    assert.equal(a.editor.state.doc.textContent, "hello big world");
    press(a.editor, "y");
    assert.equal(a.editor.state.doc.textContent, "hello big world!");
    a.history.clear();
    assert.equal(a.editor.commands.undo(), false, "nothing to undo");
  });

  it("shares selections and draws other writers' carets", () => {
    const { writer, sync } = network();
    const a = writer(), b = writer();
    a.editor.commands.insertContent("shared text");
    sync();
    b.editor.commands.setTextSelection({ from: 8, to: 12 });
    const statuses = setRemoteSelections(a.editor.view, [{ label: "B", selection: selectionCursors(b.editor.state)! }]);
    assert.deepEqual(statuses, [{ label: "B", resolved: true }]);
    assert.equal(a.editor.view.dom.querySelector(".articollab-caret")?.getAttribute("data-label"), "B");
    assert.equal(a.editor.view.dom.querySelector(".articollab-selection")?.textContent, "text");
  });

  it("stores a code block's language, which a mapping without one leaves as it is", () => {
    const doc = createClient(TiptapNote, { clientId: "a", onBatch() {} });
    doc.state.body.insert(0, "let x;\nplain");
    doc.state.body.formatBlocks(0, 0, "code", "ts");
    const editor = new Editor({ extensions: [kit, ArticollabText.configure({ document: doc, path: "body" })] });
    editors.push(editor);
    assert.equal(editor.state.doc.firstChild?.attrs.language, "ts", "the editor starts from the Text");
    editor.commands.setTextSelection(2);
    editor.commands.updateAttributes("codeBlock", { language: "js" });
    assert.deepEqual(blocks(doc), [{ code: "js" }, {}]);
    // A ProseMirror editor without a language attribute leaves the language as it is.
    const shape = new TextShape(editor.schema, { ...starterKitMapping, codeBlock: { node: "codeBlock" } });
    assert.equal(shape.sameAttribute("code", true, "js"), true);
  });

  it("refuses StarterKit's undoRedo and trailingNode, a missing document, and a path that is not a Text", () => {
    const doc = createClient(TiptapNote, { clientId: "a", onBatch() {} });
    assert.throws(() => new Editor({ extensions: [StarterKit.configure({ trailingNode: false }), ArticollabText.configure({ document: doc, path: "body" })] }),
      /Turn off the undoRedo extension/);
    assert.throws(() => new Editor({ extensions: [StarterKit.configure({ undoRedo: false }), ArticollabText.configure({ document: doc, path: "body" })] }),
      /Turn off the trailingNode extension/);
    assert.throws(() => new Editor({ extensions: [kit, ArticollabText] }), /needs a document/);
    assert.throws(() => new Editor({ extensions: [kit, ArticollabText.configure({ document: doc, path: "title" })] }), /Unknown collection path: title/);
    const note = createClient(Note, { clientId: "n", onBatch() {} });
    // A Text without strike or underline: their writes fail and stop the extension.
    const errors: unknown[] = [];
    const editor = new Editor({ extensions: [kit, ArticollabText.configure({ document: note, path: "body", onError(error) { errors.push(error); } })] });
    editors.push(editor);
    editor.commands.insertContent("x");
    editor.commands.selectAll();
    assert.throws(() => editor.commands.toggleStrike());
    assert.equal(errors.length, 1);
    editor.commands.insertContent("refused");
    assert.equal(note.state.body.toString(), "x");
  });
});
