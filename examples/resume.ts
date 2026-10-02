import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

import {
  createClient,
  createServer,
  decodeClientCheckpoint,
  defineDocument,
  list,
  text,
  value,
  type ClientBatch,
  type ClientCheckpoint,
  type ClientDocument,
  type DocumentOperation,
  type ServerCommit,
  type ServerDocument,
} from "../src/index.ts";

export const Board = defineDocument({
  count: value(0),
  items: list<string>(),
  body: text(),
});

type Shape = typeof Board.definition;
type Batch = ClientBatch<DocumentOperation<Shape>>;
type Checkpoint = ClientCheckpoint<Shape>;
type Connection = {
  readonly doc: ClientDocument<Shape>;
  mode: "offline" | "recovering" | "live";
  pumping: boolean;
};

/** Example-only synchronous routing; not a production transport. */
export function createExampleNetwork(server: ServerDocument<Shape>) {
  const connections = new Map<string, Connection>();
  const jobs: Array<() => void> = [];
  let draining = false;
  let failed = false;

  function requireUsable(): void {
    if (failed) throw new Error("Example network stopped after a delivery failure");
  }

  function enqueue(job: () => void): void {
    requireUsable();
    jobs.push(job);
    if (draining) return;

    draining = true;
    try {
      while (jobs.length > 0) jobs.shift()!();
    } catch (error) {
      failed = true;
      jobs.length = 0; // The documents still own their unacknowledged batches.
      throw error;
    } finally {
      draining = false;
    }
  }

  function deliver(
    connection: Connection,
    commit: ServerCommit<DocumentOperation<Shape>>
  ): void {
    if (connection.mode === "offline") return;
    if (commit.serverSeq <= connection.doc.checkpoint().snapshot.serverSeq) return;
    connection.doc.receive(commit); // Future gaps still throw.
    startPump(connection);
  }

  function applyBatch(batch: Batch): void {
    const { commit, replayed } = server.receive(batch);
    const source = connections.get(batch.clientId);
    const recipients = replayed
      ? (source === undefined ? [] : [source])
      : [...connections.values()];
    for (const connection of recipients) deliver(connection, commit);
  }

  function submit(batch: Batch): void {
    enqueue(() => applyBatch(batch));
  }

  function startPump(connection: Connection): void {
    if (connection.mode !== "live" || connection.pumping || connection.doc.replayConflict !== null) return;
    if (connection.doc.checkpoint().pendingBatches.length === 0) return;
    connection.pumping = true;
    enqueue(() => {
      // Re-read after earlier broadcasts; never submit a captured stale batch.
      if (connection.mode === "live" && connection.doc.replayConflict === null) {
        const pending = connection.doc.checkpoint().pendingBatches[0];
        if (pending !== undefined) applyBatch(pending);
      }
      connection.pumping = false;
      startPump(connection);
    });
  }

  function connect(clientId: string, checkpoint?: Checkpoint) {
    requireUsable();
    const previous = connections.get(clientId);
    if (previous !== undefined && previous.mode !== "offline") {
      throw new Error("Disconnect the previous writer before replacing it");
    }

    let connection: Connection;
    const doc = createClient(Board, {
      clientId,
      ...(checkpoint === undefined ? { snapshot: server.snapshot() } : { checkpoint }),
      onBatch() {
        requireUsable();
        if (connections.get(clientId) !== connection) {
          throw new Error("This connection was replaced; stop the old writer");
        }
        // Offline/recovering mutations are already buffered in the document.
        startPump(connection);
      },
    });
    connection = { doc, mode: checkpoint === undefined ? "live" : "offline", pumping: false };
    connections.set(clientId, connection);

    return {
      doc,
      disconnect(): void {
        if (connection.mode === "recovering") {
          throw new Error("Cannot disconnect during resume");
        }
        connection.mode = "offline";
      },
      resume(): boolean {
        requireUsable();
        if (draining) throw new Error("Cannot resume while the queue is draining");
        if (connections.get(clientId) !== connection) {
          throw new Error("Cannot resume a replaced connection");
        }
        if (connection.mode === "live") return doc.replayConflict === null;

        const missed = server.commitsSince(doc.checkpoint().snapshot.serverSeq);
        if (missed === null) return false;

        connection.mode = "recovering"; // Incoming enabled, outgoing still buffered.
        try {
          enqueue(() => {
            for (const commit of missed) deliver(connection, commit);
          });
          while (true) {
            if (doc.replayConflict !== null) {
              connection.mode = "offline";
              return false;
            }
            const pending = doc.checkpoint().pendingBatches[0];
            if (pending === undefined) break;
            submit(pending); // Complete delivery before selecting the next pending batch.
          }
          connection.mode = "live";
          return true;
        } catch (error) {
          connection.mode = "offline";
          throw error;
        }
      },
    };
  }

  return { connect, submit };
}

function runDemo(): void {
  const server = createServer(Board);
  const network = createExampleNetwork(server);
  const original = network.connect("client-a");
  const peer = network.connect("client-b");

  original.disconnect();
  original.doc.transact(() => {
    original.doc.state.count.value = 1;
    original.doc.state.items.push("Saved");
    original.doc.state.body.insert(0, "Hi 😀");
  });
  original.doc.transact(() => {
    original.doc.state.count.value = 2;
    original.doc.state.items.push("Unsent");
    original.doc.state.body.insert(original.doc.state.body.length, "!");
  });

  // The first batch arrives, but its disconnected sender misses the acknowledgement.
  network.submit(original.doc.checkpoint().pendingBatches[0]!);
  peer.doc.state.count.value = 7;
  const checkpoint = decodeClientCheckpoint(
    Board,
    JSON.parse(JSON.stringify(original.doc.checkpoint()))
  );
  // Stop using the old writer before restoring the same client ID.
  const restored = network.connect(checkpoint.clientId, checkpoint);
  assert.equal(restored.resume(), true);
  restored.doc.state.items.push("Live");

  assert.deepEqual(restored.doc.checkpoint().pendingBatches, []);
  assert.deepEqual(restored.doc.checkpoint().snapshot, server.snapshot());
  assert.deepEqual(peer.doc.checkpoint().snapshot, server.snapshot());
  console.log({
    count: restored.doc.state.count.value,
    items: restored.doc.state.items.toArray(),
    body: restored.doc.state.body.toString(),
    serverSeq: restored.doc.checkpoint().snapshot.serverSeq,
  });
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  runDemo();
}
