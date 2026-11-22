# Transactions and events

Use a transaction when several synchronous edits should travel as one batch. Use document-level events to refresh a view, not to infer acknowledgements or save checkpoints.

## Batch related edits

Using the Board client from [Collections](collections.md), group edits that belong together:

```ts
const result = doc.transact(() => {
  doc.state.count.value = 1;
  doc.state.items.push("Draft");
  doc.state.body.insert(0, "Hello");
  return "done";
});
// result === "done"; one batch with three operations; one local change.
```

Outside a transaction, each actual mutation creates its own batch. An empty transaction creates none. Value assignment still records an operation when the value is unchanged. To learn what the server did with a batch, make it with [`doc.track()`](server-wire.md#accept-transform-or-reject) instead.

Transactions are synchronous. Do not pass an async callback. An exception escaping the outer callback rolls back its visible mutations and does not consume a local batch sequence. Already allocated List/Text IDs are not reused.

## Nested calls have no savepoint

This example uses a Counter client from the [quick start](quick-start.md):

```ts
doc.transact(() => {
  doc.state.count.value = 1;
  try {
    doc.transact(() => {
      doc.state.count.value = 2;
      throw new Error("stop inner callback");
    });
  } catch {
    doc.state.count.value = 3;
  }
});
// One successful outer batch contains set(1), set(2), set(3).
```

The inner call joins the outer transaction. Catching its error does not undo its earlier operations. If the error escapes the outer callback, the outer transaction's uncommitted mutations are rolled back.

## Observe visible changes

```ts
const unsubscribe = doc.on("change", (event) => {
  console.log(event.origin, doc.state.count.value);
});
unsubscribe();
```

Local completion is optimistic state → pending/sequence → `onBatch` → local change. A synchronous `onBatch` may already deliver a server result before the local listener runs.

Server changes are emitted only when visible state or the replay-conflict descriptor changes. A normal own ack can be silent. Read `checkpoint()` after successful receive to track acknowledgement or persistence, including silent acks.

## Update a text view incrementally

`Text.observe()` reports edits to the visible text, including changes caused by pending replay. It is separate from document `change` events and does not run until you subscribe. This complete example maintains an element-array mirror:

```ts
import { createClient, createServer, defineDocument, text } from "articollab";

const Note = defineDocument({ body: text() });
const server = createServer(Note);
const doc = createClient(Note, {
  clientId: server.openClient(),
  onBatch() {}, // This example keeps edits local.
});

let elements = [...doc.state.body];
const stop = doc.state.body.observe(({ changes }) => {
  for (const { index, deleteCount, insert } of changes) {
    elements = elements.slice(0, index).concat(
      insert, elements.slice(index + deleteCount),
    );
  }
});

doc.state.body.insert(0, "A😀B");
doc.state.body.delete(1);
console.log(elements.join("")); // AB
stop();
```

Subscribe outside a transaction, without an asynchronous gap after reading the initial elements. Subscription does not emit the current value. Each event contains `beforeLength`, `afterLength` and frozen `changes`, ordered by descending index. All indices refer to the same pre-event view, so apply changes in the supplied order. Arrays in this example illustrate correctness; rebuilding or joining a whole array is still linear work. An editor integration should apply range updates to its own representation.

Offsets count Text elements, not UTF-16 code units or grapheme clusters. Each inserted array item preserves one element; inserting the two surrogate halves separately must remain two elements even if joining them displays one emoji. Keep the array boundaries rather than reparsing `toString()`. Editor offsets may need a separate conversion; this API is not an editor binding. For positions that survive edits, see [cursors](collections.md#stable-positions-with-cursors).

Observers run after the outermost successful mutation/receive and its existing callbacks. Reentrant work is coalesced: if `onBatch` immediately receives a server transformation from `"a"` to `"A"`, an observer may see only `"A"`. Observer mutations are drained without recursive notification. Different subscribers can receive different coalesced edits from their own baselines. Only element-content changes notify, not ID-only replacements, acknowledgements or conflict changes alone.

Normal edits compare affected IDs; conflicts, changed replay prefixes and equal-length edits that redistribute characters across offsets can require a full-text fallback. Without observers there is no additional diff calculation. Neither path removes the cost of applying operations or replaying pending batches.

If `onBatch` or an existing change listener throws, observers do not run for that failed call. A later successful operation can deliver the accumulated difference. If an observer throws, its baseline has already advanced; remaining observers keep their baselines, the error propagates and completed mutations remain. If a callback partially updated your UI, unsubscribe and rebuild its mirror before subscribing again. Callback side effects are not rolled back.

## Update a list view incrementally

This example uses List moves, which require [Articollab 0.9 or later](reference.md#compatibility).

`List.observe()` works like `Text.observe()`, but a change is a splice, an in-place set or a move. Handle `set` and `move` separately so a row keeps its own key when only its value or position changes:

```ts
import { createClient, createServer, defineDocument, list } from "articollab";

type Card = { title: string; done: boolean };
const Board = defineDocument({ cards: list<Card>() });
const server = createServer(Board);
const doc = createClient(Board, {
  clientId: server.openClient(),
  onBatch() {}, // This example keeps edits local.
});

let nextKey = 0;
let rows = [...doc.state.cards].map((card) => ({ key: nextKey++, card }));
const stop = doc.state.cards.observe(({ changes }) => {
  for (const change of changes) {
    if (change.type === "set") {
      rows = rows.with(change.index, { key: rows[change.index]!.key, card: change.value });
    } else if (change.type === "move") {
      rows = rows.toSpliced(change.from, 1).toSpliced(change.to, 0, rows[change.from]!);
    } else {
      const inserted = change.insert.map((card) => ({ key: nextKey++, card }));
      rows = rows.toSpliced(change.index, change.deleteCount, ...inserted);
    }
  }
});

doc.state.cards.push({ title: "Write docs", done: false });
doc.state.cards.push({ title: "Ship", done: false });
doc.state.cards.set(0, { title: "Write docs", done: true }); // Row 0 keeps key 0.
doc.state.cards.move(1, 0); // "Ship" moves first and keeps key 1.
console.log(rows.map(({ key, card }) => `${key}:${card.title}:${card.done}`)); // [ '1:Ship:false', '0:Write docs:true' ]
stop();
```

Apply changes in the supplied order: each index refers to the view after the changes before it. Moves come first; then splices and sets follow by descending index, with a set before a splice at the same index, so without moves every index is in the pre-event view. A set means the same element changed value, and a move means the same element changed position. A delete-and-reinsert still arrives as two splices and gets a new key; use `move()` to keep it. Payloads keep `Object.is` identity: an acknowledgement that replaces an object with an equal decoded copy is reported as a set, which a view may skip after its own equality check.

## Update a view from a Map

`Map.observe()` follows the same delivery rules. Each event lists the changed keys in key order; a change is a `set`, with the new `value`, or a `delete`. Both carry `previous`, the value before the event, which is `undefined` when a `set` adds the key:

```ts
import { createClient, createServer, defineDocument, map } from "articollab";

const Settings = defineDocument({ settings: map<string>() });
const server = createServer(Settings);
const doc = createClient(Settings, {
  clientId: server.openClient(),
  onBatch() {}, // This example keeps edits local.
});

const view = new Map(doc.state.settings);
const stop = doc.state.settings.observe(({ changes }) => {
  for (const change of changes) {
    if (change.type === "set") view.set(change.key, change.value);
    else view.delete(change.key);
    console.log(change.type, change.key, change.previous);
  }
});

doc.state.settings.set("theme", "dark"); // set theme undefined
doc.state.settings.set("theme", "light"); // set theme dark
doc.state.settings.delete("theme"); // delete theme light
stop();
```

Writing the value a key already holds (by `Object.is`), deleting an absent key, or changes that cancel out within one batch emit nothing. Like a List, an acknowledgement that replaces an object with an equal decoded copy is reported as a `set`.

## Undo and redo

`createUndoManager(doc)` records this writer's own changes as steps and reverts them on request. Undo and redo are ordinary local edits: they are sent, resolved and acknowledged like any other batch.

```ts
import { createClient, createServer, createUndoManager, defineDocument, list } from "articollab";

const Todos = defineDocument({ items: list<string>() });
const server = createServer(Todos);
const doc = createClient(Todos, {
  clientId: server.openClient(),
  onBatch() {}, // This example keeps edits local.
});
const history = createUndoManager(doc);

doc.transact(() => {
  doc.state.items.push("Write docs");
  doc.state.items.push("Ship");
});
history.stopCapturing();
doc.state.items.delete(0);

history.undo();
console.log(doc.state.items.toArray()); // [ 'Write docs', 'Ship' ]
history.undo();
console.log(doc.state.items.toArray()); // []
history.redo();
console.log(doc.state.items.toArray(), history.canRedo); // [ 'Write docs', 'Ship' ] true
```

Each transaction is one step, and local changes less than `captureTimeout` milliseconds apart (default 500) merge into one, so typing a word undoes as a unit. `stopCapturing()` starts a new step; the example uses it because both edits happen at once. A new change clears the redo steps. Use `canUndo`, `canRedo` and `history.on("change", ...)` to enable buttons. The manager keeps the latest `maxSteps` steps (default 1000) and drops older ones.

To make one step of changes that are not one transaction, such as the moves of a drag gesture, open a group. Everything this writer changes until `end()` is one step, however far apart; changes you make with `history.ignore()` are not recorded at all:

```ts
const end = history.startGroup();
doc.state.items.push("Draft");
await nextAnimationFrame(); // Changes keep joining the group across awaits.
doc.state.items.set(2, "Final");
end();

history.ignore(() => { doc.state.items.push("Added by the app"); });
history.undo();
console.log(doc.state.items.toArray()); // [ 'Write docs', 'Ship', 'Added by the app' ]
```

`undo()`, `redo()` and `stopCapturing()` end open groups. Ignored changes are still ordinary edits that are sent, and later undos skip what they changed, like a peer's change.

Only this writer's changes are recorded, and undo never overwrites a later change by someone else. It reverts a value, Map key or List element only while it still holds what this writer wrote; a step another writer has entirely superseded is skipped, and `undo()` moves on to the next one. Undoing a deletion inserts the element again at its place with a new ID, which later steps follow. See the [exact rules](reference.md#undo-and-redo).

## Callback failure is not rollback

If `onBatch` throws, its batch is already pending; the local change is not emitted. If a listener throws, completed state/sequence advances remain and later listeners may not run. A server listener throws after receive has advanced state and watermark.

The core propagates these errors, but does not permanently disable the document. Transport examples stop their connection/network on the first error. Never interpret every thrown callback as “nothing happened.” See the [full event contract](reference.md#mutations-transactions-and-events).

[Previous: Collections](collections.md) · [Next: Server policy and wire](server-wire.md)
