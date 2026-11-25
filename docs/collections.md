# Value, List, Text, Map and Counter

Choose a Value for whole immutable JSON replacements, a List for stable elements, Text for plain-text range edits, a Map for values under string keys, and a Counter for integers that several writers add to. Schema property keys are fixed wire paths.

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

A Value has no `observe()`: it holds one value, so there is no smaller change to report. Read it in a [`doc.on("change")`](transactions.md#observe-visible-changes) listener instead. The same holds for a single [Counter](#counter-additions-that-all-count).

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

`set()` requires a visible index in `0..length-1`. Setting the same value still records a local write. Pending updates follow the original ID even if another insertion changes its index.

To update a view without calling `toArray()` after every change, subscribe with `doc.state.items.observe()`; it reports `set()` as an in-place `set` change. See [Update a list view incrementally](transactions.md#update-a-list-view-incrementally).

### Move an element

List moves require [Articollab 0.9 or later](reference.md#compatibility). Before enabling moves in a shared document, [upgrade all its readers](upgrading.md#upgrading-from-08-to-09).

`move(from, to)` moves the element at index `from` so that it ends at index `to`, like moving an array item. With the List above containing `"Implement API"`:

```ts
doc.state.items.push("Write tests");
doc.state.items.move(1, 0);
console.log(doc.state.items.toArray()); // ["Write tests", "Implement API"]
```

The element keeps its identity:

- A peer's `set()` or `delete()` aimed at it still applies after the move.
- When two writers move the same element, server order decides, so the element never appears twice.
- Moving an element that a peer already deleted changes nothing, and is reported through `discard` like a lost `set()`.
- A cursor bound to a moved element stays at the element's old gap, as it would after a deletion.

Moves stay within one List. To move an item between Lists, delete and insert it, or keep one List and record each item's group in a [Map](#map-keyed-values), as the [Kanban board example](https://github.com/EastSun5566/articollab/blob/main/examples/README.md#kanban-board) does.

Delete + insert inside a transaction still creates a new element identity. If two writers concurrently do this for the same old element, both new insertions can remain: the second deletion targets an already-deleted ID.

## Map: keyed values

Map requires Articollab 0.8 or later. When adding Map to a shared document, [upgrade its readers first](upgrading.md).

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

## Counter: additions that all count

Counters require Articollab 0.10 or later. When adding one to a shared document, [upgrade its readers first](upgrading.md#upgrading-from-09-to-010).

A Value records the number a writer set, so two writers who each turn 1 into 2 leave 2: one increment is lost. A Counter records what each writer added, and the server adds every addition in order, so pending additions replay on top of everyone else's. `counter(initialValue = 0)` holds one integer; `counterMap()` holds one integer per string key, such as votes per card:

```ts
import { counter, counterMap, defineDocument } from "articollab";

const Shop = defineDocument({ stock: counter(5), likes: counterMap() });
```

With a client `doc` created from this schema:

```ts
const stock = doc.state.stock;
stock.add(-2);
console.log(stock.value); // 3

const likes = doc.state.likes;
likes.add("post-1", 1);
likes.add("post-2", 2);
console.log(likes.get("post-1"), likes.get("post-3")); // 1 0
console.log(likes.toObject()); // { "post-1": 1, "post-2": 2 }
likes.add("post-1", -1);
console.log([...likes.keys()]); // ["post-2"]: a total of 0 removes the key
```

- `counterMap()` has `observe()`, `delete(key)` and `clear()` like Map; a single `counter()`, like a Value, has no `observe()`.
- Counts, additions and totals are safe integers. `add()` throws `TypeError` for a non-number and `RangeError` for any other non-safe-integer or when this writer's total would leave the safe integer range; adding 0 records nothing. If writers together push a total out of range, the server refuses that batch and a writer replaying it is [blocked](recovery.md#blocked-pending).
- A Counter has no `set`. To bring one back to 0, add minus its current value; additions other writers make meanwhile still count.
- In `counterMap()`, an absent key counts as 0 and a total of 0 removes the key, so `size`, `keys()`, `values()`, `entries()` and snapshots list only nonzero counts, sorted by UTF-16 code unit. `delete(key)` resets a key to 0, recorded even when it is 0 here; additions the server applies after it count again. `observe()` reports each key's `value` and `previous`, with 0 for an absent key.
- [Undo](transactions.md#undo-and-redo) adds the opposite of this writer's additions, so other writers' additions stay. Undoing `delete(key)` adds back what it removed.

A server policy can bound a counter by changing an addition. This one never lets stock go below 0; a writer whose removal was cut learns of it through [`transform`](server-wire.md#accept-transform-or-reject):

```ts
const server = createServer(Shop, {
  resolve: ({ batch, snapshot }) => {
    let stock = snapshot.data.stock;
    return batch.operations.flatMap((operation) => {
      if (operation.type !== "counter/add") return [operation];
      const delta = Math.max(operation.delta, -stock);
      stock += delta;
      return delta === 0 ? [] : [{ ...operation, delta }];
    });
  },
});
```

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

### Format text

Text marks require [Articollab 0.10 or later](reference.md#compatibility).

List the marks a Text accepts, then format ranges of it:

```ts
const Note = defineDocument({
  body: text({
    marks: {
      bold: { expand: "after" },
      link: { expand: "none", payload: z.string().url() },
    },
  }),
});

doc.state.body.insert(0, "Hello world");
doc.state.body.format(6, 5, "bold", true);
doc.state.body.format(6, 5, "link", "https://example.com");
console.log(doc.state.body.attributesAt(6)); // { bold: true, link: "https://example.com" }
console.log(doc.state.body.toDelta());
// [{ insert: "Hello " }, { insert: "world", attributes: { bold: true, link: "https://example.com" } }]
doc.state.body.format(6, 5, "bold", null); // Removes bold again.
```

`format(index, count, key, value)` sets one mark on a range, and `null` removes it. The range is tied to the characters at its edges, not to indices, so text that others insert or delete elsewhere does not move it.

`expand` decides whether text typed right at an edge of the range takes the mark:

| `expand` | Typed at the start | Typed at the end | Typical marks |
| --- | --- | --- | --- |
| `"after"` | no | yes | bold, italic |
| `"none"` | no | no | links, comments |
| `"before"` | yes | no | |
| `"both"` | yes | yes | |

So typing at the end of a bold word continues in bold, while typing after a link does not extend the link. Inserted text needs no marks of its own: it takes the marks of the place where it lands.

When writers format the same characters with the same key at the same time, the mark the server applied last wins. Until the server answers, your own marks show on top. A server [resolver](server-wire.md#check-formatting) can drop or change a mark like any other operation; the writer then sees it undone, with a `transform` event.

A mark's `payload` schema validates its values like the [payload schemas](#validate-payloads) below. A `text()` without `marks` behaves exactly as before, and adding marks to an existing Text needs no data migration; see [Upgrading](upgrading.md).

## Validate payloads

Payload schemas require [Articollab 0.10 or later](reference.md#compatibility).

Value, List and Map payloads are only checked to be JSON unless you give the collection a schema. Pass any [Standard Schema](https://standardschema.dev), such as one from Zod, Valibot or ArkType, and the payload type comes from it:

```ts
import { z } from "zod";

const Board = defineDocument({
  title: value("Untitled", z.string().max(200)),
  cards: list(z.object({ title: z.string().min(1), done: z.boolean() })),
  columns: map(z.enum(["todo", "doing", "done"])),
});
```

Every value written is validated twice: locally, before the edit changes anything, and by the server, before its resolver runs and again before it applies the resolver's result. So a writer that skips the check still cannot store an invalid value.

A rejected value throws `PayloadValidationError`, a `TypeError` with the collection `path` (and the Map key) and the schema's `issues`. Schemas must validate synchronously, and they only check: the value kept is the one you passed, never a transformed output such as a trimmed or defaulted copy.

A schema can also be a small object of your own, with no dependency:

```ts
const shortTitle: StandardSchemaV1<string> = {
  "~standard": {
    version: 1,
    vendor: "my-app",
    validate: (input) => typeof input === "string" && input.length <= 20
      ? { value: input }
      : { issues: [{ message: "Use up to 20 characters" }] },
  },
};
const Notes = defineDocument({ titles: map(shortTitle) });
const notes = createClient(Notes, { clientId: "notes", onBatch() {} });
try {
  notes.state.titles.set("a", "A title that is far too long");
} catch (error) {
  if (error instanceof PayloadValidationError) console.log(error.path, error.message);
  // [ 'titles', 'a' ] Invalid payload at /titles/a: Use up to 20 characters
}
```

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

`cursorAt(index, bind?)` takes a gap index in `0..length`:

- With the default `"left"`, the cursor binds to the element before the gap, and an insertion into that gap lands after the cursor. This suits a text caret.
- With `"right"`, it binds to the element after the gap, and an insertion lands before it.
- When the bound element is deleted, the cursor moves to the nearest surviving gap on its side.
- Cursors at the very start (`"left"`) or end (`"right"`) store no element and stay there.

`cursorIndex(cursor)` returns `undefined` while the cursor's element is unknown to that document: a peer's insertion not yet committed and received, an insertion the server rejected or a transaction rolled back, or a cursor from another collection. Hide that position or keep showing its previous index, and try again after the next change.

Deleted elements stay known, so cursors keep resolving after snapshot loads and checkpoint restores. [Undo](transactions.md#undo-and-redo) brings a deleted element back with a new ID, so a cursor bound to the old element keeps resolving to the nearest gap, not to the restored element.

Validate received cursors with `decodeCursor()`, like other wire data. Articollab provides the positions, and the sync adapter can [share them as presence](sync.md#share-presence), with expiry; drawing remote carets is up to the application. Text cursor indices count elements, like every other Text index, so convert them to editor offsets at the UI boundary. Both Text and List support cursors with the same methods.

See the [canonical collection contracts](reference.md#collections-and-immutable-values) for the full immutable-value and bounds rules.

[Previous: Concepts](concepts.md) · [Next: Transactions and events](transactions.md)
