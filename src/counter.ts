import { CollectionConflictError } from "./conflict.ts";
import { MapState, requireKey } from "./map.ts";
import { CollectionObservers, type ObserverTargets } from "./observe.ts";

/** Adds a nonzero safe integer to a Counter. */
export interface CounterAddOperation<Path extends string = string> {
  readonly type: "counter/add";
  readonly path: Path;
  readonly delta: number;
}

/** Adds a nonzero safe integer to one key of a CounterMap. */
export interface CounterMapAddOperation<Path extends string = string> {
  readonly type: "counterMap/add";
  readonly path: Path;
  readonly key: string;
  readonly delta: number;
}

/** Resets one key of a CounterMap to 0. */
export interface CounterMapDeleteOperation<Path extends string = string> {
  readonly type: "counterMap/delete";
  readonly path: Path;
  readonly key: string;
}

export type CounterMapOperation<Path extends string = string> =
  | CounterMapAddOperation<Path>
  | CounterMapDeleteOperation<Path>;

/** A CounterMap snapshot: an own-property object from key to a nonzero safe integer. */
export type CounterMapSnapshotData = Readonly<Record<string, number>>;

/** One key's visible change; an absent key counts as 0. */
export interface CounterMapChange {
  readonly key: string;
  readonly value: number;
  readonly previous: number;
}

export interface CounterMapChangeEvent {
  /** Sorted by key. */
  readonly changes: readonly CounterMapChange[];
}

/** An optimistic collaborative integer that writers add to; concurrent additions all count. */
export interface Counter {
  readonly value: number;
  /** Adds a safe integer; 0 records nothing. Throws RangeError if the total would leave the safe integer range. */
  add(delta: number): void;
}

/** Optimistic collaborative counters by string key, iterated in key order. Absent keys count as 0. */
export interface CounterMap extends Iterable<[string, number]> {
  /** Keys whose count is not 0. */
  readonly size: number;
  /** The count, or 0 when the key is absent. */
  get(key: string): number;
  /** Whether the count is not 0. */
  has(key: string): boolean;
  /** Adds a safe integer to one key; 0 records nothing. A total of 0 removes the key. */
  add(key: string, delta: number): void;
  /** Resets one key to 0, recorded even when it is 0 here; returns whether it was not 0 here. */
  delete(key: string): boolean;
  /** Resets every key counted here, in one batch. Keys other writers add to concurrently keep those additions. */
  clear(): void;
  keys(): IterableIterator<string>;
  values(): IterableIterator<number>;
  entries(): IterableIterator<[string, number]>;
  /** A new plain object with the nonzero counts. */
  toObject(): Record<string, number>;
  /** Subscribes from the current view; changes are sorted by key. */
  observe(listener: (event: CounterMapChangeEvent) => void): () => void;
}

/** Throws TypeError unless `delta` is a number, and RangeError unless it is a safe integer. */
function requireDelta(delta: unknown, path: readonly string[]): asserts delta is number {
  if (typeof delta !== "number") throw new TypeError(`Counter delta at ${path.join("/")} must be a number: ${String(delta)}`);
  if (!Number.isSafeInteger(delta)) {
    throw new RangeError(`Counter delta at ${path.join("/")} must be a safe integer: ${String(delta)}`);
  }
}

/** The total after an addition; outside the safe integer range it is a state conflict. */
export function addCount(current: number, delta: number, path: string): number {
  const total = current + delta;
  if (!Number.isSafeInteger(total)) {
    throw new CollectionConflictError(`Counter total leaves the safe integer range: ${path}`);
  }
  return total;
}

const keyTargets: ObserverTargets<string> = { key: (key) => key, own: (key) => key };

/** Internal persistent state for one CounterMap: nonzero counts only. */
export class CounterMapState {
  private readonly counts: MapState<number>;

  private constructor(counts: MapState<number>) {
    this.counts = counts;
  }

  static empty(): CounterMapState {
    return new CounterMapState(MapState.empty());
  }

  static load(snapshot: CounterMapSnapshotData): CounterMapState {
    if (typeof snapshot !== "object" || snapshot === null || Array.isArray(snapshot)) {
      throw new Error("CounterMap snapshot must be an object");
    }
    for (const key of Object.keys(snapshot)) {
      const count = snapshot[key];
      if (typeof count !== "number" || !Number.isSafeInteger(count) || count === 0) {
        throw new Error(`CounterMap snapshot count must be a nonzero safe integer for key: ${JSON.stringify(key)}`);
      }
    }
    return new CounterMapState(MapState.load(snapshot));
  }

  get size(): number {
    return this.counts.size;
  }

  get(key: string): number {
    return this.counts.get(key) ?? 0;
  }

  has(key: string): boolean {
    return this.counts.has(key);
  }

  add(operation: CounterMapAddOperation): CounterMapState {
    return this.with(operation.key, addCount(this.get(operation.key), operation.delta, operation.path));
  }

  delete(operation: CounterMapDeleteOperation): CounterMapState {
    return this.with(operation.key, 0);
  }

  keys(): readonly string[] {
    return this.counts.keys();
  }

  entries(): IterableIterator<[string, number]> {
    return this.counts.entries();
  }

  visibleEquals(other: CounterMapState): boolean {
    return this === other || this.counts.visibleEquals(other.counts);
  }

  visibleKeyEquals(other: CounterMapState, key: string): boolean {
    return this.get(key) === other.get(key);
  }

