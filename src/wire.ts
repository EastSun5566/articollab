import type { ElementId } from "articulated";
import { jsonEquals } from "./json.ts";
import { initialStates, replayPending } from "./state.ts";
import { PendingReplayError } from "./conflict.ts";

import {
  ListState,
  type ListSnapshotData,
  type SavedIdRange,
} from "./list.ts";
import type {
  DocumentSchema,
  JsonValue,
  SchemaShape,
} from "./schema.ts";
import {
  TextState,
  type TextIdRange,
  type TextSnapshotData,
} from "./text.ts";
import type {
  ClientBatch,
  ClientBatchRef,
  ClientCheckpoint,
  DocumentOperation,
  DocumentSnapshot,
  DocumentSnapshotData,
  ServerCheckpoint,
  ServerCommit,
} from "./runtime.ts";

type PathSegment = string | number;
type WireRecord = Readonly<Record<string, unknown>>;

/** An invalid value encountered while decoding parsed wire JSON. */
export class WireDecodeError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`Invalid wire value at ${path}: ${message}`);
    this.name = "WireDecodeError";
    this.path = path;
  }
}

function jsonPointer(path: readonly PathSegment[]): string {
  if (path.length === 0) return "/";
  return path
    .map((segment) =>
      `/${String(segment).replaceAll("~", "~0").replaceAll("/", "~1")}`
    )
    .join("");
}

function fail(path: readonly PathSegment[], message: string): never {
  throw new WireDecodeError(jsonPointer(path), message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function decodeRecord(
  input: unknown,
  path: readonly PathSegment[],
  name: string
): WireRecord {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    fail(path, `${name} must be a plain object`);
  }

  const prototype: unknown = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    fail(path, `${name} must be a plain object`);
  }

  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string") {
      fail(path, `${name} must only have string keys`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      fail([...path, key], `${name} fields must be enumerable data properties`);
    }
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Plain enumerable data properties were checked above; values stay unknown.
  return input as WireRecord;
}

function requireExactFields(
  record: WireRecord,
  path: readonly PathSegment[],
  fields: readonly string[]
): void {
  const allowed = new Set(fields);
  for (const field of fields) {
    if (!Object.hasOwn(record, field)) {
      fail([...path, field], "field is required");
    }
  }
  for (const field of Object.keys(record)) {
    if (!allowed.has(field)) {
      fail([...path, field], "field is not allowed");
    }
  }
}

