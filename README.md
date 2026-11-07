# Articollab

Typed, server-authoritative collaborative collections for TypeScript, powered by [articulated](https://github.com/mweidner037/articulated).

Clients edit optimistically; the server orders commits and clients replay unacknowledged work. **Not a CRDT.** Includes Value, List and Unicode Text, transactions, server policy, wire decoding, checkpoints and catch-up. An optional polling HTTP [sync adapter](docs/sync.md) handles submission, catch-up and retries; your application supplies storage and authentication.

## Install

Install from [npm](https://www.npmjs.com/package/articollab). Use an ESM project (`"type": "module"`); the Node.js examples require Node 24+.

```sh
pnpm add articollab
```

## Quick start

A single client and server, connected in memory:

```ts
import { createClient, createServer, defineDocument, value } from "articollab";

const Counter = defineDocument({ count: value(0) });
const server = createServer(Counter);
const doc = createClient(Counter, {
  clientId: server.openClient(),
  onBatch(batch) {
    doc.receive(server.receive(batch).commit);
  },
});

doc.state.count.value = 1;
console.log(doc.state.count.value); // 1
```

The server opens a writer session before its first batch. Disconnecting preserves that session; `server.closeClient(id)` permanently retires it. This example submits and acknowledges each batch synchronously. For multiple clients, deliver commits to every client in server order; see the walkthroughs below.

## Documentation

- [Counter walkthrough](docs/quick-start.md)
- [API, core contracts and compatibility](docs/reference.md)
- [Recovery](docs/recovery.md)
- [Sync adapter](docs/sync.md)
- [Contributing](CONTRIBUTING.md)

## License

MIT.
