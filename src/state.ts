import { ListState, type ListSetOperation, type ListSnapshotData } from "./list.ts";
import { TextState, type TextSnapshotData } from "./text.ts";
import { MapState, type MapSnapshotData } from "./map.ts";
import type { DocumentSchema, JsonValue, SchemaShape } from "./schema.ts";
import type {
  ClientBatch,
  DocumentSnapshot,
  DocumentSnapshotData,
  Operation,
  PendingReplayConflict,
} from "./runtime.ts";
import { CollectionConflictError, PendingReplayError } from "./conflict.ts";
import { validateJsonValue } from "./json.ts";

/** Collection states that are not plain Value payloads. */
export type StructuredState = ListState<JsonValue> | TextState | MapState<JsonValue>;

export type CollectionState = JsonValue | StructuredState;

export function isStructuredState(state: CollectionState): state is StructuredState {
  return state instanceof ListState || state instanceof TextState || state instanceof MapState;
}

// Only decoder-owned, frozen snapshots enter this cache; states remain persistent.
export const decodedCollectionStates = new WeakMap<object, StructuredState>();

export function wrongCollectionKind(path: string): Error {
  return new Error(`Operation type does not match document path: ${path}`);
}

export function unknownOperationType(operation: unknown): Error {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Diagnostic access only; invalid operation behavior is intentionally preserved.
  const type = (operation as { readonly type?: unknown }).type;
  return new Error(`Unknown operation type: ${String(type)}`);
}

/** Applies operations in order; `onDiscardedSet` sees each list/set whose target was already deleted. */
export function applyOperations(
  states: Map<string, CollectionState>,
  operations: readonly Operation[],
  onDiscardedSet?: (operation: ListSetOperation) => void
): void {
  for (const operation of operations) {
    if (!states.has(operation.path)) {
      throw new Error(`Unknown document path: ${operation.path}`);
    }
    const current = states.get(operation.path)!;

    switch (operation.type) {
      case "value/set":
        if (isStructuredState(current)) {
          throw wrongCollectionKind(operation.path);
        }
        states.set(operation.path, operation.value);
        break;
      case "list/insert":
        if (!(current instanceof ListState)) {
          throw wrongCollectionKind(operation.path);
        }
        states.set(operation.path, current.insert(operation));
        break;
      case "list/delete":
        if (!(current instanceof ListState)) {
          throw wrongCollectionKind(operation.path);
        }
        states.set(operation.path, current.delete(operation));
        break;
      case "list/set":
        if (!(current instanceof ListState)) {
          throw wrongCollectionKind(operation.path);
        }
        states.set(operation.path, current.set(operation));
        // set() has thrown for unknown targets, so an absent target here is a tombstone.
        if (onDiscardedSet !== undefined && !current.has(operation.id)) onDiscardedSet(operation);
        break;
      case "text/insert":
        if (!(current instanceof TextState)) {
          throw wrongCollectionKind(operation.path);
        }
        states.set(operation.path, current.insert(operation));
        break;
      case "text/delete":
        if (!(current instanceof TextState)) {
          throw wrongCollectionKind(operation.path);
        }
        states.set(operation.path, current.delete(operation));
        break;
      case "map/set":
        if (!(current instanceof MapState)) {
          throw wrongCollectionKind(operation.path);
        }
        states.set(operation.path, current.set(operation));
        break;
      case "map/delete":
        if (!(current instanceof MapState)) {
          throw wrongCollectionKind(operation.path);
        }
        states.set(operation.path, current.delete(operation));
        break;
      default:
        throw unknownOperationType(operation);
    }
  }
}

/** Replay whole batches only, retaining the last complete optimistic prefix. */
export function replayPending<TOperation extends Operation>(
  authoritative: ReadonlyMap<string, CollectionState>,
  pending: readonly ClientBatch<TOperation>[]
): {
  readonly states: Map<string, CollectionState>;
  readonly conflict: PendingReplayConflict<TOperation> | null;
} {
  let states = new Map(authoritative);
  for (const [batchIndex, batch] of pending.entries()) {
    const next = new Map(states);
    for (const [operationIndex, operation] of batch.operations.entries()) {
      try {
        applyOperations(next, [operation]);
      } catch (error) {
        if (!(error instanceof CollectionConflictError)) {
          throw new PendingReplayError(batchIndex, operationIndex, error);
        }
        return {
          states,
          conflict: Object.freeze({ batch, operationIndex, message: error.message }),
        };
      }
    }
    states = next;
  }
  return { states, conflict: null };
}

