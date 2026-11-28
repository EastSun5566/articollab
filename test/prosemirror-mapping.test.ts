import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Schema } from "prosemirror-model";
import { schema as basic } from "prosemirror-schema-basic";
import { addListNodes } from "prosemirror-schema-list";

import { createClient, defineDocument, text } from "../packages/articollab/src/index.ts";
import { basicMapping, TextShape, textLines, type Line, type TextMapping } from "../packages/articollab/src/prosemirror/mapping.ts";

export const editorSchema = new Schema({ nodes: addListNodes(basic.spec.nodes, "paragraph block*", "block"), marks: basic.spec.marks });
const shape = new TextShape(editorSchema, basicMapping);
const Note = defineDocument({
  body: text({
    marks: { bold: { expand: "after" }, italic: { expand: "after" }, code: { expand: "after" }, link: { expand: "none" } },
    blocks: { heading: {}, list: {}, indent: {}, quote: {}, code: {} },
  }),
});

const line = (content: string, attributes: Line["attributes"] = {}, marks: Line["runs"][number]["marks"] = {}): Line =>
  ({ runs: content === "" ? [] : [{ text: content, marks }], attributes });
const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

describe("Text lines and ProseMirror documents", () => {
  it("builds every structure in one standard shape and reads it back", () => {
    const cases: Line[][] = [
      [line("")],
      [line("Title", { heading: 1 }), line("plain"), { runs: [{ text: "bold", marks: { bold: true } },
        { text: " and ", marks: {} }, { text: "link", marks: { link: "https://example.com" } }], attributes: {} }],
      [line("a", { list: "bullet" }), line("a1", { indent: 1, list: "bullet" }), line("a2", { indent: 2, list: "ordered" }),
        line("b", { list: "bullet" }), line("c", { list: "ordered" })],
      [line("quoted", { quote: true }), line("item", { list: "bullet", quote: true }), line("x = 1", { code: true, quote: true })],
      [line("let a = 1;", { code: true }), line("", { code: true }), line("😀", { code: true }), line("after")],
      [line("one", { code: true }), line("two", { quote: true }), line("three", { code: true })],
      [line("Deep", { heading: 6 })],
    ];
    for (const lines of cases) {
      const doc = shape.doc(lines);
      doc.check();
      assert.deepEqual(plain(shape.lines(doc)), plain(lines), JSON.stringify(lines));
    }
  });

  it("normalizes what the standard shape cannot hold", () => {
    const doc = shape.doc([
      line("item", { heading: 2, list: "bullet" }), // No headings in lists
      line("deep", { indent: 5, list: "bullet" }), // At most one deeper than the line before
      { runs: [{ text: "code", marks: { bold: true } }], attributes: { code: true, list: "bullet" } }, // Code wins, without marks
    ]);
    assert.deepEqual(plain(shape.lines(doc)), [
      { runs: [{ text: "item", marks: {} }], attributes: { list: "bullet" } },
      { runs: [{ text: "deep", marks: {} }], attributes: { indent: 1, list: "bullet" } },
      { runs: [{ text: "code", marks: {} }], attributes: { code: true } },
    ]);
  });

  it("reads lines from all or part of a Text, and maps its indices to positions and back", () => {
    const doc = createClient(Note, { clientId: "a", onBatch() {} });
    const body = doc.state.body;
    body.insert(0, "Title\n😀 item\nx\ny");
    body.formatBlocks(0, 0, "heading", 1);
    body.formatBlocks(6, 0, "list", "bullet");
    body.formatBlocks(14, 2, "code", true);
    body.format(8, 4, "bold", true);
    const lines = textLines(body);
    assert.deepEqual(plain(lines), [
      { runs: [{ text: "Title", marks: {} }], attributes: { heading: 1 } },
      { runs: [{ text: "😀 ", marks: {} }, { text: "item", marks: { bold: true } }], attributes: { list: "bullet" } },
      { runs: [{ text: "x", marks: {} }], attributes: { code: true } },
      { runs: [{ text: "y", marks: {} }], attributes: { code: true } },
    ]);
    assert.deepEqual(plain(textLines(body, 6, 8)), plain(lines.slice(1, 3)), "the middle two lines");
    // Lines are joined by line breaks, so a range ending after one also holds the empty start of the next line.
    assert.deepEqual(plain(textLines(body, 6, 9)), plain([...lines.slice(1, 3), { runs: [], attributes: { code: true } }]));
    assert.deepEqual(plain(textLines(body, 16, 0)), [{ runs: [], attributes: { code: true } }], "the empty end");
    const editor = shape.doc(lines);
    // <h1>Title</h1><ul><li><p>😀 item</p></li></ul><pre>x\ny</pre>
    const elements = [0, 5, 6, 7, 12, 13, 14, 15, 16];
    assert.deepEqual(elements.map((element) => shape.positionAt(editor, element)), [1, 6, 10, 12, 17, 21, 22, 23, 24]);
    for (const element of elements) assert.equal(shape.elementAt(editor, shape.positionAt(editor, element)), element);
    assert.equal(shape.elementAt(editor, 8), 5, "a position between blocks goes to the end of the line before");
    assert.equal(shape.elementAt(editor, 0), 0);
  });

  it("caches each node's lines, so an unchanged node is not read again", () => {
    const doc = shape.doc([line("a"), line("b", { heading: 2 })]);
    const first = doc.child(0);
    assert.equal(shape.nodeInfo(first), shape.nodeInfo(first));
    const changed = doc.replace(1, 2, doc.slice(1, 2));
    assert.equal(shape.nodeInfo(changed.child(1)), shape.nodeInfo(doc.child(1)), "the second paragraph is shared");
  });
});

