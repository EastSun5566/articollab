import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  createServer,
  decodeClientCheckpoint,
  decodeServerCheckpoint,
  type ClientCheckpoint,
  type ServerCheckpoint,
} from "../src/index.ts";
import { createAsyncExampleNetwork } from "./async-resume.ts";
import { Board } from "./resume.ts";

type Shape = typeof Board.definition;

export interface RecoveryServerCheckpoint {
  readonly documentId: string;
  readonly checkpoint: ServerCheckpoint<Shape>;
}

/** Example-only synchronous JSON storage: one writer per file, trusted local directory. */
export function createCheckpointStore(directory: string) {
  const root = resolve(directory);
  if (!statSync(root).isDirectory()) throw new Error("Checkpoint storage must be a directory");

  function clientPath(clientId: string): string {
    return join(root, "client-" + Buffer.from(clientId, "utf16le").toString("hex") + ".json");
  }

  function load(path: string): string | null {
    try {
      return readFileSync(path, "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
      throw error;
    }
  }

  function save(path: string, checkpoint: ClientCheckpoint<Shape> | ServerCheckpoint<Shape> | RecoveryServerCheckpoint): undefined {
    const message = JSON.stringify(checkpoint); // Finish serialization before touching files.
    const temporary = path + ".tmp";
    try {
      // ponytail: synchronous replacement blocks the event loop; async barriers belong in a later slice.
      writeFileSync(temporary, message, { encoding: "utf8", mode: 0o600 });
      renameSync(temporary, path);
    } catch (error) {
      try { unlinkSync(temporary); }
      catch { /* Best-effort cleanup must not replace the original storage error. */ }
      throw error;
    }
  }

  return {
    loadRecoveryServer(): RecoveryServerCheckpoint | null {
      const message = load(join(root, "server.json"));
      if (message === null) return null;
      const input: unknown = JSON.parse(message);
      if (input === null || typeof input !== "object" || Array.isArray(input) ||
        Object.keys(input).sort().join(",") !== "checkpoint,documentId" ||
        !("documentId" in input) || typeof input.documentId !== "string" || input.documentId.length !== 36 ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(input.documentId) ||
        !("checkpoint" in input)) {
        throw new Error("Invalid recovery server envelope; document ID and checkpoint are required");
      }
      return Object.freeze({ documentId: input.documentId, checkpoint: decodeServerCheckpoint(Board, input.checkpoint) });
    },
    saveRecoveryServer(record: RecoveryServerCheckpoint): undefined {
      save(join(root, "server.json"), record);
    },
    loadServer(): ServerCheckpoint<Shape> | null {
      const message = load(join(root, "server.json"));
      return message === null ? null : decodeServerCheckpoint(Board, JSON.parse(message));
    },
    saveServer(checkpoint: ServerCheckpoint<Shape>): undefined {
      save(join(root, "server.json"), checkpoint);
    },
    loadClient(clientId: string): ClientCheckpoint<Shape> | null {
      const message = load(clientPath(clientId));
      if (message === null) return null;
      const checkpoint = decodeClientCheckpoint(Board, JSON.parse(message));
      if (checkpoint.clientId !== clientId) throw new Error("Stored clientId does not match the requested client");
      return checkpoint;
    },
    saveClient(checkpoint: ClientCheckpoint<Shape>): undefined {
      save(clientPath(checkpoint.clientId), checkpoint);
    },
  };
}

async function runDemo(): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "articollab-checkpoints-"));
  try {
    const store = createCheckpointStore(directory);
    function boot() {
      const checkpoint = store.loadServer();
      const server = createServer(Board, {
        ...(checkpoint === null ? {} : { checkpoint }),
        resolve: ({ batch }) => batch.operations, // Application code is not serialized.
      });
      store.saveServer(server.checkpoint()); // Bootstrap before accepting clients or requests.
      const network = createAsyncExampleNetwork(server, {
        saveClientCheckpoint: store.saveClient,
        saveServerCheckpoint: store.saveServer,
      });
      return { server, network };
    }

    const original = boot();
    const source = original.network.connect("client-a");
    const peer = original.network.connect("client-b");
    source.disconnect();
    source.doc.transact(() => {
      source.doc.state.count.value = 1;
      source.doc.state.items.push("Saved");
      source.doc.state.body.insert(0, "Hi 😀");
    });
    source.doc.transact(() => {
      source.doc.state.count.value = 2;
      source.doc.state.items.push("Unsent");
      source.doc.state.body.insert(4, "!");
    });
    // Save the server result without acknowledging the disconnected source.
    await original.network.submit(source.doc.checkpoint().pendingBatches[0]!);
    await original.network.idle();
    peer.disconnect(); // Both old writers are now stopped.

    const restored = boot(); // Load files; do not pass the old objects' checkpoints.
    const restoredPeer = restored.network.connect("client-b", store.loadClient("client-b")!);
    assert.equal(await restoredPeer.resume(), true);
    await restored.network.idle();
    const restoredSource = restored.network.connect("client-a", store.loadClient("client-a")!);
    assert.equal(await restoredSource.resume(), true);
    await restored.network.idle();
    restoredSource.doc.state.items.push("Live");
    await restored.network.idle();

    assert.deepEqual(store.loadServer(), restored.server.checkpoint());
    for (const connection of [restoredSource, restoredPeer]) {
      const checkpoint = connection.doc.checkpoint();
      assert.deepEqual(checkpoint.pendingBatches, []);
      assert.deepEqual(checkpoint.snapshot, restored.server.snapshot());
      assert.deepEqual(store.loadClient(checkpoint.clientId), checkpoint);
    }
    console.log({ count: restoredSource.doc.state.count.value,
      items: restoredSource.doc.state.items.toArray(), body: restoredSource.doc.state.body.toString(),
      serverSeq: restored.server.snapshot().serverSeq });
  } finally {
    rmSync(directory, { recursive: true, force: true }); // Only this demo's own temporary directory.
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runDemo();
}
