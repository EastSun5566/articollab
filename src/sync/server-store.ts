import {
  createServer,
  type CreateServerOptions,
  type DocumentSchema,
  type SchemaShape,
  type ServerCheckpoint,
  type ServerDocument,
  type ServerLogEntry,
} from "../index.ts";
import { integerOption } from "../options.ts";

/**
 * Where a server's changes are kept: its latest checkpoint and the log entries recorded after it.
 * Implementations store parsed JSON and must keep entries in the order they were appended.
 */
export interface ServerStore {
  /** The saved checkpoint and the entries after it, as parsed JSON, or undefined when nothing is saved. */
  load(): Promise<{ readonly checkpoint: unknown; readonly entries: readonly unknown[] } | undefined>;
  /** Appends entries after those already saved; resolves once they are stored. */
  append(entries: readonly unknown[]): Promise<void>;
  /**
   * Replaces the checkpoint with one that includes every appended entry and drops those entries, in
   * one step: a load never sees the new checkpoint with entries it already includes.
   */
  compact(checkpoint: unknown): Promise<void>;
  /**
   * Releases the lock and any connection once operations already started have finished. Further
   * calls are no-ops; other methods then reject.
   */
  close(): void;
}

export interface PersistServerOptions {
  /** Entries appended before the next flush also writes a checkpoint. Default 1000. */
  readonly compactEvery?: number;
}

/** Saves a server's changes to a store as they happen. */
export interface ServerPersistence {
  /**
   * Appends the changes recorded since the last flush, and compacts the store when due. Resolves
   * once they are stored. After a failure every flush rejects with the first error: the server has
   * changes the store lacks, so open it again from the store.
   */
  flush(): Promise<void>;
  /** Flushes, stops recording and closes the store. */
  close(): Promise<void>;
}

/** A server restored from a store, with the persistence that keeps the store up to date. */
export interface PersistedServer<S extends SchemaShape> extends ServerPersistence {
  readonly server: ServerDocument<S>;
}

export interface OpenServerOptions<S extends SchemaShape>
  extends Omit<CreateServerOptions<S>, "checkpoint" | "log">, PersistServerOptions {}

/**
 * Records `server`'s changes and writes them to `store` on each `flush()`. Every `compactEvery`
 * entries, a flush also replaces the store's checkpoint, so a restore replays few entries. `store`
 * must already hold a checkpoint of this server that its later entries follow; `openServer()`
 * ensures this.
 */
export function persistServer<S extends SchemaShape>(
  server: ServerDocument<S>, store: ServerStore, options: PersistServerOptions = {}
): ServerPersistence {
  return persist(server, store, options, 0);
}

function persist<S extends SchemaShape>(
  server: ServerDocument<S>, store: ServerStore, options: PersistServerOptions, saved: number
): ServerPersistence {
  const compactEvery = integerOption(options.compactEvery ?? 1000, "compactEvery", 1);
  let pending: ServerLogEntry<S>[] = [];
  /** Entries in the store after its checkpoint. */
  let appended = saved;
  let failed = false, closed = false;
  let failure: unknown;
  const stop = server.on("entry", (entry) => { pending.push(entry); });
  let queue: Promise<unknown> = Promise.resolve();

  async function write(): Promise<void> {
    if (failed) throw failure;
    try {
      if (pending.length > 0) {
        const entries = pending;
        pending = [];
        await store.append(entries);
        appended += entries.length;
      }
      // Only while nothing is pending does the checkpoint include exactly the appended entries.
      if (appended >= compactEvery && pending.length === 0) {
        const checkpoint: ServerCheckpoint<S> = server.checkpoint();
        appended = 0;
        await store.compact(checkpoint);
      }
    } catch (error) {
      failed = true;
      failure = error;
      throw error;
    }
  }
  function flush(): Promise<void> {
    if (closed) return Promise.reject(new Error("Server persistence is closed"));
    const result = queue.then(write);
    queue = result.catch(() => {});
    return result;
  }
  return {
    flush,
    async close() {
      if (closed) return;
      const last = flush();
      closed = true;
      stop();
      try { await last; } finally { store.close(); }
    },
  };
}

/**
 * Restores a server from `store`, the latest checkpoint and the entries after it, and keeps the
 * store up to date. An empty store gets the new server's checkpoint first. If restoring fails, the
 * caller still owns the store.
 */
export async function openServer<S extends SchemaShape>(
  schema: DocumentSchema<S>, store: ServerStore, options: OpenServerOptions<S> = {}
): Promise<PersistedServer<S>> {
  const { compactEvery, ...serverOptions } = options;
  // Check the option before anything is written.
  integerOption(compactEvery ?? 1000, "compactEvery", 1);
  const saved = await store.load();
  let server: ServerDocument<S>;
  if (saved === undefined) {
    server = createServer(schema, serverOptions);
    await store.compact(server.checkpoint());
  } else {
    if (!Array.isArray(saved.entries)) throw new TypeError("Store entries must be an array");
    // createServer decodes the checkpoint and every entry before using them.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Decoded by createServer.
    const checkpoint = saved.checkpoint as ServerCheckpoint<S>;
    const log = saved.entries as readonly ServerLogEntry<S>[];
    server = createServer(schema, { ...serverOptions, checkpoint, log });
  }
  const persistence = persist(server, store, { ...(compactEvery === undefined ? {} : { compactEvery }) }, saved?.entries.length ?? 0);
  return { server, flush: () => persistence.flush(), close: () => persistence.close() };
}