describe("Custom mappings", () => {
  it("maps other node and mark names, and leaves out what the mapping lacks", () => {
    const custom = new Schema({
      topNode: "root",
      nodes: {
        root: { content: "block+" },
        para: { content: "inline*", group: "block" },
        title: { content: "inline*", group: "block", attrs: { level: { default: 1 } } },
        aside: { content: "para+", group: "block" },
        text: { group: "inline" },
      },
      marks: { heavy: {}, ref: { attrs: { to: {} } } },
    });
    const mapping: TextMapping = {
      doc: "root", paragraph: "para",
      marks: { bold: { mark: "heavy" }, link: { mark: "ref", value: (mark) => String(mark.attrs.to), attrs: (value) => ({ to: value }) } },
      heading: { node: "title", levels: [1, 2] },
      blockquote: { node: "aside" },
    };
    const own = new TextShape(custom, mapping);
    const lines = [line("Head", { heading: 2 }), line("note", { quote: true }, { bold: true }),
      { runs: [{ text: "see", marks: { link: "#top" } }], attributes: {} }];
    const doc = own.doc(lines);
    doc.check();
    assert.equal(doc.child(1).type.name, "aside");
    assert.deepEqual(plain(own.lines(doc)), plain(lines));
    // Without lists or code blocks in the mapping, those attributes make plain paragraphs.
    assert.deepEqual(plain(own.lines(own.doc([line("x", { list: "bullet", code: true })]))), [line("x")]);
    // A level outside `levels` comes back at the nearest one.
    assert.deepEqual(plain(own.lines(custom.node("root", null, [custom.node("title", { level: 5 }, [custom.text("t")])]))),
      [line("t", { heading: 2 })]);
    assert.deepEqual(own.keys(), { marks: ["bold", "link"], blocks: ["heading", "quote"] });
  });

  it("refuses a mapping the schema cannot hold", () => {
    assert.throws(() => new TextShape(editorSchema, { ...basicMapping, paragraph: "para" }), /no para node/);
    assert.throws(() => new TextShape(editorSchema, { ...basicMapping, marks: { bold: { mark: "heavy" } } }), /no heavy mark for bold/);
    assert.throws(() => new TextShape(basic, basicMapping), /no list_item node/);
  });
});
