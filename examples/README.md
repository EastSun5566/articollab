# Articollab examples

Four runnable examples, from smallest to largest. They need a checkout of this repository: run these once from its root with Node 26 (`.nvmrc`), then start any example below.

```sh
pnpm install --frozen-lockfile
pnpm build
```

New to Articollab? Read the [quick start](../docs/quick-start.md) first. The examples are demos, not production code: none has authentication, and the servers keep documents in memory.

| Example | Shows |
| --- | --- |
| [Sync adapter](#sync-adapter) | `articollab/sync` in about 80 lines of Node: two writers, a lost response, push |
| [Kanban board](#kanban-board) | List moves, Maps, Counters, undo, IndexedDB checkpoints and several tabs |
| [Text editor](#text-editor) | Text in CodeMirror, cursors and presence |
| [Folder tree](#folder-tree) | A server policy that keeps concurrent moves from making cycles |

## Sync adapter

```sh
node examples/sync-adapter.ts
```

Two writers connect to `createSyncHandler` over HTTP. Writer A's first response is lost; its next pass finds the acknowledgement and sends nothing twice. Then A receives B's edit over the push channel. It prints the three items and the server sequence. See the [sync adapter guide](../docs/sync.md).

## Kanban board

```sh
pnpm --dir examples/kanban start
```

Two writers share a three-column board. Cards live in one `order` List; `columns` and `titles` are Maps and `votes` is a Counter map. Try:

- Turn one writer **Offline**, move or rename a card, change the same card in the other writer, then go back online. Moves never duplicate a card; an edit to a card someone deleted is dropped and you are told.
- Press 👍 in both writers at once: every vote counts. **Undo** takes back only your own edits.
- Go **Offline**, edit, then reload or open a second tab: unsent edits are kept, and each tab runs its own writers.

The server policy is in [`policy.ts`](kanban/policy.ts) and the board helpers in [`board.js`](kanban/board.js).

## Text editor

```sh
pnpm --dir examples/text-editor install --frozen-lockfile
pnpm --dir examples/text-editor start
```

Two CodeMirror editors share one Text. Try:

- Type in both at once, including emoji and Chinese: edits converge without a Sync button.
- Select text in one editor: the other shows its caret or range, shared through [presence](../docs/sync.md#share-presence).
- Turn one writer **Offline**, keep typing, then go back online.

[`binding.js`](text-editor/binding.js) maps CodeMirror's UTF-16 offsets to Text elements and back; [`presence.js`](text-editor/presence.js) validates shared cursors.

## Folder tree

```sh
pnpm --dir examples/file-tree start
```

Two writers share a folder tree: `parents`, `names` and `kinds` are Maps, and the server's [`policy.ts`](file-tree/policy.ts) keeps the tree valid. Try:

- Turn one writer **Offline**, move `docs` into `src` there and `src` into `docs` in the other, then go back online. A tree cannot hold both moves; the server keeps the first and tells the other writer.
- Create `notes.md` in the same folder in both writers at once: the server names one `notes (2).md`.
- Delete a folder, then **Undo**: it comes back with everything in it. A file the other writer moved into a deleted folder is deleted with it.

Movable-tree CRDTs need a dedicated algorithm for concurrent moves; here the server decides, so a few lines of policy are enough.

## Shared helpers

`examples/shared/` holds the small pieces the examples share: a static asset server, a bridge from `node:http` to a Fetch API handler (frameworks such as Hono accept the handler directly), the sync status badge with its offline switch and the IndexedDB writer stores.
