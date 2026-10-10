# FAQ and limitations

Use this page to decide whether the collaboration core fits your application.

## Is this a CRDT?

No. The server orders every new authoritative batch. Clients edit optimistically, then reconcile and replay pending operations. Stable IDs and tombstones do not remove the need for server order.

## Do I need a repository checkout?

No. Install `articollab@beta` from npm and follow the [Counter quick start](quick-start.md). Contributor tools and repository demos require a checkout; they are not part of the installed package.

## Why do nested object edits not synchronize?

Value/List payloads are immutable JSON. Accessors intercept whole replacements, not arbitrary nested writes. Replace `{ done: false }` with `{ done: true }`; do not mutate the shared object in place. See [Value](collections.md#value-replace-the-whole-payload).

## Does a change event mean my edit was saved?

No. Local changes can precede submission, and an acknowledgement can be silent. Read the current checkpoint after a successful receive rather than treating a change event as a save signal. Storage remains your application's responsibility.

## Can I retry every lost message?

The server retains only each open client's latest processed batch. An identical retry returns that result; older or changed retries fail. [Catch up first](recovery.md#catch-up-before-resubmitting), because the missing result may already be in history.

## What if history is too short?

`commitsSince()` returns `null`, not a partial suffix. Preserve the client checkpoint and choose an application recovery policy. The core has no automatic snapshot fallback, rebase or ID remapping.

## Does cancelling pending undo accepted work?

No. Rejection acknowledges an unprocessed batch without an authoritative effect. Accepted or transformed effects remain. Later dependent batches may still be blocked. See [cancelling pending](recovery.md#cancel-a-range-of-pending-work).

## Does the namespace check authenticate a writer?

No. It prevents a batch from allocating insertion IDs under another writer/path namespace. Your application must still authenticate the caller, enforce one writer per client ID, and decide who can delete elements. See [incoming namespaces](server-wire.md#incoming-insertion-namespaces).

## What must a production application add?

Transport, quotas, storage barriers, authentication/authorization, writer coordination, document lineage checks, and recovery after ambiguous outcomes or history gaps.

The package has no rich text, presence, undo, cursor, bulk List editing, move, automatic migration or background reconnect. Same-ID server rollback/forks and power-loss durability are not promised. See the [complete boundaries](reference.md#boundaries).

[Previous: Core reference](reference.md) · [Back to Overview](README.md)
