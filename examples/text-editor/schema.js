// @ts-check
import { defineDocument, text } from "../../dist/index.js";

/** A tiny Standard Schema, so the example needs no validation library.
 * @template {import("../../dist/index.js").JsonValue} T @param {readonly T[]} allowed
 * @returns {import("../../dist/index.js").PayloadSchema<T>} */
function oneOf(allowed) {
  return { "~standard": { version: 1, vendor: "example", validate: (value) =>
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Checked against the allowed values first.
    allowed.includes(/** @type {T} */ (value)) ? { value: /** @type {T} */ (value) } : { issues: [{ message: "Not allowed: " + String(value) }] } } };
}

/**
 * One shared text, edited by every writer. Typing at the end of bold or italic text continues it; a
 * link stops at its end. Paragraphs can be headings or bullet list items.
 */
export const Note = defineDocument({
  body: text({
    marks: { bold: { expand: "after" }, italic: { expand: "after" }, link: { expand: "none" } },
    blocks: { heading: { payload: oneOf([1, 2]) }, list: { payload: oneOf(["bullet"]) } },
  }),
});

/** @typedef {import("../../dist/index.js").DocumentOperation<typeof Note.definition>} NoteOperation */

/**
 * The server's formatting policy: links must use http: or https:. Any writer can send any mark,
 * so the server checks; a dropped link disappears from the writer that set it.
 * @param {{ batch: { operations: readonly NoteOperation[] } }} context
 * @returns {readonly NoteOperation[]}
 */
export function keepSafeLinks({ batch }) {
  return batch.operations.filter((operation) => operation.type !== "text/mark" || operation.key !== "link" ||
    operation.value === null || (typeof operation.value === "string" && /^https?:\/\//.test(operation.value)));
}

/** @typedef {NonNullable<(typeof Note.definition.body)["marks"]>} NoteMarks */
/** @typedef {NonNullable<(typeof Note.definition.body)["blocks"]>} NoteBlocks */
