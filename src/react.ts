import { useRef, useSyncExternalStore } from "react";

import type {
  ClientDocument,
  CounterMapSchema,
  CounterSchema,
  DocumentState,
  JsonValue,
  ListSchema,
  MapSchema,
  SchemaShape,
  TextBlock,
  TextDeltaOp,
  TextSchema,
  UndoManager,
  ValueSchema,
} from "./index.ts";
import type { BlockShape, MarkShape } from "./schema.ts";
import type { PresenceSyncClient, SyncClient, SyncPushState, SyncStatus } from "./sync/index.ts";

/** What `useCollection()` returns for a collection schema. */
export type CollectionSnapshot<D> =
  D extends ValueSchema<infer T> ? T
    : D extends ListSchema<infer T> ? readonly T[]
      : D extends TextSchema ? string
        : D extends MapSchema<infer T> ? Readonly<Record<string, T>>
          : D extends CounterSchema ? number
            : D extends CounterMapSchema ? Readonly<Record<string, number>>
              : never;

/** A source React reads with `useSyncExternalStore`. */
interface Source<T> {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => T;
}

/** Equal arrays or plain objects with `Object.is`-equal entries, or `Object.is`-equal values. */
export function shallowEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const leftKeys = Object.keys(left), rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((key) => Object.hasOwn(right, key) && Object.is(Reflect.get(left, key), Reflect.get(right, key)));
}

/** Equal JSON values, for formatting runs and paragraphs that are rebuilt on every read. */
function jsonEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const leftKeys = Object.keys(left), rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((key) => Object.hasOwn(right, key) && jsonEqual(Reflect.get(left, key), Reflect.get(right, key)));
}

/**
 * A source that recomputes its snapshot only after a change, shared by every component that reads
 * it. While nobody is subscribed it cannot hear changes, so each read recomputes and keeps the
 * previous snapshot when the new one is equal.
 */
function cachedSource<T, E>(
  listen: (onChange: (event: E) => void) => () => void,
  read: () => T,
  equal: (left: T, right: T) => boolean,
  affects: (event: E) => boolean = () => true,
): Source<T> {
  const listeners = new Set<() => void>();
  let stop: (() => void) | undefined;
  let current: { value: T } | undefined;
  let stale = true;
  return {
    subscribe(listener) {
      listeners.add(listener);
      if (stop === undefined) {
        stop = listen((event) => {
          if (!affects(event)) return;
          stale = true;
          for (const notify of [...listeners]) notify();
        });
        // Changes made before this subscription went unheard.
        stale = true;
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) { stop?.(); stop = undefined; }
      };
    },
    getSnapshot() {
      if (current !== undefined && !stale && stop !== undefined) return current.value;
      const next = read();
      if (stop !== undefined) stale = false;
      if (current !== undefined && equal(current.value, next)) return current.value;
      current = { value: next };
      return next;
    },
  };
}

/** One source per owner and kind of reading, so components share subscriptions and snapshots. */
const sources = new WeakMap<object, Map<string, Source<unknown>>>();
function shared<V extends Source<unknown>>(owner: object, key: string, create: () => V): V {
  let byKey = sources.get(owner);
  if (byKey === undefined) sources.set(owner, byKey = new Map<string, Source<unknown>>());
  const found = byKey.get(key);
  if (found !== undefined) {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Each key always stores the same kind of source.
    return found as V;
  }
  const source = create();
  byKey.set(key, source);
  return source;
}

/** A document of any schema, read only through paths its own schema has. */
function wide<S extends SchemaShape>(doc: ClientDocument<S>): ClientDocument<SchemaShape> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Paths and values are checked against the document's own state.
  return doc as unknown as ClientDocument<SchemaShape>;
}

function useSource<T>(source: Source<T>): T {
  return useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot);
}

type ChangeEvent = { readonly changes: readonly unknown[]; readonly formats?: readonly unknown[]; readonly blocks?: readonly unknown[] };

/** The collection at `path`, or a TypeError for a path the schema does not have. */
function collectionAt(doc: ClientDocument<SchemaShape>, path: string) {
  if (!Object.hasOwn(doc.state, path)) throw new TypeError(`Unknown collection path: ${path}`);
  return doc.state[path]!;
}