function decodeDenseArray(
  input: unknown,
  path: readonly PathSegment[],
  name: string
): readonly unknown[] {
  if (!Array.isArray(input)) fail(path, `${name} must be an array`);

  let indexCount = 0;
  for (const key of Reflect.ownKeys(input)) {
    if (key === "length") continue;
    if (typeof key !== "string") {
      fail(path, `${name} must only have array indexes`);
    }
    const index = Number(key);
    if (
      !Number.isSafeInteger(index) ||
      index < 0 ||
      String(index) !== key ||
      index >= input.length
    ) {
      fail([...path, key], `${name} must only have array indexes`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      fail(
        [...path, index],
        `${name} entries must be enumerable data properties`
      );
    }
    indexCount++;
  }

  if (indexCount !== input.length) {
    fail(path, `${name} must be a dense array`);
  }
  return input;
}

function decodeString(
  input: unknown,
  path: readonly PathSegment[],
  name: string,
  nonEmpty = false
): string {
  if (typeof input !== "string") fail(path, `${name} must be a string`);
  if (nonEmpty && input.length === 0) fail(path, `${name} must not be empty`);
  return input;
}

function decodeBoolean(
  input: unknown,
  path: readonly PathSegment[],
  name: string
): boolean {
  if (typeof input !== "boolean") fail(path, `${name} must be a boolean`);
  return input;
}

function decodeSafeInteger(
  input: unknown,
  path: readonly PathSegment[],
  name: string,
  minimum: number
): number {
  if (
    typeof input !== "number" ||
    !Number.isSafeInteger(input) ||
    input < minimum
  ) {
    fail(
      path,
      `${name} must be a safe integer greater than or equal to ${minimum}`
    );
  }
  return input;
}

function assertSafeRangeEnd(
  start: number,
  count: number,
  path: readonly PathSegment[]
): void {
  if (start > Number.MAX_SAFE_INTEGER - count + 1) {
    fail(path, "range end must be a safe integer");
  }
}

function decodeJsonValue(
  input: unknown,
  path: readonly PathSegment[]
): JsonValue {
  const currentPath = [...path];
  const ancestors = new WeakSet<object>();
  const stack: Array<{
    input: object;
    output: JsonValue[] | Record<string, JsonValue>;
    entries: Iterator<[PathSegment, unknown]>;
  }> = [];

  // Reading a container schedules its children; it never recursively reads them.
  const read = (value: unknown): JsonValue => {
    if (value === null || typeof value === "string" || typeof value === "boolean") {
      return value;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) fail(currentPath, "number must be finite");
      return value;
    }
    if (typeof value !== "object") fail(currentPath, "value must be JSON-compatible");
    if (ancestors.has(value)) fail(currentPath, "value must not contain a cycle");

    const output: JsonValue[] | Record<string, JsonValue> = Array.isArray(value) ? [] : {};
    const entries = Array.isArray(value)
      ? decodeDenseArray(value, currentPath, "JSON array").entries()
      : Object.entries(decodeRecord(value, currentPath, "JSON object")).values();
    ancestors.add(value);
    stack.push({ input: value, output, entries });
    return output;
  };

  const result = read(input);
  while (stack.length > 0) {
    const frame = stack[stack.length - 1]!;
    const next = frame.entries.next();
    if (next.done) {
      Object.freeze(frame.output);
      ancestors.delete(frame.input);
      stack.pop();
      if (stack.length > 0) currentPath.pop();
      continue;
    }

    const [key, value] = next.value;
    currentPath.push(key);
    const depth = stack.length;
    const decoded = read(value);
    // Define data properties explicitly so keys such as __proto__ stay ordinary JSON.
    Object.defineProperty(frame.output, key, {
      value: decoded, enumerable: true, writable: true, configurable: true,
    });
    if (stack.length === depth) currentPath.pop();
  }
  return result;
}

function decodeElementId(
  input: unknown,
  path: readonly PathSegment[]
): Readonly<ElementId> {
  const record = decodeRecord(input, path, "ElementId");
  requireExactFields(record, path, ["bunchId", "counter"]);
  return Object.freeze({
    bunchId: decodeString(
      record.bunchId,
      [...path, "bunchId"],
      "ElementId bunchId",
      true
    ),
    counter: decodeSafeInteger(
      record.counter,
      [...path, "counter"],
      "ElementId counter",
      0
    ),
  });
}

function decodeOptionalElementId(
  input: unknown,
  path: readonly PathSegment[]
): Readonly<ElementId> | null {
  return input === null ? null : decodeElementId(input, path);
}

function decodeTextRange(
  input: unknown,
  path: readonly PathSegment[]
): TextIdRange {
  const record = decodeRecord(input, path, "Text id range");
  requireExactFields(record, path, ["start", "count"]);
  const start = decodeElementId(record.start, [...path, "start"]);
  const count = decodeSafeInteger(
    record.count,
    [...path, "count"],
    "Text id range count",
    1
  );
  assertSafeRangeEnd(start.counter, count, [...path, "count"]);
  return Object.freeze({ start, count });
}

function descriptorForPath<S extends SchemaShape>(
  schema: DocumentSchema<S>,
  pathValue: unknown,
  path: readonly PathSegment[]
): { readonly path: string; readonly kind: "value" | "list" | "text" } {
  const operationPath = decodeString(pathValue, path, "Operation path", true);
  if (!Object.hasOwn(schema.definition, operationPath)) {
    fail(path, `unknown document path: ${operationPath}`);
  }
  return {
    path: operationPath,
    kind: schema.definition[operationPath]!.kind,
  };
}

function requireKind(
  actual: "value" | "list" | "text",
  expected: "value" | "list" | "text",
  path: readonly PathSegment[]
): void {
  if (actual !== expected) {
    fail(path, `operation requires a ${expected} document path`);
  }
}

