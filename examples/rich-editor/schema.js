// @ts-check
import { Schema } from "prosemirror-model";
import { schema as basic } from "prosemirror-schema-basic";
import { addListNodes } from "prosemirror-schema-list";
import { defineDocument, text } from "articollab";

/** A tiny Standard Schema, so the example needs no validation library.
 * @template {import("articollab").JsonValue} T @param {readonly T[]} allowed
 * @returns {import("articollab").PayloadSchema<T>} */
function oneOf(allowed) {
  return { "~standard": { version: 1, vendor: "example", validate: (value) =>
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Checked against the allowed values first.
    allowed.includes(/** @type {T} */ (value)) ? { value: /** @type {T} */ (value) } : { issues: [{ message: "Not allowed: " + String(value) }] } } };
}

/** @type {import("articollab").PayloadSchema<string>} */
const href = { "~standard": { version: 1, vendor: "example", validate: (value) =>
  typeof value === "string" ? { value } : { issues: [{ message: "Expected a URL string" }] } } };

/**
 * One shared rich text. Marks match ProseMirror's: bold, italic and code continue when you type at
 * their end, links do not. Each paragraph, a run of text between "\n"s, can be a heading, a list item
 * (nested by `indent`), part of a quote or a line of a code block.
 */
export const Note = defineDocument({
  body: text({
    marks: { bold: { expand: "after" }, italic: { expand: "after" }, code: { expand: "after" }, link: { expand: "none", payload: href } },
    blocks: {
      heading: { payload: oneOf([1, 2, 3]) },
      list: { payload: oneOf(["bullet", "ordered"]) },
      indent: { payload: oneOf([1, 2, 3, 4, 5, 6, 7, 8]) },
      quote: { payload: oneOf([true]) },
      code: { payload: oneOf([true]) },
    },
  }),
});

/** @typedef {NonNullable<(typeof Note.definition.body)["marks"]>} NoteMarks */
/** @typedef {NonNullable<(typeof Note.definition.body)["blocks"]>} NoteBlocks */
/** @typedef {import("articollab").DocumentOperation<typeof Note.definition>} NoteOperation */

/** The editor's schema: ProseMirror's basic nodes and marks, without images or rules, plus lists. */
export const editorSchema = new Schema({
  nodes: addListNodes(basic.spec.nodes.remove("image").remove("horizontal_rule"), "paragraph block*", "block"),
  marks: basic.spec.marks,
});

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