/** The visible state of one collection, as it changes. */
function collectionSource(doc: ClientDocument<SchemaShape>, path: string): Source<unknown> {
  const collection = collectionAt(doc, path);
  return shared(collection, "collection", (): Source<unknown> => {
    if ("toDelta" in collection) {
      return cachedSource<string, ChangeEvent>((listener) => collection.observe(listener), () => collection.toString(), Object.is,
        (event) => event.changes.length > 0);
    }
    if ("toArray" in collection) {
      return cachedSource<readonly unknown[], ChangeEvent>((listener) => collection.observe(listener),
        () => Object.freeze(collection.toArray()), shallowEqual);
    }
    if ("toObject" in collection) {
      return cachedSource<Readonly<Record<string, unknown>>, ChangeEvent>((listener) => collection.observe(listener),
        () => Object.freeze(collection.toObject()), shallowEqual);
    }
    // A Value or a Counter: no observe(), but its value keeps its identity until it changes.
    return { subscribe: (listener) => doc.on("change", () => { listener(); }), getSnapshot: () => collection.value };
  });
}

/**
 * The visible state of the collection at `path`, re-rendering only when it changes:
 *
 * | Collection | Snapshot |
 * | --- | --- |
 * | Value | its value |
 * | List | a frozen array of its values |
 * | Text | its text |
 * | Map, CounterMap | a frozen object from key to value |
 * | Counter | its total |
 *
 * Every component reading one collection shares a subscription and a snapshot, which keeps its
 * identity until the collection changes.
 */
export function useCollection<S extends SchemaShape, K extends keyof S & string>(
  doc: ClientDocument<S>, path: K,
): CollectionSnapshot<S[K]> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The schema decides the collection, and so the snapshot.
  return useSource(collectionSource(wide(doc), path)) as CollectionSnapshot<S[K]>;
}

/** The Text at `path`. */
function textAt(doc: ClientDocument<SchemaShape>, path: string) {
  const text = collectionAt(doc, path);
  if (!("toDelta" in text)) throw new TypeError(`Not a Text collection: ${path}`);
  return text;
}

type TextAt<S extends SchemaShape> = { [K in keyof S & string]: S[K] extends TextSchema ? K : never }[keyof S & string];
type MarksOf<D> = D extends TextSchema<infer M extends MarkShape, BlockShape> ? M : never;
type BlocksOf<D> = D extends TextSchema<MarkShape, infer B extends BlockShape> ? B : never;

/** The Text at `path` as runs of equal marks, like `toDelta()`, re-rendering when its text or marks change. */
export function useTextDelta<S extends SchemaShape, K extends TextAt<S>>(
  doc: ClientDocument<S>, path: K,
): readonly TextDeltaOp<MarksOf<S[K]>>[] {
  const text = textAt(wide(doc), path);
  const source = shared(text, "delta", () => cachedSource<readonly TextDeltaOp[], ChangeEvent>(
    (listener) => text.observe(listener), () => text.toDelta(), jsonEqual,
    (event) => event.changes.length > 0 || (event.formats?.length ?? 0) > 0));
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- toDelta() runs carry the schema's marks.
  return useSource(source) as readonly TextDeltaOp<MarksOf<S[K]>>[];
}

/** The Text at `path` as paragraphs, like `blocks()`, re-rendering when its paragraphs or their attributes change. */
export function useTextBlocks<S extends SchemaShape, K extends TextAt<S>>(
  doc: ClientDocument<S>, path: K,
): readonly TextBlock<BlocksOf<S[K]>>[] {
  const text = textAt(wide(doc), path);
  const source = shared(text, "blocks", () => cachedSource<readonly TextBlock[], ChangeEvent>(
    (listener) => text.observe(listener), () => text.blocks(), jsonEqual,
    (event) => event.changes.length > 0 || (event.blocks?.length ?? 0) > 0));
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- blocks() entries carry the schema's attributes.
  return useSource(source) as readonly TextBlock<BlocksOf<S[K]>>[];
}