function decodeOperation<S extends SchemaShape>(
  schema: DocumentSchema<S>,
  input: unknown,
  path: readonly PathSegment[]
): DocumentOperation<S> {
  const record = decodeRecord(input, path, "Operation");
  if (!Object.hasOwn(record, "type")) fail([...path, "type"], "field is required");
  if (!Object.hasOwn(record, "path")) fail([...path, "path"], "field is required");

  const type = decodeString(record.type, [...path, "type"], "Operation type");
  const descriptor = descriptorForPath(schema, record.path, [...path, "path"]);

  switch (type) {
    case "value/set": {
      requireExactFields(record, path, ["type", "path", "value"]);
      requireKind(descriptor.kind, "value", [...path, "path"]);
      return Object.freeze({
        type,
        path: descriptor.path,
        value: decodeJsonValue(record.value, [...path, "value"]),
      }) as DocumentOperation<S>; // oxlint-disable-line typescript/no-unsafe-type-assertion -- Path and collection kind were checked above; business payload T remains the caller’s responsibility.
    }
    case "list/insert": {
      requireExactFields(record, path, [
        "type",
        "path",
        "before",
        "id",
        "value",
      ]);
      requireKind(descriptor.kind, "list", [...path, "path"]);
      return Object.freeze({
        type,
        path: descriptor.path,
        before: decodeOptionalElementId(record.before, [...path, "before"]),
        id: decodeElementId(record.id, [...path, "id"]),
        value: decodeJsonValue(record.value, [...path, "value"]),
      }) as DocumentOperation<S>; // oxlint-disable-line typescript/no-unsafe-type-assertion -- Path and collection kind were checked above; business payload T remains the caller’s responsibility.
    }
    case "list/delete": {
      requireExactFields(record, path, ["type", "path", "id"]);
      requireKind(descriptor.kind, "list", [...path, "path"]);
      return Object.freeze({
        type,
        path: descriptor.path,
        id: decodeElementId(record.id, [...path, "id"]),
      }) as DocumentOperation<S>; // oxlint-disable-line typescript/no-unsafe-type-assertion -- Path and collection kind were checked above; business payload T remains the caller’s responsibility.
    }
    case "text/insert": {
      requireExactFields(record, path, [
        "type",
        "path",
        "before",
        "id",
        "value",
      ]);
      requireKind(descriptor.kind, "text", [...path, "path"]);
      const id = decodeElementId(record.id, [...path, "id"]);
      const value = decodeString(
        record.value,
        [...path, "value"],
        "Text insert value",
        true
      );
      assertSafeRangeEnd(
        id.counter,
        // oxlint-disable-next-line typescript/no-misused-spread -- Text deliberately uses Unicode code points, not grapheme clusters.
        [...value].length,
        [...path, "id", "counter"]
      );
      return Object.freeze({
        type,
        path: descriptor.path,
        before: decodeOptionalElementId(record.before, [...path, "before"]),
        id,
        value,
      }) as DocumentOperation<S>; // oxlint-disable-line typescript/no-unsafe-type-assertion -- Path and collection kind were checked above; business payload T remains the caller’s responsibility.
    }
    case "text/delete": {
      requireExactFields(record, path, ["type", "path", "ranges"]);
      requireKind(descriptor.kind, "text", [...path, "path"]);
      const inputRanges = decodeDenseArray(
        record.ranges,
        [...path, "ranges"],
        "Text delete ranges"
      );
      if (inputRanges.length === 0) {
        fail([...path, "ranges"], "Text delete ranges must not be empty");
      }
      const ranges = Object.freeze(
        inputRanges.map((range, index) =>
          decodeTextRange(range, [...path, "ranges", index])
        )
      );
      return Object.freeze({
        type,
        path: descriptor.path,
        ranges,
      }) as DocumentOperation<S>; // oxlint-disable-line typescript/no-unsafe-type-assertion -- Path and collection kind were checked above; business payload T remains the caller’s responsibility.
    }
    default:
      return fail([...path, "type"], `unknown operation type: ${type}`);
  }
}

