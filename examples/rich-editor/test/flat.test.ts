import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildDoc, flattenDoc, positions, textLines, type Line } from "../flat.js";
import { editorSchema } from "../schema.js";
import { createClient, createServer } from "../../../dist/index.js";
import { Note } from "../schema.js";

const line = (text: string, attributes: Line["attributes"] = {}, marks: Line["runs"][number]["marks"] = {}): Line =>
  ({ runs: text === "" ? [] : [{ text, marks }], attributes });

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
    ];
    for (const lines of cases) {
      const doc = buildDoc(editorSchema, lines);
      doc.check();
      assert.deepEqual(JSON.parse(JSON.stringify(flattenDoc(doc).lines)), JSON.parse(JSON.stringify(lines)), JSON.stringify(lines));
    }
  });

  it("normalizes what the standard shape cannot hold", () => {
    const doc = buildDoc(editorSchema, [
      line("item", { heading: 2, list: "bullet" }), // No headings in lists
      line("deep", { indent: 5, list: "bullet" }), // At most one deeper than the line before
      { runs: [{ text: "code", marks: { bold: true } }], attributes: { code: true, list: "bullet" } }, // Code wins, without marks
    ]);
    assert.deepEqual(JSON.parse(JSON.stringify(flattenDoc(doc).lines)), [
      { runs: [{ text: "item", marks: {} }], attributes: { list: "bullet" } },
      { runs: [{ text: "deep", marks: {} }], attributes: { indent: 1, list: "bullet" } },
      { runs: [{ text: "code", marks: {} }], attributes: { code: true } },
    ]);
  });

  it("reads lines from a Text, and maps its indices to positions and back", () => {
    const server = createServer(Note);
    const doc = createClient(Note, { clientId: server.openClient(), onBatch: (batch) => { doc.receive(server.receive(batch).commit); } });
    const body = doc.state.body;
    body.insert(0, "Title\n😀 item\nx\ny");
    body.formatBlocks(0, 0, "heading", 1);
    body.formatBlocks(6, 0, "list", "bullet");
    body.formatBlocks(14, 2, "code", true);
    body.format(8, 4, "bold", true);
    const lines = textLines(body);
    assert.deepEqual(JSON.parse(JSON.stringify(lines)), [
      { runs: [{ text: "Title", marks: {} }], attributes: { heading: 1 } },
      { runs: [{ text: "😀 ", marks: {} }, { text: "item", marks: { bold: true } }], attributes: { list: "bullet" } },
      { runs: [{ text: "x", marks: {} }], attributes: { code: true } },
      { runs: [{ text: "y", marks: {} }], attributes: { code: true } },
    ]);
    const flat = flattenDoc(buildDoc(editorSchema, lines));
    const map = positions(flat);
    // <h1>Title</h1><ul><li><p>😀 item</p></li></ul><pre>x\ny</pre>
    assert.deepEqual(flat.starts, [1, 10, 21, 23]);
    assert.deepEqual([0, 5, 6, 7, 12, 13, 14, 15, 16].map((element) => map.toPosition(element)), [1, 6, 10, 12, 17, 21, 22, 23, 24]);
    for (const element of [0, 5, 6, 7, 12, 13, 14, 15, 16]) assert.equal(map.toElement(map.toPosition(element)), element);
    assert.equal(map.toElement(8), 5, "a position between blocks goes to the end of the line before");
  });
});
