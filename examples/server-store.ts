import assert from "node:assert/strict";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { defineDocument, list } from "articollab";
import { connectSync, createHttpTransport, createSyncHandler, openServer, type SyncHandler } from "articollab/sync";
import { openFileServerStore } from "articollab/sync/node";
import { serveFetch } from "./sync-adapter.ts";

const Board = defineDocument({ items: list<string>() });

/**
 * A server that saves each change in `directory` restarts without losing anything: a writer keeps
 * its session and carries on, and the store compacts every three changes.
 */
export async function runServerStoreDemo(directory: string) {
  let persisted = await openServer(Board, await openFileServerStore(directory), { compactEvery: 3 });
  let handle: SyncHandler = createSyncHandler(Board, persisted.server, { persist: persisted });
  // The address stays the same across the restart; only the handler behind it changes.
  const host = await serveFetch((request) => handle(request));
  const writer = await connectSync(Board, { transport: createHttpTransport({ url: host.url }), pollInterval: 0, push: false });
  try {
    for (const item of ["Plan", "Build"]) {
      writer.doc.state.items.push(item);
      assert.equal(await writer.sync(), true);
    }
    const before = persisted.server.snapshot().serverSeq;

    // Restart: close the store, then open the server again from the same directory.
    await persisted.close();
    persisted = await openServer(Board, await openFileServerStore(directory), { compactEvery: 3 });
    handle = createSyncHandler(Board, persisted.server, { persist: persisted });
    assert.equal(persisted.server.snapshot().serverSeq, before, "nothing was lost");

    writer.doc.state.items.push("Ship");
    assert.equal(await writer.sync(), true);
    return {
      items: persisted.server.snapshot().data.items.values,
      serverSeq: persisted.server.snapshot().serverSeq,
      files: (await readdir(directory)).toSorted(),
    };
  } finally {
    writer.close();
    await host.close();
    await persisted.close();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const directory = process.argv[2] ?? join(await mkdtemp(join(tmpdir(), "articollab-")), "board");
  console.log(directory);
  console.log(await runServerStoreDemo(directory));
}