function decodeOperations<S extends SchemaShape>(
  schema: DocumentSchema<S>,
  input: unknown,
  path: readonly PathSegment[],
  allowEmpty: boolean
): readonly DocumentOperation<S>[] {
  const operations = decodeDenseArray(input, path, "Operations");
  if (!allowEmpty && operations.length === 0) {
    fail(path, "Client batch operations must not be empty");
  }
  return Object.freeze(
    operations.map((operation, index) =>
      decodeOperation(schema, operation, [...path, index])
    )
  );
}

function decodeBatchRef(
  input: unknown,
  path: readonly PathSegment[],
  name: string
): ClientBatchRef {
  const record = decodeRecord(input, path, name);
  requireExactFields(record, path, ["clientId", "seq"]);
  return Object.freeze({
    clientId: decodeString(
      record.clientId,
      [...path, "clientId"],
      `${name} clientId`,
      true
    ),
    seq: decodeSafeInteger(record.seq, [...path, "seq"], `${name} sequence`, 1),
  });
}

function decodeSavedIdRange(
  input: unknown,
  path: readonly PathSegment[]
): SavedIdRange {
  const record = decodeRecord(input, path, "Saved id range");
  requireExactFields(record, path, [
    "bunchId",
    "startCounter",
    "count",
    "isDeleted",
  ]);
  const startCounter = decodeSafeInteger(
    record.startCounter,
    [...path, "startCounter"],
    "Saved id range startCounter",
    0
  );
  const count = decodeSafeInteger(
    record.count,
    [...path, "count"],
    "Saved id range count",
    1
  );
  assertSafeRangeEnd(startCounter, count, [...path, "count"]);
  return Object.freeze({
    bunchId: decodeString(
      record.bunchId,
      [...path, "bunchId"],
      "Saved id range bunchId",
      true
    ),
    startCounter,
    count,
    isDeleted: decodeBoolean(
      record.isDeleted,
      [...path, "isDeleted"],
      "Saved id range isDeleted"
    ),
  });
}

function decodeSavedIdList(
  input: unknown,
  path: readonly PathSegment[]
): readonly SavedIdRange[] {
  const inputRanges = decodeDenseArray(input, path, "Saved id list");
  const ranges = inputRanges.map((range, index) =>
    decodeSavedIdRange(range, [...path, index])
  );

  const intervalsByBunch = new Map<
    string,
    Array<{ readonly index: number; readonly start: number; readonly end: number }>
  >();
  for (let index = 0; index < ranges.length; index++) {
    const range = ranges[index]!;
    const intervals = intervalsByBunch.get(range.bunchId) ?? [];
    intervals.push({
      index,
      start: range.startCounter,
      end: range.startCounter + range.count - 1,
    });
    intervalsByBunch.set(range.bunchId, intervals);
  }
  for (const intervals of intervalsByBunch.values()) {
    intervals.sort((left, right) => left.start - right.start);
    for (let index = 1; index < intervals.length; index++) {
      const previous = intervals[index - 1]!;
      const current = intervals[index]!;
      if (current.start <= previous.end) {
        fail(
          [...path, current.index, "startCounter"],
          "saved id ranges must not overlap"
        );
      }
    }
  }

  return Object.freeze(ranges);
}

function validateSnapshotCollection(
  kind: "list" | "text",
  snapshot: ListSnapshotData | TextSnapshotData,
  path: readonly PathSegment[]
): void {
  try {
    if (kind === "list") {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The caller constructs this snapshot for the selected collection kind, then hydration validates it.
      ListState.load(snapshot as ListSnapshotData);
    } else {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The caller constructs this snapshot for the selected collection kind, then hydration validates it.
      TextState.load(snapshot as TextSnapshotData);
    }
  } catch (error) {
    fail(path, `invalid ${kind} snapshot: ${errorMessage(error)}`);
  }
}

