import { ListState, type ListSnapshotData } from "./list.ts";
import { TextState, type TextSnapshotData } from "./text.ts";
import type { DocumentSchema, JsonValue, SchemaShape } from "./schema.ts";
import type {
  DocumentSnapshot,
  DocumentSnapshotData,
  Operation,
} from "./runtime.ts";

export type CollectionState = JsonValue | ListState<JsonValue> | TextState;

export function wrongCollectionKind(path: string): Error {
  return new Error(`Operation type does not match document path: ${path}`);
}

export function unknownOperationType(operation: unknown): Error {
  const type = (operation as { readonly type?: unknown }).type;
  return new Error(`Unknown operation type: ${String(type)}`);
}

export function applyOperations(
  states: Map<string, CollectionState>,
  operations: readonly Operation[]
): void {
  for (const operation of operations) {
    if (!states.has(operation.path)) {
      throw new Error(`Unknown document path: ${operation.path}`);
    }
    const current = states.get(operation.path)!;

    switch (operation.type) {
      case "value/set":
        if (current instanceof ListState || current instanceof TextState) {
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
      default:
        throw unknownOperationType(operation);
    }
  }
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

  for (const path of Object.keys(schema.definition) as Array<
    Extract<keyof S, string>
  >) {
    const descriptor = schema.definition[path];
    if (descriptor.kind === "value") {
      const value =
        snapshotData === undefined
          ? descriptor.initialValue
          : snapshotData[path];
      if (value === undefined) {
        throw new Error(`Missing document path: ${path}`);
      }
      states.set(path, value as JsonValue);
    } else if (descriptor.kind === "list") {
      states.set(
        path,
        snapshotData === undefined
          ? ListState.empty()
          : ListState.load(snapshotData[path] as ListSnapshotData<JsonValue>)
      );
    } else {
      states.set(
        path,
        snapshotData === undefined
          ? TextState.empty()
          : TextState.load(snapshotData[path] as TextSnapshotData)
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
        state instanceof ListState || state instanceof TextState
          ? state.save()
          : state,
      ])
    )
  ) as DocumentSnapshotData<S>;
  return Object.freeze({ serverSeq, data });
}
