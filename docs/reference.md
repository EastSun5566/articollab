# Core reference

Look up the public API and exact collaboration contracts here. For a runnable introduction, start with the [Quick start](quick-start.md); for design reasons, read [Concepts](concepts.md).

## Compatibility

Articollab 0.10 adds Text marks, undo and redo, `track()` and `settled()`, payload schemas, Counters, presence, store `slots` and the WebSocket transport. Articollab 0.9 added List moves and the `transform` event.

Upgrade every runtime that reads a document before it exchanges new operations or snapshot formats; see [Upgrading](upgrading.md).

Numeric options, indices and counts follow one rule: a non-number throws `TypeError`, and a number that is out of range or not an integer throws `RangeError`. Size and count limits are named `max*`, and objects that hold connections, locks or storage are released with `close()`.

Private implementation details, exact runtime error wording, performance figures and example helpers are not compatibility guarantees. `WireDecodeError` promises its documented `name`, JSON Pointer `path` and readable message, not exact wording.

## Public API

Import from `"articollab"`; internal modules and example helpers are not package entrypoints. The factories are the recommended starting point. `ClientDocument` and `ServerDocument` constructors take the same schema/options as their factories; `DocumentSchema` is the exported schema container.

| API | Purpose |
| --- | --- |
| `defineDocument(definition)`, `value(initialValue)`, `list<T>()`, `text(options?)`, `map<T>()`, `counter(initialValue = 0)`, `counterMap()` | Fixed typed schema; property keys are wire paths. List, Text, Map and `counterMap()` start empty. `text({ marks })` lists the marks a Text accepts. |
| `value(initialValue, schema)`, `list(schema)`, `map(schema)`, `PayloadValidationError` | Validate every written payload with a Standard Schema, locally and on the server; the payload type comes from the schema. |
| `createClient(schema, options)` | Requires nonempty `clientId` and `onBatch`; optional `snapshot` or `checkpoint`, never both. |
| `doc.state` | Readonly collection bindings; mutate through Value/List/Text/Map/Counter methods. |
| `doc.transact(callback)` | Groups synchronous mutations and returns the callback result. |
| `doc.on("change", listener)` | Subscribes to document-level events; returns an unsubscribe function. |
| `doc.on("discard", listener)` | Subscribes to this writer's List `set()` and `move()` operations that the server applied after their element was deleted. |
| `doc.on("transform", listener)` | Subscribes to this writer's batches that the server transformed or rejected. |
| `doc.track(callback)`, `doc.settled(batch)` | Like `transact`, and also return the batch and a promise of its outcome; or that promise for any pending batch. |
| `createUndoManager(doc, options?)` | Undo and redo for this writer's own changes; optional `captureTimeout` (default 500 ms) and `paths`. |
| `doc.state.body.observe(listener)` | Opt-in visible Text edits and format changes; returns an unsubscribe function. |
| `format(index, count, key, value)`, `attributesAt(index)`, `toDelta()` on Text | Set or remove a mark on a range; read one element's marks; read the text as runs of equal marks. |
| `doc.state.items.observe(listener)` | Opt-in visible List moves, splices and in-place sets; returns an unsubscribe function. |
| `doc.state.settings.observe(listener)` | Opt-in visible Map sets and deletes, with previous values; returns an unsubscribe function. |
| `doc.state.votes.observe(listener)` | Opt-in visible `counterMap()` changes, each key's new and previous count; returns an unsubscribe function. |
| `cursorAt(index, bind?)`, `cursorIndex(cursor)` on Text and List | Stable gap positions: create a frozen cursor, then resolve its current index or `undefined`. |
| `doc.receive(commit)` | Applies the next authoritative commit, acknowledges own pending work and replays the rest. |
| `doc.replayConflict`, `doc.checkpoint()` | Read the first replay failure or save authoritative state and pending work. |
| `createServer(schema, options?)` | Optional synchronous `resolve`, restore `checkpoint`, `maxHistory` (default 1000), `maxClients` (optional open-session bound), and `allowCustomClientNamespaces` (default false). |
| `server.openClient()`, `server.closeClient(clientId)` | Issue a writer ID or permanently retire it; neither creates a commit. |
| `server.listClients()` | Open sessions with the last batch the server processed from each, for finding idle writers. |
| `server.receive(batch)`, `server.reject(batch)` | Process a batch or replay its original result; return `{ commit, replayed }`. |
| `server.snapshot()`, `server.checkpoint()`, `server.commitsSince(watermark)` | Late join, server restore, and complete ordered catch-up or `null`. |
| `decodeClientBatch`, `decodeServerCommit`, `decodeSnapshot`, `decodeClientCheckpoint`, `decodeServerCheckpoint` | Each takes `(schema, unknown)`, validates parsed wire data and returns an owned frozen object. |
| `decodeCursor(unknown)` | Validates a parsed cursor, such as one from an application presence channel, and returns an owned frozen copy. |
| `assertClientBatchNamespace(batch, expectedClientId)` | Explicit authenticated writer binding and canonical insertion namespace check; returns `void` or throws `TypeError`. |
| `WireDecodeError` | Decoder error with `name`, JSON Pointer `path` (root `/`) and a readable message. |
| `CollectionConflictError` | Thrown by `server.receive()` for an operation that cannot apply to the current state, such as an unknown List anchor; the server is unchanged. |

The entrypoint also exports these types, grouped by role rather than implementation file:

| Types | Role |
| --- | --- |
| `JsonPrimitive`, `JsonValue` | JSON-compatible payload types. |
| `SchemaShape`, `CollectionSchema`, `ValueSchema`, `ListSchema`, `TextSchema`, `MapSchema`, `CounterSchema`, `CounterMapSchema`, `ValueType`, `ListType`, `MapType` | Schema descriptors and inferred element types. |
| `MarkConfig`, `MarkExpand`, `MarkShape`, `MarkValue` | Text mark configuration and the value type of each mark. |
| `Value`, `List`, `Text`, `MapCollection`, `Counter`, `CounterMap`, `DocumentState` | Typed collection views. |
| `CreateClientOptions`, `CreateServerOptions`, `ServerResolveContext`, `ServerResolver` | Construction and batch policy contracts. |
| `ServerClientSession` | One open writer session from `server.listClients()`. |
| `ValueSetOperation`, `ListInsertOperation`, `ListDeleteOperation`, `ListSetOperation`, `ListMoveOperation`, `ListOperation`, `TextInsertOperation`, `TextDeleteOperation`, `TextMarkOperation`, `TextOperation`, `TextIdRange`, `MapSetOperation`, `MapDeleteOperation`, `MapOperation`, `CounterAddOperation`, `CounterMapAddOperation`, `CounterMapDeleteOperation`, `CounterMapOperation`, `Operation`, `DocumentOperation` | Collection wire operations; `DocumentOperation<S>` restricts path and payload to a schema. |
| `ClientBatchRef`, `ClientBatch`, `ServerCommit`, `ServerReceipt`, `ServerReplayEntry` | Batch identity, authoritative result, local routing metadata and retry entries. |
| `LocalChangeEvent`, `ServerChangeEvent`, `ChangeEvent`, `PendingReplayConflict` | Local/server notifications and the first blocked pending operation. |
| `DiscardEvent` | This writer's List sets and moves that had no effect because their element was already deleted. |
| `TransformEvent` | This writer's original batch, the acknowledged commit and the operations the server dropped. |
| `TextChange`, `TextChangeEvent`, `TextFormatChange` | Visible Text element edits and format changes from an opt-in subscription. |
| `TextMark`, `TextAttributes`, `TextAttributesOf`, `TextDeltaOp` | Saved marks, an element's marks, and `toDelta()` runs. |
| `ListChange`, `ListChangeEvent` | Visible List moves, splices and in-place sets from an opt-in subscription. |
| `MapChange`, `MapChangeEvent` | Visible Map sets and deletes, with previous values, from an opt-in subscription. |
| `CounterMapChange`, `CounterMapChangeEvent` | Visible `counterMap()` changes, with 0 for an absent key, from an opt-in subscription. |
| `Cursor` | A stable Text or List gap position: `{ anchor, bind }`. |
| `DocumentSnapshotData`, `DocumentSnapshot`, `ListSnapshotData`, `ListMoveEntry`, `TextSnapshotData`, `MapSnapshotData`, `CounterMapSnapshotData`, `SavedIdRange` | Typed snapshot payloads, including List/Text tombstones. |
| `ClientCheckpoint`, `ServerCheckpoint` | Complete client/server restore data. |

