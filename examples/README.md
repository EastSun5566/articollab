# Articollab examples

Seven runnable examples, from smallest to largest. They need a checkout of this repository: run these once from its root with Node 26 (`.nvmrc`), then start any example below.

```sh
pnpm install --frozen-lockfile
pnpm build
```

New to Articollab? Read the [quick start](../docs/quick-start.md) first. The examples are demos, not production code: none has authentication, and apart from the server store example, the servers keep documents in memory.

| Example | Shows |
| --- | --- |
| [Sync adapter](#sync-adapter) | `articollab/sync` in about 80 lines of Node: two writers, a lost response, push |
| [Server store](#server-store) | A server that saves each change to files and restarts without losing a writer's edits |
| [React todo list](#react-todo-list) | The [React hooks](../docs/react.md): collections, a derived count, sync status, presence and undo |
| [Kanban board](#kanban-board) | List moves, Maps, Counters, undo, IndexedDB checkpoints and several tabs |
| [Text editor](#text-editor) | Text in CodeMirror: marks, headings and lists as decorations, cursors and presence over WebSocket, input methods |
| [Rich text editor](#rich-text-editor) | Text marks and paragraph attributes in ProseMirror: headings, lists, quotes, code |
| [Folder tree](#folder-tree) | A server policy that keeps concurrent moves from making cycles |

## Sync adapter

```sh
node examples/sync-adapter.ts
```

Two writers connect to `createSyncHandler` over HTTP. Writer A's first response is lost; its next pass finds the acknowledgement and sends nothing twice. Then A receives B's edit over the push channel. It prints the three items and the server sequence. See the [sync adapter guide](../docs/sync.md).

## Server store

Requires Articollab 0.11 or later. The workspace uses the local build.

```sh
node examples/server-store.ts [directory]
```

A server saves each change in a directory through a [server store](../docs/sync.md#persist-the-server), and compacts every three changes. A writer adds two items; the server closes its store and opens again from the directory; the writer adds a third without registering again. It prints the items, the server sequence and the files left: the latest checkpoint and the changes after it.

## React todo list

Requires Articollab 0.11 or later. The workspace uses the local build.

```sh
pnpm --dir examples/react-todo start
```

Two writers share a todo list, each a React tree over its own sync client. The page loads React from esm.sh, so it needs internet access; there is no bundler. Try:

- Add, tick and rename items in one writer: the other follows, and its count of items left updates.
- Focus an item in one writer: the other shows who is editing it, through [presence](../docs/sync.md#share-presence).
- Turn one writer **Offline**, press 👍 in both and rename an item there, then go back online. Every like counts.
- Press **Undo**: each button press is its own step, and only your own edits come back.

[`app.js`](react-todo/app.js) holds the components and [`page.js`](react-todo/page.js) creates the sync clients outside React, so StrictMode or a re-render never opens a second writer session.

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
pnpm --dir examples/text-editor start
```

Two CodeMirror editors share one Text, each writer over one [WebSocket](../docs/sync.md#use-websocket). Try:

- Type in both at once, including emoji and Chinese: edits converge without a Sync button.
- Select text in one editor: the other shows its caret or range, shared through [presence](../docs/sync.md#share-presence). Turn that writer **Offline** and its caret goes at once.
- Turn one writer **Offline**, keep typing, then go back online.
- Make a word bold or a line a heading in one editor while the other types in it. Formatting is drawn with CodeMirror decorations.
- Type with an input method such as Zhuyin while the other writer types: only the confirmed text is sent, as its own undo step.

[`binding.js`](text-editor/binding.js) maps CodeMirror's UTF-16 offsets to Text elements and back; [`presence.js`](shared/presence.js) validates shared cursors.

## Rich text editor

```sh
pnpm --dir examples/rich-editor start
```

Two ProseMirror editors share one Text. Bold, italic, code and links are [marks](../docs/collections.md#format-text); headings, lists, quotes and code blocks are [paragraph attributes](../docs/collections.md#format-paragraphs). Try:

- Make a list, press <kbd>Tab</kbd> to nest an item and <kbd>Enter</kbd> to add one, while the other writer types in it.
- Turn one writer **Offline**, quote a paragraph there and edit it in the other writer, then go back online.
- Add a link to `javascript:alert(1)`: the server drops it, and the writer sees it go.
- Type with an input method such as Zhuyin while the other writer types: candidates stay in your editor, and only the confirmed text is sent, as its own undo step. <kbd>Esc</kbd> cancels without sending anything.

[`flat.js`](rich-editor/flat.js) turns the Text's lines into a ProseMirror document of one standard shape and back. [`binding.js`](rich-editor/binding.js) compares each local transaction with the Text and writes the difference; edits from elsewhere rebuild the document and replace the part that differs. Both read the whole document, so a keystroke costs about 20 ms at 5,000 characters and grows with its size. During a composition, edits from elsewhere wait, so the input method's text is left alone; the confirmed text is then written into the Text as it is by then.

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
