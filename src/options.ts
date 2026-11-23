/**
 * Checks an integer option: a non-number throws TypeError, and a number that is not a safe integer
 * from `minimum` to `maximum` throws RangeError, as JavaScript and Node.js do for their own options.
 */
export function integerOption(value: unknown, name: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  requireNumber(value, name);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(maximum === Number.MAX_SAFE_INTEGER
      ? `${name} must be a safe integer of at least ${minimum}`
      : `${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

/** Throws TypeError unless `value` is a number; the caller's range check then throws RangeError. */
export function requireNumber(value: unknown, name: string): asserts value is number {
  if (typeof value !== "number") throw new TypeError(`${name} must be a number: ${String(value)}`);
}
