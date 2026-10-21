# Core reference

Look up the public API and exact collaboration contracts here. For a runnable introduction, start with the [Counter quick start](quick-start.md); for design reasons, read [Concepts](concepts.md).

## Compatibility

These docs cover the public API. Install `articollab` and upgrade all participating runtimes before exchanging new operations or snapshot formats. Do not mix incompatible runtimes or document lineages. See the [0.4 upgrade guidance](recovery.md#upgrading-from-03-to-04), [0.3 upgrade guidance](recovery.md#upgrading-from-02-to-03) and the [0.1 upgrade guide](recovery.md#upgrading-from-01).

Private implementation details, exact runtime error wording, performance figures and example helpers are not compatibility guarantees. `WireDecodeError` promises its documented `name`, JSON Pointer `path` and readable message, not exact wording.

## Public API

Import from `"articollab"`; internal modules and example helpers are not package entrypoints. The factories are the recommended starting point. `ClientDocument` and `ServerDocument` constructors take the same schema/options as their factories; `DocumentSchema` is the exported schema container.

| API | Purpose |
| --- | --- |
| `defineDocument(definition)`, `value(initialValue)`, `list<T>()`, `text()` | Fixed typed schema; property keys are wire paths. List/Text start empty. |
| `createClient(schema, options)` | Requires nonempty `clientId` and `onBatch`; optional `snapshot` or `checkpoint`, never both. |
| `doc.state` | Readonly collection bindings; mutate through Value/List/Text methods. |
| `doc.transact(callback)` | Groups synchronous mutations and returns the callback result. |
| `doc.on("change", listener)` | Subscribes to document-level events; returns an unsubscribe function. |
| `doc.state.body.observe(listener)` | Opt-in visible Text edits; returns an unsubscribe function. |
| `doc.receive(commit)` | Applies the next authoritative commit, acknowledges own pending work and replays the rest. |
| `doc.replayConflict`, `doc.checkpoint()` | Read the first replay failure or save authoritative state and pending work. |
| `createServer(schema, options?)` | Optional synchronous `resolve`, restore `checkpoint`, `historyLimit` (default 1000), `maxClients` (optional open-session bound), and `allowCustomClientNamespaces` (default false). |
| `server.openClient()`, `server.closeClient(clientId)` | Issue a writer ID or permanently retire it; neither creates a commit. |
| `server.receive(batch)`, `server.reject(batch)` | Process a batch or replay its original result; return `{ commit, replayed }`. |
| `server.snapshot()`, `server.checkpoint()`, `server.commitsSince(watermark)` | Late join, server restore, and complete ordered catch-up or `null`. |
| `decodeClientBatch`, `decodeServerCommit`, `decodeSnapshot`, `decodeClientCheckpoint`, `decodeServerCheckpoint` | Each takes `(schema, unknown)`, validates parsed wire data and returns an owned frozen object. |
| `assertClientBatchNamespace(batch, expectedClientId)` | Explicit authenticated writer binding and canonical insertion namespace check; returns `void` or throws `TypeError`. |
| `WireDecodeError` | Decoder error with `name`, JSON Pointer `path` (root `/`) and a readable message. |

The entrypoint also exports these types, grouped by role rather than implementation file:

| Types | Role |
| --- | --- |
| `JsonPrimitive`, `JsonValue` | JSON-compatible payload types. |
| `SchemaShape`, `CollectionSchema`, `ValueSchema`, `ListSchema`, `TextSchema`, `ValueType`, `ListType` | Schema descriptors and inferred element types. |
| `Value`, `List`, `Text`, `DocumentState` | Typed collection views. |
| `CreateClientOptions`, `CreateServerOptions`, `ServerResolveContext`, `ServerResolver` | Construction and batch policy contracts. |
| `ValueSetOperation`, `ListInsertOperation`, `ListDeleteOperation`, `ListSetOperation`, `ListOperation`, `TextInsertOperation`, `TextDeleteOperation`, `TextOperation`, `TextIdRange`, `Operation`, `DocumentOperation` | Collection wire operations; `DocumentOperation<S>` restricts path and payload to a schema. |
| `ClientBatchRef`, `ClientBatch`, `ServerCommit`, `ServerReceipt`, `ServerReplayEntry` | Batch identity, authoritative result, local routing metadata and retry entries. |
| `LocalChangeEvent`, `ServerChangeEvent`, `ChangeEvent`, `PendingReplayConflict` | Local/server notifications and the first blocked pending operation. |
| `TextChange`, `TextChangeEvent` | Visible Text element edits from an opt-in subscription. |
| `DocumentSnapshotData`, `DocumentSnapshot`, `ListSnapshotData`, `TextSnapshotData`, `SavedIdRange` | Typed snapshot payloads, including List/Text tombstones. |
| `ClientCheckpoint`, `ServerCheckpoint` | Complete client/server restore data. |

## Core contracts

### Collections and immutable values

| Collection | Reads | Mutations |
| --- | --- | --- |
| `Value<T>` | `.value` | `.value = next` or `.set(next)`; replace the whole JSON value. |
| `List<T>` | `.length`, `.get(index)`, `.values()`, `.toArray()`, iteration | `.insert(index, value)`, `.push(value)`, `.delete(index)`; `.set(index, value)` updates one element without changing its ID. |
| `Text` | `.length`, `.values()`, `.toString()`, iteration | `.insert(index, string)`, `.delete(index, count = 1)`; Unicode code points. |

Values and List elements must be JSON-compatible and immutable after being supplied. Nested object/array edits are not intercepted: replace a Value rather than editing its fields; use List `set()` to replace the whole element value while preserving identity. Delete + insert creates a new identity instead. The public state container, operation/ID containers and library-owned wire arrays are frozen, but user payloads are not generally deep-cloned or deep-frozen. `toArray()` copies the array, but its shared elements must still remain immutable.

`value(initialValue)`, schema-default initialization, local Value set and List insert/push synchronously validate JSON payloads. Invalid values throw `TypeError` before that mutation changes state, pending, sequence or ID allocation, without calling `onBatch` or change listeners. Accepted payloads retain their references and are not frozen by validation. Validation rejects non-finite numbers, undefined, BigInt, functions, symbols, cycles, non-plain objects, sparse arrays and non-JSON property descriptors. Plain objects may have `Object.prototype` or a null prototype; shared branches are allowed. Own accessors and `toJSON` functions are rejected, not executed. Validation visits each occurrence in the supplied payload, not the whole document, and is not cached.

List `set()` uses the same local JSON validation before updating state. This is JSON validation, not application-shape validation or deep immutability enforcement. Typed receive, direct snapshot hydration and resolver output remain trusted-input boundaries; decode unknown wire data first. Finite signed zero is allowed with existing local `Object.is` semantics, but ordinary JSON serialization does not preserve its sign. Deep validation/decoding avoids recursion; the runtime's JSON serializer still has its own depth limits.

Schema paths are fixed, nonempty strings when created with `defineDocument()`; there is no nested collection schema, schema migration or application-shape validator. For example, `value(0)` infers `Value<number>`, not a literal-only zero. TypeScript payload types do not validate arbitrary incoming JSON at runtime.

List/Text insertion indices allow `0..length`; List get/delete/set require `0..length-1`. Indices and Text counts must be safe integers, and a Text deletion must fit entirely within the visible text. Invalid bounds throw without a batch or change. Text `insert(index, "")` and `delete(index, 0)` validate bounds, then do nothing, including while replay is blocked. `"😀"` has Text length 1; code points are not UTF-16 code units or grapheme clusters.

List/Text operations use stable IDs, not mutable indices. The wire field `before` is the preceding insertion anchor (`null` means start); deleted known IDs remain tombstones and can still anchor pending insertions. Text insertion allocates consecutive IDs; deletion compresses consecutive targets into ranges. Deleting known tombstones is an authoritative no-op, but unknown targets or colliding insertion IDs are errors.

`List.set(index, value): void` emits `{ type: "list/set", path, id, value }`, with exactly those fields. The target is the visible ID at call time. Setting a present target replaces the whole payload without changing its ID, position, length or allocation counters; concurrent updates follow server operation order. A known deleted target is a legal no-op and never stores the new value or resurrects the element. An unknown target is a collection conflict: server processing fails atomically, while pending replay blocks at that batch. Other operations in a batch containing a tombstone no-op still apply. Updating another writer's element is allowed; insertion namespace checks are not update authorization.

### Mutations, transactions and events

Outside a transaction, each actual mutation forms a batch. Value assignment and List `set()` record an operation even when assigning the same value. A successful nonempty outer transaction forms one batch; an empty transaction produces neither batch nor local change.

The local completion order is **optimistic state → pending batch and local sequence → `onBatch(batch)` → local `change`**. The event is `{ origin: "local", batch }`. A synchronous `onBatch` can process the server result immediately, so a later local listener may already see reconciled state; the event is not a snapshot of that state.

`transact()` is synchronous, not an async/await transaction. Nested calls join the outer batch, with no inner savepoint. An exception escaping the outer callback restores visible state and discards its uncommitted operations without consuming a local batch sequence; already allocated List/Text bunch counters are not rolled back. Catching an inner exception inside the outer callback leaves those earlier mutations in the outer transaction. `receive()` and `checkpoint()` throw inside a transaction.

`onBatch` and listeners are application callbacks, not rollback boundaries. If `onBatch` throws, the batch and sequence are already pending and the following local notification is not emitted. A local listener throw also leaves the completed batch intact. A server listener throw happens after the commit, watermark and reconciliation have completed. Exceptions propagate and can stop remaining listener notifications; the core does not permanently disable the document or undo callback side effects. Transport examples impose their own stop-on-first-error policy.

Server events are `{ origin: "server", commit }`, emitted only when visible state or the replay-conflict descriptor changes, not merely because an ack/watermark advances. Value and List payload equality uses `Object.is`; List/Text additionally compare visible stable IDs. An accepted own commit is silent when that comparison and the conflict are unchanged. Deep-equal JSON objects decoded into new references can still trigger a change. A change listener is not a reliable ack or checkpoint-save trigger.

`Text.observe(listener): () => void` independently subscribes to visible element-content changes. It starts at the current view without an initial event; subscription inside a transaction throws. Unsubscribe is idempotent. The event is `{ beforeLength, afterLength, changes }`; each change is `{ index, deleteCount, insert: readonly string[] }`. All containers are owned/frozen. Indices use the original pre-event element coordinates; changes are disjoint and sorted descending for sequential application. Each inserted string retains one Text element, including separately inserted surrogate halves. There is no minimum-edit or stable-segmentation guarantee, and these offsets are not editor UTF-16 offsets.

Text observers run after existing callbacks at successful outermost local commit/receive boundaries, with synchronous reentrant work coalesced. Each subscriber has its own baseline; notifications are neither one-per-batch nor one-per-commit. Observer mutations drain in later passes rather than recursively. Only content changes notify, not ID/conflict/ack changes alone. Normal changes use affected IDs; conflict or unproven-target cases may scan the whole Text. No diff work or observer snapshots are retained without subscribers. See the [incremental example](transactions.md#update-a-text-view-incrementally).

An `onBatch`/existing-listener throw defers Text notifications until a later successful operation. An observer baseline advances before invoking its callback; a throw stops remaining notifications and propagates without rollback or permanently disabling the document. Uncalled observers retain their baselines. After partially applying a failed observer callback, discard that mirror and resubscribe from the current elements. Subscription state is not part of checkpoints.

### Ordered reconciliation and blocked pending

A fresh client starts at `serverSeq = 0`, `seq = 1`. A hydrated/restored client expects the next commit after its saved watermark. Commits must be delivered **exactly once and in global sequence order**; an own commit must identify the earliest pending batch. Invalid sequence, acknowledgement or authoritative operations throw before state advances.

A valid receive applies authoritative operations, acknowledges the source batch if it is this client, then replays pending batches. An empty authoritative operation array confirms that batch without authoritative effect; it does not mean an empty client batch is a cancellation request.

When a pending List/Text operation references an unknown anchor/target or colliding insertion ID, the valid server commit still advances the client. `replayConflict` identifies the first failed `batch` and zero-based `operationIndex`; its `message` is diagnostic text. Visible state is authoritative state plus the complete replayable batch prefix: no partial mixed batch or later suffix is shown. All original pending work, local sequences and allocation counters remain intact.

Blocked clients can read, subscribe, checkpoint and receive further commits. Actual mutations throw before state/ID allocation, and `transact()` throws before calling its callback. Later commits retry the pending prefix and may change or clear the conflict. Unexpected replay errors remain atomic errors, not conflicts. There is no automatic rebase, pending purge or ID remapping.

Trusted application code may explicitly acknowledge abandoned batches with `server.reject(originalBatch)`, delivering commits normally. Preserve the original payload: cancellation can encounter an already accepted result. Cancellation is not undo, and later edits depending on cancelled insertions may themselves remain blocked.

### Server policy, rejection and retries

New batches are processed synchronously in `receive()`/`reject()` call order, with each client's sequence starting at 1 and increasing continuously. Every successful new batch consumes one global `serverSeq`, including rejection and transformation. A receipt is transport-local routing metadata; only its `commit` belongs on the wire.

An optional `resolve({ batch, snapshot })` sees owned frozen batch containers and the pre-batch authoritative snapshot. Return original operations to accept, any valid operation array to transform, or `[]` to reject the authoritative effect. Resolve must be a pure synchronous decision. Returning a Promise/non-array, throwing, or producing invalid authoritative operations leaves state, sequences, retry entries and history unchanged.

For a new batch, `reject()` skips the resolver and does not apply incoming operations, so state-invalid references can still be rejected. It records the original batch and an empty-operations commit. Both entrypoints share a reentrancy guard; a resolver cannot call either on the same server. Reading snapshot/checkpoint/history inside a resolver sees pre-batch state. Policy side effects cannot be rolled back.

Reusing an incoming Text insertion's start ID for a transform should preserve its code-point length. Different-length or server-created insertions require application-supplied globally unique ID ranges that cannot collide with client pending work; the package has no server ID generator.

Only the last processed batch per client is retained for retry. The same payload/sequence returns its saved commit with `replayed: true` across either entrypoint, without rerunning policy or advancing state/history. Acceptance cannot become rejection or vice versa. Older retries, gaps and changed payloads throw; JSON object key order is ignored, but array and operation order matters.

`server.openClient()` returns sequential canonical IDs (`client-1`, `client-2`, …), reserves a session even before its first batch, and throws without mutation at capacity or allocation exhaustion. Both `receive()` and `reject()` require an open issued ID; unknown/closed writers fail before operation copying, policy or sequence changes. Client construction alone does not register a writer.

`server.closeClient(id)` permanently removes the session and latest retry result. Closing an already-issued closed ID is a no-op; malformed or never-issued IDs throw `TypeError`. IDs are never reused within normal same-lineage restore. Closure changes no authoritative state, sequence, history or tombstones and cannot run reentrantly from a resolver. Disconnect/offline/reload is not closure: keep the session for resume, and stop the writer and handle pending work before closing it.

`maxClients` is a non-negative safe integer; omitted means unlimited, zero permits no opens. It bounds open sessions, not connections, historical IDs or payload bytes. Close releases capacity; failed batches and history eviction do not. Removing the retry entry does not purge state/history/tombstones or payloads retained by callers. Registration is not authentication, a writer lock or deletion authorization.

Broadcast new commits to all relevant clients, including their source. Route a replay only to the source still awaiting it, after any earlier missing commits; never redeliver an already-consumed commit. Retry does not catch up peers. Sequences and allocation counters stay within safe integers; exhaustion prevents new relevant work, while retained server retries remain available.

### Incoming insertion namespaces

For a new batch, `server.receive()` checks canonical insertion namespaces on its owned frozen batch before running the resolver. Failure throws `TypeError` without advancing state, sequences, retry metadata or history; it is not an ack. The server checks against `batch.clientId`, which must name an open session, but does not authenticate the caller. Application code must verify the caller's writer/session binding separately.

`allowCustomClientNamespaces?: boolean` defaults to `false`; non-boolean values throw `TypeError` at construction. Set it to `true` only when the application supplies its own incoming namespace policy. It bypasses namespace checks, not session, sequence, retry-payload or state validation. The option is not checkpoint data: pass it again on restore if needed. Existing state, tombstones, history and saved results are not retroactively namespace-checked.

`assertClientBatchNamespace(batch: ClientBatch, expectedClientId: string): void` checks a typed incoming batch before application code calls `server.receive()`, including retries. Unknown input must first pass `decodeClientBatch()`. The nonempty expected ID must come from an application-authenticated writer/session binding, not the batch itself; `batch.clientId` must match it.

For every List/Text insertion, `id.bunchId` must be exactly `JSON.stringify([clientId, operation.path, bunchSeq])`, where `bunchSeq` is a positive safe integer. Equivalent JSON with whitespace or alternate encoding is rejected. Bunch sequence is not batch sequence: insertions may extend an existing bunch. Text insertion ranges share their start ID's bunch. Anchors and deletion targets may belong to other writers.

Success returns `undefined`; failure throws `TypeError` identifying the relevant field, without an exact-message guarantee. The helper does not copy, freeze or modify its input, read server state, create a commit or consume a sequence. It checks namespaces, not wire structure, state-dependent ID validity, authentication, writer locking or deletion authorization. Applications must still enforce one writer per `clientId`.

The standalone helper remains useful for checking an application-authenticated writer ID. Decoders validate wire structure but do not enforce namespaces. Resolver-generated authoritative IDs are outside the incoming check and retain their existing globally unique ID requirements.

To cancel a namespace-invalid original batch, trusted application code must verify its writer binding, then call `server.reject(originalBatch)` without the standalone namespace check. `reject()` skips the server namespace check. Both entrypoints recognize the last identical batch before namespace validation and return its original result, including rejected or previously accepted custom-ID batches restored from a checkpoint. Changed payloads, old sequences and gaps still throw. Rejection is not undo.

### Snapshots, checkpoints and catch-up

`server.snapshot()` is `{ serverSeq, data }`, for a fresh client using the same schema. Value data is the JSON payload; List data is `{ idList, values }`; Text data is `{ idList, value }`, with the optional `surrogateBoundaries` extension described below. ID ranges preserve tombstones. Snapshot paths must match the schema, the watermark must be a non-negative safe integer, and List/Text visible counts must match their payloads. Snapshot acquisition and subsequent commit delivery must have a gap-free handoff supplied by the application.

**Text snapshot boundaries:** `surrogateBoundaries?: readonly number[]` preserves adjacent surrogate halves that belong to separate Text elements. Its offsets are UTF-16 code-unit positions in `value`, not the element indices used by Text operations and notifications. Each offset separates a high surrogate immediately before it from a low surrogate at it. The array must be non-empty, dense and strictly increasing, with safe-integer offsets in `1..value.length - 1`. Empty arrays, explicit `undefined`, duplicates and invalid boundaries are rejected. Without this field, normal code-point segmentation applies; with it, marked pairs remain separate. The resulting element count must equal the present-ID count. Saved arrays are owned/frozen, and the field is omitted when unnecessary. Older runtimes reject snapshots containing the field; see [recovery compatibility](recovery.md#text-snapshot-boundaries).

`doc.checkpoint()` is `{ clientId, snapshot, lastLocalSeq, pendingBatches, lastBunchSeqs }`: authoritative state, original pending work and allocation progress, not a separate optimistic snapshot. `createClient(schema, { clientId, checkpoint, onBatch })` validates restore data and matching identity, reconstructs optimistic state/conflict, and emits neither changes nor outgoing batches. `snapshot` and `checkpoint` options are mutually exclusive.

`server.checkpoint()` is `{ snapshot, lastClientNumber, clients, history }`. Each open client entry is `{ clientId, replay }`: `replay` is `null` until its first successful batch, then `{ batch, commit }`. The counter is a non-negative safe integer; entries must be unique canonical issued IDs no greater than that counter. Closed sessions are absent. Restore preserves authoritative state, allocation progress, open sessions, retries and history; callbacks, history capacity and `maxClients` are not serialized. A limit below the restored open-session count fails without truncation. Old 0.1 checkpoints fail validation.

History must be a consecutive suffix ending at the snapshot watermark. Its sources may be closed but must be issued IDs; each source sequence is consecutive. For an open source, its latest retained commit must match its replay, and a null replay cannot have history. Retained metadata supplies necessary batch-count lower bounds, not equality with all global commits: closed writers may have no metadata. Restore does not reapply history operations.

`historyLimit` defaults to 1000, is a non-negative safe integer and counts commits, not bytes. Zero disables history. Accept/reject/transform enter history; retry and failed processing do not. `commitsSince(watermark)` returns a frozen complete ascending suffix, `[]` if current, or `null` if a gap cannot be filled. Invalid/future watermarks throw. Capacity cannot recover evicted commits, and history eviction does not remove last-batch retry entries.

Use one active writer per client ID, the same schema/document lineage, and retired old writers before restoring. Restore preserves sequence/ID progress, including rejected or rolled-back allocations. Do not fork checkpoints, resume stale work that omits already-sent batches, or replace pending work with a fresh snapshot. There is no schema ID, migration, writer lock, automatic resend, history-gap recovery or core lineage guard.

If persisting, save server checkpoints before delivering new commits and client pending before sending. Saving and transport orchestration are application responsibilities; failed persistence must not continue using an advanced in-memory server. Nested payloads in ordinary snapshots/checkpoints retain the immutable-value contract; point-in-time containers do not protect against violating that contract by mutating shared JSON.

### Wire validation and error boundaries

Pass parsed `unknown` through the corresponding `decode*(schema, input)` before typed runtime use. Decoders do not parse raw strings or encode messages; existing wire objects support `JSON.stringify()`.

Decoders strictly reject missing/extra fields, invalid containers/sequences/IDs/ranges, non-JSON values, mismatched schema kinds and inconsistent snapshot/checkpoint metadata. They deeply copy and freeze JSON payloads and wire containers. JSON validation is not a runtime validator for TypeScript's business type `T`; application-specific validation belongs to the caller, often in server policy.

Current-state questions such as unknown anchors, duplicate insertion IDs or already-consumed sequences belong to runtime application, not standalone wire decoding. Checkpoint decoders additionally validate restore metadata and rebuild collection state; structurally valid state-conflicting pending work is preserved as a replay conflict, not silently removed.

Runtime errors have readable messages, not a stable error-code hierarchy. `WireDecodeError` promises its `name`, JSON Pointer `path` and readable `message`, not exact message wording. A thrown callback does not prove a mutation/receive failed atomically. Transport must handle parsing, quotas, delivery order, ambiguous outcomes and recovery without assuming throw means nothing happened.

## Boundaries

The server uses explicit writer sessions. Examples demonstrate application orchestration and are not exported or shipped as production adapters. In particular, browser `documentId` envelopes/headers are example-only lineage markers, not core wire fields or authentication.

There is no production transport or storage adapter, background sync, automatic retry/reconnect, snapshot fallback, schema migration, auth, presence, writer coordination, undo, rich text, bulk List editing, move, public stable positions or cursor API. Same-ID server rollback/forks, power-loss durability and cross-file transactions are not promised. These omissions do not imply a schedule for adding them.

[Previous: Recovery](recovery.md) · [Next: FAQ and limitations](faq.md)
