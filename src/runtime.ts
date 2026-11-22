import { equalsId, type ElementId } from "articulated";

import {
  freezeListOperation,
  ListState,
  RuntimeList,
  type List,
  type ListDeleteOperation,
  type ListInsertOperation,
  type ListMoveOperation,
  type ListSetOperation,
  type ListOperation,
} from "./list.ts";
import {
  freezeTextOperation,
  RuntimeText,
  TextState,
  type Text,
  type TextDeleteOperation,
  type TextInsertOperation,
  type TextOperation,
} from "./text.ts";
import {
  freezeMapOperation,
  MapState,
  RuntimeMap,
  type MapCollection,
  type MapDeleteOperation,
  type MapOperation,
  type MapSetOperation,
} from "./map.ts";
import {
  freezeCounterMapOperation,
  freezeCounterOperation,
  CounterMapState,
  RuntimeCounter,
  RuntimeCounterMap,
  type Counter,
  type CounterAddOperation,
  type CounterMap,
  type CounterMapAddOperation,
  type CounterMapDeleteOperation,
  type CounterMapOperation,
} from "./counter.ts";
import type {
  CounterMapSchema,
  CounterSchema,
  DocumentSchema,
  JsonValue,
  ListSchema,
  MapSchema,
  SchemaShape,
  SnapshotType,
  TextSchema,
  ValueSchema,
} from "./schema.ts";
import { decodeClientCheckpoint, decodeServerCheckpoint } from "./wire.ts";
import { clientNumber } from "./client-id.ts";
import { assertClientBatchNamespace } from "./namespace.ts";
import {
  applyOperations,
  initialStates,
  isStructuredState,
  replayPending,
  saveSnapshot,
  unknownOperationType,
  wrongCollectionKind,
  type CollectionState,
} from "./state.ts";
import { canonicalJson, jsonEquals, validateJsonValue } from "./json.ts";
import { checkPayload, type PayloadSchema } from "./payload.ts";

export interface ValueSetOperation<
  Path extends string = string,
  T extends JsonValue = JsonValue,
> {
  readonly type: "value/set";
  readonly path: Path;
  readonly value: T;
}

export type Operation =
  | ValueSetOperation
  | ListInsertOperation
  | ListDeleteOperation
  | ListSetOperation
  | ListMoveOperation
  | TextInsertOperation
  | TextDeleteOperation
  | MapSetOperation
  | MapDeleteOperation
  | CounterAddOperation
  | CounterMapAddOperation
  | CounterMapDeleteOperation;

type OperationFor<D, Path extends string> =
  D extends ValueSchema<infer T extends JsonValue>
    ? ValueSetOperation<Path, T>
    : D extends ListSchema<infer T extends JsonValue>
      ? ListOperation<Path, T>
      : D extends TextSchema
        ? TextOperation<Path>
        : D extends MapSchema<infer T extends JsonValue>
          ? MapOperation<Path, T>
          : D extends CounterSchema
            ? CounterAddOperation<Path>
            : D extends CounterMapSchema
              ? CounterMapOperation<Path>
              : never;

export type DocumentOperation<S extends SchemaShape> = {
  [K in Extract<keyof S, string>]: OperationFor<S[K], K>;
}[Extract<keyof S, string>];

export interface ClientBatchRef {
  readonly clientId: string;
  readonly seq: number;
}

export interface ClientBatch<TOperation extends Operation = Operation>
  extends ClientBatchRef {
  readonly operations: readonly TOperation[];
}

/** The first batch that cannot currently be replayed on authoritative state. */
export interface PendingReplayConflict<TOperation extends Operation = Operation> {
  readonly batch: ClientBatch<TOperation>;
  readonly operationIndex: number;
  readonly message: string;
}

export interface ServerCommit<TOperation extends Operation = Operation> {
  readonly serverSeq: number;
  readonly source: ClientBatchRef;
  readonly operations: readonly TOperation[];
}

/** Transport-local routing information; only the commit goes on the wire. */
export interface ServerReceipt<TOperation extends Operation = Operation> {
  readonly commit: ServerCommit<TOperation>;
  readonly replayed: boolean;
}

export interface ServerReplayEntry<TOperation extends Operation = Operation> {
  readonly batch: ClientBatch<TOperation>;
  readonly commit: ServerCommit<TOperation>;
}

/** An open writer session and the last batch the server processed from it. */
export interface ServerClientSession {
  readonly clientId: string;
  /** Last processed batch sequence; 0 before the first batch. */
  readonly lastSeq: number;
  /** Server sequence of that batch's commit; null before the first batch. */
  readonly lastServerSeq: number | null;
}

export interface LocalChangeEvent<TOperation extends Operation = Operation> {
  readonly origin: "local";
  readonly batch: ClientBatch<TOperation>;
}

export interface ServerChangeEvent<TOperation extends Operation = Operation> {
  readonly origin: "server";
  readonly commit: ServerCommit<TOperation>;
}

/** List sets and moves in an own acknowledged commit that had no effect because their target was already deleted. */
export interface DiscardEvent<TOperation extends Operation = Operation> {
  readonly commit: ServerCommit<TOperation>;
  readonly operations: readonly Extract<TOperation, { readonly type: "list/set" | "list/move" }>[];
}

/** What the server did with one of this writer's batches, once its acknowledgement was received. */
export interface BatchOutcome<TOperation extends Operation = Operation> {
  /** "rejected": the commit has no operations; "transformed": it is not JSON-equal to the batch. */
  readonly status: "accepted" | "transformed" | "rejected";
  readonly batch: ClientBatch<TOperation>;
  readonly commit: ServerCommit<TOperation>;
  /** Sent operations the commit lacks, in batch order, compared as JSON. */
  readonly dropped: readonly TOperation[];
  /** Committed operations that were not sent, in commit order, compared as JSON. */
  readonly added: readonly TOperation[];
  /** Committed List sets and moves whose element was already deleted, as `discard` reports them. */
  readonly discarded: readonly Extract<TOperation, { readonly type: "list/set" | "list/move" }>[];
}

/** The result of `doc.track()`: the callback's value, the batch it recorded, and its outcome. */
export interface TrackedChange<T, TOperation extends Operation = Operation> {
  readonly value: T;
  /** Undefined when the callback recorded no operation. */
  readonly batch: ClientBatch<TOperation> | undefined;
  /** Resolves once the batch's acknowledgement is received; to undefined when there is no batch. Never rejects. */
  readonly settled: Promise<BatchOutcome<TOperation> | undefined>;
}

interface Waiter<TOperation extends Operation> {
  readonly promise: Promise<BatchOutcome<TOperation>>;
  readonly resolve: (outcome: BatchOutcome<TOperation>) => void;
  batch?: ClientBatch<TOperation>;
}

/**
 * An own acknowledged batch whose commit differs from what this writer sent: the server transformed
 * or rejected it. `dropped` lists sent operations the commit lacks, in batch order, and `added` the
 * commit's operations that were not sent, in commit order; both compare operations as JSON.
 */
export interface TransformEvent<TOperation extends Operation = Operation> {
  readonly batch: ClientBatch<TOperation>;
  readonly commit: ServerCommit<TOperation>;
  readonly dropped: readonly TOperation[];
  readonly added: readonly TOperation[];
}

export type ChangeEvent<TOperation extends Operation = Operation> =
  | LocalChangeEvent<TOperation>
  | ServerChangeEvent<TOperation>;

