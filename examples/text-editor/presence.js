// @ts-check
import { decodeCursor } from "../../dist/index.js";

/** @typedef {import("./binding.js").CursorSelection} CursorSelection */
/** A cursor as it travels: its anchor element, or null for a document edge, and the side it binds to.
 * @typedef {{ readonly anchor: { readonly bunchId: string, readonly counter: number } | null, readonly bind: "left" | "right" }} WireCursor */
/** What each writer shares as presence: its main selection, or null when it has none.
 * @typedef {{ readonly selection: { readonly from: WireCursor, readonly to: WireCursor } | null }} SelectionPresence */

/** Decodes a shared selection into owned, validated cursors. @param {unknown} input @returns {CursorSelection | null} */
function decodeSelection(input) {
  if (typeof input !== "object" || input === null || Array.isArray(input) || Object.keys(input).length !== 1 ||
    !("selection" in input)) throw new TypeError("Expected { selection }");
  const { selection } = input;
  if (selection === null) return null;
  if (typeof selection !== "object" || Array.isArray(selection) || !("from" in selection) || !("to" in selection)) {
    throw new TypeError("Expected a selection with from and to");
  }
  return { from: decodeCursor(selection.from), to: decodeCursor(selection.to) };
}

/**
 * Checked by the host and by every writer, so a malformed cursor is refused and skipped.
 * @type {import("../../dist/index.js").StandardSchemaV1<SelectionPresence>}
 */
export const selectionSchema = {
  "~standard": {
    version: 1,
    vendor: "articollab-text-editor",
    validate(input) {
      try {
        decodeSelection(input);
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- decodeSelection has just accepted its shape.
        return { value: /** @type {SelectionPresence} */ (input) };
      } catch (error) {
        return { issues: [{ message: error instanceof Error ? error.message : String(error) }] };
      }
    },
  },
};

/** A peer's selection as owned cursors, from a state the schema accepted.
 * @param {SelectionPresence} state @returns {CursorSelection | null} */
export function selectionOf(state) {
  return decodeSelection(state);
}
