# Articollab

Build collaborative state in TypeScript. Clients show local edits immediately, then reconcile with commits in the order the server assigns.

## When to use it

Use Articollab when the server needs to accept, transform or reject edits. For example, a shared task board can show a move immediately while the server decides whether to keep it.

Choose [collections](collections.md) for whole JSON values, ordered items, plain text or keyed values. Each client uses the same document schema.

## Connect your application

Use the [HTTP sync adapter](sync.md) to deliver commits and resume after a disconnect, or provide your own transport.

Your application authenticates writers, stores server checkpoints and binds each writer to the right document. For saved documents, read the [upgrade guide](recovery.md#upgrading-from-08-to-09) before using List moves.

[Next: Counter quick start](quick-start.md)
