import type { JsonValue } from "./schema.ts";

export type JsonPathSegment = string | number;
type JsonFailure = (path: readonly JsonPathSegment[], message: string) => never;

export function jsonPointer(path: readonly JsonPathSegment[]): string {
  if (path.length === 0) return "/";
  return path.map((segment) =>
    `/${String(segment).replaceAll("~", "~0").replaceAll("/", "~1")}`
  ).join("");
}

export function jsonRecord(
  input: unknown,
  path: readonly JsonPathSegment[],
  name: string,
  fail: JsonFailure
): Readonly<Record<string, unknown>> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    fail(path, `${name} must be a plain object`);
  }
  const prototype: unknown = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    fail(path, `${name} must be a plain object`);
  }
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string") fail(path, `${name} must only have string keys`);
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      fail([...path, key], `${name} fields must be enumerable data properties`);
    }
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Own enumerable data properties were checked above; values stay unknown.
  return input as Readonly<Record<string, unknown>>;
}

export function jsonArray(
  input: unknown,
  path: readonly JsonPathSegment[],
  name: string,
  fail: JsonFailure
): readonly unknown[] {
  if (!Array.isArray(input)) fail(path, `${name} must be an array`);
  let indexCount = 0;
  for (const key of Reflect.ownKeys(input)) {
    if (key === "length") continue;
    if (typeof key !== "string") fail(path, `${name} must only have array indexes`);
    const index = Number(key);
    if (!Number.isSafeInteger(index) || index < 0 || String(index) !== key || index >= input.length) {
      fail([...path, key], `${name} must only have array indexes`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      fail([...path, index], `${name} entries must be enumerable data properties`);
    }
    indexCount++;
  }
  if (indexCount !== input.length) fail(path, `${name} must be a dense array`);
  return input;
}

/** Shared iterative validation, optionally producing an owned frozen JSON copy. */
function walkJsonValue(
  input: unknown,
  path: readonly JsonPathSegment[],
  fail: JsonFailure,
  copy: boolean
): JsonValue {
  const currentPath = [...path];
  const ancestors = new WeakSet<object>();
  const stack: Array<{
    input: object;
    output: JsonValue[] | Record<string, JsonValue> | undefined;
    entries: Iterator<[JsonPathSegment, unknown]>;
  }> = [];

  const read = (value: unknown): JsonValue => {
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) fail(currentPath, "number must be finite");
      return value;
    }
    if (typeof value !== "object") fail(currentPath, "value must be JSON-compatible");
    if (ancestors.has(value)) fail(currentPath, "value must not contain a cycle");
    const array = Array.isArray(value);
    const entries = array
      ? jsonArray(value, currentPath, "JSON array", fail).entries()
      : Object.entries(jsonRecord(value, currentPath, "JSON object", fail)).values();
    const output = copy ? (array ? [] : {}) : undefined;
    ancestors.add(value);
    stack.push({ input: value, output, entries });
    return output ?? null; // Validation mode has no payload output.
  };

  const result = read(input);
  while (stack.length > 0) {
    const frame = stack[stack.length - 1]!;
    const next = frame.entries.next();
    if (next.done) {
      if (frame.output !== undefined) Object.freeze(frame.output);
      ancestors.delete(frame.input);
      stack.pop();
      if (stack.length > 0) currentPath.pop();
      continue;
    }
    const [key, value] = next.value;
    currentPath.push(key);
    const depth = stack.length;
    const decoded = read(value);
    if (frame.output !== undefined) {
      // __proto__ must remain an ordinary JSON data property.
      Object.defineProperty(frame.output, key, {
        value: decoded, enumerable: true, writable: true, configurable: true,
      });
    }
    if (stack.length === depth) currentPath.pop();
  }
  return result;
}

export function copyJsonValue(
  input: unknown,
  path: readonly JsonPathSegment[],
  fail: JsonFailure
): JsonValue {
  return walkJsonValue(input, path, fail, true);
}

/** Checks local payloads without copying, freezing or retaining validation results. */
export function validateJsonValue(input: unknown, path: readonly JsonPathSegment[]): void {
  walkJsonValue(input, path, (errorPath, message) => {
    throw new TypeError(`Invalid JSON value at ${jsonPointer(errorPath)}: ${message}`);
  }, false);
}

/** JSON equality ignores object key order but preserves array/operation order. */
export function jsonEquals(left: unknown, right: unknown): boolean {
  const pending: Array<readonly [unknown, unknown]> = [[left, right]];
  while (pending.length > 0) {
    const [a, b] = pending.pop()!;
    if (a === b) continue;
    if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) {
      return false;
    }
    if (Array.isArray(a) || Array.isArray(b)) {
      if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
      for (let index = a.length - 1; index >= 0; index--) pending.push([a[index], b[index]]);
    } else {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Both operands are non-null non-array objects; indexed values remain unknown.
      const aRecord = a as Record<string, unknown>;
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Both operands are non-null non-array objects; indexed values remain unknown.
      const bRecord = b as Record<string, unknown>;
      const keys = Object.keys(aRecord);
      if (keys.length !== Object.keys(bRecord).length) return false;
      for (let index = keys.length - 1; index >= 0; index--) {
        const key = keys[index]!;
        if (!Object.hasOwn(bRecord, key)) return false;
        pending.push([aRecord[key], bRecord[key]]);
      }
    }
  }
  return true;
}
