# Value, List and Text

Choose a Value for whole immutable JSON replacements, a List for stable elements, and Text for plain-text range edits. Schema property keys are fixed wire paths.

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

`set()` requires a visible index in `0..length-1`. Setting the same value still records a local write. Pending updates follow the original ID even if another insertion changes its index. See [upgrade guidance](recovery.md#upgrading-from-02-to-03) before exchanging these operations.

Delete + insert inside a transaction remains available when you mean to create a new element identity. If two writers concurrently do this for the same old element, both new insertions can remain: the second deletion targets an already-deleted ID. It is not equivalent to `set()`. There is no move method.

## Text: Unicode code points

```ts
doc.state.body.insert(0, "A😀B");
console.log(doc.state.body.length); // 3
doc.state.body.delete(1); // Remove one code point: 😀.
console.log(doc.state.body.toString()); // "AB"
console.log([...doc.state.body]); // ["A", "B"]
```

Indices/counts use code points, not UTF-16 code units or grapheme clusters. A composed character or emoji sequence may contain several code points. Convert editor selections at the UI boundary rather than using JS string `.length` as a Text index.

One string insertion uses a continuous ID range. One delete produces one operation containing compressed target ranges. `insert(index, "")` and `delete(index, 0)` validate bounds, then do nothing. Counts/indices must be safe integers; deletions must fit completely.

See the [canonical collection contracts](reference.md#collections-and-immutable-values) for the full immutable-value and bounds rules.

[Previous: Concepts](concepts.md) · [Next: Transactions and events](transactions.md)
