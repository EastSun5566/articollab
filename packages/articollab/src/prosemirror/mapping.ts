import { Mark, type Attrs, type Node, type NodeType, type Schema } from "prosemirror-model";

import type { JsonValue } from "../schema.ts";

/** One Text mark key's ProseMirror mark. */
export interface MarkMapping {
  /** The ProseMirror mark's name. */
  readonly mark: string;
  /** The Text mark's value for a ProseMirror mark; `true` by default. */
  readonly value?: (mark: Mark) => JsonValue;
  /** The ProseMirror mark's attributes for a Text mark value; none by default. */
  readonly attrs?: (value: JsonValue) => Attrs | null;
}

/**
 * Which ProseMirror nodes and marks stand for a Text's lines, marks and paragraph attributes. A
 * paragraph's attributes use fixed keys: `heading` (a level), `code` (`true`, or a code block's
 * language), `quote` (`true`), `list` (`"bullet"` or `"ordered"`) and `indent` (a list depth from 1).
 * Nodes and marks that are not listed are left out.
 */
export interface TextMapping {
  /** The document node; `"doc"` by default. */
  readonly doc?: string;
  readonly paragraph: string;
  /** ProseMirror marks by Text mark key. */
  readonly marks: Readonly<Record<string, MarkMapping>>;
  /** A heading node with a `level` attribute, for the `heading` attribute, kept within `levels`. */
  readonly heading?: { readonly node: string; readonly levels: readonly number[] };
  /**
   * A code block, one line per `"\n"` in it, for the `code` attribute. Its text has no marks. With
   * `language`, the name of its language attribute, a block with a language stores it as the value of
   * `code`; otherwise every value of `code` is a code block, and writing leaves the value as it is.
   */
  readonly codeBlock?: { readonly node: string; readonly language?: string };
  /** A quote around paragraphs, for the `quote` attribute. */
  readonly blockquote?: { readonly node: string };
  /**
   * List nodes, for the `list` and `indent` attributes. Each item holds one paragraph and nested
   * lists. Lists nested deeper than `maxIndent` levels below the first are flattened to it.
   */
  readonly lists?: { readonly item: string; readonly bullet: string; readonly ordered: string; readonly maxIndent?: number };
  /** An inline node that breaks a line, such as a hard break: it starts another line with the same attributes. */
  readonly lineBreak?: { readonly node: string };
}

/** The nodes and marks of `prosemirror-schema-basic` with `prosemirror-schema-list`'s lists. */
export const basicMapping: TextMapping = Object.freeze({
  paragraph: "paragraph",
  marks: Object.freeze({
    bold: Object.freeze({ mark: "strong" }),
    italic: Object.freeze({ mark: "em" }),
    code: Object.freeze({ mark: "code" }),
    link: Object.freeze({
      mark: "link",
      value: (mark: Mark): JsonValue => String(mark.attrs.href),
      attrs: (value: JsonValue): Attrs => ({ href: typeof value === "string" ? value : JSON.stringify(value) }),
    }),
  }),
  heading: Object.freeze({ node: "heading", levels: Object.freeze([1, 2, 3, 4, 5, 6]) }),
  codeBlock: Object.freeze({ node: "code_block" }),
  blockquote: Object.freeze({ node: "blockquote" }),
  lists: Object.freeze({ item: "list_item", bullet: "bullet_list", ordered: "ordered_list" }),
  lineBreak: Object.freeze({ node: "hard_break" }),
});

/** Paragraph attributes or marks: JSON values by key, keys sorted. */
export type Attributes = Readonly<Record<string, JsonValue>>;
/** A run of equally marked text in one line. */
interface Run { readonly text: string; readonly marks: Attributes }
/** One paragraph of the Text: its text as runs, and its paragraph attributes. */
export interface Line { readonly runs: readonly Run[]; readonly attributes: Attributes }

const NONE: Attributes = Object.freeze({});
const EMPTY_LINE: Line = Object.freeze({ runs: Object.freeze([]), attributes: NONE });

/** Whether two JSON values are equal; object key order does not matter. */
export function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) return false;
  const left = Object.entries(a), right = new Map(Object.entries(b));
  return left.length === right.size && left.every(([key, value]) => right.has(key) && sameJson(value, right.get(key)));
}

function sorted(attributes: Record<string, JsonValue>): Attributes {
  return Object.freeze(Object.fromEntries(Object.entries(attributes).toSorted(([a], [b]) => (a < b ? -1 : 1))));
}

/** The code points of a string, as Text counts them. */
function codePointLength(text: string): number {
  let count = 0;
  for (const _ of text) count++;
  return count;
}

