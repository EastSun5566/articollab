# Upgrading

Every release can restore valid snapshots and checkpoints from the release before it, as long as the schema and document lineage stay the same. Pending batches keep their operations and sequence numbers.

New operation types are different: a runtime that does not know an operation rejects it everywhere it appears, including pending work, retry records and history. So the order is always the same:

1. Stop the old writers and back up matching client and server checkpoints.
2. Upgrade the server, every client and every other reader of snapshots or checkpoints, including offline clients that will restore later.
3. Restore writers with their original session IDs and catch up.
4. Only then start using the new feature.

Keep the original checkpoints until you no longer need to roll back. Once saved data contains a new operation, rolling back means restoring those backups, not just installing the old package.

## Upgrading from 0.10 to 0.11

0.11 adds [Text marks](collections.md#format-text). A 0.10 reader rejects `text/mark`, and it rejects Text snapshots that have a `marks` field, so finish the steps above before calling `format()`.

Adding `marks` to an existing `text()` changes the schema but not the saved data: snapshots and pending batches from 0.10 restore unchanged. Removing a mark key that saved data uses makes that data fail to decode.

## Upgrading from 0.9 to 0.10

0.10 adds [Counters](collections.md#counter-additions-that-all-count). A 0.9 reader rejects `counter/add`, `counterMap/add` and `counterMap/delete`, so finish the steps above before adding a `counter()` or `counterMap()` path.

Adding a Counter path changes the schema. If you replace a `value()` that held a count with `counter()`, its whole-number snapshot decodes as a Counter, but pending `value/set` operations for that path do not: send or cancel them first.

0.10 also renames some APIs so that they follow one style:

| 0.9 | 0.10 |
| --- | --- |
| `createServer(schema, { historyLimit })` | `createServer(schema, { maxHistory })` |
| `createSyncHandler(schema, server, { bodyLimit })` | `createSyncHandler(schema, server, { maxBodySize })` |
| `SyncHttpError` | `SyncRequestError`, with the same `status` and `retryable` |
| `sync.stop()` and status `"stopped"` | `sync.close()` and status `"closed"` |

Errors now follow one rule. A non-number option, index or count throws `TypeError`. A number that is out of range or not an integer throws `RangeError`. Before, some threw `TypeError` and others a plain `Error`.

## Upgrading from 0.8 to 0.9

0.9 adds [List moves](collections.md#move-an-element). A 0.8 reader rejects `list/move`, and it rejects the `moves` field in snapshots that contain moved elements. Finish the steps above before calling `List.move()`.

If you keep a List view in sync with `observe()`, handle the new `move` change and apply changes in the order given. See the [List view example](transactions.md#update-a-list-view-incrementally).

Do not try to make moved data readable by an older runtime by removing the `moves` field or turning a move into a delete and an insert: that loses positions or element identity.

0.9 also adds the [`transform` event](reference.md#mutations-transactions-and-events). It is a local notification and adds no fields to batches or commits.

Guides for older releases are in the [repository history](https://github.com/EastSun5566/articollab/blob/v0.9.0/docs/recovery.md).

[Previous: Core reference](reference.md) · [Next: FAQ](faq.md)
