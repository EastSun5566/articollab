// @ts-check

/** What each writer shares: the node it has selected, or null. @typedef {{ readonly selected: string | null }} Selection */

/**
 * Checked by the host and by every writer, so a malformed selection is refused and skipped.
 * @type {import("../../dist/index.js").StandardSchemaV1<Selection>}
 */
export const selectionSchema = {
  "~standard": {
    version: 1,
    vendor: "articollab-file-tree",
    validate(input) {
      const valid = typeof input === "object" && input !== null && !Array.isArray(input) && Object.keys(input).length === 1 &&
        "selected" in input && (input.selected === null || (typeof input.selected === "string" && input.selected.length <= 100));
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Checked just above.
      return valid ? { value: /** @type {Selection} */ (input) } : { issues: [{ message: "Expected { selected: node ID or null }" }] };
    },
  },
};
