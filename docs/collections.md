# Value, List, Text and Map

Choose a Value for whole immutable JSON replacements, a List for stable elements, Text for plain-text range edits, and a Map for values under string keys. Schema property keys are fixed wire paths.

```ts
const Board = defineDocument({
  count: value(0),
  items: list<string>(),
  body: text(),
});
```

Import `defineDocument`, `value`, `list` and `text` from `"articollab"`. List and Text start empty. The following snippets assume `doc` was created from this schema, with `count = 0` and empty collections; use the [quick start](quick-start.md) for client/server construction.

## Value: replace the whole payload

```ts
doc.state.count.set(1);
doc.state.count.value = 2;
console.log(doc.state.count.value); // 2
```

An accessor intercepts replacement, not nested object mutation. If your schema instead defines `task: value({ done: false })`, assign a new object with `doc.state.task.value = { done: true }`; do not edit `.value.done` in place. JSON payloads must remain immutable after being supplied.

Schema defaults and local Value/List payloads are validated before use. For example, `doc.state.count.set(NaN)` throws `TypeError` without changing state or producing a batch. Validation does not copy or freeze your object and does not check its application-specific shape. Large payloads cost more to validate; unchanged document collections are not scanned.

## List: single-element edits

```ts
doc.state.items.push("Write tests");
doc.state.items.insert(0, "Design API");
doc.state.items.delete(1);
console.log(doc.state.items.get(0)); // "Design API"
console.log(doc.state.items.toArray()); // ["Design API"]
```

Insertion positions are `0..length`. Reads/deletes require `0..length-1`; invalid indices throw without a batch/change. `values()` and iteration yield visible values. `toArray()` copies the array, not its nested elements.

Local positions become stable insertion anchors or deletion targets on the wire. The field named `before` is the **preceding anchor**, with `null` meaning the start. Deleted known IDs remain tombstones and may still anchor pending insertions.

### Update an existing element

With the List above containing `"Design API"`:

```ts
doc.state.items.set(0, "Implement API");
console.log(doc.state.items.toArray()); // ["Implement API"]
```

The element keeps its stable ID and position. `set()` replaces its whole value, not individual object fields, and allocates no new IDs or tombstones. If two writers update that same element, the last update applied by the server wins. Their fields are not merged. An update to an element already deleted by a peer is a no-op, never a resurrection.

To tell the writer that an edit was lost this way, listen for `discard`. It fires when this writer's own update, or [move](#move-an-element), is acknowledged after its element was deleted:

```ts
const stop = doc.on("discard", ({ operations }) => {
  for (const operation of operations) {
    if (operation.type === "list/set") console.warn(`Not saved, the item was deleted by someone else: ${operation.value}`);
  }
});
```