function decodeSnapshotCollection(
  kind: "value" | "list" | "text",
  input: unknown,
  path: readonly PathSegment[]
): JsonValue | ListSnapshotData | TextSnapshotData {
  if (kind === "value") return decodeJsonValue(input, path);

  const record = decodeRecord(input, path, `${kind} snapshot`);
  if (kind === "list") {
    requireExactFields(record, path, ["idList", "values"]);
    const inputValues = decodeDenseArray(
      record.values,
      [...path, "values"],
      "List snapshot values"
    );
    const snapshot: ListSnapshotData = Object.freeze({
      idList: decodeSavedIdList(record.idList, [...path, "idList"]),
      values: Object.freeze(
        inputValues.map((value, index) =>
          decodeJsonValue(value, [...path, "values", index])
        )
      ),
    });
    validateSnapshotCollection(kind, snapshot, path);
    return snapshot;
  }

  requireExactFields(record, path, ["idList", "value"]);
  const snapshot: TextSnapshotData = Object.freeze({
    idList: decodeSavedIdList(record.idList, [...path, "idList"]),
    value: decodeString(
      record.value,
      [...path, "value"],
      "Text snapshot value"
    ),
  });
  validateSnapshotCollection(kind, snapshot, path);
  return snapshot;
}

/** Decodes a parsed client batch before passing it to server.receive(). */
export function decodeClientBatch<S extends SchemaShape>(
  schema: DocumentSchema<S>,
  input: unknown
): ClientBatch<DocumentOperation<S>> {
  return decodeClientBatchAt(schema, input, []);
}

function decodeClientBatchAt<S extends SchemaShape>(
  schema: DocumentSchema<S>,
  input: unknown,
  path: readonly PathSegment[]
): ClientBatch<DocumentOperation<S>> {
  const record = decodeRecord(input, path, "Client batch");
  requireExactFields(record, path, ["clientId", "seq", "operations"]);
  return Object.freeze({
    clientId: decodeString(
      record.clientId, [...path, "clientId"], "Client id", true
    ),
    seq: decodeSafeInteger(record.seq, [...path, "seq"], "Client sequence", 1),
    operations: decodeOperations(
      schema, record.operations, [...path, "operations"], false
    ),
  });
}

/** Decodes a parsed server commit before passing it to client.receive(). */
export function decodeServerCommit<S extends SchemaShape>(
  schema: DocumentSchema<S>,
  input: unknown
): ServerCommit<DocumentOperation<S>> {
  return decodeServerCommitAt(schema, input, []);
}

function decodeServerCommitAt<S extends SchemaShape>(
  schema: DocumentSchema<S>,
  input: unknown,
  path: readonly PathSegment[]
): ServerCommit<DocumentOperation<S>> {
  const record = decodeRecord(input, path, "Server commit");
  requireExactFields(record, path, ["serverSeq", "source", "operations"]);
  return Object.freeze({
    serverSeq: decodeSafeInteger(
      record.serverSeq,
      [...path, "serverSeq"],
      "Server sequence",
      1
    ),
    source: decodeBatchRef(record.source, [...path, "source"], "Commit source"),
    operations: decodeOperations(
      schema, record.operations, [...path, "operations"], true
    ),
  });
}

function decodeSnapshotAt<S extends SchemaShape>(
  schema: DocumentSchema<S>,
  input: unknown,
  path: readonly PathSegment[]
): DocumentSnapshot<S> {
  const record = decodeRecord(input, path, "Document snapshot");
  requireExactFields(record, path, ["serverSeq", "data"]);
  const serverSeq = decodeSafeInteger(
    record.serverSeq,
    [...path, "serverSeq"],
    "Snapshot server sequence",
    0
  );
  const dataPath = [...path, "data"];
  const dataRecord = decodeRecord(record.data, dataPath, "Snapshot data");
  const schemaPaths = Object.keys(schema.definition);
  requireExactFields(dataRecord, dataPath, schemaPaths);

  const data = Object.freeze(
    Object.fromEntries(
      schemaPaths.map((documentPath) => [
        documentPath,
        decodeSnapshotCollection(
          schema.definition[documentPath]!.kind,
          dataRecord[documentPath],
          [...dataPath, documentPath]
        ),
      ])
    )
  ) as DocumentSnapshotData<S>; // oxlint-disable-line typescript/no-unsafe-type-assertion -- Every schema path and collection payload has been decoded before restoring the mapped type.

  return Object.freeze({
    serverSeq,
    data,
  });
}

