// @ts-check
import { defineDocument, text } from "articollab";

/** A tiny Standard Schema, so the example needs no validation library.
 * @template {import("articollab").JsonValue} T @param {(value: unknown) => value is T} test @param {string} message
 * @returns {import("articollab").PayloadSchema<T>} */
function check(test, message) {
  return { "~standard": { version: 1, vendor: "example", validate: (value) => (test(value) ? { value } : { issues: [{ message }] }) } };
}

/**
 * One shared rich text with the marks and paragraph attributes of Tiptap's StarterKit: a code
 * block's language is the value of `code`, and lists nest with `indent`.
 */
export const Note = defineDocument({
  body: text({
    marks: {
      bold: { expand: "after" }, italic: { expand: "after" }, strike: { expand: "after" }, underline: { expand: "after" },
      code: { expand: "after" },
      link: { expand: "none", payload: check(/** @returns {value is string} */ (value) => typeof value === "string", "Expected a URL string") },
    },
    blocks: {
      heading: { payload: check(/** @returns {value is 1 | 2 | 3} */ (value) => value === 1 || value === 2 || value === 3, "Expected a level from 1 to 3") },
      list: { payload: check(/** @returns {value is "bullet" | "ordered"} */ (value) => value === "bullet" || value === "ordered", "Expected bullet or ordered") },
      indent: { payload: check(/** @returns {value is number} */ (value) => Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 8, "Expected 1 to 8") },
      quote: { payload: check(/** @returns {value is true} */ (value) => value === true, "Expected true") },
      code: { payload: check(/** @returns {value is true | string} */ (value) => value === true || (typeof value === "string" && /^[a-z]{1,20}$/.test(value)),
        "Expected true or a language name") },
    },
  }),
});

/** @typedef {typeof Note.definition} Shape */
/** @typedef {import("articollab").DocumentOperation<Shape>} NoteOperation */

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
