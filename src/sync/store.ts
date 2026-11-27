import { integerOption } from "../options.ts";

/**
 * Durable storage for one writer's checkpoint. `connectSync({ store })` loads it once, saves through
 * it and closes it when the client closes. Implementations hold an exclusive lock while open, so
 * two clients can never share one stored writer.
 */
export interface CheckpointStore {
  /** The saved checkpoint as parsed JSON, or undefined when nothing is saved. */
  load(): Promise<unknown>;
  /** Replaces the saved checkpoint; resolves once it is stored. */
  save(checkpoint: unknown): Promise<void>;
  /** Removes the saved checkpoint. */
  clear(): Promise<void>;
  /**
   * Releases the lock and any connection once operations already started have finished. Further
   * calls are no-ops; other methods then reject.
   */
  close(): void;
}

/** Another client in this browser profile or process already holds this store's lock. */
export class CheckpointLockedError extends Error {
  override readonly name = "CheckpointLockedError";
}

/** The part of the Web Locks API the stores use; browsers and Node.js provide `navigator.locks`. */
export interface LockManagerLike {
  request(
    name: string,
    options: { readonly ifAvailable: true },
    callback: (lock: unknown) => Promise<void>
  ): Promise<unknown>;
}

function defaultLocks(): LockManagerLike {
  const locks = (globalThis as { navigator?: { locks?: LockManagerLike } }).navigator?.locks;
  if (locks === undefined) throw new Error("navigator.locks is unavailable; pass `locks`");
  return locks;
}

/** Locks this realm released but the lock manager may not have freed yet, by name. */
const releasing = new Map<string, Promise<unknown>>();

/**
 * Takes an exclusive lock without waiting for another holder. The returned function waits for
 * `after` before releasing the lock and resolves once the lock manager has freed it. A reopen
 * in this realm waits for a pending release, so it cannot overlap the closing store's operations.
 * @internal Shared by the IndexedDB and file stores.
 */
export async function acquireLock(
  name: string, locks: LockManagerLike = defaultLocks()
): Promise<(after?: Promise<unknown>) => Promise<void>> {
  await releasing.get(name);
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  let finished: Promise<unknown> = Promise.resolve();
  const granted = await new Promise<boolean>((resolve, reject) => {
    // The request settles only after the callback returns, that is, once the lock is free again.
    finished = locks.request(name, { ifAvailable: true }, async (lock) => {
      resolve(lock !== null);
      if (lock !== null) await held;
    });
    finished.catch(reject);
  });
  if (!granted) throw new CheckpointLockedError(`Checkpoint store is in use elsewhere: ${name}`);
  return (after = Promise.resolve()) => {
    const released = after.catch(() => {}).then(() => { release(); return finished; }).then(() => {});
    const ready = released.catch(() => {}).finally(() => { if (releasing.get(name) === ready) releasing.delete(name); });
    releasing.set(name, ready);
    return released;
  };
}

/**
 * Shared state for stores that hold a lock until `close()`. Operations started before `close()`
 * finish first; then `onClose` runs, and the lock is released once it settles.
 * @internal
 */
export function closable(
  release: (after: Promise<unknown>) => Promise<void>, onClose: () => void | Promise<void> = () => {}
) {
  let closing: Promise<void> | undefined;
  const running = new Set<Promise<unknown>>();
  return {
    run<T>(operation: () => Promise<T>): Promise<T> {
      if (closing !== undefined) return Promise.reject(new Error("Checkpoint store is closed"));
      const promise = operation();
      running.add(promise);
      const settled = () => { running.delete(promise); };
      promise.then(settled, settled);
      return promise;
    },
    close(): Promise<void> {
      if (closing !== undefined) return closing;
      const cleanup = Promise.allSettled([...running]).then(onClose);
      closing = Promise.allSettled([cleanup, release(cleanup)]).then(([cleaned, unlocked]) => {
        if (cleaned.status === "rejected") throw cleaned.reason;
        if (unlocked.status === "rejected") throw unlocked.reason;
      });
      return closing;
    },
  };
}

// Minimal IndexedDB shapes: this package compiles without the DOM type library.
interface IdbRequest<T> {
  result: T;
  error: unknown;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
}
interface IdbOpenRequest extends IdbRequest<IdbDatabase> {
  onupgradeneeded: (() => void) | null;
  onblocked: (() => void) | null;
}
interface IdbObjectStore {
  get(key: string): IdbRequest<unknown>;
  put(value: string, key: string): IdbRequest<unknown>;
  delete(key: string): IdbRequest<unknown>;
}
interface IdbTransaction {
  objectStore(name: string): IdbObjectStore;
  error: unknown;
  oncomplete: (() => void) | null;
  onerror: (() => void) | null;
  onabort: (() => void) | null;
}
interface IdbDatabase {
  readonly objectStoreNames: { contains(name: string): boolean };
  createObjectStore(name: string): unknown;
  transaction(name: string, mode: "readonly" | "readwrite"): IdbTransaction;
  close(): void;
}
/** The part of `indexedDB` the store uses. */
export interface IdbFactoryLike {
  open(name: string, version: number): unknown;
}

