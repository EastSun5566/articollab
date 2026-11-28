import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { baseKeymap, lift, setBlockType, toggleMark, wrapIn } from "prosemirror-commands";
import { liftListItem, sinkListItem, splitListItem, wrapInList } from "prosemirror-schema-list";
import type { Schema } from "prosemirror-model";
import { Selection, TextSelection, type Command } from "prosemirror-state";

import { basicMapping, selectionCursors, textToDoc, type TextMapping } from "../packages/articollab/src/prosemirror/index.ts";
import { editorSchema, json, network } from "./prosemirror-helpers.ts";

// Loaded after the helpers set up a DOM.
const { getSchema } = await import("@tiptap/core");
const { StarterKit } = await import("@tiptap/starter-kit");
const { starterKitMapping } = await import("../packages/articollab/src/tiptap/index.ts");

/** An editor schema with its mapping, and the commands a writer runs at random. */
interface Variant { readonly schema: Schema; readonly mapping: TextMapping; readonly commands: readonly (readonly [string, Command])[] }

/** The commands for a schema whose nodes and marks have these names. */
function variant(schema: Schema, mapping: TextMapping, names: {
  item: string; bullets: string; numbers: string; code: string; quote: string; br: string; strong: string; em: string;
}, extra: readonly (readonly [string, Command])[] = []): Variant {
  const node = (name: string) => schema.nodes[name]!, mark = (name: string) => schema.marks[name]!;
  const commands: (readonly [string, Command])[] = [
    ["enter", (state, dispatch) => splitListItem(node(names.item))(state, dispatch) || baseKeymap.Enter!(state, dispatch)],
    ["backspace", baseKeymap.Backspace!],
    ["delete", baseKeymap.Delete!],
    ["bold", toggleMark(mark(names.strong))],
    ["italic", toggleMark(mark(names.em))],
    ["code", toggleMark(mark("code"))],
    ["link", toggleMark(mark("link"), { href: "https://example.com" })],
    ["heading", setBlockType(node("heading"), { level: 2 })],
    ["paragraph", setBlockType(node("paragraph"))],
    ["code block", setBlockType(node(names.code))],
    ["bullets", wrapInList(node(names.bullets))],
    ["numbers", wrapInList(node(names.numbers))],
    ["sink", sinkListItem(node(names.item))],
    ["lift item", liftListItem(node(names.item))],
    ["quote", wrapIn(node(names.quote))],
    ["lift", lift],
    // Shift+Enter: a hard break, which starts another line.
    ["hard break", (state, dispatch) => {
      if (!state.selection.$from.parent.type.contentMatch.matchType(node(names.br))) return false;
      dispatch?.(state.tr.replaceSelectionWith(node(names.br).create()).scrollIntoView());
      return true;
    }],
    ...extra,
  ];
  return { schema, mapping, commands };
}

const tiptapSchema = getSchema([StarterKit.configure({ undoRedo: false, trailingNode: false })]);
const variants: Record<string, Variant> = {
  ProseMirror: variant(editorSchema, basicMapping, {
    item: "list_item", bullets: "bullet_list", numbers: "ordered_list", code: "code_block", quote: "blockquote", br: "hard_break",
    strong: "strong", em: "em",
  }),
  Tiptap: variant(tiptapSchema, starterKitMapping, {
    item: "listItem", bullets: "bulletList", numbers: "orderedList", code: "codeBlock", quote: "blockquote", br: "hardBreak",
    strong: "bold", em: "italic",
  }, [
    ["strike", toggleMark(tiptapSchema.marks.strike!)],
    ["underline", toggleMark(tiptapSchema.marks.underline!)],
    ["code block js", setBlockType(tiptapSchema.nodes.codeBlock!, { language: "js" })],
    ["code block py", setBlockType(tiptapSchema.nodes.codeBlock!, { language: "py" })],
  ]),
};

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
function run(seed: number, steps: number, { schema, mapping, commands }: Variant) {
  let state = seed >>> 0;
  const pick = (n: number) => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state % n; };
  const made = network(schema);
  networks.push(made);
  const writers = [0, 1].map(() => {
    const unsent: string[] = [];
    let batches = 0;
    const writer = made.writer({ mapping, onUnsentComposition(text) { unsent.push(text); } });
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
    assert.equal(json(writer.state), JSON.stringify(textToDoc(writer.doc.state.body, schema, mapping).toJSON()), context());
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

for (const [name, editor] of Object.entries(variants)) {
  describe(`${name} sync under random edits`, () => {
    for (const seed of seeds) it(`matches a full rebuild and converges for seed ${seed}`, () => { run(seed, 300, editor); });
  });
}