## Core contracts

### Collections and immutable values

| Collection | Reads | Mutations |
| --- | --- | --- |
| `Value<T>` | `.value` | `.value = next` or `.set(next)`; replace the whole JSON value. |
| `List<T>` | `.length`, `.get(index)`, `.values()`, `.toArray()`, iteration | `.insert(index, value)`, `.push(value)`, `.delete(index)`; `.set(index, value)` updates one element and `.move(from, to)` repositions it, both without changing its ID. |
| `Text` | `.length`, `.values()`, `.toString()`, iteration, `.attributesAt(index)`, `.toDelta()` | `.insert(index, string)`, `.delete(index, count = 1)`, `.format(index, count, key, value)`; Unicode code points. |
| `MapCollection<T>` | `.size`, `.get(key)`, `.has(key)`, `.keys()`, `.values()`, `.entries()`, `.toObject()`, iteration of `[key, value]` | `.set(key, value)`, `.delete(key)`, `.clear()`; each key holds one whole JSON value. |

#### Immutable payloads

- Values and List elements must be JSON-compatible, and must not change after you hand them over.
- Nested object or array edits are not intercepted. Replace a Value instead of editing its fields; use List `set()` to replace a whole element and keep its identity. Delete plus insert creates a new identity.
- The state container, operation and ID containers and library-owned wire arrays are frozen. User payloads are not deep-cloned or deep-frozen. `toArray()` copies the array, but its elements are shared and must stay unchanged.

#### JSON validation

- `value(initialValue)`, schema defaults, local Value set, List insert and push, and List `set()` validate JSON synchronously.
- An invalid value throws `TypeError` before the mutation changes state, pending work, sequences or ID allocation, and without calling `onBatch` or change listeners.
- Rejected: non-finite numbers, `undefined`, BigInt, functions, symbols, cycles, non-plain objects, sparse arrays and non-JSON property descriptors. Own accessors and `toJSON` functions are rejected, not run.
- Allowed: plain objects with `Object.prototype` or a null prototype, and shared branches.
- Accepted payloads keep their references and are not frozen. Validation visits each occurrence in the supplied payload, not the whole document, and is not cached.
- This checks JSON only, not your application's shape (see payload schemas below) and not deep immutability.
- Typed `receive()` and direct snapshot hydration trust their input: decode unknown wire data first.
- Finite signed zero is allowed with `Object.is` semantics, but ordinary JSON serialization does not keep its sign.
- Deep validation and decoding do not recurse; the runtime's JSON serializer still has its own depth limits.

#### Schemas

- Schema paths are fixed, nonempty strings from `defineDocument()`. There are no nested collections and no schema migration.
- `value(0)` infers `Value<number>`, not a literal zero.
- TypeScript types do not check incoming JSON at runtime; payload schemas do.

#### Payload schemas

