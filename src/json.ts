/** JSON equality ignores object key order but preserves array/operation order. */
export function jsonEquals(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (
    typeof left !== "object" ||
    left === null ||
    typeof right !== "object" ||
    right === null
  ) {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => jsonEquals(value, right[index]))
    );
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Both operands are non-null non-array objects; indexed values remain unknown.
  const leftRecord = left as Record<string, unknown>;
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Both operands are non-null non-array objects; indexed values remain unknown.
  const rightRecord = right as Record<string, unknown>;
  const keys = Object.keys(leftRecord);
  return (
    keys.length === Object.keys(rightRecord).length &&
    keys.every((key) =>
      Object.hasOwn(rightRecord, key) && jsonEquals(leftRecord[key], rightRecord[key])
    )
  );
}
