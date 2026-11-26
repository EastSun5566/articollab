// @ts-check
import { Mark } from "prosemirror-model";

/** @typedef {import("../../dist/index.js").JsonValue} JsonValue */
/** @typedef {Readonly<Record<string, JsonValue>>} Attributes */
/** A run of equally marked text in one line. @typedef {{ readonly text: string, readonly marks: Attributes }} Run */
/** One paragraph of the Text: its text as runs, and its paragraph attributes.
 * @typedef {{ readonly runs: readonly Run[], readonly attributes: Attributes }} Line */

const NONE = Object.freeze({});

/** A node type of the editor schema, which must exist.
 * @param {import("prosemirror-model").Schema} schema @param {string} name */
function nodeType(schema, name) {
  const type = schema.nodes[name];
  if (type === undefined) throw new Error(`The schema has no ${name} node`);
  return type;
}

/** `array[index]`, which must exist. @template T @param {readonly T[]} array @param {number} index @returns {T} */
function at(array, index) {
  const value = array[index];
  if (value === undefined) throw new RangeError(`No entry at ${index}`);
  return value;
}

/** ProseMirror mark names by Text mark key. */
const MARK_NAMES = /** @type {const} */ ({ bold: "strong", italic: "em", code: "code", link: "link" });

/** Whether two JSON values are equal; object key order does not matter. @param {unknown} a @param {unknown} b @returns {boolean} */
export function same(a, b) {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) return false;
  const left = Object.entries(a), right = new Map(Object.entries(b));
  return left.length === right.size && left.every(([key, value]) => right.has(key) && same(value, right.get(key)));
}

/** The lines of a Text, from its `toDelta()` and `blocks()`.
 * @param {{ toDelta(): readonly { readonly insert: string, readonly attributes?: Attributes }[],
 *   blocks(): readonly { readonly attributes: Attributes }[] }} body
 * @returns {Line[]} */
export function textLines(body) {
  /** @type {{ runs: Run[], attributes: Attributes }[]} */
  const lines = body.blocks().map(({ attributes }) => ({ runs: [], attributes }));
  let line = 0;
  for (const { insert, attributes } of body.toDelta()) {
    insert.split("\n").forEach((part, index) => {
      if (index > 0) line++;
      if (part !== "") lines[line]?.runs.push({ text: part, marks: attributes ?? NONE });
    });
  }
  return lines;
}

/** @param {import("prosemirror-model").Schema} schema @param {Attributes} marks @returns {readonly Mark[]} */
function marksFor(schema, marks) {
  /** @type {Mark[]} */
  const result = [];
  for (const [key, name] of Object.entries(MARK_NAMES)) {
    const value = marks[key];
    if (value === undefined) continue;
    const type = schema.marks[name];
    if (type === undefined) continue;
    result.push(name === "link" ? type.create({ href: typeof value === "string" ? value : JSON.stringify(value) }) : type.create());
  }
  return Mark.setFrom(result);
}

/** @param {import("prosemirror-model").Schema} schema @param {Line} line */
function inline(schema, line) {
  return line.runs.filter(({ text }) => text !== "").map(({ text, marks }) => schema.text(text, marksFor(schema, marks)));
}

/** @param {import("prosemirror-model").Schema} schema @param {Line} line @param {boolean} inList */
function textblock(schema, line, inList) {
  const level = line.attributes.heading;
  if (!inList && (level === 1 || level === 2 || level === 3)) return nodeType(schema, "heading").create({ level }, inline(schema, line));
  return nodeType(schema, "paragraph").create(null, inline(schema, line));
}

/**
 * Nested lists for a run of list lines. A line's depth is its `indent`, but at most one deeper than
 * the line before, and the first is at depth 0. A change of list kind at one depth starts a new list.
 * @param {import("prosemirror-model").Schema} schema @param {readonly Line[]} lines
 */