/** Decodes a parsed document snapshot before hydrating a client. */
export function decodeSnapshot<S extends SchemaShape>(
  schema: DocumentSchema<S>,
  input: unknown
): DocumentSnapshot<S> {
  return decodeSnapshotAt(schema, input, []);
}

/** Identifies only canonical bunch IDs generated by this client for this path. */
function localBunchSeq(
  bunchId: string,
  clientId: string,
  path: string
): number | undefined {
  let parts: unknown;
  try {
    parts = JSON.parse(bunchId);
  } catch {
    return undefined;
  }
  if (
    !Array.isArray(parts) ||
    parts.length !== 3 ||
    parts[0] !== clientId ||
    parts[1] !== path ||
    !Number.isSafeInteger(parts[2]) ||
    parts[2] < 1 ||
    JSON.stringify(parts) !== bunchId
  ) {
    return undefined;
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Number.isSafeInteger and bounds above validate this parsed allocation counter.
  return parts[2] as number;
}

/** Decodes and validates the pending replay needed to restore a client. */
export function decodeClientCheckpoint<S extends SchemaShape>(
  schema: DocumentSchema<S>,
  input: unknown
): ClientCheckpoint<S> {
  const record = decodeRecord(input, [], "Client checkpoint");
  requireExactFields(record, [], [
    "clientId",
    "snapshot",
    "lastLocalSeq",
    "pendingBatches",
    "lastBunchSeqs",
  ]);
  const clientId = decodeString(record.clientId, ["clientId"], "Client id", true);
  const snapshot = decodeSnapshotAt(schema, record.snapshot, ["snapshot"]);
  const lastLocalSeq = decodeSafeInteger(
    record.lastLocalSeq, ["lastLocalSeq"], "Last local sequence", 0
  );
  const inputPending = decodeDenseArray(
    record.pendingBatches, ["pendingBatches"], "Pending batches"
  );
  const pendingBatches = Object.freeze(
    inputPending.map((batch, index) =>
      decodeClientBatchAt(schema, batch, ["pendingBatches", index])
    )
  );
  if (pendingBatches.length > lastLocalSeq) {
    fail(["pendingBatches"], "pending count must not exceed lastLocalSeq");
  }
  const acknowledgedLocalSeq = lastLocalSeq - pendingBatches.length;
  if (acknowledgedLocalSeq > snapshot.serverSeq) {
    fail(
      ["snapshot", "serverSeq"],
      "watermark must include all acknowledged local batches"
    );
  }

  const allocationPaths = Object.keys(schema.definition).filter(
    (path) => schema.definition[path]!.kind !== "value"
  );
  const allocationRecord = decodeRecord(
    record.lastBunchSeqs, ["lastBunchSeqs"], "Bunch sequences"
  );
  requireExactFields(allocationRecord, ["lastBunchSeqs"], allocationPaths);
  const allocations = Object.freeze(
    Object.fromEntries(
      allocationPaths.map((path) => [
        path,
        decodeSafeInteger(
          allocationRecord[path],
          ["lastBunchSeqs", path],
          "Last bunch sequence",
          0
        ),
      ])
    )
  );
  for (const path of allocationPaths) {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Allocation paths contain only List/Text descriptors in this validated snapshot.
    const data = snapshot.data[path] as ListSnapshotData | TextSnapshotData;
    for (const range of data.idList) {
      const seq = localBunchSeq(range.bunchId, clientId, path);
      if (seq !== undefined && seq > allocations[path]!) {
        fail(
          ["lastBunchSeqs", path],
          "bunch sequence must cover snapshot IDs, including tombstones"
        );
      }
    }
  }

  const insertedRanges = new Map<string, Array<{
    start: number; end: number; path: readonly PathSegment[];
  }>>();
  for (const [batchIndex, batch] of pendingBatches.entries()) {
    const batchPath = ["pendingBatches", batchIndex] as const;
    if (batch.clientId !== clientId) {
      fail(
        [...batchPath, "clientId"],
        "pending batch must belong to checkpoint client"
      );
    }
    if (batch.seq !== acknowledgedLocalSeq + batchIndex + 1) {
      fail(
        [...batchPath, "seq"],
        "pending sequences must be a consecutive suffix ending at lastLocalSeq"
      );
    }
    for (const [operationIndex, operation] of batch.operations.entries()) {
      const operationPath = [...batchPath, "operations", operationIndex];
      if (operation.type === "list/insert" || operation.type === "text/insert") {
        const seq = localBunchSeq(operation.id.bunchId, clientId, operation.path);
        if (seq === undefined) {
          fail(
            [...operationPath, "id", "bunchId"],
            "pending insert must use this client/path's canonical bunch ID"
          );
        }
        if (seq > allocations[operation.path]!) {
          fail(
            ["lastBunchSeqs", operation.path],
            "bunch sequence must cover pending insert IDs"
          );
        }
        const key = JSON.stringify([operation.path, operation.id.bunchId]);
        const ranges = insertedRanges.get(key) ?? [];
        // oxlint-disable-next-line typescript/no-misused-spread -- Text deliberately uses Unicode code points, not grapheme clusters.
        const count = operation.type === "list/insert" ? 1 : [...operation.value].length;
        ranges.push({ start: operation.id.counter,
          end: operation.id.counter + count - 1, path: operationPath });
        insertedRanges.set(key, ranges);
      }
    }
  }

  // Validate all pending metadata, even after the first replay conflict.
  for (const ranges of insertedRanges.values()) {
    ranges.sort((left, right) => left.start - right.start);
    for (let index = 1; index < ranges.length; index++) {
      if (ranges[index]!.start <= ranges[index - 1]!.end) {
        fail(ranges[index]!.path, "pending insert ID ranges must not overlap");
      }
    }
  }
  try {
    replayPending(initialStates(schema, snapshot), pendingBatches);
  } catch (error) {
    if (!(error instanceof PendingReplayError)) throw error;
    fail(["pendingBatches", error.batchIndex, "operations", error.operationIndex],
      `invalid pending replay: ${error.message}`);
  }

  return Object.freeze({
    clientId,
    snapshot,
    lastLocalSeq,
    pendingBatches,
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The validated allocation paths and safe counters match the schema’s List/Text keys.
    lastBunchSeqs: allocations as ClientCheckpoint<S>["lastBunchSeqs"],
  });
}

/** Decodes parsed state used to restore an authoritative server. */
export function decodeServerCheckpoint<S extends SchemaShape>(
  schema: DocumentSchema<S>,
  input: unknown
): ServerCheckpoint<S> {
  const path: readonly PathSegment[] = [];
  const record = decodeRecord(input, path, "Server checkpoint");
  requireExactFields(record, path, ["snapshot", "replays", "history"]);
  const snapshot = decodeSnapshotAt(schema, record.snapshot, ["snapshot"]);
  const inputReplays = decodeDenseArray(
    record.replays,
    ["replays"],
    "Replay entries"
  );
  const clientIds = new Set<string>();
  const serverSeqs = new Set<number>();
  let totalClientSeq = 0;
  let maxServerSeq = 0;
  const replays = Object.freeze(
    inputReplays.map((inputReplay, index) => {
      const entryPath = ["replays", index] as const;
      const entry = decodeRecord(inputReplay, entryPath, "Replay entry");
      requireExactFields(entry, entryPath, ["batch", "commit"]);
      const batchPath = [...entryPath, "batch"];
      const commitPath = [...entryPath, "commit"];
      const batch = decodeClientBatchAt(schema, entry.batch, batchPath);
      const commit = decodeServerCommitAt(schema, entry.commit, commitPath);
      if (clientIds.has(batch.clientId)) {
        fail([...batchPath, "clientId"], "clientId must not be duplicated");
      }
      clientIds.add(batch.clientId);
      if (commit.source.clientId !== batch.clientId) {
        fail(
          [...commitPath, "source", "clientId"],
          "source must match replay batch"
        );
      }
      if (commit.source.seq !== batch.seq) {
        fail([...commitPath, "source", "seq"], "source must match replay batch");
      }
      if (commit.serverSeq > snapshot.serverSeq) {
        fail(
          [...commitPath, "serverSeq"],
          "commit must not exceed snapshot serverSeq"
        );
      }
      if (serverSeqs.has(commit.serverSeq)) {
        fail(
          [...commitPath, "serverSeq"],
          "commit serverSeq must not be duplicated"
        );
      }
      serverSeqs.add(commit.serverSeq);
      maxServerSeq = Math.max(maxServerSeq, commit.serverSeq);
      if (totalClientSeq > snapshot.serverSeq - batch.seq) {
        fail(
          ["replays"],
          "client sequences must sum to snapshot serverSeq"
        );
      }
      totalClientSeq += batch.seq;
      return Object.freeze({ batch, commit });
    })
  );
  if (totalClientSeq !== snapshot.serverSeq) {
    fail(
      ["replays"],
      "client sequences must sum to snapshot serverSeq"
    );
  }
  if (maxServerSeq !== snapshot.serverSeq) {
    fail(["replays"], "latest replay commit must match snapshot serverSeq");
  }

  // By each client's last commit, all of that client's earlier batches exist.
  // Their cumulative count cannot exceed the global sequence at that point.
  const ordered = replays
    .map((entry, index) => ({ entry, index }))
    .sort((left, right) => left.entry.commit.serverSeq - right.entry.commit.serverSeq);
  let completedBatches = 0;
  for (const { entry, index } of ordered) {
    if (completedBatches > entry.commit.serverSeq - entry.batch.seq) {
      fail(
        ["replays", index, "commit", "serverSeq"],
        "commit sequence precedes the required client batches"
      );
    }
    completedBatches += entry.batch.seq;
  }

  const inputHistory = decodeDenseArray(
    record.history,
    ["history"],
    "Commit history"
  );
  const history = Object.freeze(
    inputHistory.map((commit, index) =>
      decodeServerCommitAt(schema, commit, ["history", index])
    )
  );
  if (history.length > 0) {
    const firstSeq = history[0]!.serverSeq;
    if (
      history.length > snapshot.serverSeq ||
      firstSeq !== snapshot.serverSeq - history.length + 1
    ) {
      fail(
        ["history", 0, "serverSeq"],
        "history must be a suffix ending at snapshot serverSeq"
      );
    }

    const firstClientSeq = new Map<string, number>();
    const lastByClient = new Map<string, {
      readonly commit: ServerCommit<DocumentOperation<S>>;
      readonly index: number;
    }>();
    for (const [index, commit] of history.entries()) {
      const commitPath = ["history", index] as const;
      if (commit.serverSeq !== firstSeq + index) {
        fail(
          [...commitPath, "serverSeq"],
          "history serverSeq must be consecutive and ascending"
        );
      }
      const clientId = commit.source.clientId;
      if (!clientIds.has(clientId)) {
        fail([...commitPath, "source", "clientId"], "history client must exist in replays");
      }
      const previous = lastByClient.get(clientId);
      if (previous === undefined) {
        firstClientSeq.set(clientId, commit.source.seq);
      } else if (commit.source.seq !== previous.commit.source.seq + 1) {
        fail([...commitPath, "source", "seq"], "history client sequence must be consecutive");
      }
      lastByClient.set(clientId, { commit, index });
    }

    // Account for all batches before this suffix, including absent clients.
    const beforeHistory = firstSeq - 1;
    let totalBeforeHistory = 0;
    for (const replay of replays) {
      const clientId = replay.batch.clientId;
      const last = lastByClient.get(clientId);
      if (last === undefined && replay.commit.serverSeq >= firstSeq) {
        fail(
          ["history", replay.commit.serverSeq - firstSeq],
          "history must include each replay commit within its retained range"
        );
      }
      if (last !== undefined && !jsonEquals(last.commit, replay.commit)) {
        fail(["history", last.index], "last client history commit must match replay commit");
      }
      const first = firstClientSeq.get(clientId);
      const priorCount = first === undefined ? replay.batch.seq : first - 1;
      if (totalBeforeHistory > beforeHistory - priorCount) {
        fail(
          ["history"],
          "client sequences before history must sum to its starting watermark"
        );
      }
      totalBeforeHistory += priorCount;
    }
    if (totalBeforeHistory !== beforeHistory) {
      fail(
        ["history"],
        "client sequences before history must sum to its starting watermark"
      );
    }
  }

  return Object.freeze({ snapshot, replays, history });
}