/** A counter of the document's visible changes; while unsubscribed, every read counts as a change. */
function versionSource(doc: ClientDocument<SchemaShape>): Source<number> & { current(): number } {
  return shared(doc, "version", (): Source<number> & { current(): number } => {
    const listeners = new Set<() => void>();
    let stop: (() => void) | undefined;
    let version = 0;
    return {
      subscribe(listener: () => void) {
        listeners.add(listener);
        if (stop === undefined) {
          version++;
          stop = doc.on("change", () => { version++; for (const notify of [...listeners]) notify(); });
        }
        return () => {
          listeners.delete(listener);
          if (listeners.size === 0) { stop?.(); stop = undefined; }
        };
      },
      getSnapshot: () => version,
      current: () => (stop === undefined ? ++version : version),
    };
  });
}

/**
 * Derives a value from the document's visible state. `selector` runs after each change, and the
 * component re-renders only when its result is not `isEqual` to the previous one (by default,
 * shallowly equal), which then keeps its identity. `selector` may be a new function on each render.
 */
export function useDocument<S extends SchemaShape, R>(
  doc: ClientDocument<S>,
  selector: (state: DocumentState<S>) => R,
  isEqual: (left: R, right: R) => boolean = shallowEqual,
): R {
  const source = versionSource(wide(doc));
  const memo = useRef<{ doc: object; version: number; selector: unknown; value: R } | undefined>(undefined);
  const getSnapshot = (): R => {
    const version = source.current();
    const previous = memo.current;
    if (previous !== undefined && previous.doc === doc && previous.version === version && previous.selector === selector) return previous.value;
    const next = selector(doc.state);
    const value = previous !== undefined && previous.doc === doc && isEqual(previous.value, next) ? previous.value : next;
    memo.current = { doc, version, selector, value };
    return value;
  };
  return useSyncExternalStore(source.subscribe, getSnapshot, getSnapshot);
}

/** The sync client's state, for a status badge. */
export interface SyncState {
  readonly status: SyncStatus;
  readonly push: SyncPushState;
  /** Why the client failed, while `status` is "failed". */
  readonly error: unknown;
}

/** The sync client's status, push channel and failure, re-rendering when any of them changes. */
export function useSyncStatus<S extends SchemaShape>(sync: SyncClient<S>): SyncState {
  const source = shared(sync, "status", (): Source<SyncState> => {
    let current: SyncState | undefined;
    return {
      subscribe(listener) {
        const stopStatus = sync.on("status", () => { listener(); }), stopPush = sync.on("push", () => { listener(); });
        return () => { stopStatus(); stopPush(); };
      },
      getSnapshot() {
        const { status, push, error } = sync;
        if (current?.status !== status || current.push !== push || !Object.is(current.error, error)) {
          current = Object.freeze({ status, push, error });
        }
        return current;
      },
    };
  });
  return useSource(source);
}

/** The other writers' presence states by client ID, re-rendering when they change. */
export function usePeers<S extends SchemaShape, P extends JsonValue>(sync: PresenceSyncClient<S, P>): ReadonlyMap<string, P> {
  const source = shared(sync, "peers", (): Source<ReadonlyMap<string, P>> => ({
    subscribe: (listener) => sync.presence.on("change", () => { listener(); }),
    getSnapshot: () => sync.presence.peers,
  }));
  return useSource(source);
}

/** Whether `history` can undo or redo, for enabling buttons. */
export interface UndoState {
  readonly canUndo: boolean;
  readonly canRedo: boolean;
}

/** `canUndo` and `canRedo` of an undo manager, re-rendering when either changes. */
export function useUndoState(history: UndoManager): UndoState {
  const source = shared(history, "undo", (): Source<UndoState> => {
    let current: UndoState | undefined;
    return {
      subscribe: (listener) => history.on("change", () => { listener(); }),
      getSnapshot() {
        const { canUndo, canRedo } = history;
        if (current?.canUndo !== canUndo || current.canRedo !== canRedo) current = Object.freeze({ canUndo, canRedo });
        return current;
      },
    };
  });
  return useSource(source);
}
