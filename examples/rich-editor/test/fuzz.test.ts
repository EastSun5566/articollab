import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { baseKeymap, lift, setBlockType, toggleMark, wrapIn } from "prosemirror-commands";
import { liftListItem, sinkListItem, splitListItem, wrapInList } from "prosemirror-schema-list";
import { Selection, TextSelection, type Command } from "prosemirror-state";
import { createClient, createServer, type ClientBatch, type DocumentOperation } from "articollab";
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

/** An open input method composition: its candidate is at `at` to `end`, and replaced `replaced`. */
type Composition = { at: number; end: number; text: string; replaced: string; multiline: boolean; batches: number };

/**
 * Runs `steps` random edits by two writers with random delivery, then checks they converge. Writers
 * also compose: candidates stay local while the other writer's changes arrive, then they confirm or cancel.
 */
function run(seed: number, steps: number) {
  let state = seed >>> 0;
  const pick = (n: number) => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state % n; };
  const server = createServer(Note, { resolve: keepSafeLinks });
  const writers = [0, 1].map(() => {
    const outbox: Batch[] = [];
    let made = 0; // Batches, sent or not.
    const doc = createClient(Note, { clientId: server.openClient(), onBatch(batch) { made++; outbox.push(batch); } });
    const unsent: string[] = [];
    const binding = createRichTextBinding(doc, { update() {}, canEdit: () => true, onError(error) { throw error; },
      onUnsentComposition(text) { unsent.push(text); } });
    let seen = 0;
    return { doc, binding, outbox, unsent, composition: undefined as Composition | undefined, get made() { return made; },
      send() { for (const batch of outbox.splice(0)) server.receive(batch); },
      receive() { for (const commit of server.commitsSince(seen) ?? []) { doc.receive(commit); seen = commit.serverSeq; } } };
  });
  const trace: string[] = [];
  function candidate(writer: (typeof writers)[number], composition: Composition) {
    const text = ["ㄏ", "ㄏㄠ", "好", "你好"][pick(4)]!;
    trace.push(`candidate ${text}`);
    const tr = writer.binding.state.tr.insertText(text, composition.at, composition.end);
    writer.binding.dispatch(tr.setSelection(TextSelection.near(tr.doc.resolve(composition.at + text.length))));
    composition.end = composition.at + text.length;
    composition.text = text;
  }
  function finish(writer: (typeof writers)[number], cancelled: boolean) {
    const composition = writer.composition!;
    writer.composition = undefined;
    trace.push(cancelled ? "cancel" : "confirm");
    const unsent = writer.unsent.length;
    writer.binding.finishComposition(cancelled);
    const body = writer.doc.state.body;
    if (cancelled) assert.equal(writer.made, composition.batches, `seed ${seed}: ${trace.slice(-5).join(" | ")}`);
    else if (writer.unsent.length !== unsent) assert.ok(composition.multiline, `seed ${seed}: unsent ${trace.slice(-5).join(" | ")}`);
    else if (composition.text !== composition.replaced) {
      // The confirmed text is in the Text, just before the caret.
      const caret = body.cursorIndex(writer.binding.selectionCursors().from)!;
      assert.equal(Array.from(body).slice(caret - composition.text.length, caret).join(""), composition.text,
        `seed ${seed}: ${trace.slice(-5).join(" | ")}`);
    }
  }
  for (let step = 0; step < steps; step++) {
    const writer = writers[pick(2)]!;
    const { binding } = writer;
    if (writer.composition !== undefined) {
      const action = pick(6);
      if (action <= 1) candidate(writer, writer.composition);
      else if (action === 2) finish(writer, pick(4) === 0);
      else if (pick(2) === 0) writer.send(); else writer.receive();
      // Nothing is written while composing.
      if (writer.composition !== undefined) assert.equal(writer.made, writer.composition.batches);
      else assert.equal(JSON.stringify(binding.state.doc.toJSON()),
        JSON.stringify(buildDoc(editorSchema, textLines(writer.doc.state.body)).toJSON()), `seed ${seed}: ${trace.slice(-5).join(" | ")}`);
      continue;
    }
    const size = binding.state.doc.content.size;
    // Never inside an emoji's surrogate pair, where a browser cannot put the caret.
    const near = (position: number) => {
      const selection = Selection.near(binding.state.doc.resolve(position)), { $from } = selection;
      const before = $from.parent.textBetween(0, $from.parentOffset).at(-1) ?? "";
      return /[\uD800-\uDBFF]/u.test(before) ? Selection.near(binding.state.doc.resolve($from.pos - 1)) : selection;
    };
    const from = near(pick(size + 1));
    const to = pick(3) === 0 ? near(pick(size + 1)) : from;
    binding.dispatch(binding.state.tr.setSelection(TextSelection.between(
      binding.state.doc.resolve(Math.min(from.from, to.from)), binding.state.doc.resolve(Math.max(from.from, to.from)))));
    const action = pick(5);
    if (action === 4) {
      const { from: at, to: end, $from, $to } = binding.state.selection;
      trace.push(`${step} compose`);
      binding.startComposition();
      const composition = writer.composition = { at, end, text: "", replaced: binding.state.doc.textBetween(at, end, "\n"),
        multiline: $from.parent !== $to.parent, batches: writer.made };
      candidate(writer, composition);
      continue;
    }
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
  for (const writer of writers) if (writer.composition !== undefined) finish(writer, false);
  for (const writer of writers) writer.send();
  for (const writer of writers) writer.receive();
  const [a, b] = writers;
  assert.equal(JSON.stringify(a!.binding.state.doc.toJSON()), JSON.stringify(b!.binding.state.doc.toJSON()), `seed ${seed}`);
}

describe("Rich text binding under random edits", () => {
  for (const seed of [1, 7, 42, 2026]) it(`converges for seed ${seed}`, () => { run(seed, 300); });
});