`value(initialValue, schema)`, `list(schema)` and `map(schema)` take an optional [Standard Schema](https://standardschema.dev) v1 object: `schema["~standard"]` with `version: 1` and a `validate` function.

- Anything else throws `TypeError` when the schema is defined.
- The payload type is the schema's input type and must be JSON-compatible. `value()` validates its initial value.
- **Checked locally**, after JSON validation, by Value set, List insert, push and set, Map set and the undo manager's writes. These throw before changing state, pending work, sequences or ID allocation.
- **Checked by `server.receive()`** for each `value/set`, `list/insert`, `list/set` and `map/set` of the incoming batch: after the namespace check, before the resolver runs, and again on the resolver's output before it is applied.
- A server rejection throws with state, sequences, sessions and history unchanged. Trusted code can then cancel the batch with `server.reject(originalBatch)`, which checks no payloads.
- Not checked by decoders, client `receive()`, snapshots or checkpoints: their data comes from the server or from state that already passed.
- Failures throw `PayloadValidationError`, a `TypeError` with a frozen `path` (the collection path, plus the key for a Map) and the schema's frozen `issues`. Its message names the path and the first issue.
- `validate()` must answer synchronously; a returned promise throws `TypeError`.
- The value kept is always the one written. A schema's output, such as a trimmed or defaulted copy, is ignored.
- When client and server schemas differ, the server's decides.

#### Indices and counts

- List and Text insertion indices are `0..length`. List get, delete and set need `0..length-1`.
- Indices and Text counts must be safe integers, and a Text deletion must fit inside the visible text.
- A non-number index or count throws `TypeError`; invalid bounds throw `RangeError`. Neither records a batch or a change.
- Text `insert(index, "")` and `delete(index, 0)` check bounds, then do nothing, even while replay is blocked.
- `"😀"` has Text length 1: Text counts code points, not UTF-16 code units or grapheme clusters.

#### Stable IDs in List and Text

- Operations name stable IDs, not indices. The wire field `before` is the insertion anchor before the new element (`null` means the start).
- Deleted known IDs stay as tombstones and can still anchor pending insertions.
- Text insertion allocates consecutive IDs; deletion compresses consecutive targets into ranges.
- Deleting a known tombstone is a no-op on the server. Unknown targets and colliding insertion IDs are errors.

#### Text marks

- `text({ marks })` takes one entry per mark key: nonempty keys, each `{ expand, payload? }`. `expand` is `"none"`, `"before"`, `"after"` or `"both"`; `payload` is a Standard Schema.
- `format(index, count, key, value)` follows the Text deletion bounds rules. A key the schema does not list throws. A value is JSON or `null`; a non-null value is checked by the key's payload schema locally and on the server, before and after its resolver. `count` 0 checks, then records nothing.
- It records `{ type: "text/mark", path, start, end, key, value }`. `start` and `end` are cursors: `start` binds `"left"` when `expand` includes before, otherwise `"right"`; `end` binds `"right"` when `expand` includes after, otherwise `"left"`.
- A mark covers every element, visible or deleted, between its two gaps, including elements inserted there later.
- Each element's value for a key is the value of the last applied mark that covers it; `null` means unmarked. On the server this is commit order. On a client, pending marks apply after authoritative ones.
- An unknown anchor is a [collection conflict](#collection-conflicts). A `start` that is not before `end` is invalid.
- `attributesAt()` returns a frozen object with one entry per mark that is set, keys sorted. `toDelta()` returns frozen `{ insert, attributes? }` runs; neighbors with equal marks merge.
- Snapshots save marks in application order, in a `marks` field that is absent when there are none. A mark that a later mark of its key covers completely is dropped; this never changes any element's marks.
- `attributesAt()` costs O(m log n) for m marks. `toDelta()` reads the whole Text. After a mark, observers and change events compute every element's marks once, then compare only the elements inside the marks that changed.

#### List `set()`

`List.set(index, value): void` emits `{ type: "list/set", path, id, value }`, with exactly those fields.

- The target is the visible ID at call time.
- A present target gets the whole new payload; its ID, position, length and allocation counters stay the same. Concurrent updates follow server order.
- A known deleted target is a no-op: the value is not stored and the element does not come back.
- An unknown target is a collection conflict: the server fails the whole batch, while pending replay blocks at that batch.
- Other operations in a batch that contains a tombstone no-op still apply.
- Any writer may update another writer's element; insertion namespace checks do not authorize updates.

#### Map

`map<T>()` paths hold string keys, including `""` and `"__proto__"`, each with one immutable JSON value.

- `set(key, value)` emits `{ type: "map/set", path, key, value }` and `delete(key)` emits `{ type: "map/delete", path, key }`, with exactly those fields.
- Non-string keys throw `TypeError`. Values get the same JSON validation as List `set()`.
- Each key is last-writer-wins in server order: a later `set` recreates a deleted key, and a later `delete` removes it.
- Deleting an absent key is a legal no-op that is still recorded, because the server may hold a value this writer has not received. `delete()` returns whether the key was present here.
- `clear()` emits one `map/delete` per key visible here, in key order and in one batch (or the enclosing transaction). An empty Map records nothing, and keys that peers set meanwhile survive.
- Map operations have no IDs, tombstones, namespace checks or bunch allocation. They never cause replay conflicts, and `lastBunchSeqs` has no entry for Map paths.
- Iteration (`keys()`, `values()`, `entries()`, `for...of`) is sorted by UTF-16 code unit.
- A Map snapshot is a frozen own-property object from key to value.

#### Counter and `counterMap()`

`counter(initialValue = 0)` paths hold one safe integer. A non-number `initialValue` throws `TypeError`, and any other non-safe-integer throws `RangeError`.

**Operations**

- `add(delta)` emits `{ type: "counter/add", path, delta }`.
- In `counterMap()`, `add(key, delta)` emits `{ type: "counterMap/add", path, key, delta }` and `delete(key)` emits `{ type: "counterMap/delete", path, key }`.
- Each has exactly those fields. On the wire, `delta` is a nonzero safe integer and keys are strings.

**Adding**

- `delta` must be a number (else `TypeError`) and a safe integer (else `RangeError`).
- `add()` also throws `RangeError` when this writer's total would leave the safe integer range.
- Both errors are thrown before any change or batch. Adding 0 checks the arguments, then records nothing.
- Applying an addition adds `delta` to the authoritative or replayed total. A total outside the safe integer range is a collection conflict: the server fails the whole batch, while pending replay blocks at that batch.

**Keys in `counterMap()`**

- An absent key counts as 0, and a total of 0 removes the key.
- `counterMap/delete` sets a key to 0; a later addition in server order counts from 0.
- `get(key)` returns the count or 0, `has(key)` whether it is nonzero, and `size` the number of nonzero keys.
- `delete(key)` records the reset even when the key is 0 here, and returns whether it was nonzero here.
- `clear()` emits one `counterMap/delete` per key counted here, in key order and in one batch, like Map `clear()`. Additions made concurrently survive it.
- Iteration is sorted by UTF-16 code unit.

**Other rules**

- Counter operations have no IDs, namespace checks, payload schemas or bunch allocation, and `lastBunchSeqs` has no entry for them.
- A `counter()` snapshot is the integer. A `counterMap()` snapshot is a frozen own-property object from key to a nonzero safe integer; decoders reject 0, fractions and out-of-range numbers.
- `observe()` on `counterMap()` reports `{ changes }` sorted by key, each `{ key, value, previous }` with 0 for an absent key, with the same delivery rules as Map.
- A resolver that changes `delta` transforms the batch, like any changed payload.

#### List `move()`

`List.move(from, to): void` requires `from` and `to` in `0..length-1`; `from === to` records nothing. It emits `{ type: "list/move", path, id, before, position }`, with exactly those fields:

- `id` is the element's permanent ID, its original insertion ID.
- `before` is the position anchor before it once it is taken out (`null` for the start).
- `position` is a new ID from the mover's namespace, allocated like an insertion ID and counted in `lastBunchSeqs`.

Applying a move:

- inserts `position` after `before` and keeps the element's previous position as a tombstone;
- keeps `id`, so `set`, `delete` and later moves name `id` wherever the element is;
- follows server order when several writers move one element.

Edge cases:

- Moving a known deleted element is a no-op that still records `position` as a tombstone, so later anchors on it resolve. The mover's acknowledgement reports it through `discard`.
- An unknown `id` or anchor, or an already known `position`, is a collection conflict, as for insertion.
- `set`, `delete` and `move` must name permanent IDs. Naming a moved element's current position ID is an unknown-ID conflict.
- Cursors and insertion anchors name positions, so a cursor bound to a moved element stays at its old gap.
- `assertClientBatchNamespace` checks `position` like an insertion ID.

### Mutations, transactions and events

#### Batches

- Outside a transaction, each actual mutation forms a batch. Value assignment and List `set()` record an operation even for the same value.
- A successful nonempty outer transaction forms one batch. An empty transaction forms no batch and no local change.
- Local order: **optimistic state → pending batch and local sequence → `onBatch(batch)` → local `change`**. The event is `{ origin: "local", batch }`.
- A synchronous `onBatch` can process the server result at once, so a later local listener may already see reconciled state. The event is not a snapshot of that state.

#### Transactions

- `transact()` is synchronous; it is not an async transaction.
- Nested calls join the outer batch, with no inner savepoint.
- An exception escaping the outer callback restores visible state and discards its operations without using a local batch sequence. List and Text bunch counters already allocated are not rolled back.
- Catching an inner exception inside the outer callback keeps the earlier mutations in the outer transaction.
- `receive()` and `checkpoint()` throw inside a transaction.

#### Callback failures

- `onBatch` and listeners are application callbacks, not rollback boundaries.
- If `onBatch` throws, the batch and sequence are already pending, and the local notification that would follow is not emitted.
- A local listener throw leaves the batch intact. A server listener throw happens after the commit, watermark and reconciliation are complete.
- Exceptions propagate and can stop the remaining notifications. The core does not disable the document or undo callback side effects. Transport examples choose their own stop-on-first-error policy.

#### Server `change` events

- Server events are `{ origin: "server", commit }`. They fire only when visible state or the replay-conflict descriptor changes, not just because an acknowledgement or watermark advanced.
- Value, List and Map payloads compare with `Object.is`. List also compares visible permanent element IDs and their order, Text visible stable IDs and their marks, and Map visible keys.
- List moves can require comparing the whole List. For a single remote move with no pending work or replay conflict, the moved element's index decides whether the order changed.
- An accepted own commit is silent when that comparison and the conflict are unchanged.
- Deep-equal JSON objects decoded into new references can still fire a change.
- A change listener is not a reliable signal of acknowledgement or of when to save a checkpoint.

#### `discard` events

`doc.on("discard", listener)` reports this writer's List `set()` and `move()` operations that reached the server after a peer deleted their element, so they changed nothing.

- When `receive()` applies an acknowledgement of this writer's batch whose commit contains such operations, each listener gets `{ commit, operations }` once: the commit and those `list/set` and `list/move` operations in commit order, frozen.
- Detection uses the commit as applied, so server transformations count. A peer's commit is never reported, and a rejected batch has nothing to report.
- Discard listeners run after any server `change` event for that commit and before observers, even when nothing visible changed.
- A throw propagates from `receive()` after the commit has been applied, skips later listeners and does not roll back.
- The event is not part of checkpoints. A restored writer reports discards for acknowledgements it receives after restore.

#### `transform` events

`doc.on("transform", listener)` reports this writer's batches whose acknowledged commit differs from what it sent: a resolver transformed them, or `reject()`, `rejectPending()` or a resolver returning `[]` left them without effect.

- When `receive()` applies an acknowledgement whose operations are not JSON-equal to the batch's, in order, each listener gets `{ batch, commit, dropped, added }` once.
- Comparison is by JSON value, ignoring object key order, so a decoded copy of an unchanged batch is not reported. A peer's commit never is.
- `dropped` holds the batch's operations that no commit operation equals, in batch order. `added` holds the commit's operations that no batch operation equals, in commit order.
- Matching is a multiset: an operation sent twice and kept once is dropped once. An operation whose value the server changed appears in both arrays.
- A reordered but otherwise equal commit is reported with both arrays empty. An empty commit drops the whole batch.
- The event and both arrays are frozen. `batch` is the pending batch as sent or restored, and `commit` the object passed to `receive()`; neither is a copy.
- Transform listeners run after any server `change` event for that commit and before discard listeners and observers. A throw propagates from `receive()` after the commit has been applied, skips later transform and discard listeners and does not roll back.
- Discards and transforms are independent: one commit can trigger both, or only a discard when the commit is unchanged.
- The event is not part of checkpoints. A restored writer reports transforms for acknowledgements of restored pending batches.
- `reject()` and `rejectPending()` also report each cancelled batch, so an application that cancels on purpose can ignore events during that call.

#### `track()` and `settled()`

`doc.track(callback)` runs `callback` like an outer `transact()`, with the same grouping, rollback and synchronous rule. It returns a frozen `{ value, batch, settled }`: the callback's result, the batch it recorded (`undefined` if none) and a promise of that batch's outcome (`undefined` when there is no batch). It throws inside a transaction, where no batch has formed yet.

`doc.settled(batch)` returns the outcome promise of a batch still pending in this document, matched by `clientId` and `seq`, including batches restored from a checkpoint. Each batch has one promise; a batch that is not pending throws.

- The promise resolves when `receive()` applies the batch's acknowledgement, even one delivered synchronously inside `onBatch`.
- It resolves to a frozen `{ status, batch, commit, dropped, added, discarded }`:
  - `status` is `"rejected"` when the commit has no operations, `"transformed"` when its operations are not JSON-equal to the batch's, and `"accepted"` otherwise;
  - `dropped` and `added` follow the `transform` event's rules and are empty when accepted;
  - `discarded` lists the commit's List sets and moves whose element was already deleted, as `discard` reports them, so an accepted outcome can carry some.
- It never rejects: a server rejection is a status.
- It resolves after the server `change` event and before transform and discard listeners, so a throwing listener cannot leave it pending. Promise callbacks run after `receive()` returns.
- A batch that is never acknowledged, for example because the document is discarded, leaves its promise pending. `restartFromSnapshot()` requires no pending work, so it leaves none.
- Outcomes are computed only for batches someone awaits or while transform listeners exist, and are not part of checkpoints.

#### Text `observe()`

`Text.observe(listener): () => void` subscribes to visible content changes.

- It starts at the current view without an initial event. Subscribing inside a transaction throws. Unsubscribing twice is harmless.
- The event is `{ beforeLength, afterLength, changes, formats? }`; each change is `{ index, deleteCount, insert: readonly string[] }`. All containers are owned and frozen.
- Once the Text has marks, `formats` lists `{ index, count, attributes }` runs: every run whose marks changed and every inserted run, with their complete marks, at post-event indices. Apply `changes` first, then `formats`. It is absent when empty.
- Indices use pre-event element positions. Changes are disjoint and sorted in descending order, so you can apply them one after another.
- Each inserted string is one Text element, including separately inserted surrogate halves.
- There is no minimum-edit or stable-segmentation guarantee, and these offsets are not editor UTF-16 offsets.

Delivery rules, shared by every `observe()`:

- Observers run after existing callbacks, at successful outermost local commit or receive boundaries, with synchronous reentrant work coalesced.
- Each subscriber has its own baseline, so notifications are neither one per batch nor one per commit.
- Mutations made by an observer are delivered in later passes, not recursively.
- Only content and format changes notify, not ID, conflict or acknowledgement changes alone.
- Normal changes compare affected IDs. Conflicts and unproven targets may scan the whole Text. Without subscribers, no diff work runs and no observer state is kept.

See the [incremental example](transactions.md#update-a-text-view-incrementally).

#### List `observe()`

`List.observe(listener): () => void` follows the same subscription, delivery, baseline and failure rules as Text. Each change is one of:

- `{ type: "splice", index, deleteCount, insert: readonly T[] }`;
- `{ type: "set", index, value }`: the element stayed visible with the same ID but a different payload by `Object.is`. An in-place `set()` is reported this way, not as a removal and an insertion, and so is an acknowledgement that adopts a decoded copy of an own payload;
- `{ type: "move", from, to, value }`.

Apply changes in order; each index refers to the view after the changes before it.

- Moves come first. Each takes the element at `from` out and reinserts it so it ends at `to`. After them, elements present before and after the event are in their final relative order.
- The remaining changes are disjoint and sorted by descending index, with a set before a splice at the same index. Without moves, every index is therefore a pre-event index.
- A single visible move produces one move change. For an adjacent swap, either element can describe the result.
- Same-value writes, ID-only replacements and delete-and-reinsert edits that leave equal values in place are silent. Other delete-and-reinsert edits report two splices.
- Normal changes compare the affected IDs. A single remote move can use its old and new indices when there is no pending work or replay conflict and the observer's baseline matches. Other moves, conflicts and transformed own acknowledgements can require comparing the whole List.

See the [incremental List example](transactions.md#update-a-list-view-incrementally).

#### Map `observe()`

`Map.observe(listener): () => void` follows the same subscription, delivery, baseline and failure rules.

- Each event's `changes` are sorted by key, one entry per changed key: `{ type: "set", key, value, previous }`, where `previous` is `undefined` for an added key, or `{ type: "delete", key, previous }`.
- Equality is `Object.is`. Same-value writes, deletes of absent keys and edits that cancel out are silent. An acknowledgement that adopts a decoded copy of an own payload is a set.

#### Observer failures

- A throw from `onBatch` or an existing listener defers Text, List and Map notifications until a later successful operation.
- An observer's baseline advances before its callback runs. A throw stops the remaining notifications and propagates, without rollback and without disabling the document. Observers not yet called keep their baselines.
- If an observer callback failed partway through applying changes, discard that mirror and subscribe again from the current state.
- Subscriptions are not part of checkpoints.

#### Cursors

`cursorAt(index, bind = "left"): Cursor` takes a safe integer gap index in `0..length` and returns a frozen `{ anchor, bind }` with its own copy of the anchor.

- With `"left"`, `anchor` is the element before the gap (`null` at index 0). With `"right"`, it is the element after the gap (`null` at `length`).
- `cursorIndex(cursor): number | undefined` resolves the current gap. An insertion into the gap lands after a left-bound cursor and before a right-bound one. A deleted anchor moves the cursor to the nearest surviving gap on its side.
- It returns `undefined` when this collection does not know the anchor ID: for example a peer's insertion not yet committed or received, a rejected or rolled-back insertion, or a cursor from another collection. `null` anchors always resolve.
- Tombstones keep anchors known across snapshots and restores.
- Both methods read the optimistic state, including inside a transaction, never notify and cost O(log n). Text cursor indices count elements.
- A non-number index throws `TypeError`; out-of-range indices and invalid binds throw `RangeError`; malformed cursor shapes throw `TypeError`.
- `decodeCursor` rejects missing or extra fields with a `WireDecodeError`.

See [Stable positions with cursors](collections.md#stable-positions-with-cursors).

### Undo and redo

`createUndoManager(doc, { captureTimeout?, paths?, maxSteps? })` returns `{ undo(), redo(), canUndo, canRedo, stopCapturing(), startGroup(), ignore(callback), clear(), on("change", listener), destroy() }`.

#### Options

| Option | Default | Rule |
| --- | --- | --- |
| `paths` | all collections | Only these collections are recorded. An unknown path throws. Typed as the document's keys. |
| `captureTimeout` | 500 | Non-negative milliseconds. |
| `maxSteps` | 1000 | A positive integer or `Infinity`. Beyond it, recording drops the oldest undo step; redo steps work the same way. |

A non-number option throws `TypeError`, and an out-of-range one `RangeError`. A document has at most one manager: creating a second throws until the first is destroyed, and so does creating one inside a transaction.

#### Recording steps

- Each local batch that touches a recorded path becomes a step: the touched collections' states before and after it, and the elements or keys its operations named.
- Peers' commits, acknowledgements and untracked paths are not recorded.
- A batch joins the latest step when it comes less than `captureTimeout` after the previous recorded local batch, by `Date.now()`, unless `stopCapturing()`, `undo()` or `redo()` happened in between.
- `startGroup()` returns an end function. The next recorded batch starts a new step and every later one joins it, however much time passes, until the group ends; the batch after that starts a new step.
- Groups nest and end once every end function has been called; each counts once. `undo()`, `redo()`, `stopCapturing()`, `clear()` and `destroy()` end all open groups, after which their end functions do nothing.
- `ignore(callback)` runs a synchronous callback and returns its result. Batches committed meanwhile are not recorded and do not clear the redo steps. It throws inside a transaction, whose batch commits after the callback.
- Ignored batches are ordinary edits: they are sent, and later undos treat what they changed like a peer's change.
- A batch whose effects cancel out, such as inserting and deleting one element, is not a step.
- A new step clears the redo steps; a batch on untracked paths does not.

#### Undoing

`undo()` reverts the latest step against the current optimistic state, writing only what nobody has changed since, compared as JSON:

| Collection | Reverted when | Written |
| --- | --- | --- |
| Value | it still equals the step's result | the value before the step |
| Map key | it still equals the step's result, absence included | the earlier value, or a delete |
| Counter or `counterMap()` key | the step's net addition is not 0, whatever others added since | an addition of the opposite amount; a reset is undone by adding back what it removed |
| List element inserted | it is still visible | `list/delete` |
| List element deleted | it is still deleted | `list/insert` of its earlier value with a new ID, right after its last position, so it returns to its place |
| List element set or moved | it still holds the step's value, or still sits at the step's position | `list/set` of the earlier value, or `list/move` back right after its earlier position |
| Text elements inserted | they are still visible | `text/delete` |
| Text elements deleted | they are still deleted | `text/insert` of the earlier text with new IDs, after the deleted run's last element, then `text/mark` to give it back its earlier marks |
| Text marks | an element still has the value the step left for that key; text typed into the mark since follows its neighbor | `text/mark` over the step's own range with the most common earlier value, so the old mark stops expanding, then `text/mark` on exactly each run that needs another value |

- All writes of one undo form one transaction, so one batch.
- A reinserted element or text gets new IDs. The manager maps old IDs to new ones, so earlier and later steps keep following it; cursors and application references to the old IDs do not.
- A step with nothing left to revert, because others changed or deleted all of it or the server never applied it, is dropped, and `undo()` tries the next one. It returns whether it changed anything.
- `redo()` works the same way on undone steps: each undo records a redo step, and each redo an undo step.
- Both throw, keeping the steps, while pending replay is blocked or inside a transaction.

#### Memory and lifetime

- Steps are not part of checkpoints: a restored writer starts with none.
- Steps keep references to earlier collection states, which share structure with later ones. `clear()` or `destroy()` releases them, and a step dropped beyond `maxSteps` releases its own. The map from replaced to reinserted IDs is kept until `clear()` or `destroy()`.
- `on("change", listener)` reports each change of the steps, for example to update buttons.
- After `destroy()` the manager stops recording and holds no steps. `undo()` and `redo()` throw, and a second `destroy()` does nothing.

### Ordered reconciliation and blocked pending

#### Delivery order

- A fresh client starts at `serverSeq = 0`, `seq = 1`. A hydrated or restored client expects the next commit after its saved watermark.
- Commits must be delivered **exactly once and in global sequence order**. An own commit must name the earliest pending batch.
- An invalid sequence, acknowledgement or authoritative operation throws before state advances.
- A valid receive applies the authoritative operations, acknowledges the source batch if it is this client's, then replays pending batches.
- An empty authoritative operation array confirms that batch without effect. An empty client batch is not a cancellation request.

#### Collection conflicts

An operation that is well formed but cannot apply to the current state is a collection conflict: an unknown List or Text anchor or target, a colliding insertion ID, or a Counter total outside the safe integer range.

- `server.receive()` throws `CollectionConflictError`, exported so servers can tell it from other failures, and leaves the server unchanged.
- On a client, the valid server commit still advances it when a pending List or Text operation hits such a conflict.
- `replayConflict` names the first failed `batch` and zero-based `operationIndex`; its `message` is diagnostic text.
- Visible state is the authoritative state plus the replayable prefix of pending batches: never a partly applied batch or a later suffix.
- All original pending work, local sequences and allocation counters stay intact.

#### Blocked clients

- A blocked client can read, subscribe, checkpoint and receive more commits.
- Actual mutations throw before state or ID allocation, and `transact()` throws before calling its callback.
- Later commits retry the pending prefix and may change or clear the conflict.
- Unexpected replay errors stay atomic errors, not conflicts.
- There is no automatic rebase, pending purge or ID remapping.
- Trusted code may acknowledge abandoned batches with `server.reject(originalBatch)` and deliver the commits normally. Keep the original payload: the cancellation can meet an already accepted result.
- Cancellation is not undo, and later edits that depend on cancelled insertions may stay blocked.

### Server policy, rejection and retries

#### Processing order

- New batches are processed synchronously, in `receive()` and `reject()` call order. Each client's sequence starts at 1 and increases by one.
- Every successful new batch uses one global `serverSeq`, including rejections and transformations.
- A receipt is routing metadata for your transport; only its `commit` goes on the wire.

#### Resolvers

- An optional `resolve({ batch, snapshot })` sees owned frozen batch containers and the authoritative snapshot before the batch.
- Return the original operations to accept, any valid operation array to transform, or `[]` to reject the effect.
- It must be a pure synchronous decision. Returning a promise or a non-array, throwing, or producing invalid authoritative operations leaves state, sequences, retry entries and history unchanged.
- To transform a Text insertion while reusing its start ID, keep its code-point length. Insertions of another length, or created by the server, need application-supplied globally unique ID ranges that cannot collide with client pending work; the package has no server ID generator.

#### `reject()`

- For a new batch, `reject()` skips the resolver and does not apply the incoming operations, so even batches with invalid references can be rejected.
- It records the original batch and a commit with no operations.
- `receive()` and `reject()` share a reentrancy guard: a resolver cannot call either on the same server.
- Reading the snapshot, checkpoint or history inside a resolver shows the state before the batch. Side effects of your policy cannot be rolled back.

#### Retries

- Only the last processed batch per client is kept for retry.
- The same payload and sequence return the saved commit with `replayed: true` through either entrypoint, without running policy or advancing state or history. An acceptance never turns into a rejection, or the other way round.
- Older retries, gaps and changed payloads throw. JSON object key order is ignored; array and operation order matter.

#### Writer sessions

- `server.openClient()` returns sequential canonical IDs (`client-1`, `client-2`, …) and reserves a session before its first batch. At capacity, or when IDs run out, it throws without changing anything.
- `receive()` and `reject()` require an open issued ID. Unknown or closed writers fail before copying operations, running policy or changing sequences.
- Constructing a client does not register a writer.
- `server.closeClient(id)` permanently removes the session and its latest retry result.
  - Closing an issued, already closed ID does nothing; malformed or never-issued IDs throw `TypeError`.
  - IDs are never reused within normal same-lineage restore.
  - Closing changes no authoritative state, sequence, history or tombstones, and cannot run from inside a resolver.
  - Disconnecting, going offline or reloading is not closing: keep the session for resume, and stop the writer and handle its pending work before closing it.
- `server.listClients()` returns the open sessions in opening order as frozen `{ clientId, lastSeq, lastServerSeq }` entries.
  - `lastSeq` is the sequence of the last batch the server processed from that writer, accepted or rejected (0 before the first). `lastServerSeq` is that batch's commit sequence (`null` before the first).
  - It reads the retry entries a checkpoint saves, so the results survive restore.
  - It copies no state or history, changes nothing and may be called from a resolver, where it shows the sessions before the current batch.
  - There are no timestamps; see [idle sessions](server-wire.md#close-idle-writer-sessions).

#### `maxClients`

- A non-negative safe integer. Omitted means unlimited; 0 allows no sessions.
- It bounds open sessions, not connections, historical IDs or payload bytes.
- Closing releases capacity; failed batches and history eviction do not.
- Removing a retry entry does not purge state, history, tombstones or payloads that callers still hold.
- Registration is not authentication, a writer lock or permission to delete.

#### Broadcasting

- Send new commits to every relevant client, including their source.
- Send a replay only to the source still waiting for it, after any earlier commits it missed. Never deliver a commit twice. A retry does not catch up peers.
- Sequences and allocation counters stay within safe integers. Running out blocks new work, while retained server retries stay available.

### Incoming insertion namespaces

#### Server check

- For a new batch, `server.receive()` checks canonical insertion namespaces on its owned frozen batch before running the resolver.
- A failure throws `TypeError` without advancing state, sequences, retry metadata or history; it is not an acknowledgement.
- The server checks against `batch.clientId`, which must name an open session, but does not authenticate the caller. Your application must verify which writer the caller is.
- `allowCustomClientNamespaces?: boolean` defaults to `false`; a non-boolean throws `TypeError` at construction.
  - Set it to `true` only when your application supplies its own namespace policy.
  - It skips namespace checks only, not session, sequence, retry-payload or state validation.
  - It is not saved in checkpoints: pass it again on restore.
  - Existing state, tombstones, history and saved results are not checked retroactively.

#### `assertClientBatchNamespace()`

`assertClientBatchNamespace(batch: ClientBatch, expectedClientId: string): void` checks a typed incoming batch before your code calls `server.receive()`, retries included.

- Unknown input must pass `decodeClientBatch()` first.
- The nonempty expected ID must come from your authenticated writer binding, not from the batch. `batch.clientId` must match it.
- For every List and Text insertion, `id.bunchId` must be exactly `JSON.stringify([clientId, operation.path, bunchSeq])`, with `bunchSeq` a positive safe integer. Equivalent JSON with other whitespace or encoding is rejected.
- Bunch sequence is not batch sequence: insertions may extend an existing bunch. A Text insertion range shares its start ID's bunch. Anchors and deletion targets may belong to other writers.
- Success returns `undefined`. Failure throws `TypeError` naming the field; the exact message is not guaranteed.
- The helper does not copy, freeze or change its input, read server state, create a commit or use a sequence.
- It checks namespaces only: not wire structure, state-dependent ID validity, authentication, writer locking or permission to delete. You must still allow one writer per `clientId`.
- Decoders check wire structure but not namespaces. IDs your resolver creates are outside this check and must still be globally unique.

#### Cancelling an invalid batch

- To cancel a batch that fails the namespace check, verify its writer, then call `server.reject(originalBatch)` without the standalone check. `reject()` skips the server's namespace check.
- Both entrypoints recognize the last identical batch before checking namespaces and return its original result, including rejected or accepted custom-ID batches restored from a checkpoint.
- Changed payloads, old sequences and gaps still throw. Rejection is not undo.

### Snapshots, checkpoints and catch-up

#### Snapshots

`server.snapshot()` is `{ serverSeq, data }`, for a fresh client of the same schema.

| Collection | Snapshot data |
| --- | --- |
| Value | the JSON payload |
| List | `{ idList, values }`, plus `moves` (`{ id, position }` entries) when visible elements have moved |
| Text | `{ idList, value }`, plus the optional `surrogateBoundaries` below |
| Map | a JSON object from key to value |
| Counter, `counterMap()` | see [Counter](#counter-and-countermap) |

- ID ranges keep tombstones.
- Snapshot paths must match the schema, the watermark must be a non-negative safe integer, and List and Text visible counts must match their payloads.
- Your application must hand over from snapshot to later commits without a gap.

**Text snapshot boundaries:** `surrogateBoundaries?: readonly number[]` keeps adjacent surrogate halves that are separate Text elements apart.

- Offsets are UTF-16 positions in `value`, not the element indices of Text operations and notifications. Each offset separates a high surrogate just before it from a low surrogate at it.
- The array must be non-empty, dense and strictly increasing, with safe-integer offsets in `1..value.length - 1`. Empty arrays, explicit `undefined`, duplicates and invalid boundaries are rejected.
- Without the field, normal code-point segmentation applies; with it, marked pairs stay separate. The resulting element count must equal the present-ID count.
- Saved arrays are owned and frozen, and the field is omitted when not needed.
- Older runtimes reject snapshots that contain it; see [Text snapshot boundaries](recovery.md#text-snapshot-boundaries).

#### Client checkpoints

- `doc.checkpoint()` is `{ clientId, snapshot, lastLocalSeq, pendingBatches, lastBunchSeqs }`: authoritative state, the original pending work and allocation progress. It is not a separate optimistic snapshot.
- `createClient(schema, { clientId, checkpoint, onBatch })` validates the restore data and matching identity, rebuilds optimistic state and any conflict, and emits no changes or outgoing batches.
- `snapshot` and `checkpoint` options cannot be combined.

#### Server checkpoints

- `server.checkpoint()` is `{ snapshot, lastClientNumber, clients, history }`.
- Each open client entry is `{ clientId, replay }`. `replay` is `null` until the first successful batch, then `{ batch, commit }`.
- `lastClientNumber` is a non-negative safe integer. Entries must be unique canonical issued IDs no greater than it. Closed sessions are absent.
- Restore keeps authoritative state, allocation progress, open sessions, retries and history. Callbacks, history capacity and `maxClients` are not saved.
- A `maxClients` below the restored number of open sessions fails, without dropping any. Checkpoints from 0.1 fail validation.
- History must be a consecutive suffix ending at the snapshot watermark. Its sources may be closed but must be issued IDs, and each source's sequences are consecutive.
- For an open source, its latest retained commit must match its replay, and a `null` replay cannot have history.
- Retained metadata gives lower bounds on batch counts, not exact totals: closed writers may have no metadata.
- Restore does not reapply history operations.

#### History and catch-up

- `maxHistory` defaults to 1000, is a non-negative safe integer and counts commits, not bytes. 0 disables history.
- Accepted, rejected and transformed batches enter history; retries and failed processing do not.
- `commitsSince(watermark)` returns a frozen, complete ascending suffix, `[]` when current, or `null` when a gap cannot be filled. Invalid or future watermarks throw.
- Raising the capacity cannot bring back evicted commits, and evicting history does not remove last-batch retry entries.

#### Safe restore

- Keep one active writer per client ID and the same schema and document lineage, and retire old writers before restoring.
- Restore keeps sequence and ID progress, including rejected or rolled-back allocations.
- Do not fork checkpoints, resume stale work that misses already-sent batches, or replace pending work with a fresh snapshot.
- There is no schema ID, migration, writer lock, automatic resend, history-gap recovery or core lineage check.
- If you persist, save server checkpoints before delivering new commits, and client pending work before sending. Saving and transport are your application's job. After a failed save, do not keep using the advanced in-memory server.
- Nested payloads in snapshots and checkpoints follow the immutable-value rule. Point-in-time containers do not protect against mutating shared JSON.

### Wire validation and error boundaries

- Pass parsed `unknown` through the matching `decode*(schema, input)` before typed runtime use. Decoders do not parse raw strings or encode messages; wire objects support `JSON.stringify()`.
- Decoders strictly reject missing or extra fields, invalid containers, sequences, IDs and ranges, non-JSON values, mismatched schema kinds and inconsistent snapshot or checkpoint metadata.
- They deeply copy and freeze JSON payloads and wire containers.
- JSON validation does not check your business type `T`. Application rules belong to you, often in server policy.
- Questions about current state, such as unknown anchors, duplicate insertion IDs or already-consumed sequences, are answered when the runtime applies data, not by decoders.
- Checkpoint decoders also validate restore metadata and rebuild collection state. Structurally valid pending work that conflicts with state is kept as a replay conflict, not silently removed.
- Runtime errors have readable messages, not a stable error-code hierarchy. `WireDecodeError` promises its `name`, JSON Pointer `path` and a readable `message`, not exact wording.
- A thrown callback does not prove that a mutation or receive failed atomically. Your transport must handle parsing, quotas, delivery order, ambiguous outcomes and recovery without assuming a throw means nothing happened.

## Sync adapter

Import from `"articollab/sync"`. It depends only on the core entrypoint and on `fetch`, `Request` and `Response`; the WebSocket transport also uses `WebSocket`, and the IndexedDB store `indexedDB` and `navigator.locks`. The file store is in `"articollab/sync/node"`, which uses `node:fs`. See the [guide](sync.md).

| API | Purpose |
| --- | --- |
| `connectSync(schema, { transport, checkpoint?, save?, store?, pollInterval?, retry?, push?, pushTimeout? })` | Creates or restores a `ClientDocument` that owns its `onBatch` and returns a `SyncClient`. Without `checkpoint`, or a checkpoint in `store`, it registers a session. |
| `openIndexedDbStore({ database, key, slots?, indexedDB?, locks? })`, `openFileStore(path, { locks?, fs? })` | Open a `CheckpointStore` after taking an exclusive lock; a lock held elsewhere throws `CheckpointLockedError`. The IndexedDB store is an `IndexedDbCheckpointStore` with the `slot` and `key` it took. |
| `client.doc`, `client.status`, `client.error`, `client.push` | The document, the current `SyncStatus`, the failure while `status` is `"failed"`, and the push channel's `SyncPushState`. |
| `client.sync()`, `client.rejectPending()` | Run a pass now, or confirm cancellation of the pending batches that exist when called. Both resolve `true` on success. |
| `client.restartFromSnapshot()`, `client.on("status" \| "push", listener)`, `client.close()` | Recover from a gap without pending work, observe status or push-channel changes, stop polling, retries and push and close the store and transport. |
| `createHttpTransport({ url, fetch?, headers? })` | A `SyncTransport` for the handler's routes under `url`. |
| `createWebSocketTransport({ url, WebSocket? })` | A `SyncTransport` over one socket to `url`, served by `handler.accept`. |
| `createSyncHandler(schema, server, { authorize?, saveCheckpoint?, allowRejections?, maxBodySize?, heartbeatInterval?, maxEventStreams? })` | A `SyncHandler`: a Fetch API handler for `clients`, `batches`, `commits`, `events` and, when allowed, `rejections`. |
| `handler.accept(socket, request)` | Serves one WebSocket with the same server, queue and presence as the routes; returns a `SyncConnection`. |
| `handler.notify()` | Pushes commits applied without the handler to open event streams and subscribed sockets. |
| `SyncRequestError` | A sync request answered with an unexpected status, with `status` and `retryable`. The sync client retries HTTP 408, 429 and 5xx, as well as network failures during a pass. |

Types: `SyncClient`, `PresenceSyncClient`, `SyncStatus`, `SyncPushState`, `SyncTransport`, `SyncSubscription`, `ConnectSyncOptions`, `SyncRetryOptions`, `SyncPresence`, `SyncPresenceOptions`, `SyncHandlerPresenceOptions`, `HttpTransportOptions`, `WebSocketTransportOptions`, `WebSocketLike`, `SyncHandler`, `SyncHandlerOptions`, `SyncAction`, `SyncSocket`, `SyncConnection`, `CheckpointStore`, `IndexedDbCheckpointStore`, `IndexedDbStoreOptions`, `IdbFactoryLike`, `LockManagerLike`; from `"articollab/sync/node"` also `FileStoreOptions` and `FileStoreFileSystem`.

### Client persistence

#### Saves

- Saves run one at a time. Each reads the checkpoint when it starts and is skipped if neither the last local sequence nor the watermark changed since the last save, so an older checkpoint never replaces a newer one.
- A save is queued after every local edit (one per microtask), at the start of each pass, before each submission and after commits are applied.

#### Stores and ownership

- `store` replaces `checkpoint` and `save`; passing either with it throws `TypeError`.
- `connectSync` loads the store and decodes a saved value with `decodeClientCheckpoint`. An invalid value rejects the call instead of starting over.
- The client saves through the store and closes it in `close()`.
- If `connectSync` rejects, the caller still owns the store.
- `restartFromSnapshot()` hands the store to the new client, which registers a session without loading and replaces the saved checkpoint with its first save.
- A transport with `close()`, such as the WebSocket transport, follows the same rules. `close()` closes it after the push channel and presence have ended, `restartFromSnapshot()` hands it on, and if `connectSync` rejects the caller still owns it.

#### `openIndexedDbStore`

- It takes the Web Lock `articollab:<database>:<key>` with `ifAvailable`, so a second tab fails at once with `CheckpointLockedError`.
- It keeps each checkpoint as a JSON string under `key` in the `checkpoints` object store.
- `slots` is an integer from 1 to 64, default 1. A non-number throws `TypeError`, another value `RangeError`.
- Slot 0 is `key` and slot n is `key#n`, each with its own lock. Do not give other stores keys of that form.
- The store opens the database, reads every slot in one transaction, and tries the locks with `ifAvailable` in this order: slots whose saved checkpoint has pending batches, then slots with any saved checkpoint, then empty or unparsable ones; lower slots first within each group.
- The reads only order the attempts; the lock decides. It throws `CheckpointLockedError` when every slot is held. The returned store's `slot` and `key` name the one it took.

#### `openFileStore`

- It locks `articollab:file:<absolute path>` within the process only.
- It writes each checkpoint to a temporary file in the same directory, flushes it and renames it over the target.
- Unparsable contents are an error, not an empty store.

#### Closing a store

- Closing rejects later operations, lets operations already started finish, then releases the lock.
- Reopening the same store in this realm waits for that instead of failing, so a closing store's last save never lands after a newer one.

### Submission and recovery

#### Passes

- A pass saves the checkpoint if it changed and catches up. It then saves, submits the earliest pending batch and catches up until that batch is acknowledged.
- Catch-up decodes every commit and checks that server sequences are consecutive before applying any.
- Overlapping calls share one pass. Work created after its final pending check starts another pass.
- A `null` catch-up result sets `"gap"` and keeps pending work.
- A replay conflict sets `"blocked"` once the batches before the conflict are acknowledged. Submission waits for the conflict to clear or for `rejectPending()` to confirm cancellation.

#### Retries and failure

- Retry delays double from `initialDelay` (500 ms) to `maxDelay` (30 s), times a random factor between 0.5 and 1. A successful pass resets the delay.
- These set `"failed"` permanently: errors with `retryable: false`, invalid or out-of-order commits, an unacknowledged submission, a failing save and a throwing status listener.
- If a document listener or observer throws during catch-up, the commit stays applied and the client fails.

#### Cancellation and shutdown

- Each queued cancellation keeps its own cutoff from when it was called. Newer batches are not cancelled by it, though normal syncing may submit them.
- Work checks terminal state again after waiting in the queue: closing interrupts queued and running work with `false`, while failure rejects it with the original `client.error`.
- New calls after `close()` reject, and no queued work can turn a closed or failed client back to syncing or idle.
- I/O already started may complete, but late results are ignored, and no new transport call, save or commit delivery starts after termination.
- Completed document changes and unconfirmed pending work remain. Calling `close()` after a failure does not replace the failure.

### Push and polling

- With a transport that provides `subscribe`, the client opens a channel from its watermark after a pass ends `"idle"` or `"blocked"`.
- The HTTP transport uses `fetch`, so it sends configured headers and the handler authorizes the request as `catchUp`. The WebSocket transport subscribes on its socket.
- An idle or blocked client polls every `pollInterval` milliseconds (1,000 by default) while the channel is closed. Set it to `0` to disable polling, or use `push: false` for hosts without SSE.
- Pushed commits are decoded like catch-up. Sequences at or below the watermark are ignored, and a consecutive delivery is applied directly. A gap runs a pass.
- On EOF, a retryable error or `pushTimeout` milliseconds without traffic (45,000 by default), the client runs a pass, resumes polling and reconnects with backoff. Opening the channel resets the backoff.
- Invalid pushed data or `retryable: false` fails the client and keeps the first error.
- `"gap"`, `"failed"` and `"closed"` close the channel and ignore anything it reports afterwards.

### HTTP handler

#### Defaults

| Option | Default |
| --- | --- |
| `maxBodySize` | 1 MiB |
| `maxEventStreams` | 1,000 |
| `heartbeatInterval` | 15,000 ms |

#### Requests

- The handler checks JSON content types and uses `decodeClientBatch` for submissions and rejections.
- It opens sessions, receives batches and, with `allowRejections`, rejects them, one at a time. When the server changed, it calls `saveCheckpoint` before answering.
- A failed save makes it answer 503 to every later request; recreate the server from its last saved checkpoint.
- Catch-up and event streams read commits only between queued writes and their saves, so no commit is served or pushed before it is saved.
- `authorize` receives the request and `{ action, clientId? }`; `false` answers 403.
- `notify()` pushes commits made outside the handler; call it after saving them.
- Responses use `Cache-Control: no-store`, and error messages are fixed.

#### Event streams

- `events?since=n` answers a `text/event-stream`: the commits after `n` (or after a larger numeric `Last-Event-ID`) as one `commits` event, then each later group of saved commits. Each event's `id` is its last server sequence.
- If history no longer covers the stream's position, it sends a `gap` event and ends.
- Streams get a `: ping` comment every `heartbeatInterval` milliseconds, end when the request is aborted or a save fails, and count against `maxEventStreams`.
- Admission and stream creation run together in the queue, so concurrent requests respect the limit; extra requests get 503.
- An already-aborted request starts no heartbeat and keeps no stream. Aborting or cancelling a stream releases its slot and timer.

#### Stream queue limit

- Each event stream has a 4 MiB queue, measured in encoded UTF-8 bytes.
- If a commit frame does not fit, including the first catch-up frame, the handler releases that stream's slot and ends its body after the frames already queued.
- A heartbeat that does not fit is skipped. If a gap frame does not fit, the stream ends and the next catch-up can report the gap.
- The sync client catches up from its last applied sequence before resuming push. Custom `EventSource` consumers should also call `GET /commits` before reconnecting after an unexpected end.
- This limit covers the handler's queue; HTTP and socket buffers are separate.

### WebSocket

#### Server

`handler.accept(socket, request)` takes a `SyncSocket` and the upgrade `Request`.

- A `SyncSocket` has `send(text)`, `close(code?, reason?)` and, where the runtime reports it, `bufferedAmount`.
- `authorize` receives the upgrade request with each message's action.
- Pass each received message to the returned connection's `message(data)`, as text or UTF-8 bytes. Call its `close()` when the socket closes: that ends its subscription and removes the presence states it sent.

#### Messages

Messages are JSON objects. Each request has a non-negative integer `id`. Its reply is `{ id, status, body? }`, with the status and body the matching HTTP route would return, including `{ error }` bodies.

| Request | Route | Success |
| --- | --- | --- |
| `{ id, type: "register" }` | `POST clients` | 201, `{ clientId, snapshot }` |
| `{ id, type: "submit", batch }` | `POST batches` | 204 |
| `{ id, type: "reject", batch }` | `POST rejections` | 204; 404 unless `allowRejections` |
| `{ id, type: "commits", since }` | `GET commits` | 200, the commits or `null` |
| `{ id, type: "presence", clientId, state }` | `POST presence` | 204; 404 unless `presence` |
| `{ id, type: "subscribe", since }` | `GET events` | 200, then pushes |
| `{ id, type: "unsubscribe" }` | — | 204 |

- Other fields answer 400; other types answer 404.
- A socket has at most one subscription. The latest `subscribe` replaces it, and a `subscribe` replaced before it opened answers 204.
- A subscription counts against `maxEventStreams`. Its reply always comes before its first push.
- Pushes are `{ type: "commits", commits }`, `{ type: "presence", clientId, state }`, `{ type: "ping" }` every `heartbeatInterval` milliseconds, and `{ type: "gap" }` when history no longer covers it. A gap ends the subscription but not the socket.

#### Close codes

| Code | When |
| --- | --- |
| 1009 | A message is over `maxBodySize` bytes |
| 1007 | A message's bytes are not UTF-8 |
| 1008 | A message is not a JSON object with an `id` and a string `type` |
| 1013 | `bufferedAmount` passes 4 MiB |
| 1011 | A checkpoint save failed; new sockets are then closed at once |

#### Client

- `createWebSocketTransport({ url, WebSocket? })` opens a socket on first use, with the global `WebSocket` unless you pass one.
- `url` is a `string`, a `URL` or a function returning either, read before each connection. A fixed URL that is not valid throws `TypeError`.
- When the socket closes, waiting requests reject as retryable and the subscription ends. The next request opens a new socket.
- A status other than the expected one throws `SyncRequestError`. An invalid message from the server fails the client.

### Presence

#### Server

`createSyncHandler(schema, server, { presence: { schema?, ttl? } })` enables `POST presence` with the JSON body `{ clientId, state }`, exactly those fields. `state` is a JSON value or `null`.

- The handler authorizes it as `presence` for `clientId`.
- It answers 400 for another shape, a non-JSON state or one the optional Standard Schema rejects; 409 when `clientId` is not an open session; and 204 otherwise.
- Without `presence`, the route and the socket `presence` message answer 404.
- States live only in the handler's memory, keyed by client ID. `null` removes one.
- A state not sent again within `ttl` milliseconds (30,000 by default; it must be positive) is removed by a sweep that runs every third of `ttl` while any state exists.
- A state sent over a WebSocket is also removed when that socket closes, unless a later message, from either transport, set it again.
- `server.closeClient()` removes the closed session's state at once, whichever transport sent it.
- Each change is pushed to every subscriber; on an event stream as `event: presence` with the data `{ clientId, state }`, `null` for a removal. Re-sending an identical state only extends its life.
- A new subscriber receives every current state after its commits.
- Presence frames share the stream's queue limit and end the stream like commit frames when it is full.

#### Client

`connectSync(schema, { presence: { schema?, republishInterval? } })` requires a transport with `publishPresence(clientId, state)`. Both built-in transports provide it and pass pushed `presence` events to `onPresence`.

- `presence.set(state)` validates JSON and the optional schema, throwing `TypeError` or `PayloadValidationError`.
- It sends the state, keeping only the newest while a request is in flight. It sends it again every `republishInterval` milliseconds (10,000 by default; keep it well below the handler's `ttl`) and whenever a push channel opens.
- `set(null)` sends `null` and stops the re-sends.
- Send failures are ignored and do not affect document sync.
- `state` is the last value set.
- `peers` is a `ReadonlyMap` from client ID to state for every other writer. It is rebuilt from scratch on each new push channel and emptied when the channel ends. Received states that are not JSON, or that the client's schema rejects, are skipped.
- `on("change", listener)` reports each new `peers` map.
- `close()`, or a failed client, sends `null` once, best-effort, and stops the re-sends. Later valid `set()` calls are ignored.

## Boundaries

- The server uses explicit writer sessions.
- Examples show how an application can be built. They are not exported or shipped as production adapters. In particular, browser `documentId` envelopes and headers are example-only lineage markers, not core wire fields or authentication.
- The [sync adapter](sync.md) provides HTTP and WebSocket transports with push, polling and retries, plus IndexedDB and file checkpoint stores.
- Not provided: a server-side storage adapter, snapshot fallback, schema migration, authentication, writer coordination, rich text, bulk List editing, or moving elements between Lists.
- Tabs that open one store key with `slots` are separate writers. They exchange edits only through the server, never share undo history or unsent edits, and do not see each other's edits while offline.
- Presence lives in one handler's memory, best-effort. It is not saved or shared between server instances, and there is no selection type or remote-caret rendering.
- Not promised: same-ID server rollback or forks, power-loss durability, or cross-file transactions.
- These gaps are not a roadmap.

[Previous: Sync adapter](sync.md) · [Next: Upgrading](upgrading.md)