/** A line's text. */
function lineText(line: Line): string {
  return line.runs.map(({ text }) => text).join("");
}

/** A line's length in Text elements. */
export function lineLength(line: Line): number {
  let length = 0;
  for (const { text } of line.runs) length += codePointLength(text);
  return length;
}

/** The Text lines of `count` elements from `index`, which must start and end at line boundaries. */
export function textLines(
  body: {
    toDelta(index?: number, count?: number): readonly { readonly insert: string; readonly attributes?: Attributes }[];
    blocks(index?: number, count?: number): readonly { readonly attributes: Attributes }[];
  },
  index?: number,
  count?: number,
): Line[] {
  const ranged = index !== undefined;
  const delta = ranged ? body.toDelta(index, count) : body.toDelta();
  const blocks = [...(ranged ? body.blocks(index, count) : body.blocks())];
  // A range ending just after a line break also holds the empty start of the next line, which
  // blocks() leaves out: a paragraph starts within a range only before its last element.
  if (ranged && delta.at(-1)?.insert.endsWith("\n") === true) blocks.push(...body.blocks(index + delta.reduce((sum, run) => sum + codePointLength(run.insert), 0), 0));
  const lines: { runs: Run[]; attributes: Attributes }[] = blocks.map(({ attributes }) => ({ runs: [], attributes: sorted({ ...attributes }) }));
  let line = 0;
  for (const { insert, attributes } of delta) {
    insert.split("\n").forEach((part, position) => {
      if (position > 0) line++;
      if (part !== "") lines[line]?.runs.push({ text: part, marks: attributes === undefined ? NONE : sorted({ ...attributes }) });
    });
  }
  return lines.map((each) => ({ runs: mergeRuns(each.runs), attributes: each.attributes }));
}

function mergeRuns(runs: readonly Run[]): Run[] {
  const merged: Run[] = [];
  for (const run of runs) {
    const last = merged.at(-1);
    if (last !== undefined && sameJson(last.marks, run.marks)) merged[merged.length - 1] = { text: last.text + run.text, marks: run.marks };
    else merged.push(run);
  }
  return merged;
}

/** One top-level node's lines, where each line's text starts in it, and its length in Text elements. */
interface NodeInfo {
  readonly lines: readonly Line[];
  /** Each line's text start, counted from the node's own start. */
  readonly starts: readonly number[];
  /** Each line's length in Text elements. */
  readonly lengths: readonly number[];
  /** The node's length in Text elements, with a line break between its lines. */
  readonly length: number;
}

/**
 * Where each top-level node of a document starts, in Text elements and as a ProseMirror position,
 * by child index. A node without lines, such as one the mapping leaves out, takes no elements.
 */
export interface Layout {
  readonly elements: readonly number[];
  readonly positions: readonly number[];
  /** The child indices of the nodes that have lines, in order. */
  readonly lined: readonly number[];
  /** The text's length in elements. */
  readonly length: number;
}

/** The last index whose value is at most `target` in an ascending array, or 0. */
function lastAtMost(values: readonly number[], target: number): number {
  let low = 0, high = values.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >>> 1;
    if (values[middle]! <= target) low = middle; else high = middle - 1;
  }
  return low;
}

/**
 * Converts between a Text's lines and ProseMirror nodes for one mapping. The nodes are always in one
 * standard shape: consecutive quoted lines are one quote, consecutive code lines one code block
 * without marks, list lines nested lists with one paragraph per item, and a list item never a
 * heading. A line's list depth is its `indent`, but at most one deeper than the line before.
 */
export class TextShape {
  readonly schema: Schema;
  readonly mapping: TextMapping;
  private readonly cache = new WeakMap<Node, NodeInfo>();
  private readonly layouts = new WeakMap<Node, Layout>();

  constructor(schema: Schema, mapping: TextMapping) {
    this.schema = schema;
    this.mapping = mapping;
    // Fail at once for a mapping the schema cannot hold.
    this.node(mapping.doc ?? "doc");
    this.node(mapping.paragraph);
    if (mapping.heading !== undefined) this.node(mapping.heading.node);
    if (mapping.codeBlock !== undefined) this.node(mapping.codeBlock.node);
    if (mapping.blockquote !== undefined) this.node(mapping.blockquote.node);
    if (mapping.lists !== undefined) for (const name of [mapping.lists.item, mapping.lists.bullet, mapping.lists.ordered]) this.node(name);
    if (mapping.lineBreak !== undefined) this.node(mapping.lineBreak.node);
    for (const [key, { mark }] of Object.entries(mapping.marks)) {
      if (schema.marks[mark] === undefined) throw new TypeError(`The schema has no ${mark} mark for ${key}`);
    }
  }

