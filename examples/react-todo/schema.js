// @ts-check
import { counter, defineDocument, list, value } from "../../dist/index.js";

/** @typedef {{ readonly id: string, readonly title: string, readonly done: boolean }} Todo */
/** What a writer shares with the others: the item it is editing. @typedef {{ readonly editing: string | null }} Editing */

/** @param {unknown} input @returns {input is Record<string, unknown>} */
const isRecord = (input) => typeof input === "object" && input !== null && !Array.isArray(input);

/** A small Standard Schema, so the example needs no validation library.
 * @type {import("../../dist/index.js").PayloadSchema<Todo>} */
const todo = { "~standard": { version: 1, vendor: "example", validate(input) {
  if (isRecord(input) && typeof input.id === "string" && typeof input.title === "string" && input.title.length <= 200 &&
    typeof input.done === "boolean" && Object.keys(input).length === 3) {
    return { value: { id: input.id, title: input.title, done: input.done } };
  }
  return { issues: [{ message: "Expected { id, title, done } with a title of at most 200 characters" }] };
} } };

/** @type {import("../../dist/index.js").PayloadSchema<Editing>} */
export const editingSchema = { "~standard": { version: 1, vendor: "example", validate(input) {
  if (isRecord(input) && (input.editing === null || typeof input.editing === "string") && Object.keys(input).length === 1) {
    return { value: { editing: input.editing } };
  }
  return { issues: [{ message: "Expected { editing }" }] };
} } };

/** One shared todo list: its title, the items in order, and likes that every writer adds to. */
export const Todos = defineDocument({ title: value("Groceries"), items: list(todo), likes: counter() });

/** @typedef {typeof Todos.definition} Shape */