function buildLists(schema, lines) {
  /** @type {number[]} */
  const depths = [];
  for (const [index, line] of lines.entries()) {
    const indent = typeof line.attributes.indent === "number" ? line.attributes.indent : 0;
    depths.push(index === 0 ? 0 : Math.min(indent, at(depths, index - 1) + 1));
  }
  /** @param {number} start @param {number} depth @returns {[import("prosemirror-model").Node[], number]} */
  const level = (start, depth) => {
    /** @type {import("prosemirror-model").Node[]} */
    const lists = [];
    let position = start;
    while (position < lines.length && depths[position] === depth) {
      const kind = at(lines, position).attributes.list;
      const type = kind === "ordered" ? nodeType(schema, "ordered_list") : nodeType(schema, "bullet_list");
      /** @type {import("prosemirror-model").Node[]} */
      const items = [];
      while (position < lines.length && depths[position] === depth && at(lines, position).attributes.list === kind) {
        const children = [textblock(schema, at(lines, position), true)];
        position++;
        if (position < lines.length && at(depths, position) > depth) {
          const [nested, next] = level(position, depth + 1);
          children.push(...nested);
          position = next;
        }
        items.push(nodeType(schema, "list_item").create(null, children));
      }
      lists.push(type.create(null, items));
    }
    return [lists, position];
  };
  return level(0, 0)[0];
}

/** @param {import("prosemirror-model").Schema} schema @param {readonly Line[]} lines @param {boolean} inQuote */
function buildBlocks(schema, lines, inQuote) {
  /** @type {import("prosemirror-model").Node[]} */
  const blocks = [];
  /** @param {number} start @param {(line: Line) => boolean} test */
  const runEnd = (start, test) => {
    let end = start;
    while (end < lines.length && test(at(lines, end))) end++;
    return end;
  };
  const quoted = (/** @type {Line} */ line) => !inQuote && line.attributes.quote === true;
  for (let index = 0; index < lines.length;) {
    const line = at(lines, index);
    if (quoted(line)) {
      const end = runEnd(index, quoted);
      blocks.push(nodeType(schema, "blockquote").create(null, buildBlocks(schema, lines.slice(index, end), true)));
      index = end;
    } else if (line.attributes.code === true) {
      const end = runEnd(index, (next) => next.attributes.code === true && !quoted(next));
      const code = lines.slice(index, end).map(({ runs }) => runs.map(({ text }) => text).join("")).join("\n");
      blocks.push(nodeType(schema, "code_block").create(null, code === "" ? [] : [schema.text(code)]));
      index = end;
    } else if (line.attributes.list !== undefined) {
      const end = runEnd(index, (next) => next.attributes.list !== undefined && next.attributes.code !== true && !quoted(next));
      blocks.push(...buildLists(schema, lines.slice(index, end)));
      index = end;
    } else {
      blocks.push(textblock(schema, line, false));
      index++;
    }
  }
  return blocks;
}

/**
 * The ProseMirror document for some lines, always in one standard shape: a quote is one blockquote,
 * consecutive code lines are one code block without marks, list lines are nested lists with one
 * paragraph per item, and a list item is never a heading.
 * @param {import("prosemirror-model").Schema} schema @param {readonly Line[]} lines
 */
export function buildDoc(schema, lines) {
  return nodeType(schema, "doc").create(null, buildBlocks(schema, lines.length === 0 ? [{ runs: [], attributes: NONE }] : lines, false));
}

/** @param {Record<string, JsonValue>} attributes @returns {Attributes} */
function sorted(attributes) {
  return Object.freeze(Object.fromEntries(Object.entries(attributes).toSorted(([a], [b]) => (a < b ? -1 : 1))));
}

/** The Text marks of a ProseMirror text node. @param {import("prosemirror-model").Node} node @returns {Attributes} */
function textMarks(node) {
  /** @type {Record<string, JsonValue>} */
  const marks = {};
  for (const mark of node.marks) {
    for (const [key, name] of Object.entries(MARK_NAMES)) {
      if (mark.type.name !== name) continue;
      marks[key] = name === "link" ? String(mark.attrs.href) : true;
    }
  }
  return sorted(marks);
}

/**
 * The lines of a ProseMirror document, and where each line's text starts in it. For a document
 * `buildDoc` made, `flattenDoc(buildDoc(lines)).lines` equals `lines`; other documents come out in
 * the standard shape.
 * @param {import("prosemirror-model").Node} doc @returns {{ lines: Line[], starts: number[] }}
 */