  private node(name: string): NodeType {
    const type = this.schema.nodes[name];
    if (type === undefined) throw new TypeError(`The schema has no ${name} node`);
    return type;
  }

  /** The Text mark and paragraph attribute keys this mapping writes. */
  keys(): { marks: readonly string[]; blocks: readonly string[] } {
    const { heading, codeBlock, blockquote, lists } = this.mapping;
    return {
      marks: Object.keys(this.mapping.marks),
      blocks: [...(heading ? ["heading"] : []), ...(codeBlock ? ["code"] : []), ...(blockquote ? ["quote"] : []),
        ...(lists ? ["list", "indent"] : [])],
    };
  }

  /**
   * Whether two values of a paragraph attribute show the same: for `code` without a language
   * attribute, any two values make a code block.
   */
  sameAttribute(key: string, a: JsonValue | undefined, b: JsonValue | undefined): boolean {
    if (key === "code" && this.mapping.codeBlock?.language === undefined && a != null && b != null) return true;
    return sameJson(a ?? null, b ?? null);
  }

  // Lines to nodes.

  private marksFor(marks: Attributes): readonly Mark[] {
    const result: Mark[] = [];
    for (const [key, { mark, attrs }] of Object.entries(this.mapping.marks)) {
      const value = marks[key];
      if (value === undefined) continue;
      result.push(this.schema.marks[mark]!.create(attrs === undefined ? null : attrs(value)));
    }
    return Mark.setFrom(result);
  }

  private inline(line: Line): Node[] {
    return line.runs.filter(({ text }) => text !== "").map(({ text, marks }) => this.schema.text(text, this.marksFor(marks)));
  }

  private textblock(line: Line, inList: boolean): Node {
    const { heading } = this.mapping;
    const level = line.attributes.heading;
    if (!inList && heading !== undefined && typeof level === "number" && heading.levels.includes(level)) {
      return this.node(heading.node).create({ level }, this.inline(line));
    }
    return this.node(this.mapping.paragraph).create(null, this.inline(line));
  }

  private buildLists(lines: readonly Line[]): Node[] {
    const lists = this.mapping.lists!;
    const depths: number[] = [];
    for (const [index, line] of lines.entries()) {
      const indent = typeof line.attributes.indent === "number" ? line.attributes.indent : 0;
      depths.push(index === 0 ? 0 : Math.min(indent, depths[index - 1]! + 1, lists.maxIndent ?? Infinity));
    }
    const level = (start: number, depth: number): [Node[], number] => {
      const result: Node[] = [];
      let position = start;
      while (position < lines.length && depths[position] === depth) {
        const kind = lines[position]!.attributes.list;
        const type = this.node(kind === "ordered" ? lists.ordered : lists.bullet);
        const items: Node[] = [];
        while (position < lines.length && depths[position] === depth && lines[position]!.attributes.list === kind) {
          const children = [this.textblock(lines[position]!, true)];
          position++;
          if (position < lines.length && depths[position]! > depth) {
            const [nested, next] = level(position, depth + 1);
            children.push(...nested);
            position = next;
          }
          items.push(this.node(lists.item).create(null, children));
        }
        result.push(type.create(null, items));
      }
      return [result, position];
    };
    return level(0, 0)[0];
  }

  private buildBlocks(lines: readonly Line[], inQuote: boolean): Node[] {
    const { codeBlock, blockquote, lists } = this.mapping;
    const blocks: Node[] = [];
    const runEnd = (start: number, test: (line: Line) => boolean) => {
      let end = start;
      while (end < lines.length && test(lines[end]!)) end++;
      return end;
    };
    const quoted = (line: Line) => blockquote !== undefined && !inQuote && line.attributes.quote === true;
    const coded = (line: Line) => codeBlock !== undefined && line.attributes.code != null;
    // Lines of one code block: the same language, when the mapping stores one.
    const language = (line: Line) => (codeBlock?.language === undefined || typeof line.attributes.code !== "string" ? true : line.attributes.code);
    const listed = (line: Line) => lists !== undefined && (line.attributes.list === "bullet" || line.attributes.list === "ordered");
    for (let index = 0; index < lines.length;) {
      const line = lines[index]!;
      if (quoted(line)) {
        const end = runEnd(index, quoted);
        blocks.push(this.node(blockquote!.node).create(null, this.buildBlocks(lines.slice(index, end), true)));
        index = end;
      } else if (coded(line)) {
        const value = language(line);
        const end = runEnd(index, (next) => coded(next) && !quoted(next) && language(next) === value);
        const code = lines.slice(index, end).map(lineText).join("\n");
        const attrs = codeBlock!.language === undefined ? null : { [codeBlock!.language]: value === true ? null : value };
        blocks.push(this.node(codeBlock!.node).create(attrs, code === "" ? [] : [this.schema.text(code)]));
        index = end;
      } else if (listed(line)) {
        const end = runEnd(index, (next) => listed(next) && !coded(next) && !quoted(next));
        blocks.push(...this.buildLists(lines.slice(index, end)));
        index = end;
      } else {
        blocks.push(this.textblock(line, false));
        index++;
      }
    }
    return blocks;
  }

