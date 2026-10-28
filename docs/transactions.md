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

Outside a transaction, each actual mutation creates its own batch. An empty transaction creates none. Value assignment still records an operation when the value is unchanged.

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

`List.observe()` works like `Text.observe()`, but a change is either a splice or an in-place set. Handle `set` separately so a row keeps its own key when only its value changes:

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
    } else {
      const inserted = change.insert.map((card) => ({ key: nextKey++, card }));
      rows = rows.toSpliced(change.index, change.deleteCount, ...inserted);
    }
  }
});

doc.state.cards.push({ title: "Write docs", done: false });
doc.state.cards.push({ title: "Ship", done: false });
doc.state.cards.set(0, { title: "Write docs", done: true }); // Row 0 keeps key 0.
console.log(rows.map(({ key, card }) => `${key}:${card.title}:${card.done}`)); // [ '0:Write docs:true', '1:Ship:false' ]
stop();
```

All indices refer to the pre-event view and changes arrive by descending index, with a set before a splice at the same index, so apply them in the supplied order. A set means the same element changed value; there is no move event, so a delete-and-reinsert move arrives as two splices and the moved row gets a new key. Payloads keep `Object.is` identity: an acknowledgement that replaces an object with an equal decoded copy is reported as a set, which a view may skip after its own equality check.

## Callback failure is not rollback

If `onBatch` throws, its batch is already pending; the local change is not emitted. If a listener throws, completed state/sequence advances remain and later listeners may not run. A server listener throws after receive has advanced state and watermark.

The core propagates these errors, but does not permanently disable the document. Transport examples stop their connection/network on the first error. Never interpret every thrown callback as “nothing happened.” See the [full event contract](reference.md#mutations-transactions-and-events).

[Previous: Collections](collections.md) · [Next: Server policy and wire](server-wire.md)
