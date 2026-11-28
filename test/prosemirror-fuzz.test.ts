import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { baseKeymap, lift, setBlockType, toggleMark, wrapIn } from "prosemirror-commands";
import { liftListItem, sinkListItem, splitListItem, wrapInList } from "prosemirror-schema-list";
import { Selection, TextSelection, type Command } from "prosemirror-state";

import { selectionCursors, textToDoc } from "../packages/articollab/src/prosemirror/index.ts";
import { editorSchema, json, network } from "./prosemirror-helpers.ts";

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

const networks: ReturnType<typeof network>[] = [];
after(() => { for (const each of networks) each.destroy(); });

/**
 * Runs `steps` random edits by two writers with random delivery. After every step that is not inside
 * a composition, the editor that was updated in place must equal a full rebuild from its Text, and
 * the writers must converge at the end. Writers also compose: candidates stay local while the other
 * writer's changes arrive, then they confirm or cancel.
 */
function run(seed: number, steps: number) {
  let state = seed >>> 0;
  const pick = (n: number) => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state % n; };
  const made = network();
  networks.push(made);
  const writers = [0, 1].map(() => {
    const unsent: string[] = [];
    let batches = 0;
    const writer = made.writer({ onUnsentComposition(text) { unsent.push(text); } });
    const send = writer.send.bind(writer);
    return Object.assign(writer, {
      unsent, composition: undefined as Composition | undefined,
      get made() { return batches + writer.outbox.length; },
      send() { batches += writer.outbox.length; send(); },
    });
  });
  const trace: string[] = [];
  const context = () => `seed ${seed}: ${trace.slice(-6).join(" | ")}`;
  /** The editor, updated in place, equals a rebuild of the whole Text. */
  const rebuilt = (writer: (typeof writers)[number]) => {
    assert.equal(json(writer.state), JSON.stringify(textToDoc(writer.doc.state.body, editorSchema).toJSON()), context());
  };
  function candidate(writer: (typeof writers)[number], composition: Composition) {
    const text = ["ㄏ", "ㄏㄠ", "好", "你好"][pick(4)]!;
    trace.push(`candidate ${text}`);
    const tr = writer.state.tr.insertText(text, composition.at, composition.end);
    writer.view.dispatch(tr.setSelection(TextSelection.near(tr.doc.resolve(composition.at + text.length))));
    composition.end = composition.at + text.length;
    composition.text = text;
  }
  function finish(writer: (typeof writers)[number], cancelled: boolean) {
    const composition = writer.composition!;
    writer.composition = undefined;
    trace.push(cancelled ? "cancel" : "confirm");
    const unsent = writer.unsent.length;
    writer.finish(cancelled);
    const body = writer.doc.state.body;
    if (cancelled) assert.equal(writer.made, composition.batches, context());
    else if (writer.unsent.length !== unsent) assert.ok(composition.multiline, `unsent ${context()}`);
    else if (composition.text !== composition.replaced) {
      // The confirmed text is in the Text, just before the caret.
      const caret = body.cursorIndex(selectionCursors(writer.state)!.from)!;
      assert.equal(Array.from(body).slice(caret - composition.text.length, caret).join(""), composition.text, context());
    }
    rebuilt(writer);
  }
  for (let step = 0; step < steps; step++) {
    const writer = writers[pick(2)]!;
    if (writer.composition !== undefined) {
      const action = pick(6);
      if (action <= 1) candidate(writer, writer.composition);
      else if (action === 2) finish(writer, pick(4) === 0);
      else if (pick(2) === 0) writer.send(); else writer.receive();
      // Nothing is written while composing.
      if (writer.composition !== undefined) assert.equal(writer.made, writer.composition.batches, context());
      continue;
    }
    const doc = writer.state.doc, size = doc.content.size;
    // Never inside an emoji's surrogate pair, where a browser cannot put the caret.
    const near = (position: number) => {
      const selection = Selection.near(doc.resolve(position)), { $from } = selection;
      const before = $from.parent.textBetween(0, $from.parentOffset).at(-1) ?? "";
      return /[\uD800-\uDBFF]/u.test(before) ? Selection.near(doc.resolve($from.pos - 1)) : selection;
    };
    const from = near(pick(size + 1));
    const to = pick(3) === 0 ? near(pick(size + 1)) : from;
    writer.view.dispatch(writer.state.tr.setSelection(TextSelection.between(
      doc.resolve(Math.min(from.from, to.from)), doc.resolve(Math.max(from.from, to.from)))));
    const action = pick(5);
    if (action === 4) {
      const { from: at, to: end } = writer.state.selection;
      trace.push(`${step} compose`);
      writer.binding.startComposition(writer.state);
      const replaced = writer.state.doc.textBetween(at, end, "\n");
      // Across lines, including the lines of one code block.
      const composition = writer.composition = { at, end, text: "", replaced, multiline: replaced.includes("\n"), batches: writer.made };
      candidate(writer, composition);
      continue;
    }
    if (action === 0) {
      const text = ["a", "bc", "😀", " ", "x\ny"][pick(5)]!;
      trace.push(`${step} type ${JSON.stringify(text)}`);
      writer.type(text);
    } else if (action <= 2) {
      const [name, command] = commands[pick(commands.length)]!;
      trace.push(`${step} ${name}`);
      writer.run(command);
    } else if (pick(2) === 0) { trace.push(`${step} send`); writer.send(); } else { trace.push(`${step} receive`); writer.receive(); }
    rebuilt(writer);
  }
  for (const writer of writers) if (writer.composition !== undefined) finish(writer, false);
  for (const writer of writers) writer.send();
  for (const writer of writers) writer.receive();
  const [a, b] = writers;
  assert.equal(json(a!.state), json(b!.state), `seed ${seed}`);
  rebuilt(a!);
}

// More seeds locally with PROSEMIRROR_FUZZ_SEEDS=300.
const count = Number(process.env.PROSEMIRROR_FUZZ_SEEDS ?? 0);
const seeds = count > 0 ? Array.from({ length: count }, (_, index) => index + 1) : [1, 7, 42, 2026];

describe("ProseMirror sync under random edits", () => {
  for (const seed of seeds) it(`matches a full rebuild and converges for seed ${seed}`, () => { run(seed, 300); });
});