  /** The top-level nodes for some lines, in the standard shape. */
  nodes(lines: readonly Line[]): Node[] {
    return this.buildBlocks(lines, false);
  }

  /** The document for some lines, in the standard shape; no lines make one empty paragraph. */
  doc(lines: readonly Line[]): Node {
    return this.node(this.mapping.doc ?? "doc").create(null, this.nodes(lines.length === 0 ? [EMPTY_LINE] : lines));
  }

  // Nodes to lines.

  private textMarks(node: Node): Attributes {
    const marks: Record<string, JsonValue> = {};
    for (const mark of node.marks) {
      for (const [key, { mark: name, value }] of Object.entries(this.mapping.marks)) {
        if (mark.type.name === name) marks[key] = value === undefined ? true : value(mark);
      }
    }
    return sorted(marks);
  }

  /** Collects the lines under `parent`, whose content starts at position `offset`, and where each line's text starts. */
  private walk(parent: Node, offset: number, context: { quote: boolean; list?: "bullet" | "ordered"; depth: number },
    lines: Line[], starts: number[]): void {
    const { heading, codeBlock, blockquote, lists, lineBreak } = this.mapping;
    parent.forEach((node, childOffset) => {
      const position = offset + childOffset;
      const name = node.type.name;
      const attributes: Record<string, JsonValue> = {};
      if (context.quote) attributes.quote = true;
      if (blockquote !== undefined && name === blockquote.node) {
        this.walk(node, position + 1, { ...context, quote: true }, lines, starts);
      } else if (lists !== undefined && (name === lists.bullet || name === lists.ordered)) {
        const depth = context.list === undefined ? 0 : Math.min(context.depth + 1, lists.maxIndent ?? Infinity);
        const list = name === lists.ordered ? "ordered" : "bullet";
        node.forEach((item, itemOffset) => { this.walk(item, position + 1 + itemOffset + 1, { quote: context.quote, list, depth }, lines, starts); });
      } else if (codeBlock !== undefined && name === codeBlock.node) {
        let start = position + 1;
        const language: unknown = codeBlock.language === undefined ? undefined : node.attrs[codeBlock.language];
        const code = typeof language === "string" && language !== "" ? language : true;
        for (const part of node.textContent.split("\n")) {
          lines.push({ runs: part === "" ? [] : [{ text: part, marks: NONE }], attributes: sorted({ ...attributes, code }) });
          starts.push(start);
          start += part.length + 1;
        }
      } else if (node.isTextblock) {
        if (context.list !== undefined) {
          attributes.list = context.list;
          if (context.depth > 0) attributes.indent = context.depth;
        } else if (heading !== undefined && name === heading.node) {
          const levels = heading.levels, level = Number(node.attrs.level);
          attributes.heading = levels.includes(level) ? level : (level < Math.min(...levels) ? Math.min(...levels) : Math.max(...levels));
        }
        // A line break typed into the text, as insertText("a\nb") makes, or a line break node starts
        // another line like it.
        let runs: Run[] = [], start = position + 1;
        const own = sorted(attributes);
        node.forEach((child, at) => {
          if (lineBreak !== undefined && child.type.name === lineBreak.node) {
            lines.push({ runs, attributes: own });
            starts.push(start);
            runs = [];
            start = position + 1 + at + child.nodeSize;
            return;
          }
          if (!child.isText) return;
          const marks = this.textMarks(child);
          for (const [index, part] of (child.text ?? "").split("\n").entries()) {
            if (index > 0) {
              lines.push({ runs, attributes: own });
              starts.push(start);
              runs = [];
              start = position + 1 + at + (child.text ?? "").split("\n").slice(0, index).join("\n").length + 1;
            }
            if (part === "") continue;
            const last = runs.at(-1);
            if (last !== undefined && sameJson(last.marks, marks)) runs[runs.length - 1] = { text: last.text + part, marks };
            else runs.push({ text: part, marks });
          }
        });
        lines.push({ runs, attributes: own });
        starts.push(start);
      } else {
        this.walk(node, position + 1, context, lines, starts);
      }
    });
  }

