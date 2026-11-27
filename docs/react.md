# React

Read a document, its sync client, presence and undo manager from React components. The hooks re-render a component only when what it reads changes.

## Install

The hooks require Articollab 0.11 and React 18 or later. To use the 0.11 beta:

```sh
pnpm add articollab@beta react
```

Import them from `"articollab/react"`.

## Create the writer outside React

Connect each writer once, outside your components, and pass it down as a prop or through your own context:

```ts
import { createUndoManager, defineDocument, list, value } from "articollab";
import { connectSync, createHttpTransport } from "articollab/sync";

type Todo = { id: string; title: string; done: boolean };
export const Todos = defineDocument({ title: value("Groceries"), items: list<Todo>() });

export const sync = await connectSync(Todos, {
  transport: createHttpTransport({ url: "https://example.com/sync/" }),
  presence: {},
});
export const history = createUndoManager(sync.doc);
```

Do not call `connectSync` in an effect. Each call registers a writer session. In development, `StrictMode` runs effects twice, so that opens two sessions, and a connection that finishes after its component unmounted is never closed.

## Read a collection

`useCollection(doc, path)` returns one collection's visible state. The schema decides its type:

| Collection | Returns |
| --- | --- |
| Value | its value |
| List | a frozen array of its values |
| Text | its text |
| Map, `counterMap()` | a frozen object from key to value |
| Counter | its total |

```tsx
import { useCollection } from "articollab/react";

function TodoList() {
  const title = useCollection(sync.doc, "title"); // string
  const items = useCollection(sync.doc, "items"); // readonly Todo[]
  return (
    <section>
      <h2>{title}</h2>
      <ul>{items.map((item) => <li key={item.id}>{item.title}</li>)}</ul>
    </section>
  );
}
```

The component re-renders only when that collection changes, whether the change is local, from another writer, a rejection or an undo. Edit the document as usual, for example `sync.doc.state.items.push(todo)` in an event handler.

Components that read the same collection share one subscription and one snapshot. A snapshot keeps its identity until the collection changes, so you can pass it to `memo` components or use it as an effect dependency.

## Derive a value

`useDocument(doc, selector)` runs `selector` on the document's state after each change. The component re-renders only when the result changes:

```tsx
import { useDocument } from "articollab/react";

function Remaining() {
  const left = useDocument(sync.doc, (state) => state.items.toArray().filter((item) => !item.done).length);
  return <p>{left} left</p>;
}
```

Results are compared shallowly by default: arrays and plain objects whose entries are the same are equal, and the component keeps the earlier one. Pass your own comparison as the third argument. The selector can be an inline function.

`useDocument` runs on every change to the document, so prefer `useCollection` when you need a whole collection.

## Read formatted text

For a Text with [marks or paragraph attributes](collections.md#format-text):

- `useTextDelta(doc, path)` returns its runs of equal marks, like `toDelta()`, and re-renders when the text or its marks change.
- `useTextBlocks(doc, path)` returns its paragraphs, like `blocks()`, and re-renders when they or their attributes change.

## Show sync status, presence and undo

```tsx
import { usePeers, useSyncStatus, useUndoState } from "articollab/react";

function Toolbar() {
  const { status, push } = useSyncStatus(sync);
  const peers = usePeers(sync);
  const { canUndo, canRedo } = useUndoState(history);
  return (
    <div>
      <span>{status === "idle" && push === "open" ? "Live" : status}</span>
      <span>{peers.size} others here</span>
      <button disabled={!canUndo} onClick={() => history.undo()}>Undo</button>
      <button disabled={!canRedo} onClick={() => history.redo()}>Redo</button>
    </div>
  );
}
```

- `useSyncStatus(sync)` returns `{ status, push, error }`.
- `usePeers(sync)` returns the other writers' [presence](sync.md#share-presence) by client ID. Set your own with `sync.presence.set()`.
- `useUndoState(history)` returns `{ canUndo, canRedo }`.

The undo manager merges changes made less than `captureTimeout` apart (500 ms by default) into one step, so a typed word undoes at once. For buttons, call `history.stopCapturing()` before and after the change, so that quick presses stay separate steps.

The [React todo list example](https://github.com/EastSun5566/articollab/blob/main/examples/README.md#react-todo-list) uses every hook. See the [reference](reference.md#react) for the exact rules.

[Previous: Sync adapter](sync.md) · [Next: Core reference](reference.md)