export function flattenDoc(doc) {
  /** @type {Line[]} */
  const lines = [];
  /** @type {number[]} */
  const starts = [];
  /** @param {import("prosemirror-model").Node} parent @param {number} offset @param {{ quote: boolean, list?: string, depth: number }} context */
  const walk = (parent, offset, context) => {
    parent.forEach((node, childOffset) => {
      const position = offset + childOffset;
      const name = node.type.name;
      /** @type {Record<string, JsonValue>} */
      const attributes = {};
      if (context.quote) attributes.quote = true;
      if (name === "blockquote") {
        walk(node, position + 1, { ...context, quote: true });
      } else if (name === "bullet_list" || name === "ordered_list") {
        const depth = context.list === undefined ? 0 : context.depth + 1;
        node.forEach((item, itemOffset) => {
          walk(item, position + 1 + itemOffset + 1, { quote: context.quote, list: name === "ordered_list" ? "ordered" : "bullet", depth });
        });
      } else if (name === "code_block") {
        let start = position + 1;
        for (const part of node.textContent.split("\n")) {
          lines.push({ runs: part === "" ? [] : [{ text: part, marks: NONE }], attributes: sorted({ ...attributes, code: true }) });
          starts.push(start);
          start += part.length + 1;
        }
      } else if (node.isTextblock) {
        if (context.list !== undefined) {
          attributes.list = context.list;
          if (context.depth > 0) attributes.indent = context.depth;
        } else if (name === "heading") {
          attributes.heading = Math.min(3, Math.max(1, Number(node.attrs.level)));
        }
        /** @type {Run[]} */
        const runs = [];
        node.forEach((child) => {
          const marks = textMarks(child), last = runs.at(-1);
          if (last !== undefined && same(last.marks, marks)) runs[runs.length - 1] = { text: last.text + (child.text ?? ""), marks };
          else runs.push({ text: child.text ?? "", marks });
        });
        lines.push({ runs, attributes: sorted(attributes) });
        starts.push(position + 1);
      } else {
        walk(node, position + 1, context);
      }
    });
  };
  walk(doc, 0, { quote: false, depth: 0 });
  if (lines.length === 0) { lines.push({ runs: [], attributes: NONE }); starts.push(0); }
  return { lines, starts };
}

/** The number of code points in a string, as Text counts. @param {string} text */
function codePoints(text) {
  let count = 0;
  for (const _ of text) count++;
  return count;
}

/** The first `count` code points of a string. @param {string} text @param {number} count */
function firstCodePoints(text, count) {
  let length = 0, seen = 0;
  for (const point of text) {
    if (seen++ === count) break;
    length += point.length;
  }
  return text.slice(0, length);
}

/** A line's text. @param {Line} line */
function lineText(line) {
  return line.runs.map(({ text }) => text).join("");
}

/**
 * Converts between Text element indices, which count code points and one "\n" between lines, and
 * ProseMirror positions, which count UTF-16 units and node boundaries.
 * @param {{ lines: readonly Line[], starts: readonly number[] }} flat
 */
export function positions(flat) {
  const texts = flat.lines.map(lineText);
  /** Each line's first element index. @type {number[]} */
  const firsts = [];
  let index = 0;
  for (const text of texts) { firsts.push(index); index += codePoints(text) + 1; }
  /** @param {number} element */
  const lineOf = (element) => {
    let low = 0, high = firsts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >>> 1;
      if (at(firsts, middle) <= element) low = middle; else high = middle - 1;
    }
    return low;
  };
  return {
    /** @param {number} element @returns {number} */
    toPosition(element) {
      const line = lineOf(element);
      return at(flat.starts, line) + firstCodePoints(at(texts, line), element - at(firsts, line)).length;
    },
    /** @param {number} position @returns {number} */
    toElement(position) {
      let line = 0;
      while (line + 1 < flat.starts.length && at(flat.starts, line + 1) <= position) line++;
      const text = at(texts, line);
      const offset = Math.max(0, Math.min(text.length, position - at(flat.starts, line)));
      return at(firsts, line) + codePoints(text.slice(0, offset));
    },
  };
}
