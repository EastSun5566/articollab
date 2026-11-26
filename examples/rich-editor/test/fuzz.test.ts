import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { baseKeymap, lift, setBlockType, toggleMark, wrapIn } from "prosemirror-commands";
import { liftListItem, sinkListItem, splitListItem, wrapInList } from "prosemirror-schema-list";
import { Selection, TextSelection, type Command } from "prosemirror-state";
import { createClient, createServer, type ClientBatch, type DocumentOperation } from "../../../dist/index.js";
import { createRichTextBinding } from "../binding.js";
import { buildDoc, textLines } from "../flat.js";
import { editorSchema, keepSafeLinks, Note } from "../schema.js";

type Batch = ClientBatch<DocumentOperation<typeof Note.definition>>;
const nodes = editorSchema.nodes, marks = editorSchema.marks;
const commands: [string, Command][] = [
  ["enter", (state, dispatch) => splitListItem(nodes.list_item!)(state, dispatch) || baseKeymap.Enter!(state, dispatch)],
  ["backspace", baseKeymap.Backspace!],
  ["delete", baseKeymap.Delete!],
  ["bold", toggleMark(marks.strong!)],
  ["italic", toggleMark(marks.em!)],
  ["code", toggleMark(marks.code!)],
  ["link", toggleMark(marks.link!, { href: "https://example.com" })],
  ["heading", setBlockType(nodes.heading!, { level: 2 })],
  ["paragraph", setBlockType(nodes.paragraph!)],
  ["code block", setBlockType(nodes.code_block!)],
  ["bullets", wrapInList(nodes.bullet_list!)],
  ["numbers", wrapInList(nodes.ordered_list!)],
  ["sink", sinkListItem(nodes.list_item!)],
  ["lift item", liftListItem(nodes.list_item!)],
  ["quote", wrapIn(nodes.blockquote!)],
  ["lift", lift],
];

/** Runs `steps` random edits by two writers with random delivery, then checks they converge. */
function run(seed: number, steps: number) {
  let state = seed >>> 0;
  const pick = (n: number) => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state % n; };
  const server = createServer(Note, { resolve: keepSafeLinks });
  const writers = [0, 1].map(() => {
    const outbox: Batch[] = [];
    const doc = createClient(Note, { clientId: server.openClient(), onBatch: (batch) => outbox.push(batch) });
    const binding = createRichTextBinding(doc, { update() {}, canEdit: () => true, onError(error) { throw error; } });
    let seen = 0;
    return { doc, binding, outbox,
      send() { for (const batch of outbox.splice(0)) server.receive(batch); },
      receive() { for (const commit of server.commitsSince(seen) ?? []) { doc.receive(commit); seen = commit.serverSeq; } } };
  });
  const trace: string[] = [];
  for (let step = 0; step < steps; step++) {
    const writer = writers[pick(2)]!;
    const { binding } = writer;
    const size = binding.state.doc.content.size;
    const from = Selection.near(binding.state.doc.resolve(pick(size + 1)));
    const to = pick(3) === 0 ? Selection.near(binding.state.doc.resolve(pick(size + 1))) : from;
    binding.dispatch(binding.state.tr.setSelection(TextSelection.between(
      binding.state.doc.resolve(Math.min(from.from, to.from)), binding.state.doc.resolve(Math.max(from.from, to.from)))));
    const action = pick(4);
    if (action === 0) {
      const text = ["a", "bc", "😀", " "][pick(4)]!;
      trace.push(`${step} type ${JSON.stringify(text)}`);
      binding.dispatch(binding.state.tr.insertText(text));
    } else if (action <= 2) {
      const [name, command] = commands[pick(commands.length)]!;
      trace.push(`${step} ${name}`);
      command(binding.state, (tr) => { binding.dispatch(tr); });
    } else if (pick(2) === 0) writer.send(); else writer.receive();
    // The editor always shows the standard shape of its Text.
    assert.equal(JSON.stringify(binding.state.doc.toJSON()),
      JSON.stringify(buildDoc(editorSchema, textLines(writer.doc.state.body)).toJSON()), `seed ${seed}: ${trace.slice(-5).join(" | ")}`);
  }
  for (const writer of writers) writer.send();
  for (const writer of writers) writer.receive();
  const [a, b] = writers;
  assert.equal(JSON.stringify(a!.binding.state.doc.toJSON()), JSON.stringify(b!.binding.state.doc.toJSON()), `seed ${seed}`);
}

describe("Rich text binding under random edits", () => {
  for (const seed of [1, 7, 42, 2026]) it(`converges for seed ${seed}`, () => { run(seed, 300); });
});
