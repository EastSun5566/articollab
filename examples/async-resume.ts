import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

import {
  createClient,
  createServer,
  decodeClientBatch,
  decodeClientCheckpoint,
  decodeServerCommit,
  decodeSnapshot,
  type ClientBatch,
  type ClientCheckpoint,
  type ClientDocument,
  type DocumentOperation,
  type ServerCheckpoint,
  type ServerDocument,
} from "../src/index.ts";
import { Board } from "./resume.ts";

type Shape = typeof Board.definition;
type Batch = ClientBatch<DocumentOperation<Shape>>;
type Checkpoint = ClientCheckpoint<Shape>;
type Transfer = (
  direction: "client-to-server" | "server-to-client",
  clientId: string,
  message: string
) => Promise<string>;
type Connection = {
  readonly doc: ClientDocument<Shape>;
  mode: "offline" | "joining" | "recovering" | "live";
  inbox: Promise<void>;
  pumping: boolean;
};

/** Example-only ordered JSON delivery, with independently progressing clients. */
export function createAsyncExampleNetwork(
  server: ServerDocument<Shape>,
  options: {
    readonly transfer?: Transfer;
    readonly saveClientCheckpoint?: (checkpoint: Checkpoint) => undefined;
    readonly saveServerCheckpoint?: (checkpoint: ServerCheckpoint<Shape>) => undefined;
  } = {}
) {
  const transfer: Transfer = options.transfer ?? (async (_direction, _clientId, message) => message);
  const connections = new Map<string, Connection>();
  let serverTail = Promise.resolve();
  let active = 0;
  let failed = false;
  let failure: unknown;
  const cancellations = new Set<(error: unknown) => void>();
  const idleWaiters: Array<{ resolve(): void; reject(error: unknown): void }> = [];

  function requireUsable(): void {
    if (failed) throw failure;
  }

  function requireIdle(): void {
    requireUsable();
    if (active !== 0) throw new Error("Example network must be idle");
  }

  function stop(error: unknown): void {
    if (failed) return;
    failed = true;
    failure = error;
    for (const cancel of cancellations) cancel(error);
    cancellations.clear();
    for (const waiter of idleWaiters.splice(0)) waiter.reject(error);
  }

  // Saving can run outside a tracked job (connect and synchronous onBatch).
  function saveClient(connection: Connection): void {
    requireUsable();
    try {
      options.saveClientCheckpoint?.(connection.doc.checkpoint());
    } catch (error) {
      stop(error);
      throw error;
    }
  }

  // Track nested work too: idle must not miss jobs created by listeners or pumps.
  function track<T>(work: () => T | Promise<T>): Promise<T> {
    requireUsable();
    active++;
    let cancel!: (error: unknown) => void;
    const interrupted = new Promise<never>((_resolve, reject) => { cancel = reject; });
    cancellations.add(cancel);
    function done(): void {
      cancellations.delete(cancel);
      finish();
    }
    const task = Promise.race([
      Promise.resolve().then(() => { requireUsable(); return work(); }),
      interrupted,
    ]).then(
      (result) => { done(); return result; },
      (error: unknown) => { stop(error); done(); throw error; }
    );
    // Automatic jobs have an observer; public callers still receive the rejection.
    void task.catch(() => {});
    return task;
  }

  function finish(): void {
    active--;
    if (active === 0 && !failed) {
      for (const waiter of idleWaiters.splice(0)) waiter.resolve();
    }
  }

  function serverJob<T>(work: () => T): Promise<T> {
    const previous = serverTail;
    const task = track(async () => {
      await previous;
      requireUsable();
      return work(); // Callers return delivery promises inside objects, never await them here.
    });
    serverTail = task.then(() => {}, () => {});
    return task;
  }

  function incoming(connection: Connection, work: () => Promise<void>): Promise<void> {
    const previous = connection.inbox;
    const task = track(async () => {
      await previous;
      requireUsable();
      await work();
    });
    connection.inbox = task;
    return task;
  }

  function subscribed(connection: Connection): boolean {
    return connection.mode === "live" || connection.mode === "recovering";
  }

  async function deliver(connection: Connection, message: string): Promise<void> {
    if (!subscribed(connection)) return;
    const clientId = connection.doc.checkpoint().clientId;
    const received = await transfer("server-to-client", clientId, message);
    requireUsable();
    if (!subscribed(connection) || connections.get(clientId) !== connection) return;
    const commit = decodeServerCommit(Board, JSON.parse(received));
    if (commit.serverSeq <= connection.doc.checkpoint().snapshot.serverSeq) return;
    connection.doc.receive(commit);
    saveClient(connection); // Own acknowledgements need not emit a change.
    startPump(connection);
  }

  function canSend(connection: Connection, batch: Batch): boolean {
    return connections.get(batch.clientId) === connection &&
      connection.doc.replayConflict === null &&
      connection.doc.checkpoint().pendingBatches[0]?.seq === batch.seq;
  }

  function send(batch: Batch, automatic?: Connection): Promise<{
    sourceDelivery: Promise<void>; submitted: boolean;
  }> {
    const message = JSON.stringify(batch); // Capture before the asynchronous boundary.
    const clientId = batch.clientId;
    return track(async () => {
      if (automatic !== undefined && !canSend(automatic, batch)) {
        return { sourceDelivery: Promise.resolve(), submitted: false };
      }
      const received = await transfer("client-to-server", clientId, message);
      requireUsable();
      const decoded = decodeClientBatch(Board, JSON.parse(received));
      return serverJob(() => {
        if (automatic !== undefined && !canSend(automatic, batch)) {
          return { sourceDelivery: Promise.resolve(), submitted: false };
        }
        const { commit, replayed } = server.receive(decoded);
        if (!replayed) {
          try {
            options.saveServerCheckpoint?.(server.checkpoint());
          } catch (error) {
            stop(error);
            throw error;
          }
        }
        const wire = JSON.stringify(commit);
        const source = connections.get(decoded.clientId);
        const recipients = replayed
          ? (source === undefined ? [] : [source])
          : [...connections.values()];
        let sourceDelivery = Promise.resolve();
        for (const connection of recipients) {
          if (!subscribed(connection)) continue;
          const delivery = incoming(connection, () => deliver(connection, wire));
          if (connection === source) sourceDelivery = delivery;
        }
        return { sourceDelivery, submitted: true };
      });
    });
  }

  async function sendAndReceive(connection: Connection, batch: Batch): Promise<void> {
    const { sourceDelivery, submitted } = await send(batch, connection);
    if (!submitted) return; // A queued send became blocked or was already acknowledged.
    await sourceDelivery;
    requireUsable();
    if (subscribed(connection) && connection.doc.checkpoint().pendingBatches[0]?.seq === batch.seq) {
      throw new Error("Submission completed without acknowledging the pending batch");
    }
  }

  function startPump(connection: Connection): void {
    if (connection.mode !== "live" || connection.pumping || connection.doc.replayConflict !== null) return;
    if (connection.doc.checkpoint().pendingBatches.length === 0) return;
    connection.pumping = true;
    void track(async () => {
      try {
        while (connection.mode === "live" && connection.doc.replayConflict === null) {
          const batch = connection.doc.checkpoint().pendingBatches[0];
          if (batch === undefined) break;
          await sendAndReceive(connection, batch);
        }
      } finally {
        connection.pumping = false;
      }
    });
  }

  function connect(clientId: string, checkpoint?: Checkpoint) {
    requireIdle();
    const previous = connections.get(clientId);
    if (previous !== undefined && previous.mode !== "offline") {
      throw new Error("Disconnect the previous writer before replacing it");
    }
    let connection: Connection;
    const doc = createClient(Board, {
      clientId,
      ...(checkpoint === undefined
        ? { snapshot: decodeSnapshot(Board, JSON.parse(JSON.stringify(server.snapshot()))) }
        : { checkpoint: decodeClientCheckpoint(Board, JSON.parse(JSON.stringify(checkpoint))) }),
      onBatch() {
        requireUsable();
        if (connections.get(clientId) !== connection) {
          throw new Error("This connection was replaced; stop the old writer");
        }
        saveClient(connection);
        startPump(connection);
      },
    });
    connection = { doc, mode: checkpoint === undefined ? "live" : "offline",
      inbox: Promise.resolve(), pumping: false };
    saveClient(connection);
    connections.set(clientId, connection);

    return {
      doc,
      disconnect(): void {
        if (connection.mode === "joining" || connection.mode === "recovering") {
          throw new Error("Cannot disconnect during resume");
        }
        connection.mode = "offline";
      },
      async resume(): Promise<boolean> {
        requireIdle();
        if (connections.get(clientId) !== connection) {
          throw new Error("Cannot resume a replaced connection");
        }
        if (connection.mode === "live") return doc.replayConflict === null;
        connection.mode = "joining";
        return track(async () => {
          try {
            const joined = await serverJob(() => {
              const missed = server.commitsSince(doc.checkpoint().snapshot.serverSeq);
              if (missed === null) return null;
              const messages = missed.map((commit) => JSON.stringify(commit));
              const delivery = incoming(connection, async () => {
                for (const message of messages) await deliver(connection, message);
              });
              // The entire prefix is queued before later broadcasts can include this client.
              connection.mode = "recovering";
              return { delivery };
            });
            if (joined === null) {
              connection.mode = "offline";
              return false;
            }
            await joined.delivery;
            while (true) {
              const inbox = connection.inbox;
              await inbox;
              requireUsable();
              if (inbox !== connection.inbox) continue; // Drain all queued incoming work first.
              if (doc.replayConflict !== null) {
                connection.mode = "offline";
                return false;
              }
              const batch = doc.checkpoint().pendingBatches[0];
              if (batch !== undefined) {
                await sendAndReceive(connection, batch);
              } else if (inbox === connection.inbox) {
                connection.mode = "live"; // No await between the empty checks and handoff.
                return true;
              }
            }
          } catch (error) {
            connection.mode = "offline";
            throw error;
          }
        });
      },
    };
  }

  async function submit(batch: Batch): Promise<void> {
    await send(batch);
  }

  async function idle(): Promise<void> {
    requireUsable();
    if (active === 0) return;
    await new Promise<void>((resolve, reject) => { idleWaiters.push({ resolve, reject }); });
  }

  return { connect, submit, idle };
}

async function runDemo(): Promise<void> {
  const server = createServer(Board);
  const network = createAsyncExampleNetwork(server);
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
    original.doc.state.body.insert(4, "!");
  });
  await network.submit(original.doc.checkpoint().pendingBatches[0]!);
  peer.doc.state.count.value = 7;
  await network.idle();
  const checkpoint = decodeClientCheckpoint(
    Board, JSON.parse(JSON.stringify(original.doc.checkpoint()))
  );
  const restored = network.connect(checkpoint.clientId, checkpoint);
  assert.equal(await restored.resume(), true);
  restored.doc.state.items.push("Live");
  await network.idle();
  assert.deepEqual(restored.doc.checkpoint().pendingBatches, []);
  assert.deepEqual(restored.doc.checkpoint().snapshot, server.snapshot());
  assert.deepEqual(peer.doc.checkpoint().snapshot, server.snapshot());
  console.log({ count: restored.doc.state.count.value, items: restored.doc.state.items.toArray(),
    body: restored.doc.state.body.toString(), serverSeq: server.snapshot().serverSeq });
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runDemo();
}