  /**
   * The lines of one top-level node, and where each line's text starts, counted from the node's own
   * start. Cached: ProseMirror nodes never change.
   */
  nodeInfo(node: Node): NodeInfo {
    let info = this.cache.get(node);
    if (info === undefined) {
      const lines: Line[] = [], starts: number[] = [];
      this.walk(this.node(this.mapping.doc ?? "doc").create(null, node), 0, { quote: false, depth: 0 }, lines, starts);
      const lengths = lines.map(lineLength);
      const length = lengths.reduce((sum, each) => sum + each, 0) + Math.max(0, lines.length - 1);
      info = Object.freeze({ lines: Object.freeze(lines), starts: Object.freeze(starts), lengths: Object.freeze(lengths), length });
      this.cache.set(node, info);
    }
    return info;
  }

  /**
   * Where each top-level node starts, in Text elements and positions. Linear in the number of
   * top-level nodes, not in the text: each node's length is cached.
   */
  layout(doc: Node): Layout {
    let layout = this.layouts.get(doc);
    if (layout === undefined) {
      const elements: number[] = [], positions: number[] = [], lined: number[] = [];
      let element = 0;
      doc.forEach((node, position, index) => {
        const info = this.nodeInfo(node);
        // A line break separates this node's first line from the line before.
        const start = info.lines.length > 0 && lined.length > 0 ? element + 1 : element;
        elements.push(start);
        positions.push(position);
        if (info.lines.length === 0) return;
        lined.push(index);
        element = start + info.length;
      });
      layout = Object.freeze({ elements: Object.freeze(elements), positions: Object.freeze(positions), lined: Object.freeze(lined), length: element });
      this.layouts.set(doc, layout);
    }
    return layout;
  }

  /** The child index of the node with lines that holds Text element gap `element`. */
  childAtElement(doc: Node, element: number): number {
    const layout = this.layout(doc);
    const starts = layout.lined.map((index) => layout.elements[index]!);
    return layout.lined[lastAtMost(starts, element)] ?? 0;
  }

  /** The document position of Text element gap `element`. */
  positionAt(doc: Node, element: number): number {
    const layout = this.layout(doc);
    if (layout.lined.length === 0) return 0;
    const child = this.childAtElement(doc, element);
    const info = this.nodeInfo(doc.child(child));
    let offset = element - layout.elements[child]!, line = 0;
    while (line < info.lines.length - 1 && offset > info.lengths[line]!) { offset -= info.lengths[line]! + 1; line++; }
    offset = Math.max(0, Math.min(offset, info.lengths[line]!));
    let units = 0, seen = 0;
    for (const point of lineText(info.lines[line]!)) {
      if (seen++ === offset) break;
      units += point.length;
    }
    return layout.positions[child]! + info.starts[line]! + units;
  }

  /** The Text element gap nearest document position `position`; between blocks, the end of the line before. */
  elementAt(doc: Node, position: number): number {
    const layout = this.layout(doc);
    if (layout.lined.length === 0) return 0;
    const lined = layout.lined.map((index) => layout.positions[index]!);
    const at = lastAtMost(lined, position);
    const child = layout.lined[at]!;
    const info = this.nodeInfo(doc.child(child));
    const relative = position - layout.positions[child]!;
    // Before the node's first text, as between two blocks: the end of the line before.
    if (relative < info.starts[0]! && at > 0) return layout.elements[child]! - 1;
    const line = lastAtMost(info.starts, relative);
    let element = layout.elements[child]!;
    for (let before = 0; before < line; before++) element += info.lengths[before]! + 1;
    const text = lineText(info.lines[line]!);
    const units = Math.max(0, Math.min(text.length, relative - info.starts[line]!));
    return element + codePointLength(text.slice(0, units));
  }


  /** The lines of one top-level node. */
  nodeLines(node: Node): readonly Line[] {
    return this.nodeInfo(node).lines;
  }

  /** The lines of a document: every top-level node's, and one empty line for a document with none. */
  lines(doc: Node): Line[] {
    const lines: Line[] = [];
    doc.forEach((node) => { lines.push(...this.nodeLines(node)); });
    return lines.length === 0 ? [EMPTY_LINE] : lines;
  }
}