export type DocumentSnapshotData<S extends SchemaShape> = Readonly<{
  [K in keyof S]: SnapshotType<S[K]>;
}>;

export interface DocumentSnapshot<
  S extends SchemaShape = SchemaShape,
> {
  readonly serverSeq: number;
  readonly data: DocumentSnapshotData<S>;
}

export interface ServerCheckpoint<
  S extends SchemaShape = SchemaShape,
> {
  readonly snapshot: DocumentSnapshot<S>;
  readonly lastClientNumber: number;
  readonly clients: readonly {
    readonly clientId: string;
    readonly replay: ServerReplayEntry<DocumentOperation<S>> | null;
  }[];
  readonly history: readonly ServerCommit<DocumentOperation<S>>[];
}

export interface ClientCheckpoint<S extends SchemaShape = SchemaShape> {
  readonly clientId: string;
  readonly snapshot: DocumentSnapshot<S>;
  /** Last emitted local batch sequence, including still-pending batches. */
  readonly lastLocalSeq: number;
  readonly pendingBatches: readonly ClientBatch<DocumentOperation<S>>[];
  /** Last allocated bunch per List/Text path, including rolled-back allocations. */
  readonly lastBunchSeqs: Readonly<{
    [K in keyof S as S[K] extends ListSchema | TextSchema ? K : never]: number;
  }>;
}

export interface CreateClientOptions<S extends SchemaShape> {
  readonly clientId: string;
  readonly onBatch: (batch: ClientBatch<DocumentOperation<S>>) => void;
  readonly snapshot?: DocumentSnapshot<S>;
  readonly checkpoint?: ClientCheckpoint<S>;
}

export interface ServerResolveContext<S extends SchemaShape> {
  readonly batch: ClientBatch<DocumentOperation<S>>;
  readonly snapshot: DocumentSnapshot<S>;
}

export type ServerResolver<S extends SchemaShape> = (
  context: ServerResolveContext<S>
) => readonly DocumentOperation<S>[];

export interface CreateServerOptions<S extends SchemaShape> {
  readonly resolve?: ServerResolver<S>;
  readonly checkpoint?: ServerCheckpoint<S>;
  readonly historyLimit?: number;
  /** Maximum open writer sessions, including those without a batch. */
  readonly maxClients?: number;
  /** Skip incoming insertion namespace checks; application code owns the policy. */
  readonly allowCustomClientNamespaces?: boolean;
}

/** An optimistic collaborative value. Values are treated as immutable. */
export interface Value<T extends JsonValue> {
  get value(): T;
  set value(nextValue: T);
  set(nextValue: T): void;
}

class RuntimeValue<T extends JsonValue> implements Value<T> {
  private current: T;
  private readonly path: string;
  private readonly mutate: (operation: ValueSetOperation<string, T>) => void;
  private readonly beforeMutation: () => void;
  private readonly payload: PayloadSchema | undefined;

  constructor(
    mutate: (operation: ValueSetOperation<string, T>) => void,
    path: string,
    initialValue: T,
    beforeMutation: () => void,
    payload: PayloadSchema | undefined
  ) {
    this.mutate = mutate;
    this.path = path;
    this.current = initialValue;
    this.beforeMutation = beforeMutation;
    this.payload = payload;
  }

  get state(): T {
    return this.current;
  }

  get value(): T {
    return this.current;
  }

  set value(nextValue: T) {
    this.set(nextValue);
  }

  set(nextValue: T): void {
    this.beforeMutation();
    validateJsonValue(nextValue, [this.path]);
    checkPayload(this.payload, nextValue, [this.path]);
    this.current = nextValue;
    this.mutate(
      Object.freeze({
        type: "value/set",
        path: this.path,
        value: nextValue,
      })
    );
  }

  restore(value: T): void {
    this.current = value;
  }

  visibleEquals(value: T): boolean {
    return Object.is(this.current, value);
  }
}

type RuntimeCollection =
  | RuntimeValue<JsonValue>
  | RuntimeList<JsonValue>
  | RuntimeText
  | RuntimeMap<JsonValue>
  | RuntimeCounter
  | RuntimeCounterMap;

function restoreServerCheckpoint<S extends SchemaShape>(
  schema: DocumentSchema<S>,
  checkpoint: ServerCheckpoint<S>
): {
  readonly states: Map<string, CollectionState>;
  readonly clients: Map<string, ServerReplayEntry<DocumentOperation<S>> | null>;
  readonly lastClientNumber: number;
  readonly history: readonly ServerCommit<DocumentOperation<S>>[];
  readonly nextServerSeq: number;
} {
  // Use the same structural and cross-entry validation at both restore boundaries.
  const owned = decodeServerCheckpoint(schema, checkpoint);
  return {
    states: initialStates(schema, owned.snapshot),
    clients: new Map(owned.clients.map((entry) => [entry.clientId, entry.replay])),
    lastClientNumber: owned.lastClientNumber,
    history: owned.history,
    nextServerSeq: owned.snapshot.serverSeq + 1,
  };
}

/** Collections with `observe()`. */
function isObservable(
  runtime: RuntimeCollection | undefined
): runtime is RuntimeList<JsonValue> | RuntimeText | RuntimeMap<JsonValue> | RuntimeCounterMap {
  return runtime instanceof RuntimeText || runtime instanceof RuntimeList || runtime instanceof RuntimeMap ||
    runtime instanceof RuntimeCounterMap;
}

function runtimeState(runtime: RuntimeCollection): CollectionState {
  return runtime.state;
}

function sameAnchor(left: Readonly<ElementId> | null, right: Readonly<ElementId> | null): boolean {
  return left === right || (left !== null && right !== null && equalsId(left, right));
}

/** Matches sent and committed operations as a JSON multiset, keeping each side's order. */
function transformEvent<TOperation extends Operation>(
  batch: ClientBatch<TOperation>, commit: ServerCommit<TOperation>
): TransformEvent<TOperation> {
  const unmatched = new Map<string, number>();
  const commitKeys = commit.operations.map((operation) => {
    const key = canonicalJson(operation);
    unmatched.set(key, (unmatched.get(key) ?? 0) + 1);
    return key;
  });
  const sent = new Map<string, number>();
  const dropped = batch.operations.filter((operation) => {
    const key = canonicalJson(operation);
    const count = unmatched.get(key) ?? 0;
    if (count === 0) return true;
    unmatched.set(key, count - 1);
    sent.set(key, (sent.get(key) ?? 0) + 1);
    return false;
  });
  const added = commit.operations.filter((_operation, index) => {
    const key = commitKeys[index]!;
    const count = sent.get(key) ?? 0;
    if (count === 0) return true;
    sent.set(key, count - 1);
    return false;
  });
  return Object.freeze({ batch, commit, dropped: Object.freeze(dropped), added: Object.freeze(added) });
}

