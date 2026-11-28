# Tiptap

Edit a formatted [Text](collections.md#format-text) in a [Tiptap](https://tiptap.dev) editor. The `ArticollabText` extension adds the [ProseMirror plugin](prosemirror.md) to the editor, with Tiptap commands for undo and redo. Typing costs about the same in a long document as in a short one.

## Install

Use Articollab 0.12 or later and Tiptap 3:

```sh
pnpm add articollab @tiptap/core @tiptap/pm @tiptap/starter-kit
```

Import the extension from `"articollab/tiptap"`.

The extension uses the same `prosemirror-model`, `prosemirror-state` and `prosemirror-view` as Tiptap, through `@tiptap/pm`. npm, Yarn and pnpm install one copy of each when their versions agree. If the editor loads a second copy, creating it throws `TypeError`; then add the three packages to your own dependencies at the versions `@tiptap/pm` uses.

## Define the Text

`starterKitMapping` stores StarterKit's marks and blocks with these keys:

| Tiptap | Text |
| --- | --- |
| `bold`, `italic`, `strike`, `underline`, `code` marks | marks with the same names and the value `true` |
| `link` mark | `link` mark with the `href` as its value |
| `heading` with `level` 1 to 6 | `heading` attribute with the level |
| `codeBlock` | `code` on each of its lines: its `language`, or `true` without one |
| `blockquote` | `quote: true` on each paragraph inside it |
| `bulletList`, `orderedList` | `list: "bullet"` or `"ordered"` on each item, and `indent` from 1 for nested items |
| `hardBreak` | a line break: the text after it is a new paragraph |

So the Text lists those keys:

```ts
import { defineDocument, text } from "articollab";

export const Note = defineDocument({
  body: text({
    marks: {
      bold: { expand: "after" }, italic: { expand: "after" }, strike: { expand: "after" }, underline: { expand: "after" },
      code: { expand: "after" }, link: { expand: "none" },
    },
    blocks: { heading: {}, list: {}, indent: {}, quote: {}, code: {} },
  }),
});
```

A Text written by the [ProseMirror plugin](prosemirror.md) with `basicMapping` uses the same keys, so Tiptap and ProseMirror editors can share it. Give the keys [payload schemas](collections.md#validate-payloads) to limit their values, and keep the mapping inside them. For example, if `heading` accepts only levels 1 to 3, pass a mapping with `heading: { node: "heading", levels: [1, 2, 3] }`.

## Create the editor

```ts
import { Editor } from "@tiptap/core";
import { StarterKit } from "@tiptap/starter-kit";
import { createUndoManager } from "articollab";
import { connectSync, createWebSocketTransport } from "articollab/sync";
import { ArticollabText } from "articollab/tiptap";

const sync = await connectSync(Note, { transport: createWebSocketTransport({ url: "wss://example.com/sync/socket" }) });
const history = createUndoManager(sync.doc);

const editor = new Editor({
  element: document.querySelector("#editor"),
  extensions: [
    StarterKit.configure({ undoRedo: false, trailingNode: false }),
    ArticollabText.configure({ document: sync.doc, path: "body", history }),
  ],
});
```

Leave out `content`: the editor shows the Text. Turn off two StarterKit extensions, or creating the editor throws `TypeError`:

- `undoRedo` would undo other writers' changes too. `ArticollabText` provides `undo` and `redo` instead.
- `trailingNode` adds an empty paragraph after a final list or code block. Every writer would add its own.

| Option | Meaning |
| --- | --- |
| `document`, `path` | The writer's document and the path of its Text; required. |
| `history` | This writer's [undo manager](transactions.md#undo-and-redo), for `undo`, `redo` and their keys. Text confirmed from an input method is its own step. |
| `mapping` | Which nodes and marks stand for the Text; `starterKitMapping` by default. See [Map your own schema](prosemirror.md#map-your-own-schema). |
| `canEdit` | While it returns `false`, local changes are refused and the editor stays as it was. |
| `onError` | Called once with an error that stopped the extension, such as a value a payload schema refuses. Local changes are refused from then on. |
| `onUnsentComposition` | Called with input method text that could not be written, for the user to copy. See [Input methods](prosemirror.md#input-methods). |
| `remoteSelections` | How to draw other writers' selections, or `false` to leave them out. |

## Use it in React

Create the sync client and undo manager outside React, as for the [hooks](react.md#create-the-writer-outside-react), and pass them to `useEditor`:

```tsx
import { EditorContent, useEditor } from "@tiptap/react";
import { useUndoState } from "articollab/react";

function NoteEditor({ sync, history }) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ undoRedo: false, trailingNode: false }),
      ArticollabText.configure({ document: sync.doc, path: "body", history }),
    ],
  }, [sync, history]);
  const { canUndo } = useUndoState(history);
  return (
    <>
      <button disabled={!canUndo} onClick={() => editor.commands.undo()}>Undo</button>
      <EditorContent editor={editor} />
    </>
  );
}
```

The extension makes new plugins for each editor, so StrictMode and a new editor after a dependency change work as usual.

## Undo and redo

`editor.commands.undo()` and `redo()` undo this writer's own changes through the undo manager. <kbd>Mod</kbd>+<kbd>Z</kbd>, <kbd>Mod</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd> and <kbd>Mod</kbd>+<kbd>Y</kbd> run them. They return `false` when there is nothing to undo or an input method is composing.

The change reaches the editor as a transaction of its own, so other commands in the same `chain()` are not applied with it.

## Show other writers' selections

Share the selection through [presence](sync.md#share-presence) after each transaction, and draw the others' with `setRemoteSelections`:

```ts
import { isComposing, selectionCursors, setRemoteSelections } from "articollab/tiptap";

editor.on("transaction", () => {
  if (!isComposing(editor.view)) sync.presence.set({ selection: selectionCursors(editor.state) ?? null });
});
sync.presence.on("change", () => {
  setRemoteSelections(editor.view, [...sync.presence.peers].flatMap(([clientId, state]) =>
    state.selection === null ? [] : [{ label: clientId, selection: state.selection }]));
});
```

Share it on every transaction, not only when the selection moves: after a composition, the caret moves to the confirmed text in a transaction that can leave the selection's positions unchanged. See [ProseMirror](prosemirror.md#show-other-writers-selections) for how selections are drawn.

## Limits

- An ordered list's `start` number, images, tables, task lists and other extensions' nodes are not stored. Map them with your own [mapping](prosemirror.md#map-your-own-schema) only where they fit a Text line.
- A link stores only its `href`. Its `target` and `rel` come from the link extension's defaults.
- Tiptap's link commands refuse addresses such as `javascript:`, but a writer can still send any mark. Check links on the [server](server-wire.md).

The [Tiptap in React example](https://github.com/EastSun5566/articollab/blob/main/examples/README.md#tiptap-in-react) uses every part of the extension. See the [reference](reference.md#tiptap) for the exact rules.

[Previous: ProseMirror](prosemirror.md) · [Next: Core reference](reference.md)
