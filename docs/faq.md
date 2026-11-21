# FAQ

## Why do nested object edits not synchronize?

Assign a new JSON value, for example `task.value = { done: true }`. To let writers edit fields independently, put each field under its own [Map key](collections.md#map-keyed-values).

## Does a change event mean my edit was saved?

Save the checkpoint after a successful receive. A local change can fire before submission, and an acknowledgement can leave visible state unchanged. The [sync adapter](sync.md#persist-checkpoints) can save client checkpoints for you.

## Can I resend a batch after a lost response?

[Catch up first](recovery.md#catch-up-before-resubmitting). The result may already be in history. An identical retry of the writer's latest processed batch returns the original result. Older or changed retries fail.

## What if history is too short?

`commitsSince()` returns `null`. Preserve any pending work and follow the [history-gap recovery steps](recovery.md#catch-up-before-resubmitting).

## Does cancelling pending undo accepted work?

[Cancelling pending work](recovery.md#cancel-a-range-of-pending-work) confirms unprocessed batches without applying their edits. Accepted or transformed effects remain.

## Does the namespace check authenticate a writer?

Authenticate the caller in your application and bind them to a writer session. The [namespace check](server-wire.md#incoming-insertion-namespaces) validates the ownership of insertion IDs within the batch.

[Previous: Core reference](reference.md) · [Back to Overview](README.md)