/** JSON equality would lose payload identity and signed-zero changes. */
function sameOperations(
  left: readonly Operation[], right: readonly Operation[], allowValueChanges = false
): boolean {
  if (left.length !== right.length) return false;
  return left.every((operation, index) => {
    const other = right[index]!;
    if (operation.path !== other.path) return false;
    switch (operation.type) {
      case "value/set":
        return other.type === "value/set" && (allowValueChanges || Object.is(operation.value, other.value));
      case "list/insert":
        return other.type === "list/insert" && sameAnchor(operation.before, other.before) &&
          equalsId(operation.id, other.id) && (allowValueChanges || Object.is(operation.value, other.value));
      case "list/delete":
        return other.type === "list/delete" && equalsId(operation.id, other.id);
      case "list/set":
        return other.type === "list/set" && equalsId(operation.id, other.id) &&
          (allowValueChanges || Object.is(operation.value, other.value));
      case "list/move":
        return other.type === "list/move" && equalsId(operation.id, other.id) &&
          sameAnchor(operation.before, other.before) && equalsId(operation.position, other.position);
      case "text/insert":
        return other.type === "text/insert" && sameAnchor(operation.before, other.before) &&
          equalsId(operation.id, other.id) && operation.value === other.value;
      case "text/delete":
        return other.type === "text/delete" && operation.ranges.length === other.ranges.length &&
          operation.ranges.every((range, rangeIndex) => {
            const otherRange = other.ranges[rangeIndex]!;
            return range.count === otherRange.count && equalsId(range.start, otherRange.start);
          });
      case "map/set":
        return other.type === "map/set" && operation.key === other.key &&
          (allowValueChanges || Object.is(operation.value, other.value));
      case "map/delete":
        return other.type === "map/delete" && operation.key === other.key;
      case "counter/add":
        return other.type === "counter/add" && (allowValueChanges || operation.delta === other.delta);
      case "counters/add":
        return other.type === "counters/add" && operation.key === other.key &&
          (allowValueChanges || operation.delta === other.delta);
      case "counters/delete":
        return other.type === "counters/delete" && operation.key === other.key;
      default:
        return false;
    }
  });
}

function runtimeVisibleEquals(
  runtime: RuntimeCollection,
  state: CollectionState,
  path: string,
  skipComparison: boolean,
  ownTextUnchanged: boolean,
  listComparisonIds?: readonly Readonly<ElementId>[],
  textComparisonOperations?: readonly TextOperation[],
  mapComparisonKeys?: readonly string[]
): boolean {
  if (runtime instanceof RuntimeList) {
    if (!(state instanceof ListState)) throw wrongCollectionKind(path);
    return skipComparison || (listComparisonIds === undefined ? runtime.visibleEquals(state) :
      listComparisonIds.every((id) => runtime.state.visibleValueEquals(state, id)));
  }
  if (runtime instanceof RuntimeText) {
    if (!(state instanceof TextState)) throw wrongCollectionKind(path);
    return skipComparison || ownTextUnchanged || (textComparisonOperations === undefined ? runtime.visibleEquals(state) :
      runtime.state.visibleEqualsAt(state, textComparisonOperations));
  }
  if (runtime instanceof RuntimeMap) {
    if (!(state instanceof MapState)) throw wrongCollectionKind(path);
    return skipComparison || (mapComparisonKeys === undefined ? runtime.visibleEquals(state) :
      mapComparisonKeys.every((key) => runtime.state.visibleKeyEquals(state, key)));
  }
  if (runtime instanceof RuntimeCounterMap) {
    if (!(state instanceof CounterMapState)) throw wrongCollectionKind(path);
    return skipComparison || (mapComparisonKeys === undefined ? runtime.visibleEquals(state) :
      mapComparisonKeys.every((key) => runtime.state.visibleKeyEquals(state, key)));
  }
  if (runtime instanceof RuntimeCounter) {
    if (typeof state !== "number") throw wrongCollectionKind(path);
    return skipComparison || runtime.visibleEquals(state);
  }
  if (isStructuredState(state)) {
    throw wrongCollectionKind(path);
  }
  return skipComparison || runtime.visibleEquals(state);
}

function restoreRuntime(
  runtime: RuntimeCollection,
  state: CollectionState,
  path: string,
  singleMoveId?: Readonly<ElementId>
): void {
  if (runtime instanceof RuntimeList) {
    if (!(state instanceof ListState)) throw wrongCollectionKind(path);
    runtime.restore(state, singleMoveId);
  } else if (runtime instanceof RuntimeText) {
    if (!(state instanceof TextState)) throw wrongCollectionKind(path);
    runtime.restore(state);
  } else if (runtime instanceof RuntimeMap) {
    if (!(state instanceof MapState)) throw wrongCollectionKind(path);
    runtime.restore(state);
  } else if (runtime instanceof RuntimeCounterMap) {
    if (!(state instanceof CounterMapState)) throw wrongCollectionKind(path);
    runtime.restore(state);
  } else if (runtime instanceof RuntimeCounter) {
    if (typeof state !== "number") throw wrongCollectionKind(path);
    runtime.restore(state);
  } else {
    if (isStructuredState(state)) {
      throw wrongCollectionKind(path);
    }
    runtime.restore(state);
  }
}

function freezeOperation(operation: Operation): Operation {
  switch (operation.type) {
    case "value/set":
      return Object.freeze({ ...operation });
    case "list/insert":
    case "list/delete":
    case "list/set":
    case "list/move":
      return freezeListOperation(operation);
    case "text/insert":
    case "text/delete":
      return freezeTextOperation(operation);
    case "map/set":
    case "map/delete":
      return freezeMapOperation(operation);
    case "counter/add":
      return freezeCounterOperation(operation);
    case "counters/add":
    case "counters/delete":
      return freezeCounterMapOperation(operation);
    default:
      throw unknownOperationType(operation);
  }
}

function freezeOperations<TOperation extends Operation>(
  operations: readonly TOperation[]
): readonly TOperation[] {
  return Object.freeze(
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Copying/freezing preserves the input operation discriminator, path and payload.
    operations.map((operation) => freezeOperation(operation) as TOperation)
  );
}

type DocumentCollection<D> =
  D extends ValueSchema<infer T extends JsonValue>
    ? Value<T>
    : D extends ListSchema<infer T extends JsonValue>
      ? List<T>
      : D extends TextSchema
        ? Text
        : D extends MapSchema<infer T extends JsonValue>
          ? MapCollection<T>
          : D extends CounterSchema
            ? Counter
            : D extends CounterMapSchema
              ? CounterMap
              : never;

export type DocumentState<S extends SchemaShape> = Readonly<{
  [K in keyof S]: DocumentCollection<S[K]>;
}>;

type ChangeListener<S extends SchemaShape> = (
  event: ChangeEvent<DocumentOperation<S>>
) => void;

type DiscardListener<S extends SchemaShape> = (
  event: DiscardEvent<DocumentOperation<S>>
) => void;

type TransformListener<S extends SchemaShape> = (
  event: TransformEvent<DocumentOperation<S>>
) => void;

interface ClientProgress<S extends SchemaShape> {
  readonly serverSeq: number;
  readonly lastLocalSeq: number;
  readonly nextPendingBatch: ClientBatch<DocumentOperation<S>> | undefined;
}

/** A local batch with every collection's state right before and after it. Internal, for undo. */
export interface LocalStep<S extends SchemaShape> {
  readonly batch: ClientBatch<DocumentOperation<S>>;
  readonly before: ReadonlyMap<string, CollectionState>;
  readonly after: ReadonlyMap<string, CollectionState>;
}

/** Internal access for the undo manager: records each local batch while attached. Initialized by ClientDocument. */
export let attachHistory: <S extends SchemaShape>(
  document: ClientDocument<S>, recorder: ((step: LocalStep<S>) => void) | undefined
) => void;

