# ProseMirror

Edit a formatted [Text](collections.md#format-text) in a [ProseMirror](https://prosemirror.net) editor. The `textSync` plugin writes each local change to the Text and shows changes from elsewhere in the editor. It compares only the part of the document a change touched, so typing costs about the same in a long document as in a short one.

## Install

Use Articollab 0.12 or later:

```sh
pnpm add articollab prosemirror-model prosemirror-state prosemirror-view
```

Import it from `"articollab/prosemirror"`. Use `prosemirror-schema-basic` and `prosemirror-schema-list` for the editor's schema, or [map your own](#map-your-own-schema). For Tiptap, use the [Tiptap extension](tiptap.md).

## Define the Text

`basicMapping` stores ProseMirror's marks and blocks as Text marks and paragraph attributes with these keys:

| ProseMirror | Text |
| --- | --- |
| `strong`, `em`, `code` marks | `bold`, `italic`, `code` marks with the value `true` |
| `link` mark | `link` mark with the `href` as its value |
| `heading` with `level` 1 to 6 | `heading` attribute with the level |
| `code_block` | `code: true` on each of its lines |
| `blockquote` | `quote: true` on each paragraph inside it |
| `bullet_list`, `ordered_list` | `list: "bullet"` or `"ordered"` on each item, and `indent` from 1 for nested items |
| `hard_break` | a line break: the text after it is a new paragraph |

So the Text lists those keys:

```ts
import { defineDocument, text } from "articollab";

export const Note = defineDocument({
  body: text({
    marks: { bold: { expand: "after" }, italic: { expand: "after" }, code: { expand: "after" }, link: { expand: "none" } },
    blocks: { heading: {}, list: {}, indent: {}, quote: {}, code: {} },
  }),
});
```

Give the keys [payload schemas](collections.md#validate-payloads) to limit their values, for example to keep only `http:` and `https:` links. Keep the mapping inside them: a heading level or an indent the Text refuses stops the plugin. See [Map your own schema](#map-your-own-schema) for `levels` and `maxIndent`.

## Create the editor

```ts
import { createUndoManager } from "articollab";
import { connectSync, createWebSocketTransport } from "articollab/sync";
import { basicMapping, redo, textSync, textToDoc, undo } from "articollab/prosemirror";
import { baseKeymap } from "prosemirror-commands";
import { keymap } from "prosemirror-keymap";
import { Schema } from "prosemirror-model";
import { schema as basic } from "prosemirror-schema-basic";
import { addListNodes } from "prosemirror-schema-list";
import { EditorState } from "prosemirror-state";
import { EditorView } from "prosemirror-view";

const schema = new Schema({ nodes: addListNodes(basic.spec.nodes, "paragraph block*", "block"), marks: basic.spec.marks });
const sync = await connectSync(Note, { transport: createWebSocketTransport({ url: "wss://example.com/sync/socket" }) });
const history = createUndoManager(sync.doc);

const view = new EditorView(document.querySelector("#editor"), {
  state: EditorState.create({
    schema,
    doc: textToDoc(sync.doc.state.body, schema, basicMapping),
    plugins: [
      textSync(sync.doc, "body", { mapping: basicMapping, history }),
      keymap({ "Mod-z": undo(history), "Mod-Shift-z": redo(history) }),
      keymap(baseKeymap),
    ],
  }),
});
```

- `textToDoc()` builds the editor's first document. If the editor starts with something else, the plugin replaces it with the Text.
- Each transaction that changes the document is written as one batch.
- The editor always shows one standard shape of the Text. For example, a list item holds one paragraph: pressing Enter in a list item's paragraph without `splitListItem` makes two items.
- Use ProseMirror's own commands, such as `toggleMark`, `setBlockType`, `wrapInList` and `sinkListItem`.

Do not add ProseMirror's `history` plugin: undo and redo go through the Text, so that they undo only this writer's changes.

## Undo and redo

`undo(history)` and `redo(history)` are ProseMirror commands for an [undo manager](transactions.md#undo-and-redo). They return `false` when there is nothing to undo, while an input method is composing, and when undo throws, for example while this writer's edits are blocked.

Pass the same undo manager as `history` to `textSync`. Then text confirmed from an input method is its own undo step.

## Input methods

While an input method such as Zhuyin or Pinyin is composing, its candidates stay in the editor and are not sent. Changes from other writers wait until the composition ends, so the input method's text is left alone.

- When the composition is confirmed, its text is written as one batch, merged with the changes that arrived meanwhile.
- When <kbd>Esc</kbd> cancels it, nothing is written.
- If the writer cannot edit when it ends, nothing is written. Nor is it when changes arrived meanwhile and the composition replaced text across paragraphs or changed formatting outside its own text. The text goes to `onUnsentComposition(text)`, so you can show it for the user to copy.

`isComposing(view)` tells whether a composition is open. Do not run toolbar commands while it is.

## Show other writers' selections

Share this writer's selection through [presence](sync.md#share-presence), and draw the others' with `remoteSelections()`:

```ts
import { remoteSelections, selectionCursors, setRemoteSelections } from "articollab/prosemirror";

// Add remoteSelections() to the plugins, after textSync.
function share() {
  const selection = selectionCursors(view.state);
  if (selection !== undefined) sync.presence.set({ selection });
}

sync.presence.on("change", () => {
  setRemoteSelections(view, [...sync.presence.peers].flatMap(([clientId, state]) =>
    state.selection === undefined ? [] : [{ label: clientId, selection: state.selection }]));
});
```

- `selectionCursors(state)` returns the selection as two [cursors](collections.md#stable-positions-with-cursors), or `undefined` while composing. Share it again when a composition ends: the caret moves to the confirmed text even when the editor's selection looks unchanged. Validate cursors from other writers with `decodeCursor()` before you draw them.
- `setRemoteSelections(view, selections)` returns `{ label, resolved }` for each one. `resolved` is `false` while its text has not reached this writer; it is drawn once it has.
- Selections are drawn as a `span` with the class `articollab-selection` and a caret `span.articollab-caret` with `data-label`. Pass `selectionClass` or a `caret(label)` function to change them.

## When the writer cannot edit

- `canEdit()` is checked before each local change. While it returns `false`, the change is refused and the editor stays as it was. Changes are also refused while the document has a [blocked replay](recovery.md#blocked-pending).
- To show this, make the editor read-only with ProseMirror's `editable` prop as well.
- An error while writing or showing a change, such as a value a payload schema refuses, stops the plugin. It calls `onError(error)` and refuses local changes from then on. Changes it already wrote stay. Show the error and offer to reload.

## Map your own schema

For other node and mark names, pass a `TextMapping`:

```ts
import type { TextMapping } from "articollab/prosemirror";

const mapping: TextMapping = {
  doc: "root",
  paragraph: "para",
  marks: {
    bold: { mark: "heavy" },
    link: { mark: "ref", value: (mark) => String(mark.attrs.to), attrs: (value) => ({ to: value }) },
  },
  heading: { node: "title", levels: [1, 2] },
  blockquote: { node: "aside" },
};
```

| Field | Meaning |
| --- | --- |
| `doc` | The top node; `"doc"` by default. |
| `paragraph` | The textblock for a plain paragraph. |
| `marks` | One entry per Text mark key: the ProseMirror mark, and for a mark with attributes, `value(mark)` to read the Text value and `attrs(value)` to build the attributes. Without them the value is `true`. |
| `heading` | A node with a `level` attribute. A level outside `levels` is stored as the nearest one. |
| `codeBlock` | A code block. Each of its lines is a paragraph with `code: true`; its text has no marks. With `language`, the name of its language attribute, a block with a language stores it as the value of `code`. Without it, every `code` value shows as a code block and is kept when written. |
| `blockquote` | A node around paragraphs, for `quote: true`. |
| `lists` | `item`, `bullet` and `ordered` nodes, for `list` and `indent`. Each item holds one paragraph and its nested lists. `maxIndent` flattens deeper nesting. |
| `lineBreak` | An inline node, such as a hard break, that ends a line: the text after it is a new paragraph with the same attributes. So <kbd>Shift</kbd>+<kbd>Enter</kbd> works like <kbd>Enter</kbd>. |

Leave out what your schema does not have. Creating the editor state throws `TypeError` if the schema lacks a node or mark the mapping names. Nodes and marks the mapping does not name are not stored: an image or a horizontal rule disappears from the editor.

## Limits

- One editor shows one Text, the whole of it.
- Paragraph attributes the mapping does not use stay in the Text, but the editor cannot show or change them.
- A line break in a paragraph's text, as `insertText("a\nb")` makes, starts a new paragraph.

The [rich text editor example](https://github.com/EastSun5566/articollab/blob/main/examples/README.md#rich-text-editor) uses every part of the plugin. See the [reference](reference.md#prosemirror) for the exact rules.

[Previous: React](react.md) · [Next: Tiptap](tiptap.md)
