// @ts-check
import { defineDocument, text } from "../../dist/index.js";

/** One shared text, edited by every writer. Typing at the end of bold or italic text continues it; a link stops at its end. */
export const Note = defineDocument({
  body: text({ marks: { bold: { expand: "after" }, italic: { expand: "after" }, link: { expand: "none" } } }),
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