/** Internal: whether a transaction is open on the document. Initialized by ClientDocument. */
export let isTransacting: <S extends SchemaShape>(document: ClientDocument<S>) => boolean;

/** Internal access for the sync adapter. Initialized by ClientDocument. */
export let readClientProgress: <S extends SchemaShape>(document: ClientDocument<S>) => ClientProgress<S>;

/** A client-side optimistic document with server reconciliation. */
export class ClientDocument<S extends SchemaShape> {
  readonly state: DocumentState<S>;

  private readonly clientId: string;
  private readonly onBatch: CreateClientOptions<S>["onBatch"];
  private readonly listeners = new Set<ChangeListener<S>>();
  private readonly discardListeners = new Set<DiscardListener<S>>();
  private readonly transformListeners = new Set<TransformListener<S>>();
  /** Outcome promises by local sequence, created only on request. */
  private readonly waiters = new Map<number, Waiter<DocumentOperation<S>>>();
  private readonly collections = new Map<string, RuntimeCollection>();
  private authoritativeStates: Map<string, CollectionState>;
  private readonly pendingBatches: ClientBatch<DocumentOperation<S>>[] = [];
  private currentReplayConflict: PendingReplayConflict<DocumentOperation<S>> | null = null;

  private nextSeq = 1;
  private lastServerSeq = 0;
  private checkpointSnapshot: DocumentSnapshot<S> | undefined;
  private transactionDepth = 0;
  private operations: Operation[] = [];
  private transactionSnapshot: Map<string, CollectionState> | undefined;
  private notificationDepth = 0;
  private drainingObservers = false;
  private observerCount = 0;
  private historyRecorder: ((step: LocalStep<S>) => void) | undefined;
  /** States before the batch being built, kept only while history is attached. */
  private batchBefore: Map<string, CollectionState> | undefined;

  static {
    attachHistory = <Shape extends SchemaShape>(
      document: ClientDocument<Shape>, recorder: ((step: LocalStep<Shape>) => void) | undefined
    ): void => {
      if (recorder !== undefined && document.historyRecorder !== undefined) {
        throw new Error("This document already has an undo manager");
      }
      document.historyRecorder = recorder;
      document.batchBefore = undefined;
    };
    isTransacting = <Shape extends SchemaShape>(document: ClientDocument<Shape>): boolean => document.transactionDepth !== 0;
    readClientProgress = <Shape extends SchemaShape>(document: ClientDocument<Shape>): ClientProgress<Shape> => {
      document.assertOutsideTransactionForCheckpoint();
      return {
        serverSeq: document.lastServerSeq,
        lastLocalSeq: document.nextSeq - 1,
        nextPendingBatch: document.pendingBatches[0],
      };
    };
  }

  constructor(schema: DocumentSchema<S>, options: CreateClientOptions<S>) {
    if (options.clientId.length === 0) {
      throw new Error("clientId must not be empty");
    }

    if (options.snapshot !== undefined && options.checkpoint !== undefined) {
      throw new Error("Cannot provide both snapshot and checkpoint");
    }
    const checkpoint =
      options.checkpoint === undefined
        ? undefined
        : decodeClientCheckpoint(schema, options.checkpoint);
    if (checkpoint !== undefined && checkpoint.clientId !== options.clientId) {
      throw new Error("Checkpoint clientId must match client options");
    }

    this.clientId = options.clientId;
    this.onBatch = options.onBatch;
    const snapshot = checkpoint?.snapshot ?? options.snapshot;
    this.authoritativeStates = initialStates(schema, snapshot);
    this.lastServerSeq = snapshot?.serverSeq ?? 0;
    this.nextSeq = checkpoint === undefined ? 1 : checkpoint.lastLocalSeq + 1;
    if (checkpoint !== undefined) {
      for (const batch of checkpoint.pendingBatches) {
        this.pendingBatches.push(batch);
      }
    }
    const { states, conflict } = replayPending(this.authoritativeStates, this.pendingBatches);
    this.currentReplayConflict = conflict;
    const lastBunchSeqs = checkpoint?.lastBunchSeqs as
      | Readonly<Record<string, number>>
      | undefined;
    const beforeMutation = () => {
      this.assertCanMutate();
      // The first mutation of a batch runs before any collection changes.
      if (this.historyRecorder !== undefined && this.batchBefore === undefined) this.batchBefore = this.currentStates();
    };

    const publicState: Partial<
      Record<keyof S, Value<JsonValue> | List<JsonValue> | Text | MapCollection<JsonValue> | Counter | CounterMap>
    > = {};
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The fixed schema’s own keys are the document paths.
    for (const path of Object.keys(schema.definition) as Array<
      Extract<keyof S, string>
    >) {
      const descriptor = schema.definition[path];
      const collectionState = states.get(path);
      if (collectionState === undefined) {
        throw new Error(`Missing document path: ${path}`);
      }

      let runtime: RuntimeCollection;
      if (descriptor.kind === "value") {
        if (isStructuredState(collectionState)) {
          throw wrongCollectionKind(path);
        }
        runtime = new RuntimeValue(
          (operation) => this.mutate(operation),
          path,
          collectionState,
          beforeMutation,
          descriptor.payload
        );
      } else if (descriptor.kind === "list") {
        if (!(collectionState instanceof ListState)) {
          throw wrongCollectionKind(path);
        }
        runtime = new RuntimeList(
          (operation) => this.mutate(operation),
          this.clientId,
          path,
          collectionState,
          beforeMutation,
          lastBunchSeqs?.[path] ?? 0,
          () => this.registerObserver("List"),
          descriptor.payload
        );
      } else if (descriptor.kind === "counter") {
        if (typeof collectionState !== "number") {
          throw wrongCollectionKind(path);
        }
        runtime = new RuntimeCounter((operation) => this.mutate(operation), path, collectionState, beforeMutation);
      } else if (descriptor.kind === "counters") {
        if (!(collectionState instanceof CounterMapState)) {
          throw wrongCollectionKind(path);
        }
        runtime = new RuntimeCounterMap(
          (operation) => this.mutate(operation),
          path,
          collectionState,
          beforeMutation,
          () => this.registerObserver("CounterMap")
        );
      } else if (descriptor.kind === "map") {
        if (!(collectionState instanceof MapState)) {
          throw wrongCollectionKind(path);
        }
        runtime = new RuntimeMap(
          (operation) => this.mutate(operation),
          path,
          collectionState,
          beforeMutation,
          (callback) => { this.transact(callback); },
          () => this.registerObserver("Map"),
          descriptor.payload
        );
      } else {
        if (!(collectionState instanceof TextState)) {
          throw wrongCollectionKind(path);
        }
        runtime = new RuntimeText(
          (operation) => this.mutate(operation),
          this.clientId,
          path,
          collectionState,
          beforeMutation,
          lastBunchSeqs?.[path] ?? 0,
          () => this.registerObserver("Text")
        );
      }
      this.collections.set(path, runtime);
      publicState[path] = runtime;
    }
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The loop builds one matching runtime collection for every schema descriptor.
    this.state = Object.freeze(publicState) as DocumentState<S>;
  }

  get replayConflict(): PendingReplayConflict<DocumentOperation<S>> | null {
    return this.currentReplayConflict;
  }

