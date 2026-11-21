/**
 * Durable storage for one writer's checkpoint. `connectSync({ store })` loads it once, saves through
 * it and closes it when the client stops. Implementations hold an exclusive lock while open, so
 * two clients can never share one stored writer.
 */
export interface CheckpointStore {
  /** The saved checkpoint as parsed JSON, or undefined when nothing is saved. */
  load(): Promise<unknown>;
  /** Replaces the saved checkpoint; resolves once it is stored. */
  save(checkpoint: unknown): Promise<void>;
  /** Removes the saved checkpoint. */
  clear(): Promise<void>;
  /** Releases the lock and any connection. Further calls are no-ops; other methods then throw. */
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
 * Takes an exclusive lock without waiting for another holder, and returns the function that releases
 * it. A lock this realm just released is awaited first, so close-then-reopen works immediately.
 * @internal Shared by the IndexedDB and file stores.
 */
export async function acquireLock(name: string, locks: LockManagerLike = defaultLocks()): Promise<() => void> {
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
  return () => {
    const done = finished.catch(() => {}).finally(() => { if (releasing.get(name) === done) releasing.delete(name); });
    releasing.set(name, done);
    release();
  };
}

/** @internal Shared state for stores that hold a lock until `close()`. */
export function closable(release: () => void, onClose: () => void = () => {}) {
  let closed = false;
  return {
    assertOpen(): void {
      if (closed) throw new Error("Checkpoint store is closed");
    },
    close(): void {
      if (closed) return;
      closed = true;
      try { onClose(); } finally { release(); }
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

/**
 * Opens a browser checkpoint store. It takes the Web Lock `articollab:<database>:<key>` first and
 * throws `CheckpointLockedError` if another tab, or another client in this tab, holds it.
 * Checkpoints are stored as JSON strings in the `checkpoints` object store.
 */
export async function openIndexedDbStore(options: IndexedDbStoreOptions): Promise<CheckpointStore> {
  const { database, key } = options;
  if (typeof database !== "string" || database.length === 0) throw new TypeError("database must be a nonempty string");
  if (typeof key !== "string") throw new TypeError("key must be a string");
  const factory = options.indexedDB ?? (globalThis as { indexedDB?: IdbFactoryLike }).indexedDB;
  if (factory === undefined) throw new Error("indexedDB is unavailable; pass `indexedDB`");
  const release = await acquireLock(`articollab:${database}:${key}`, options.locks);
  let db: IdbDatabase;
  try {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The IndexedDB open request shape.
    const request = factory.open(database, 1) as IdbOpenRequest;
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(OBJECT_STORE)) request.result.createObjectStore(OBJECT_STORE);
    };
    db = await settle(request);
  } catch (cause) {
    release();
    throw cause;
  }
  const state = closable(release, () => db.close());

  async function write(change: (store: IdbObjectStore) => void): Promise<void> {
    state.assertOpen();
    const transaction = db.transaction(OBJECT_STORE, "readwrite");
    const done = completion(transaction);
    change(transaction.objectStore(OBJECT_STORE));
    await done;
  }

  return {
    async load() {
      state.assertOpen();
      const stored = await settle(db.transaction(OBJECT_STORE, "readonly").objectStore(OBJECT_STORE).get(key));
      if (stored === undefined) return undefined;
      if (typeof stored !== "string") throw new Error(`Stored checkpoint is not a JSON string: ${key}`);
      return JSON.parse(stored) as unknown;
    },
    save: (checkpoint) => write((store) => { store.put(JSON.stringify(checkpoint), key); }),
    clear: () => write((store) => { store.delete(key); }),
    close: () => state.close(),
  };
}
