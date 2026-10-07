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