  /** Saves authoritative state and the pending work needed to rebuild this client. */
  checkpoint(): ClientCheckpoint<S> {
    this.assertOutsideTransactionForCheckpoint();
    const lastBunchSeqs = Object.freeze(
      Object.fromEntries(
        [...this.collections].flatMap(([path, runtime]) =>
          runtime instanceof RuntimeList || runtime instanceof RuntimeText
            ? [[path, runtime.lastBunchSeq]]
            : []
        )
      )
    ) as ClientCheckpoint<S>["lastBunchSeqs"]; // oxlint-disable-line typescript/no-unsafe-type-assertion -- Only List/Text runtimes contribute their allocation counters.
    return Object.freeze({
      clientId: this.clientId,
      snapshot: this.checkpointSnapshot ??= saveSnapshot<S>(this.authoritativeStates, this.lastServerSeq),
      lastLocalSeq: this.nextSeq - 1,
      pendingBatches: Object.freeze([...this.pendingBatches]),
      lastBunchSeqs,
    });
  }

  private assertOutsideTransactionForCheckpoint(): void {
    if (this.transactionDepth !== 0) {
      throw new Error("Cannot checkpoint during a transaction");
    }
  }

  private assertCanMutate(): void {
    this.assertReplayable();
    if (!Number.isSafeInteger(this.nextSeq)) {
      throw new Error("Client sequence exhausted");
    }
  }

  private assertReplayable(): void {
    if (this.currentReplayConflict !== null) {
      throw new Error("Cannot mutate while pending replay is blocked");
    }
  }

  private mutate(operation: Operation): void {
    this.operations.push(operation);
    if (this.transactionDepth === 0) this.commit();
  }

  /**
   * Like `transact()`, and also returns the batch it recorded and a promise of its outcome. The
   * promise resolves when the acknowledgement is received and never rejects.
   */
  track<T>(
    callback: () => T,
    ...mustBeSynchronous: [T] extends [never]
      ? []
      : T extends PromiseLike<unknown>
        ? [never]
        : []
  ): TrackedChange<T, DocumentOperation<S>>;
  track<T>(callback: () => T): TrackedChange<T, DocumentOperation<S>> {
    if (this.transactionDepth !== 0) throw new Error("Cannot track inside a transaction");
    // Wait before committing: a synchronous transport may acknowledge the batch inside onBatch.
    const seq = this.nextSeq;
    const waiter = this.waiter(seq);
    let value: T;
    try {
      value = this.runTransaction(callback);
    } finally {
      if (waiter.batch === undefined) this.waiters.delete(seq);
    }
    const batch = waiter.batch;
    return Object.freeze({ value, batch, settled: batch === undefined ? Promise.resolve(undefined) : waiter.promise });
  }

  /** The outcome of a pending batch of this document, such as one restored from a checkpoint. Never rejects. */
  settled(batch: ClientBatch<DocumentOperation<S>>): Promise<BatchOutcome<DocumentOperation<S>>> {
    const pending = typeof batch === "object" && batch !== null && batch.clientId === this.clientId
      ? this.pendingBatches.find(({ seq }) => seq === batch.seq) : undefined;
    if (pending === undefined) throw new Error("The batch is not pending in this document");
    const waiter = this.waiter(pending.seq);
    waiter.batch ??= pending;
    return waiter.promise;
  }

  private waiter(seq: number): Waiter<DocumentOperation<S>> {
    let waiter = this.waiters.get(seq);
    if (waiter === undefined) {
      let resolve!: (outcome: BatchOutcome<DocumentOperation<S>>) => void;
      const promise = new Promise<BatchOutcome<DocumentOperation<S>>>((settle) => { resolve = settle; });
      waiter = { promise, resolve };
      this.waiters.set(seq, waiter);
    }
    return waiter;
  }

  /** Groups all synchronous mutations in callback into one client batch. */
  transact<T>(
    callback: () => T,
    ...mustBeSynchronous: [T] extends [never]
      ? []
      : T extends PromiseLike<unknown>
        ? [never]
        : []
  ): T;
  transact<T>(callback: () => T): T {
    return this.runTransaction(callback);
  }

  private runTransaction<T>(callback: () => T): T {
    this.assertReplayable();
    const isOuterTransaction = this.transactionDepth === 0;
    if (isOuterTransaction) {
      this.transactionSnapshot = new Map(
        [...this.collections].map(([path, runtime]) => [
          path,
          runtimeState(runtime),
        ])
      );
    }

    this.transactionDepth++;
    let result: T;
    try {
      result = callback();
    } catch (error) {
      this.transactionDepth--;
      if (isOuterTransaction) this.rollbackTransaction();
      throw error;
    }

    this.transactionDepth--;
    if (isOuterTransaction) {
      this.transactionSnapshot = undefined;
      this.commit();
    }
    return result;
  }

