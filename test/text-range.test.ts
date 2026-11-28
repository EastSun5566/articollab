import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createClient, defineDocument, text, type TextAttributes } from "../packages/articollab/src/index.ts";

const Doc = defineDocument({
  body: text({ marks: { bold: { expand: "after" }, link: { expand: "none" } }, blocks: { heading: {}, list: {} } }),
});

/** A writer whose Text has marks across lines, paragraph attributes and an emoji. */
function sample() {
  const doc = createClient(Doc, { clientId: "a", onBatch() {} });
  const body = doc.state.body;
  body.insert(0, "Ti😀le\nfirst line\n\nlast");
  body.format(1, 8, "bold", true);
  body.format(9, 3, "link", "https://example.com");
  body.formatBlocks(0, 0, "heading", 1);
  body.formatBlocks(7, 12, "list", "bullet");
  return body;
}

/** The same runs as the whole text's, cut to `count` elements from `index`. */
function expectedDelta(body: ReturnType<typeof sample>, index: number, count: number) {
  const elements: { value: string; attributes: TextAttributes }[] = [];
  for (const run of body.toDelta()) for (const value of run.insert) elements.push({ value, attributes: run.attributes ?? {} });
  const runs: { insert: string; attributes?: TextAttributes }[] = [];
  for (const { value, attributes } of elements.slice(index, index + count)) {
    const last = runs.at(-1);
    if (last !== undefined && JSON.stringify(last.attributes ?? {}) === JSON.stringify(attributes)) last.insert += value;
    else runs.push(Object.keys(attributes).length === 0 ? { insert: value } : { insert: value, attributes });
  }
  return runs;
}

/** The whole text's paragraphs that the range touches, by formatBlocks' rule. */
function expectedBlocks(body: ReturnType<typeof sample>, index: number, count: number) {
  const values = [...body];
  return body.blocks().filter((block) => {
    const end = block.index + block.length; // The paragraph's last gap.
    if (count === 0) return block.index <= index && index <= end;
    // The paragraph holding `index`, or one started by a line break among the first count - 1 elements.
    if (block.index <= index && index <= end) return true;
    return block.index > index && block.index - 1 < index + count - 1 && values[block.index - 1] === "\n";
  });
}

describe("Text range reads", () => {
  it("returns the runs and paragraphs of any range, as the whole text's", () => {
    const body = sample();
    for (let index = 0; index <= body.length; index++) {
      for (let count = 0; count <= body.length - index; count++) {
        assert.deepEqual(body.toDelta(index, count), expectedDelta(body, index, count), `toDelta(${index}, ${count})`);
        assert.deepEqual(body.blocks(index, count), expectedBlocks(body, index, count), `blocks(${index}, ${count})`);
      }
    }
  });

  it("reads to the end by default, and the whole text without arguments", () => {
    const body = sample();
    assert.deepEqual(body.toDelta(7), expectedDelta(body, 7, body.length - 7));
    assert.deepEqual(body.toDelta(0), body.toDelta());
    assert.deepEqual(body.blocks(0), body.blocks());
    assert.deepEqual(body.blocks(body.length, 0), [{ index: 18, length: 4, attributes: { list: "bullet" } }]);
    assert.ok(Object.isFrozen(body.toDelta(1, 3)) && Object.isFrozen(body.blocks(1, 3)[0]));
  });

  it("checks the range like the other index APIs", () => {
    const body = sample();
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- A wrong type on purpose.
    assert.throws(() => body.toDelta("1" as unknown as number), TypeError);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- A wrong type on purpose.
    assert.throws(() => body.blocks(0, "1" as unknown as number), TypeError);
    for (const [index, count] of [[-1, 0], [body.length + 1, 0], [0, body.length + 1], [2, -1], [1.5, 0], [0, 0.5]] as const) {
      assert.throws(() => body.toDelta(index, count), RangeError, `${index}, ${count}`);
      assert.throws(() => body.blocks(index, count), RangeError, `${index}, ${count}`);
    }
    const empty = createClient(Doc, { clientId: "b", onBatch() {} }).state.body;
    assert.deepEqual(empty.toDelta(0, 0), []);
    assert.deepEqual(empty.blocks(0, 0), [{ index: 0, length: 0, attributes: {} }]);
  });
});
