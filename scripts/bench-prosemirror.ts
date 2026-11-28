import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";

import { Window } from "happy-dom";
import { Schema } from "prosemirror-model";
import { schema as basic } from "prosemirror-schema-basic";
import { addListNodes } from "prosemirror-schema-list";
import { EditorState, TextSelection } from "prosemirror-state";

type Api = typeof import("../packages/articollab/src/index.ts");
type ProseMirrorApi = typeof import("../packages/articollab/src/prosemirror/index.ts");

export interface ProseMirrorResult {
  readonly size: number;
  readonly scenario: "local-keystroke" | "remote-keystroke";
  readonly unit: "ms/op";
  readonly samples: readonly number[];
  readonly median: number;
  readonly min: number;
  readonly max: number;
}

export function prosemirrorSettings(smoke: boolean) {
  return smoke ? { sizes: [500], keystrokes: 5, warmups: 1 } : { sizes: [5_000, 50_000], keystrokes: 50, warmups: 10 };
}

function summarize(size: number, scenario: ProseMirrorResult["scenario"], samples: number[]): ProseMirrorResult {
  const sorted = samples.toSorted((a, b) => a - b);
  return { size, scenario, unit: "ms/op", samples, median: sorted[Math.floor(sorted.length / 2)]!, min: sorted[0]!, max: sorted.at(-1)! };
}

/**
 * Two writers with ProseMirror editors on one Text of about `size` characters, in paragraphs of
 * about 100 with every tenth a heading. Measures a keystroke in the middle: the local transaction
 * with its write to the Text, and the other writer receiving it into its editor.
 */
export async function prosemirrorBench(smoke: boolean): Promise<ProseMirrorResult[]> {
  const window = new Window();
  Object.assign(globalThis, { window, document: window.document });
  const { EditorView } = await import("prosemirror-view");
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The built entrypoints of the sources typed here.
  const api = await import(import.meta.resolve("articollab")) as Api;
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- As above.
  const prosemirror = await import(import.meta.resolve("articollab/prosemirror")) as ProseMirrorApi;
  const schema = new Schema({ nodes: addListNodes(basic.spec.nodes, "paragraph block*", "block"), marks: basic.spec.marks });
  const Note = api.defineDocument({
    body: api.text({ marks: { bold: { expand: "after" }, italic: { expand: "after" }, code: { expand: "after" }, link: { expand: "none" } },
      blocks: { heading: {}, list: {}, indent: {}, quote: {}, code: {} } }),
  });
  const config = prosemirrorSettings(smoke);
  const results: ProseMirrorResult[] = [];
  for (const size of config.sizes) {
    const server = api.createServer(Note);
    const writer = () => {
      const doc = api.createClient(Note, { clientId: server.openClient(), onBatch: (batch) => { server.receive(batch); } });
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- happy-dom implements the DOM's HTMLElement.
      const view = new EditorView(window.document.createElement("div") as unknown as HTMLElement, {
        state: EditorState.create({ schema, plugins: [prosemirror.textSync(doc, "body")] }),
      });
      let seen = 0;
      return { doc, view, receive() { for (const commit of server.commitsSince(seen) ?? []) { doc.receive(commit); seen = commit.serverSeq; } } };
    };
    const a = writer(), b = writer();
    const paragraph = "lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore";
    const lines = Math.max(1, Math.round(size / (paragraph.length + 1)));
    a.doc.transact(() => {
      a.doc.state.body.insert(0, Array.from({ length: lines }, () => paragraph).join("\n"));
      for (let line = 0; line < lines; line += 10) a.doc.state.body.formatBlocks(line * (paragraph.length + 1), 0, "heading", 2);
    });
    b.receive();
    assert.equal(b.view.state.doc.childCount, lines);
    const middle = Math.floor(a.view.state.doc.content.size / 2);
    a.view.dispatch(a.view.state.tr.setSelection(TextSelection.near(a.view.state.doc.resolve(middle))));
    const local: number[] = [], remote: number[] = [];
    for (let round = 0; round < config.warmups + config.keystrokes; round++) {
      const started = performance.now();
      a.view.dispatch(a.view.state.tr.insertText("x"));
      const typed = performance.now();
      b.receive();
      const received = performance.now();
      if (round >= config.warmups) { local.push(typed - started); remote.push(received - typed); }
    }
    assert.equal(JSON.stringify(a.view.state.doc.toJSON()), JSON.stringify(b.view.state.doc.toJSON()));
    a.view.destroy();
    b.view.destroy();
    results.push(summarize(size, "local-keystroke", local), summarize(size, "remote-keystroke", remote));
  }
  return results;
}