  on(event: "change", listener: ChangeListener<S>): () => void;
  /** Own list sets and moves that the server applied after their target was deleted, once per acknowledged commit. */
  on(event: "discard", listener: DiscardListener<S>): () => void;
  /** Own batches whose acknowledged commit differs from what was sent: transformed or rejected. */
  on(event: "transform", listener: TransformListener<S>): () => void;
  on(
    event: "change" | "discard" | "transform",
    listener: ChangeListener<S> | DiscardListener<S> | TransformListener<S>
  ): () => void {
    if (event !== "change" && event !== "discard" && event !== "transform") {
      throw new Error(`Unknown event: ${event as string}`);
    }
    // The overloads pair each event name with its listener type.
    const listeners = (event === "change" ? this.listeners
      : event === "discard" ? this.discardListeners : this.transformListeners) as Set<typeof listener>;
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  /** Applies the next authoritative server commit and replays local changes. */
  receive(commit: ServerCommit<DocumentOperation<S>>): void {
    this.notificationDepth++;
    try {
      const { discarded, transform, ownBatch } = this.receiveCommit(commit);
      // Before listeners run, so a throwing listener cannot leave the outcome unresolved.
      const waiter = ownBatch === undefined ? undefined : this.waiters.get(ownBatch.seq);
      if (ownBatch !== undefined && waiter !== undefined) {
        this.waiters.delete(ownBatch.seq);
        waiter.resolve(Object.freeze({
          status: commit.operations.length === 0 ? "rejected" : transform === undefined ? "accepted" : "transformed",
          batch: ownBatch, commit,
          dropped: transform?.dropped ?? Object.freeze([]),
          added: transform?.added ?? Object.freeze([]),
          discarded: Object.freeze([...discarded]),
        }));
      }
      if (transform !== undefined && this.transformListeners.size !== 0) {
        for (const listener of [...this.transformListeners]) listener(transform);
      }
      if (discarded.length !== 0) {
        const event = Object.freeze({ commit, operations: Object.freeze(discarded) });
        for (const listener of [...this.discardListeners]) listener(event);
      }
    } finally {
      this.notificationDepth--;
    }
    this.flushObservers();
  }

  /** Applies one commit; returns the own list sets and moves it discarded and, if it differs from the own batch, how. */
  private receiveCommit(commit: ServerCommit<DocumentOperation<S>>): {
    readonly discarded: Extract<DocumentOperation<S>, { readonly type: "list/set" | "list/move" }>[];
    readonly transform: TransformEvent<DocumentOperation<S>> | undefined;
    readonly ownBatch: ClientBatch<DocumentOperation<S>> | undefined;
  } {
    if (this.transactionDepth !== 0) {
      throw new Error("Cannot receive a server commit during a transaction");
    }

    // A mutation that failed validation may have captured states this commit is about to replace.
    this.batchBefore = undefined;
    const expectedServerSeq = this.lastServerSeq + 1;
    if (commit.serverSeq !== expectedServerSeq) {
      throw new Error(
        `Expected server sequence ${expectedServerSeq}, received ${commit.serverSeq}`
      );
    }

    const isOwnCommit = commit.source.clientId === this.clientId;
    const ownBatch = isOwnCommit ? this.pendingBatches[0] : undefined;
    if (isOwnCommit) {
      const pending = this.pendingBatches[0];
      if (pending === undefined || pending.seq !== commit.source.seq) {
        throw new Error(
          `Server commit does not match the next pending batch: ${commit.source.seq}`
        );
      }
    }

    const nextAuthoritativeStates = new Map(this.authoritativeStates);
    const discarded: Extract<DocumentOperation<S>, { readonly type: "list/set" | "list/move" }>[] = [];
    applyOperations(nextAuthoritativeStates, commit.operations, isOwnCommit
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Commit operations are this schema's operations.
      ? (operation) => { discarded.push(operation as Extract<DocumentOperation<S>, { readonly type: "list/set" | "list/move" }>); }
      : undefined);

    // shortcut: exact, conflict-free own acks preserve the entire optimistic view.
    if (isOwnCommit && this.currentReplayConflict === null &&
      sameOperations(commit.operations, this.pendingBatches[0]!.operations)) {
      // With no remaining pending, these states are also authoritative; keep references aligned.
      if (this.pendingBatches.length === 1) {
        for (const [path, runtime] of this.collections) {
          nextAuthoritativeStates.set(path, runtimeState(runtime));
        }
      }
      this.authoritativeStates = nextAuthoritativeStates;
      this.pendingBatches.shift();
      this.lastServerSeq = commit.serverSeq;
      this.checkpointSnapshot = undefined;
      return { discarded, transform: undefined, ownBatch };
    }

    const remainingBatches = isOwnCommit
      ? this.pendingBatches.slice(1)
      : this.pendingBatches;
    const commitPaths = new Set<string>(commit.operations.map((operation) => operation.path));
    // shortcut: disjoint paths cannot change replayability of a conflict-free pending batch.
    const canKeepPending = !isOwnCommit && remainingBatches.length > 0 &&
      this.currentReplayConflict === null && remainingBatches.every((batch) =>
        batch.operations.every((operation) => !commitPaths.has(operation.path)));
    const { states: nextOptimisticStates, conflict } = canKeepPending
      ? { states: new Map([...this.collections].map(([path, runtime]) => [path,
          commitPaths.has(path) ? nextAuthoritativeStates.get(path)! : runtimeState(runtime),
        ])), conflict: null }
      : replayPending(nextAuthoritativeStates, remainingBatches);
    const previous = this.currentReplayConflict;
    const sameConflict = previous === null || conflict === null
      ? previous === conflict
      : previous.batch === conflict.batch &&
        previous.operationIndex === conflict.operationIndex &&
        previous.message === conflict.message;
    // shortcut: matching own structure preserves IDs and Text; Value/List payloads may differ.
    // Both replays must be conflict-free; otherwise compare the entire visible prefix.
    const compareOwnPayloads = isOwnCommit && previous === null && conflict === null &&
      sameOperations(commit.operations, this.pendingBatches[0]!.operations, true);
    // shortcut: complete fixed-ID replay preserves untouched IDs/values. General moves compare in full.
    const compareRemoteTargets = !isOwnCommit && previous === null && conflict === null;
    // shortcut: one remote move with no pending replay changes only the named element's position.
    const commitOperations: readonly Operation[] = commit.operations;
    const onlyOperation = commitOperations[0];
    const singleRemoteMove = compareRemoteTargets && remainingBatches.length === 0 &&
      commitOperations.length === 1 && onlyOperation?.type === "list/move" ? onlyOperation : undefined;
    const listComparisonIds = compareOwnPayloads || compareRemoteTargets
      ? new Map<string, Readonly<ElementId>[]>() : undefined;
    const textComparisonOperations = compareRemoteTargets
      ? new Map<string, TextOperation[]>() : undefined;
    // Map operations touch only their own key; own acks compare the keys whose payload may differ.
    const mapComparisonKeys = listComparisonIds === undefined ? undefined : new Map<string, string[]>();
    if (listComparisonIds !== undefined) {
      for (const operation of commit.operations) {
        if (operation.type === "list/insert" || operation.type === "list/set" ||
          (compareRemoteTargets && operation.type === "list/delete")) {
          const ids = listComparisonIds.get(operation.path) ?? [];
          ids.push(operation.id);
          listComparisonIds.set(operation.path, ids);
        } else if (operation.type === "map/set" || operation.type === "counters/add" ||
          (compareRemoteTargets && (operation.type === "map/delete" || operation.type === "counters/delete"))) {
          const keys = mapComparisonKeys!.get(operation.path) ?? [];
          keys.push(operation.key);
          mapComparisonKeys!.set(operation.path, keys);
        } else if (textComparisonOperations !== undefined &&
          (operation.type === "text/insert" || operation.type === "text/delete")) {
          const operations = textComparisonOperations.get(operation.path) ?? [];
          operations.push(operation);
          textComparisonOperations.set(operation.path, operations);
        }
      }
    }
    const movedPaths = new Set<string>(commit.operations.flatMap((operation) => operation.type === "list/move" ? [operation.path] : []));
    let changed = !sameConflict;
    for (const [path, runtime] of this.collections) {
      const nextState = nextOptimisticStates.get(path);
      if (nextState === undefined) {
        throw new Error(`Missing document path: ${path}`);
      }
      if (singleRemoteMove?.path === path && runtime instanceof RuntimeList && nextState instanceof ListState) {
        if (!changed) changed = !runtime.state.singleMoveVisibleEquals(nextState, singleRemoteMove.id);
        continue;
      }
      // For general moves, testing only affected IDs and values cannot establish order equality.
      const ids = listComparisonIds === undefined || (compareRemoteTargets && movedPaths.has(path))
        ? undefined : listComparisonIds.get(path) ?? [];
      const textOperations = textComparisonOperations === undefined ? undefined : textComparisonOperations.get(path) ?? [];
      const keys = mapComparisonKeys === undefined ? undefined : mapComparisonKeys.get(path) ?? [];
      if (!runtimeVisibleEquals(runtime, nextState, path, changed, compareOwnPayloads, ids, textOperations, keys)) changed = true;
    }

    this.authoritativeStates = nextAuthoritativeStates;
    if (isOwnCommit) this.pendingBatches.shift();
    this.lastServerSeq = commit.serverSeq;
    this.checkpointSnapshot = undefined;
    this.currentReplayConflict = sameConflict ? previous : conflict;

    for (const [path, runtime] of this.collections) {
      restoreRuntime(runtime, nextOptimisticStates.get(path)!, path,
        this.observerCount > 0 && singleRemoteMove?.path === path ? singleRemoteMove.id : undefined);
      if (isObservable(runtime) &&
        (previous !== null || conflict !== null || (isOwnCommit && !compareOwnPayloads))) {
        runtime.requireFullComparison();
      }
    }
    if (singleRemoteMove === undefined) this.trackObservedOperations(commit.operations);
    if (ownBatch !== undefined) this.trackObservedOperations(ownBatch.operations);

    if (changed) {
      this.emitChange(Object.freeze({ origin: "server", commit }));
    }
    // Decoded commits carry copies of own payloads, so equality is by JSON value, not reference.
    // Without transform listeners or a waiter for this batch, skip the comparison.
    const transform = ownBatch === undefined ||
      (this.transformListeners.size === 0 && !this.waiters.has(ownBatch.seq)) ||
      jsonEquals(ownBatch.operations, commit.operations) ? undefined : transformEvent(ownBatch, commit);
    return { discarded, transform, ownBatch };
  }

  private currentStates(): Map<string, CollectionState> {
    return new Map([...this.collections].map(([path, runtime]) => [path, runtimeState(runtime)]));
  }

  private commit(): void {
    const before = this.batchBefore;
    this.batchBefore = undefined;
    if (this.operations.length === 0) return;

    const operations = Object.freeze(
      this.operations.splice(0)
    ) as readonly DocumentOperation<S>[]; // oxlint-disable-line typescript/no-unsafe-type-assertion -- Operations originate from this schema’s collection runtimes; copying preserves their wire types.
    const batch: ClientBatch<DocumentOperation<S>> = Object.freeze({
      clientId: this.clientId,
      seq: this.nextSeq++,
      operations,
    });

    this.pendingBatches.push(batch);
    const waiter = this.waiters.get(batch.seq);
    if (waiter !== undefined) waiter.batch = batch;
    this.trackObservedOperations(operations);
    if (before !== undefined && this.historyRecorder !== undefined) {
      this.historyRecorder(Object.freeze({ batch, before, after: this.currentStates() }));
    }
    this.notificationDepth++;
    try {
      this.onBatch(batch);
      this.emitChange(Object.freeze({ origin: "local", batch }));
    } finally {
      this.notificationDepth--;
    }
    this.flushObservers();
  }

  private registerObserver(kind: "List" | "Text" | "Map" | "CounterMap"): () => void {
    if (this.transactionDepth !== 0) throw new Error(`Cannot observe ${kind} during a transaction`);
    this.observerCount++;
    return () => { this.observerCount--; };
  }

  private trackObservedOperations(operations: readonly Operation[]): void {
    if (this.observerCount === 0) return;
    for (const operation of operations) {
      const runtime = this.collections.get(operation.path);
      switch (operation.type) {
        case "text/insert": case "text/delete":
          if (runtime instanceof RuntimeText) runtime.track(operation);
          break;
        case "list/insert": case "list/delete": case "list/set": case "list/move":
          if (runtime instanceof RuntimeList) runtime.track(operation);
          break;
        case "map/set": case "map/delete":
          if (runtime instanceof RuntimeMap) runtime.track(operation);
          break;
        case "counters/add": case "counters/delete":
          if (runtime instanceof RuntimeCounterMap) runtime.track(operation);
          break;
        default:
          break;
      }
    }
  }

  private flushObservers(): void {
    if (this.observerCount === 0 || this.notificationDepth !== 0 || this.drainingObservers) return;
    this.drainingObservers = true;
    try {
      let pending: boolean;
      do {
        pending = false;
        for (const runtime of this.collections.values()) {
          if (isObservable(runtime) && runtime.hasPendingObservers) {
            runtime.flushObservers();
          }
        }
        for (const runtime of this.collections.values()) {
          if (isObservable(runtime) && runtime.hasPendingObservers) {
            pending = true;
          }
        }
      } while (pending);
    } finally {
      this.drainingObservers = false;
    }
  }

  private emitChange(event: ChangeEvent<DocumentOperation<S>>): void {
    for (const listener of [...this.listeners]) listener(event);
  }

  private rollbackTransaction(): void {
    const snapshot = this.transactionSnapshot;
    this.transactionSnapshot = undefined;
    this.operations = [];
    this.batchBefore = undefined;

    if (snapshot === undefined) return;
    for (const [path, state] of snapshot) {
      const runtime = this.collections.get(path);
      if (runtime !== undefined) restoreRuntime(runtime, state, path);
    }
  }
}

/** Throws a PayloadValidationError for the first written value its collection's schema rejects. */
function checkOperationPayloads(definition: Readonly<SchemaShape>, operations: readonly Operation[]): void {
  for (const operation of operations) {
    const descriptor = Object.hasOwn(definition, operation.path) ? definition[operation.path] : undefined;
    const payload = descriptor === undefined || !("payload" in descriptor) ? undefined : descriptor.payload;
    if (payload === undefined) continue;
    switch (operation.type) {
      case "value/set": case "list/insert": case "list/set":
        checkPayload(payload, operation.value, [operation.path]);
        break;
      case "map/set":
        checkPayload(payload, operation.value, [operation.path, operation.key]);
        break;
      default:
        break;
    }
  }
}

/** A synchronous authoritative document that resolves and orders client batches. */
export class ServerDocument<S extends SchemaShape> {
  private authoritativeStates: Map<string, CollectionState>;
  private readonly clients: Map<string, ServerReplayEntry<DocumentOperation<S>> | null>;
  private lastClientNumber: number;
  private readonly historyLimit: number;
  private readonly maxClients: number | undefined;
  private readonly allowCustomClientNamespaces: boolean;
  /** Retained commits are `history[historyStart..]`; evicted entries are dropped in amortized batches. */
  private history: ServerCommit<DocumentOperation<S>>[];
  private historyStart = 0;
  private readonly resolve: ServerResolver<S> | undefined;
  private readonly definition: Readonly<S>;
  private nextServerSeq = 1;
  private receiving = false;

