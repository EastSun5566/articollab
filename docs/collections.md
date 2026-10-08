# Value, List and Text

Choose a Value for whole immutable JSON replacements, a List for stable elements, and Text for plain-text range edits. Schema property keys are fixed wire paths.

```ts
const Board = defineDocument({
  count: value(0),
  items: list<string>(),
  body: text(),
});
```

List and Text start empty. The following examples assume `doc` was created from this schema; imports and construction follow the [quick start](quick-start.md).

## Value: replace the whole payload

```ts
doc.state.count.set(1);
doc.state.count.value = 2;
console.log(doc.state.count.value); // 2
```

An accessor intercepts replacement, not nested object mutation. For `value({ done: false })`, replace with `doc.state.task.value = { done: true }`; do not edit `.value.done` in place. JSON payloads must remain immutable after being supplied.

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

There is no replacement or move method. Replace one element with delete + insert inside a transaction.

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