`set()` requires a visible index in `0..length-1`. Setting the same value still records a local write. Pending updates follow the original ID even if another insertion changes its index. See [upgrade guidance](recovery.md#upgrading-from-02-to-03) before exchanging these operations.

To update a view without calling `toArray()` after every change, subscribe with `doc.state.items.observe()`; it reports `set()` as an in-place `set` change. See [Update a list view incrementally](transactions.md#update-a-list-view-incrementally).

### Move an element

List moves require [Articollab 0.9 or later](reference.md#compatibility). Before enabling moves in a shared document, [upgrade all its readers](recovery.md#upgrading-from-08-to-09).

`move(from, to)` moves the element at index `from` so that it ends at index `to`, like moving an array item. With the List above containing `"Implement API"`:

```ts
doc.state.items.push("Write tests");
doc.state.items.move(1, 0);
console.log(doc.state.items.toArray()); // ["Write tests", "Implement API"]
```

The element keeps its identity: a peer's `set()` or `delete()` aimed at it still applies after the move, and a concurrent move of the same element is decided by server order, so the element never appears twice. Moving an element that a peer deleted first changes nothing and is reported through `discard`, like a lost `set()`. A cursor bound to a moved element stays at the element's old gap, as it would after a deletion. Moves stay within one List; to move an item between Lists, delete and insert it, or keep one List and record the group in a [Map](#map-keyed-values), as the [Kanban board example](https://github.com/EastSun5566/articollab/blob/main/examples/README.md#kanban-board) does.

Delete + insert inside a transaction still creates a new element identity. If two writers concurrently do this for the same old element, both new insertions can remain: the second deletion targets an already-deleted ID.

## Map: keyed values

Map requires Articollab 0.8 or later. When adding Map to a shared document, [upgrade its readers first](recovery.md#upgrading-from-07-to-08).

A Map holds JSON values under string keys at one schema path. It starts empty:

```ts
import { defineDocument, map } from "articollab";

const Settings = defineDocument({ settings: map<string | number>() });
```

With a client `doc` created from this schema:

```ts
const settings = doc.state.settings;
settings.set("theme", "dark");
settings.set("fontSize", 14);
console.log(settings.get("theme")); // "dark"
console.log([...settings.keys()]); // ["fontSize", "theme"]
console.log(settings.delete("theme")); // true: it was present here
console.log(settings.toObject()); // { fontSize: 14 }
```

Each key is decided on its own, by server order: the last `set` or `delete` the server applies wins. Two writers changing different keys never conflict. A `set` after a delete creates the key again; there are no tombstones, and no Map operation can block pending replay. `set()` replaces the key's whole value, like List `set()`, so give each independently edited field its own key, for example `"card-1/title"` and `"card-1/done"`, rather than one object per record.

- `delete(key)` returns whether the key was present here, but records the delete even when it was not: the server may hold a value this writer has not received yet.
- `clear()` deletes every key visible here, in one batch. A key another writer sets concurrently survives it. An empty Map records nothing.
- Keys may be any string, including `""` and `"__proto__"`. Iteration (`keys()`, `values()`, `entries()`, `for...of`) is sorted by UTF-16 code unit, so every replica lists keys in the same order whatever order they were written in.
- A Map snapshot is a JSON object from key to value, so a server `resolve` policy can read `snapshot.data.settings["theme"]` directly.

Map updates have no `discard` event: a `set` is never a no-op, because it recreates a deleted key. If an application should not recreate a key, for example a deleted record's field, its server policy must drop that `set`; the writer learns of it through [`transform`](server-wire.md#accept-transform-or-reject). To follow changes, subscribe with `observe()`; see [Update a view from a Map](transactions.md#update-a-view-from-a-map).

## Text: Unicode code points

```ts
doc.state.body.insert(0, "A😀B");
console.log(doc.state.body.length); // 3
doc.state.body.delete(1); // Remove one code point: 😀.
console.log(doc.state.body.toString()); // "AB"
console.log([...doc.state.body]); // ["A", "B"]
```

Indices/counts use code points, not UTF-16 code units or grapheme clusters. A composed character or emoji sequence may contain several code points. Convert editor selections at the UI boundary rather than using JS string `.length` as a Text index.

Each insertion is split into elements independently. Inserting `"😀"` creates one element; separately inserting `"\ud83d"` and `"\ude00"` creates two, even though `toString()` joins them into the same displayed emoji. Joining a string does not preserve element boundaries; use iteration when maintaining an element-based mirror.

Text snapshots preserve these boundaries across restore. See [Text snapshot boundaries](recovery.md#text-snapshot-boundaries) before exchanging saved data with older runtimes.

One string insertion uses a continuous ID range. One delete produces one operation containing compressed target ranges. `insert(index, "")` and `delete(index, 0)` validate bounds, then do nothing. Counts/indices must be safe integers; deletions must fit completely.

## Stable positions with cursors

An index is only valid for the view it was read from: a remote insertion or deletion earlier in the Text or List moves everything after it. To keep a caret or selection, or to show another writer's position, store a cursor instead. A cursor is a frozen JSON object that names the element on one side of a gap, so it follows that element through later edits:

```ts
import { createClient, createServer, decodeCursor, decodeServerCommit, defineDocument, text } from "articollab";
import type { ClientBatch, ClientDocument, Cursor, DocumentOperation } from "articollab";

const Note = defineDocument({ body: text() });
type Shape = typeof Note.definition;
const server = createServer(Note);
const outbox: ClientBatch<DocumentOperation<Shape>>[] = [];
const alice = createClient(Note, { clientId: server.openClient(), onBatch: (batch) => outbox.push(batch) });
const bob = createClient(Note, { clientId: server.openClient(), onBatch: (batch) => outbox.push(batch) });
function deliver() {
  for (const batch of outbox.splice(0)) {
    const commit = JSON.parse(JSON.stringify(server.receive(batch).commit));
    for (const doc of [alice, bob]) doc.receive(decodeServerCommit(Note, commit));
  }
}

/** Resolve a received selection; undefined until both anchors have arrived. */
function resolve(doc: ClientDocument<Shape>, selection: { from: Cursor; to: Cursor }) {
  const from = doc.state.body.cursorIndex(selection.from);
  const to = doc.state.body.cursorIndex(selection.to);
  if (from === undefined || to === undefined) return undefined;
  return { from, to: Math.max(from, to) }; // Collapses when the selected text was deleted.
}

alice.state.body.insert(0, "Hello world");
deliver();
// Alice selects "world". "right" binds the start to "w", "left" binds the end to "d",
// so text inserted at either edge stays outside the selection.
const presence = JSON.stringify({ from: alice.state.body.cursorAt(6, "right"), to: alice.state.body.cursorAt(11) });

bob.state.body.insert(6, "brave ");
deliver();
const received = JSON.parse(presence); // Arrives on the application's own presence channel.
const selection = { from: decodeCursor(received.from), to: decodeCursor(received.to) };
const range = resolve(bob, selection)!;
console.log([...bob.state.body].slice(range.from, range.to).join("")); // world

alice.state.body.delete(12, 5);
deliver();
console.log(resolve(bob, selection)); // { from: 12, to: 12 }

alice.state.body.insert(12, "!"); // Still pending, so Bob has not seen "!" yet.
const caret = decodeCursor(JSON.parse(JSON.stringify(alice.state.body.cursorAt(13))));
console.log(bob.state.body.cursorIndex(caret)); // undefined
deliver();
console.log(bob.state.body.cursorIndex(caret)); // 13
```

`cursorAt(index, bind?)` takes a gap index in `0..length`. With the default `"left"`, the cursor binds to the element before the gap; an insertion into that gap lands after the cursor, which suits a text caret. With `"right"`, it binds to the element after the gap and an insertion lands before it. When the bound element is deleted, the cursor moves to the nearest surviving gap on its side. Cursors at the very start (`"left"`) or end (`"right"`) store no element and stay there.

`cursorIndex(cursor)` returns `undefined` while the cursor's element is unknown to that document: a peer's pending insertion that has not been committed and received yet, an insertion the server rejected or a transaction rolled back, or a cursor from another collection. Hide that position or keep showing its previous index, and try again after the next change. Deleted elements stay known, so cursors keep resolving after snapshot loads and checkpoint restores.

Validate received cursors with `decodeCursor()`, like other wire data. Articollab provides only the positions; sending presence, expiring it and drawing remote carets are up to the application. Text cursor indices count elements, like every other Text index, so convert them to editor offsets at the UI boundary. Both Text and List support cursors with the same methods.

See the [canonical collection contracts](reference.md#collections-and-immutable-values) for the full immutable-value and bounds rules.

[Previous: Concepts](concepts.md) · [Next: Transactions and events](transactions.md)
