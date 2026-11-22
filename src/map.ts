import type { JsonValue } from "./schema.ts";
import { HamtMap } from "./vendor/hamt.ts";
import { validateJsonValue } from "./json.ts";
import { checkPayload, type PayloadSchema } from "./payload.ts";
import { CollectionObservers, type ObserverTargets } from "./observe.ts";

export interface MapSetOperation<
  Path extends string = string,
  T extends JsonValue = JsonValue,
> {
  readonly type: "map/set";
  readonly path: Path;
  readonly key: string;
  readonly value: T;
}

export interface MapDeleteOperation<Path extends string = string> {
  readonly type: "map/delete";
  readonly path: Path;
  readonly key: string;
}

export type MapOperation<
  Path extends string = string,
  T extends JsonValue = JsonValue,
> = MapSetOperation<Path, T> | MapDeleteOperation<Path>;

/** A Map snapshot: an own-property JSON object from key to value. */
export type MapSnapshotData<T extends JsonValue = JsonValue> = Readonly<Record<string, T>>;

/** One key's visible change. `previous` is undefined when a set adds the key. */
export type MapChange<T extends JsonValue = JsonValue> =
  | { readonly type: "set"; readonly key: string; readonly value: T; readonly previous: T | undefined }
  | { readonly type: "delete"; readonly key: string; readonly previous: T };

export interface MapChangeEvent<T extends JsonValue = JsonValue> {
  /** Sorted by key. */
  readonly changes: readonly MapChange<T>[];
}

/** An optimistic collaborative map from string keys to immutable values, iterated in key order. */
export interface MapCollection<T extends JsonValue> extends Iterable<[string, T]> {
  readonly size: number;
  get(key: string): T | undefined;
  has(key: string): boolean;
  set(key: string, value: T): void;
  /** Records a delete even when the key is absent here; returns whether it was present here. */
  delete(key: string): boolean;
  /** Deletes every key visible here, in one batch. */
  clear(): void;
  keys(): IterableIterator<string>;
  values(): IterableIterator<T>;
  entries(): IterableIterator<[string, T]>;
  /** A new plain object with the visible entries. */
  toObject(): Record<string, T>;
  /** Subscribes from the current view; changes are sorted by key. */
  observe(listener: (event: MapChangeEvent<T>) => void): () => void;
}

const keyTargets: ObserverTargets<string> = { key: (key) => key, own: (key) => key };