  constructor(
    schema: DocumentSchema<S>,
    options: CreateServerOptions<S> = {}
  ) {
    this.definition = schema.definition;
    const allowCustomClientNamespaces = options.allowCustomClientNamespaces;
    if (allowCustomClientNamespaces !== undefined && typeof allowCustomClientNamespaces !== "boolean") {
      throw new TypeError("allowCustomClientNamespaces must be a boolean");
    }
    this.allowCustomClientNamespaces = allowCustomClientNamespaces ?? false;
    const maxClients = options.maxClients;
    if (maxClients !== undefined && (!Number.isSafeInteger(maxClients) || maxClients < 0)) {
      throw new Error("maxClients must be a non-negative safe integer");
    }
    this.maxClients = maxClients;
    const historyLimit =
      options.historyLimit === undefined ? 1000 : options.historyLimit;
    if (!Number.isSafeInteger(historyLimit) || historyLimit < 0) {
      throw new Error("historyLimit must be a non-negative safe integer");
    }
    this.historyLimit = historyLimit;
    const restored =
      options.checkpoint === undefined
        ? undefined
        : restoreServerCheckpoint(schema, options.checkpoint);
    if (maxClients !== undefined && restored !== undefined && restored.clients.size > maxClients) {
      throw new Error("Checkpoint exceeds maxClients");
    }
    this.authoritativeStates =
      restored?.states ?? initialStates(schema, undefined);
    this.clients = restored?.clients ?? new Map<string, ServerReplayEntry<DocumentOperation<S>> | null>();
    this.lastClientNumber = restored?.lastClientNumber ?? 0;
    this.history =
      historyLimit === 0 ? [] : (restored?.history ?? []).slice(-historyLimit);
    this.nextServerSeq = restored?.nextServerSeq ?? 1;
    this.resolve = options.resolve;
  }