  /** Visible changes to a later state; with targets, every other key must be unchanged. */
  changesTo(other: CounterMapState, targets?: Iterable<string>): CounterMapChangeEvent {
    const { changes } = this.counts.changesTo(other.counts, targets);
    return Object.freeze({
      changes: Object.freeze(changes.map((change) => Object.freeze({
        key: change.key, value: change.type === "set" ? change.value : 0, previous: change.previous ?? 0,
      }))),
    });
  }

  save(): CounterMapSnapshotData {
    return this.counts.save();
  }

  /** A total of 0 removes the key, so absent and 0 are the same state. */
  private with(key: string, count: number): CounterMapState {
    const next = count === 0
      ? this.counts.delete({ type: "map/delete", path: "", key })
      : this.counts.set({ type: "map/set", path: "", key, value: count });
    return next === this.counts ? this : new CounterMapState(next);
  }
}

export function freezeCounterOperation<Path extends string>(operation: CounterAddOperation<Path>): CounterAddOperation<Path> {
  return Object.freeze({ type: operation.type, path: operation.path, delta: operation.delta });
}

export function freezeCounterMapOperation<Path extends string>(operation: CounterMapAddOperation<Path>): CounterMapAddOperation<Path>;
export function freezeCounterMapOperation<Path extends string>(operation: CounterMapDeleteOperation<Path>): CounterMapDeleteOperation<Path>;
export function freezeCounterMapOperation<Path extends string>(operation: CounterMapOperation<Path>): CounterMapOperation<Path>;
export function freezeCounterMapOperation<Path extends string>(
  operation: CounterMapOperation<Path>
): CounterMapOperation<Path> {
  return operation.type === "counterMap/add"
    ? Object.freeze({ type: operation.type, path: operation.path, key: operation.key, delta: operation.delta })
    : Object.freeze({ type: operation.type, path: operation.path, key: operation.key });
}

/** Internal mutable API wrapper around one Counter's total. */
export class RuntimeCounter implements Counter {
  private current: number;
  private readonly path: string;
  private readonly mutate: (operation: CounterAddOperation) => void;
  private readonly beforeMutation: () => void;

  constructor(mutate: (operation: CounterAddOperation) => void, path: string, initial: number, beforeMutation: () => void) {
    this.mutate = mutate;
    this.path = path;
    this.current = initial;
    this.beforeMutation = beforeMutation;
  }

  get state(): number {
    return this.current;
  }

  get value(): number {
    return this.current;
  }

  add(delta: number): void {
    requireDelta(delta, [this.path]);
    const total = this.current + delta;
    if (!Number.isSafeInteger(total)) throw new RangeError(`Counter total leaves the safe integer range: ${this.path}`);
    this.beforeMutation();
    if (delta === 0) return;
    this.current = total;
    this.mutate(freezeCounterOperation({ type: "counter/add", path: this.path, delta }));
  }

  restore(state: number): void {
    this.current = state;
  }

  visibleEquals(state: number): boolean {
    return this.current === state;
  }
}

/** Internal mutable API wrapper around a persistent CounterMapState. */
export class RuntimeCounterMap implements CounterMap {
  private current: CounterMapState;
  private readonly path: string;
  private readonly mutate: (operation: CounterMapOperation) => void;
  private readonly beforeMutation: () => void;
  private readonly transact: (callback: () => void) => void;
  private readonly observers: CollectionObservers<CounterMapState, CounterMapChangeEvent, string>;

  constructor(
    mutate: (operation: CounterMapOperation) => void,
    path: string,
    initialState: CounterMapState,
    beforeMutation: () => void,
    transact: (callback: () => void) => void,
    beforeObserve: () => () => void
  ) {
    this.mutate = mutate;
    this.transact = transact;
    this.path = path;
    this.current = initialState;
    this.beforeMutation = beforeMutation;
    this.observers = new CollectionObservers(() => this.current, beforeObserve, keyTargets);
  }

  get state(): CounterMapState {
    return this.current;
  }

  get size(): number {
    return this.current.size;
  }

  get(key: string): number {
    requireKey(key, "CounterMap");
    return this.current.get(key);
  }

  has(key: string): boolean {
    requireKey(key, "CounterMap");
    return this.current.has(key);
  }

  add(key: string, delta: number): void {
    requireKey(key, "CounterMap");
    requireDelta(delta, [this.path, key]);
    if (!Number.isSafeInteger(this.current.get(key) + delta)) {
      throw new RangeError(`Counter total leaves the safe integer range: ${this.path}/${key}`);
    }
    this.beforeMutation();
    if (delta === 0) return;
    const operation = freezeCounterMapOperation({ type: "counterMap/add", path: this.path, key, delta });
    this.current = this.current.add(operation);
    this.mutate(operation);
  }

  delete(key: string): boolean {
    requireKey(key, "CounterMap");
    this.beforeMutation();
    const present = this.current.has(key);
    const operation = freezeCounterMapOperation({ type: "counterMap/delete", path: this.path, key });
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

  *values(): IterableIterator<number> {
    for (const [, count] of this.current.entries()) yield count;
  }

  entries(): IterableIterator<[string, number]> {
    return this.current.entries();
  }

  toObject(): Record<string, number> {
    return Object.fromEntries(this.current.entries());
  }

  observe(listener: (event: CounterMapChangeEvent) => void): () => void {
    return this.observers.observe(listener);
  }

  /** Every CounterMap operation changes at most its own key. */
  track(operation: CounterMapOperation): void {
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

  [Symbol.iterator](): IterableIterator<[string, number]> {
    return this.entries();
  }

  restore(state: CounterMapState): void {
    this.current = state;
  }

  visibleEquals(state: CounterMapState): boolean {
    return this.current.visibleEquals(state);
  }
}