/** UTF-16 code unit order, the same on every replica. */
function compareKeys(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function setChange<T extends JsonValue>(key: string, value: T, previous: T | undefined): MapChange<T> {
  return Object.freeze({ type: "set", key, value, previous });
}

function deleteChange<T extends JsonValue>(key: string, previous: T): MapChange<T> {
  return Object.freeze({ type: "delete", key, previous });
}

/** Internal persistent state for one Map collection. */
export class MapState<T extends JsonValue> {
  private readonly entriesByKey: HamtMap<T>;
  private sortedKeys: readonly string[] | undefined;

  private constructor(entriesByKey: HamtMap<T>) {
    this.entriesByKey = entriesByKey;
  }

  static empty<T extends JsonValue>(): MapState<T> {
    return new MapState(HamtMap.empty<T>());
  }

  static load<T extends JsonValue>(snapshot: MapSnapshotData<T>): MapState<T> {
    if (typeof snapshot !== "object" || snapshot === null || Array.isArray(snapshot)) {
      throw new Error("Map snapshot must be an object");
    }
    const entries = HamtMap.empty<T>().mutate((draft) => {
      for (const key of Object.keys(snapshot)) {
        const value = snapshot[key];
        if (value === undefined) throw new Error(`Map snapshot value is missing for key: ${JSON.stringify(key)}`);
        draft.set(key, value);
      }
    });
    return new MapState(entries);
  }

  get size(): number {
    return this.entriesByKey.size;
  }

  get(key: string): T | undefined {
    return this.entriesByKey.get(key);
  }

  has(key: string): boolean {
    return this.entriesByKey.get(key) !== undefined;
  }

  set(operation: MapSetOperation<string, T>): MapState<T> {
    if (Object.is(this.get(operation.key), operation.value)) return this;
    return new MapState(this.entriesByKey.set(operation.key, operation.value));
  }

  /** Deleting an absent key is a legal no-op. */
  delete(operation: MapDeleteOperation): MapState<T> {
    if (!this.has(operation.key)) return this;
    return new MapState(this.entriesByKey.delete(operation.key));
  }

  keys(): readonly string[] {
    this.sortedKeys ??= Object.freeze([...this.entriesByKey.entries()].map(([key]) => key).sort(compareKeys));
    return this.sortedKeys;
  }

  *entries(): IterableIterator<[string, T]> {
    for (const key of this.keys()) yield [key, this.get(key)!];
  }

  visibleEquals(other: MapState<T>): boolean {
    if (this === other) return true;
    if (this.size !== other.size) return false;
    for (const [key, value] of this.entriesByKey.entries()) {
      if (!Object.is(value, other.get(key))) return false;
    }
    return true;
  }

  /** Whether one key has the same presence and value (by Object.is) in both states. */
  visibleKeyEquals(other: MapState<T>, key: string): boolean {
    return Object.is(this.get(key), other.get(key));
  }

  /** Visible changes to a later state; with targets, every other key must be unchanged. */
  changesTo(other: MapState<T>, targets?: Iterable<string>): MapChangeEvent<T> {
    const changes: MapChange<T>[] = [];
    if (this !== other) {
      const keys = targets === undefined ? new Set([...this.keys(), ...other.keys()]) : new Set(targets);
      for (const key of [...keys].sort(compareKeys)) {
        const before = this.get(key), after = other.get(key);
        if (Object.is(before, after)) continue;
        changes.push(after === undefined ? deleteChange(key, before!) : setChange(key, after, before));
      }
    }
    return Object.freeze({ changes: Object.freeze(changes) });
  }

  save(): MapSnapshotData<T> {
    // fromEntries defines own properties, so "__proto__" stays an ordinary key.
    return Object.freeze(Object.fromEntries(this.entries()));
  }
}

export function freezeMapOperation<Path extends string, T extends JsonValue>(
  operation: MapSetOperation<Path, T>
): MapSetOperation<Path, T>;
export function freezeMapOperation<Path extends string>(
  operation: MapDeleteOperation<Path>
): MapDeleteOperation<Path>;
export function freezeMapOperation<Path extends string, T extends JsonValue>(
  operation: MapOperation<Path, T>
): MapOperation<Path, T>;
export function freezeMapOperation<Path extends string, T extends JsonValue>(
  operation: MapOperation<Path, T>
): MapOperation<Path, T> {
  return operation.type === "map/set"
    ? Object.freeze({ type: operation.type, path: operation.path, key: operation.key, value: operation.value })
    : Object.freeze({ type: operation.type, path: operation.path, key: operation.key });
}

function requireKey(key: unknown): asserts key is string {
  if (typeof key !== "string") throw new TypeError(`Map keys must be strings: ${String(key)}`);
}

/** Internal mutable API wrapper around a persistent MapState. */
export class RuntimeMap<T extends JsonValue> implements MapCollection<T> {
  private current: MapState<T>;
  private readonly path: string;
  private readonly mutate: (operation: MapOperation<string, T>) => void;
  private readonly beforeMutation: () => void;
  private readonly transact: (callback: () => void) => void;
  private readonly observers: CollectionObservers<MapState<T>, MapChangeEvent<T>, string>;
  private readonly payload: PayloadSchema | undefined;

  constructor(
    mutate: (operation: MapOperation<string, T>) => void,
    path: string,
    initialState: MapState<T>,
    beforeMutation: () => void,
    transact: (callback: () => void) => void,
    beforeObserve: () => () => void,
    payload?: PayloadSchema
  ) {
    this.payload = payload;
    this.mutate = mutate;
    this.path = path;
    this.current = initialState;
    this.beforeMutation = beforeMutation;
    this.transact = transact;
    this.observers = new CollectionObservers(() => this.current, beforeObserve, keyTargets);
  }

  get state(): MapState<T> {
    return this.current;
  }

  get size(): number {
    return this.current.size;
  }

  get(key: string): T | undefined {
    requireKey(key);
    return this.current.get(key);
  }

  has(key: string): boolean {
    requireKey(key);
    return this.current.has(key);
  }

  set(key: string, value: T): void {
    requireKey(key);
    this.beforeMutation();
    validateJsonValue(value, [this.path, key]);
    checkPayload(this.payload, value, [this.path, key]);
    const operation = freezeMapOperation({ type: "map/set", path: this.path, key, value });
    this.current = this.current.set(operation);
    this.mutate(operation);
  }

  delete(key: string): boolean {
    requireKey(key);
    this.beforeMutation();
    const present = this.current.has(key);
    const operation = freezeMapOperation({ type: "map/delete", path: this.path, key });
    this.current = this.current.delete(operation);
    this.mutate(operation);
    return present;
  }

  clear(): void {
    this.beforeMutation();
    const keys = this.current.keys();
    if (keys.length === 0) return;
    this.transact(() => { for (const key of keys) this.delete(key); });
  }

  *keys(): IterableIterator<string> {
    yield* this.current.keys();
  }

  *values(): IterableIterator<T> {
    for (const [, value] of this.current.entries()) yield value;
  }

  entries(): IterableIterator<[string, T]> {
    return this.current.entries();
  }

  toObject(): Record<string, T> {
    return Object.fromEntries(this.current.entries());
  }

  observe(listener: (event: MapChangeEvent<T>) => void): () => void {
    return this.observers.observe(listener);
  }

  /** Every Map operation changes at most its own key. */
  track(operation: MapOperation): void {
    this.observers.track([operation.key]);
  }

  requireFullComparison(): void {
    this.observers.requireFullComparison();
  }

  get hasPendingObservers(): boolean {
    return this.observers.hasPending;
  }

  flushObservers(): void {
    this.observers.flush();
  }

  [Symbol.iterator](): IterableIterator<[string, T]> {
    return this.entries();
  }

  restore(state: MapState<T>): void {
    this.current = state;
  }

  visibleEquals(state: MapState<T>): boolean {
    return this.current.visibleEquals(state);
  }
}
