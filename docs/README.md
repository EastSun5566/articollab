# Articollab

Build collaborative state in TypeScript. Each client shows its own edits at once, and the server decides the final order and result.

## When to use it

Use Articollab when the server must be able to accept, change or reject edits. For example, a task board can show a card move immediately while the server checks whether the move is allowed.

Pick [collections](collections.md) for what you store: a whole JSON value, an ordered list, text with optional formatting, keyed values or counts. Every client uses the same document schema.

## Connect your application

Use the [sync adapter](sync.md) to carry edits and commits over HTTP or a WebSocket, or write your own transport. In React, read them with the [hooks](react.md).

Your application still owns authentication, where the server is saved (a [server store](sync.md#persist-the-server) writes it to files or Postgres) and making sure each writer opens the right document. When you change versions with saved data, read [Upgrading](upgrading.md).

[Next: Quick start](quick-start.md)
