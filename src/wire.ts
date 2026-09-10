import type { ElementId } from "articulated";

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
  DocumentOperation,
  DocumentSnapshot,
  DocumentSnapshotData,
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

  const prototype = Object.getPrototypeOf(input);
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
  path: readonly PathSegment[],
  ancestors = new WeakSet<object>()
): JsonValue {
  if (
    input === null ||
    typeof input === "string" ||
    typeof input === "boolean"
  ) {
    return input;
  }
  if (typeof input === "number") {
    if (!Number.isFinite(input)) fail(path, "number must be finite");
    return input;
  }
  if (typeof input !== "object") fail(path, "value must be JSON-compatible");
  if (ancestors.has(input)) fail(path, "value must not contain a cycle");

  ancestors.add(input);
  try {
    if (Array.isArray(input)) {
      const array = decodeDenseArray(input, path, "JSON array");
      return Object.freeze(
        array.map((value, index) =>
          decodeJsonValue(value, [...path, index], ancestors)
        )
      ) as unknown as JsonValue;
    }

    const record = decodeRecord(input, path, "JSON object");
    return Object.freeze(
      Object.fromEntries(
        Object.keys(record).map((key) => [
          key,
          decodeJsonValue(record[key], [...path, key], ancestors),
        ])
      )
    );
  } finally {
    ancestors.delete(input);
  }
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
      }) as DocumentOperation<S>;
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
      }) as DocumentOperation<S>;
    }
    case "list/delete": {
      requireExactFields(record, path, ["type", "path", "id"]);
      requireKind(descriptor.kind, "list", [...path, "path"]);
      return Object.freeze({
        type,
        path: descriptor.path,
        id: decodeElementId(record.id, [...path, "id"]),
      }) as DocumentOperation<S>;
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
        [...value].length,
        [...path, "id", "counter"]
      );
      return Object.freeze({
        type,
        path: descriptor.path,
        before: decodeOptionalElementId(record.before, [...path, "before"]),
        id,
        value,
      }) as DocumentOperation<S>;
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
      }) as DocumentOperation<S>;
    }
    default:
      fail([...path, "type"], `unknown operation type: ${type}`);
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
  snapshot: ListSnapshotData<JsonValue> | TextSnapshotData,
  path: readonly PathSegment[]
): void {
  try {
    if (kind === "list") {
      ListState.load(snapshot as ListSnapshotData<JsonValue>);
    } else {
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
): JsonValue | ListSnapshotData<JsonValue> | TextSnapshotData {
  if (kind === "value") return decodeJsonValue(input, path);

  const record = decodeRecord(input, path, `${kind} snapshot`);
  if (kind === "list") {
    requireExactFields(record, path, ["idList", "values"]);
    const inputValues = decodeDenseArray(
      record.values,
      [...path, "values"],
      "List snapshot values"
    );
    const snapshot: ListSnapshotData<JsonValue> = Object.freeze({
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
  const path: readonly PathSegment[] = [];
  const record = decodeRecord(input, path, "Client batch");
  requireExactFields(record, path, ["clientId", "seq", "operations"]);
  return Object.freeze({
    clientId: decodeString(record.clientId, ["clientId"], "Client id", true),
    seq: decodeSafeInteger(record.seq, ["seq"], "Client sequence", 1),
    operations: decodeOperations(schema, record.operations, ["operations"], false),
  });
}

/** Decodes a parsed server commit before passing it to client.receive(). */
export function decodeServerCommit<S extends SchemaShape>(
  schema: DocumentSchema<S>,
  input: unknown
): ServerCommit<DocumentOperation<S>> {
  const path: readonly PathSegment[] = [];
  const record = decodeRecord(input, path, "Server commit");
  requireExactFields(record, path, ["serverSeq", "source", "operations"]);
  return Object.freeze({
    serverSeq: decodeSafeInteger(
      record.serverSeq,
      ["serverSeq"],
      "Server sequence",
      1
    ),
    source: decodeBatchRef(record.source, ["source"], "Commit source"),
    operations: decodeOperations(schema, record.operations, ["operations"], true),
  });
}

/** Decodes a parsed document snapshot before hydrating a client. */
export function decodeSnapshot<S extends SchemaShape>(
  schema: DocumentSchema<S>,
  input: unknown
): DocumentSnapshot<S> {
  const path: readonly PathSegment[] = [];
  const record = decodeRecord(input, path, "Document snapshot");
  requireExactFields(record, path, ["serverSeq", "data"]);
  const serverSeq = decodeSafeInteger(
    record.serverSeq,
    ["serverSeq"],
    "Snapshot server sequence",
    0
  );
  const dataRecord = decodeRecord(record.data, ["data"], "Snapshot data");
  const schemaPaths = Object.keys(schema.definition);
  requireExactFields(dataRecord, ["data"], schemaPaths);

  const data = Object.freeze(
    Object.fromEntries(
      schemaPaths.map((documentPath) => [
        documentPath,
        decodeSnapshotCollection(
          schema.definition[documentPath]!.kind,
          dataRecord[documentPath],
          ["data", documentPath]
        ),
      ])
    )
  ) as DocumentSnapshotData<S>;

  return Object.freeze({
    serverSeq,
    data,
  });
}