  /** Returns the current authoritative state and its server sequence. */
  snapshot(): DocumentSnapshot<S> {
    return saveSnapshot<S>(this.authoritativeStates, this.nextServerSeq - 1);
  }

  /** Opens a writer session. Disconnecting does not close it. */
  openClient(): string {
    if (this.receiving) throw new Error("Cannot call server.openClient() reentrantly");
    if (this.maxClients !== undefined && this.clients.size >= this.maxClients) {
      throw new Error("Server client capacity exhausted");
    }
    if (this.lastClientNumber === Number.MAX_SAFE_INTEGER) {
      throw new Error("Client ID allocation exhausted");
    }
    const clientId = `client-${this.lastClientNumber + 1}`;
    this.clients.set(clientId, null);
    this.lastClientNumber++;
    return clientId;
  }

  /** Permanently closes this writer session; pending work is caller-owned. */
  closeClient(clientId: string): void {
    if (this.receiving) throw new Error("Cannot call server.closeClient() reentrantly");
    const number = clientNumber(clientId);
    if (number === undefined || number > this.lastClientNumber) {
      throw new TypeError("Unknown client ID");
    }
    this.clients.delete(clientId);
  }

  /** Lists open writer sessions in opening order, without copying state or history. */
  listClients(): readonly ServerClientSession[] {
    return Object.freeze([...this.clients].map(([clientId, replay]) => Object.freeze({
      clientId,
      lastSeq: replay?.batch.seq ?? 0,
      lastServerSeq: replay?.commit.serverSeq ?? null,
    })));
  }

  /** Returns the state needed to restore this authoritative server. */
  checkpoint(): ServerCheckpoint<S> {
    return Object.freeze({
      snapshot: this.snapshot(),
      lastClientNumber: this.lastClientNumber,
      clients: Object.freeze(
        [...this.clients].map(([clientId, replay]) => Object.freeze({ clientId, replay }))
      ),
      history: Object.freeze(this.history.slice(this.historyStart)),
    });
  }

  /** Returns every later commit, or null if any required history was evicted. */
  commitsSince(
    serverSeq: number
  ): readonly ServerCommit<DocumentOperation<S>>[] | null {
    const currentSeq = this.nextServerSeq - 1;
    if (!Number.isSafeInteger(serverSeq) || serverSeq < 0 || serverSeq > currentSeq) {
      throw new Error(
        "Catch-up watermark must be a non-negative safe integer no greater than the current server sequence"
      );
    }
    if (serverSeq === currentSeq) return Object.freeze([]);
    const first = this.history[this.historyStart];
    if (first === undefined || serverSeq < first.serverSeq - 1) return null;
    return Object.freeze(this.history.slice(this.historyStart + serverSeq - first.serverSeq + 1));
  }

  /** Appends to retained history in amortized O(1); runs only after the commit is fully applied. */
  private retain(commit: ServerCommit<DocumentOperation<S>>): void {
    if (this.historyLimit === 0) return;
    this.history.push(commit);
    if (this.history.length - this.historyStart > this.historyLimit) this.historyStart++;
    // Compact once the evicted prefix is at least as long as the retained window.
    if (this.historyStart >= Math.max(this.historyLimit, 1024)) {
      this.history = this.history.slice(this.historyStart);
      this.historyStart = 0;
    }
  }

  /** Resolves the next batch or replays this client's last identical batch. */
  receive(
    batch: ClientBatch<DocumentOperation<S>>
  ): ServerReceipt<DocumentOperation<S>> {
    return this.processBatch(batch, false);
  }

  /** Rejects a new batch, or replays its original result if already processed. */
  reject(
    batch: ClientBatch<DocumentOperation<S>>
  ): ServerReceipt<DocumentOperation<S>> {
    return this.processBatch(batch, true);
  }

  private processBatch(
    batch: ClientBatch<DocumentOperation<S>>,
    reject: boolean
  ): ServerReceipt<DocumentOperation<S>> {
    if (this.receiving) {
      throw new Error(`Cannot call server.${reject ? "reject" : "receive"}() reentrantly`);
    }

    this.receiving = true;
    try {
      const previous = this.clients.get(batch.clientId);
      if (previous === undefined) throw new Error("Client session is not open");
      const expectedClientSeq = (previous?.batch.seq ?? 0) + 1;
      if (previous !== null && batch.seq === previous.batch.seq) {
        if (!jsonEquals(batch.operations, previous.batch.operations)) {
          throw new Error(
            `Retry batch differs from the saved batch for ${batch.clientId} sequence ${batch.seq}`
          );
        }
        return Object.freeze({ commit: previous.commit, replayed: true });
      }
      if (batch.seq !== expectedClientSeq) {
        throw new Error(
          `Expected client sequence ${expectedClientSeq} for ${batch.clientId}, received ${batch.seq}`
        );
      }
      if (!Number.isSafeInteger(this.nextServerSeq)) {
        throw new Error("Server sequence exhausted");
      }

      const incomingOperations = freezeOperations(batch.operations);
      const ownedBatch: ClientBatch<DocumentOperation<S>> = Object.freeze({
        clientId: batch.clientId,
        seq: batch.seq,
        operations: incomingOperations,
      });
      if (!reject && !this.allowCustomClientNamespaces) {
        assertClientBatchNamespace(ownedBatch, ownedBatch.clientId);
      }
      // A rejected batch is never applied, so its payloads need not be valid.
      if (!reject) checkOperationPayloads(this.definition, incomingOperations);
      const states = this.authoritativeStates;
      const watermark = this.nextServerSeq - 1;
      let snapshot: DocumentSnapshot<S> | undefined;
      const resolvedOperations =
        reject
          ? []
          : this.resolve === undefined
            ? incomingOperations
            : this.resolve(
                Object.freeze({
                  batch: ownedBatch,
                  get snapshot(): DocumentSnapshot<S> {
                    // Capture pre-batch state even if the context is read after later commits.
                    return snapshot ??= saveSnapshot<S>(states, watermark);
                  },
                })
              );
      if (!Array.isArray(resolvedOperations)) {
        throw new Error("Server resolver must return an array of operations");
      }

      const operations = freezeOperations<DocumentOperation<S>>(resolvedOperations);
      checkOperationPayloads(this.definition, operations);
      const nextAuthoritativeStates = new Map(this.authoritativeStates);
      applyOperations(nextAuthoritativeStates, operations);

      const commit: ServerCommit<DocumentOperation<S>> = Object.freeze({
        serverSeq: this.nextServerSeq,
        source: Object.freeze({ clientId: ownedBatch.clientId, seq: ownedBatch.seq }),
        operations,
      });
      this.authoritativeStates = nextAuthoritativeStates;
      this.clients.set(
        ownedBatch.clientId,
        Object.freeze({ batch: ownedBatch, commit })
      );
      this.retain(commit);
      this.nextServerSeq++;
      return Object.freeze({ commit, replayed: false });
    } finally {
      this.receiving = false;
    }
  }
}

export function createClient<S extends SchemaShape>(
  schema: DocumentSchema<S>,
  options: CreateClientOptions<S>
): ClientDocument<S> {
  return new ClientDocument(schema, options);
}

export function createServer<S extends SchemaShape>(
  schema: DocumentSchema<S>,
  options: CreateServerOptions<S> = {}
): ServerDocument<S> {
  return new ServerDocument(schema, options);
}
