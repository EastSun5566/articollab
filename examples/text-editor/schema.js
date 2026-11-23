// @ts-check
import { defineDocument, text } from "../../dist/index.js";

/** One shared text, edited by every writer. */
export const Note = defineDocument({ body: text() });