function validateSnapshot<S extends SchemaShape>(
  schema: DocumentSchema<S>,
  snapshot: DocumentSnapshot<S>
): Readonly<Record<string, unknown>> {
  if (typeof snapshot !== "object" || snapshot === null) {
    throw new Error("Snapshot must be an object");
  }
  if (!Number.isSafeInteger(snapshot.serverSeq) || snapshot.serverSeq < 0) {
    throw new Error(
      `Snapshot server sequence must be a non-negative safe integer: ${snapshot.serverSeq}`
    );
  }
  if (
    typeof snapshot.data !== "object" ||
    snapshot.data === null ||
    Array.isArray(snapshot.data)
  ) {
    throw new Error("Snapshot data must be an object");
  }

  const schemaPaths = Object.keys(schema.definition);
  const snapshotData = snapshot.data as Readonly<Record<string, unknown>>;
  for (const path of schemaPaths) {
    if (!Object.hasOwn(snapshotData, path)) {
      throw new Error(`Missing snapshot path: ${path}`);
    }
  }

  const schemaPathSet = new Set(schemaPaths);
  for (const path of Object.keys(snapshotData)) {
    if (!schemaPathSet.has(path)) {
      throw new Error(`Unknown snapshot path: ${path}`);
    }
  }
  return snapshotData;
}

export function initialStates<S extends SchemaShape>(
  schema: DocumentSchema<S>,
  snapshot: DocumentSnapshot<S> | undefined
): Map<string, CollectionState> {
  const snapshotData =
    snapshot === undefined ? undefined : validateSnapshot(schema, snapshot);
  const states = new Map<string, CollectionState>();

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The fixed schema’s own keys are the document paths.
  for (const path of Object.keys(schema.definition) as Array<
    Extract<keyof S, string>
  >) {
    const descriptor = schema.definition[path];
    const payload = snapshotData?.[path];
    const decoded = typeof payload === "object" && payload !== null
      ? decodedCollectionStates.get(payload) : undefined;
    if (descriptor.kind === "value") {
      const value =
        snapshotData === undefined
          ? descriptor.initialValue
          : payload;
      if (snapshotData === undefined) validateJsonValue(value, [path]);
      if (value === undefined) {
        throw new Error(`Missing document path: ${path}`);
      }
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Typed snapshot boundary supplies the matching payload; collection loaders retain their runtime checks.
      states.set(path, value as JsonValue);
    } else if (descriptor.kind === "list") {
      states.set(
        path,
        snapshotData === undefined
          ? ListState.empty()
          : decoded instanceof ListState
            ? decoded
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Typed snapshot boundary supplies the matching payload; collection loaders retain their runtime checks.
            : ListState.load(payload as ListSnapshotData)
      );
    } else if (descriptor.kind === "map") {
      states.set(
        path,
        snapshotData === undefined
          ? MapState.empty()
          : decoded instanceof MapState
            ? decoded
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Typed snapshot boundary supplies the matching payload; collection loaders retain their runtime checks.
            : MapState.load(payload as MapSnapshotData)
      );
    } else {
      states.set(
        path,
        snapshotData === undefined
          ? TextState.empty()
          : decoded instanceof TextState
            ? decoded
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Typed snapshot boundary supplies the matching payload; collection loaders retain their runtime checks.
            : TextState.load(payload as TextSnapshotData)
      );
    }
  }
  return states;
}

/** Saves authoritative state, never pending optimistic values. */
export function saveSnapshot<S extends SchemaShape>(
  states: ReadonlyMap<string, CollectionState>,
  serverSeq: number
): DocumentSnapshot<S> {
  const data = Object.freeze(
    Object.fromEntries(
      [...states].map(([path, state]) => [
        path,
        isStructuredState(state) ? state.save() : state,
      ])
    )
  ) as DocumentSnapshotData<S>; // oxlint-disable-line typescript/no-unsafe-type-assertion -- Each state was created for the corresponding schema descriptor before serialization.
  return Object.freeze({ serverSeq, data });
}