export interface IndexedDbStoreOptions {
  /** IndexedDB database name; one database can hold many writers' checkpoints. */
  readonly database: string;
  /** This writer's key within the database, for example a document and writer name. */
  readonly key: string;
  /**
   * How many writers, one per tab, may use `key` at once. Default 1. Slot 0 is `key` itself and slot
   * n is `key#n`; the store takes a free slot, preferring one with pending edits, then one with a
   * saved checkpoint, then the lowest. At most 64.
   */
  readonly slots?: number;
  /** Defaults to the global `indexedDB`. */
  readonly indexedDB?: IdbFactoryLike;
  /** Defaults to `navigator.locks`. */
  readonly locks?: LockManagerLike;
}

const OBJECT_STORE = "checkpoints";

function settle<T>(request: IdbRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function completion(transaction: IdbTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
  });
}

/** A browser checkpoint store, with the slot it took. */
export interface IndexedDbCheckpointStore extends CheckpointStore {
  /** The slot this store holds, from 0 to `slots - 1`. */
  readonly slot: number;
  /** The key its checkpoint is stored under: `key` for slot 0, `key#n` for slot n. */
  readonly key: string;
}

const MAX_SLOTS = 64;

/** How much a free slot is worth taking: 2 with pending edits, 1 with a checkpoint, 0 empty or unreadable. */
function slotRank(stored: unknown): number {
  if (typeof stored !== "string") return 0;
  try {
    const parsed: unknown = JSON.parse(stored);
    if (typeof parsed !== "object" || parsed === null) return 0;
    const pending = (parsed as { readonly pendingBatches?: unknown }).pendingBatches;
    return Array.isArray(pending) && pending.length > 0 ? 2 : 1;
  } catch {
    return 0;
  }
}

/**
 * Opens a browser checkpoint store. It takes the Web Lock `articollab:<database>:<key>` first and
 * throws `CheckpointLockedError` if another tab, or another client in this tab, holds it. With
 * `slots`, each tab takes a free slot instead and the error means every slot is held.
 * Checkpoints are stored as JSON strings in the `checkpoints` object store.
 */
export async function openIndexedDbStore(options: IndexedDbStoreOptions): Promise<IndexedDbCheckpointStore> {
  const { database } = options;
  if (typeof database !== "string" || database.length === 0) throw new TypeError("database must be a nonempty string");
  if (typeof options.key !== "string") throw new TypeError("key must be a string");
  const slots = integerOption(options.slots ?? 1, "slots", 1, MAX_SLOTS);
  const factory = options.indexedDB ?? (globalThis as { indexedDB?: IdbFactoryLike }).indexedDB;
  if (factory === undefined) throw new Error("indexedDB is unavailable; pass `indexedDB`");
  const keys = Array.from({ length: slots }, (_, slot) => slot === 0 ? options.key : `${options.key}#${slot}`);
  // With one slot, a held lock fails before the database is opened.
  let release =
    slots === 1 ? await acquireLock(`articollab:${database}:${keys[0]!}`, options.locks) : undefined;
  let slot = 0;
  let db: IdbDatabase;
  try {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The IndexedDB open request shape.
    const request = factory.open(database, 1) as IdbOpenRequest;
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(OBJECT_STORE)) request.result.createObjectStore(OBJECT_STORE);
    };
    db = await settle(request);
  } catch (cause) {
    release?.().catch(() => {});
    throw cause;
  }
  if (release === undefined) {
    try {
      // A hint only: the lock decides. Take over a closed tab's pending edits first, then an existing session.
      const objects = db.transaction(OBJECT_STORE, "readonly").objectStore(OBJECT_STORE);
      const ranks = await Promise.all(keys.map(async (key) => slotRank(await settle(objects.get(key)))));
      const order = keys.map((_, index) => index).sort((a, b) => ranks[b]! - ranks[a]! || a - b);
      for (const candidate of order) {
        try {
          release = await acquireLock(`articollab:${database}:${keys[candidate]!}`, options.locks);
          slot = candidate;
          break;
        } catch (error) {
          if (!(error instanceof CheckpointLockedError)) throw error;
        }
      }
    } catch (cause) {
      db.close();
      throw cause;
    }
    if (release === undefined) {
      db.close();
      throw new CheckpointLockedError(`All ${slots} checkpoint slots are in use elsewhere: ${options.key}`);
    }
  }
  const key = keys[slot]!;
  const state = closable(release, () => db.close());

  function write(change: (store: IdbObjectStore) => void): Promise<void> {
    return state.run(async () => {
      const transaction = db.transaction(OBJECT_STORE, "readwrite");
      const done = completion(transaction);
      change(transaction.objectStore(OBJECT_STORE));
      await done;
    });
  }

  return {
    slot,
    key,
    load: () => state.run(async () => {
      const stored = await settle(db.transaction(OBJECT_STORE, "readonly").objectStore(OBJECT_STORE).get(key));
      if (stored === undefined) return undefined;
      if (typeof stored !== "string") throw new Error(`Stored checkpoint is not a JSON string: ${key}`);
      return JSON.parse(stored) as unknown;
    }),
    save: (checkpoint) => write((store) => { store.put(JSON.stringify(checkpoint), key); }),
    clear: () => write((store) => { store.delete(key); }),
    close() { state.close().catch(() => {}); },
  };
}
