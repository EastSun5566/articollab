# FAQ and limitations

Use this page to decide whether the minimal core fits your application before choosing transport or storage.

## Is this a CRDT?

No. The server orders every new authoritative batch. Clients edit optimistically, then reconcile and replay pending work. List/Text stable IDs and tombstones do not remove the need for server total order.

## Can I install it from npm?

Not yet. `articollab@0.1.0` remains private and unpublished. With repository access, use a built checkout or local tarball. Documentation availability is not package publication or source access.

## Why do nested object edits not synchronize?

Value/List payloads are immutable JSON. Accessors intercept whole replacements, not arbitrary nested writes. For example, replace `{ done: false }` with `{ done: true }`; do not mutate the shared object in place.

## Does a change event mean my edit was saved?

No. A local change can precede submission; an own ack can emit no event. Persistence and acknowledgement are separate. Track the successful receive and current checkpoint rather than treating change as a save signal.

## Can I retry every lost message?

The server retains only each client's latest processed batch. An identical retry returns that result, but older or changed retries fail. First catch up from the saved watermark; preserve original pending payloads. Transport examples stop on failure rather than automatically retrying.

## What if history is too short?

`commitsSince()` returns `null`, not a partial suffix. Preserve the client checkpoint and choose an application recovery policy. The core has no automatic snapshot fallback, rebase or ID remapping.

## Does cancelling pending undo accepted work?

No. Rejection acknowledges abandoned unprocessed batches with an empty authoritative effect. Previously accepted or transformed effects remain. Dependent newer batches may still be blocked.

## What must production applications add?

Transport, quotas, storage barriers, authentication/authorization, one-writer coordination, lineage checks, and explicit recovery after ambiguous outcomes or history gaps. The examples are learning tools, not production adapters.

There is no rich text, presence, undo, cursor, bulk List editing, move, automatic migration or background reconnect. Same-ID server rollback/forks and power-loss durability are not promised. See the [canonical boundaries](reference.md#boundaries).

[Previous: Examples guide](examples.md) · [Back to Overview](README.md)
