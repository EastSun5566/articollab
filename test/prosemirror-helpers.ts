import { Window } from "happy-dom";
import { Schema } from "prosemirror-model";
import { schema as basic } from "prosemirror-schema-basic";
import { addListNodes } from "prosemirror-schema-list";
import { EditorState, TextSelection, type Command } from "prosemirror-state";

import {
  createClient, createServer, defineDocument, text, type ClientBatch, type ClientDocument, type DocumentOperation, type PayloadSchema,
} from "../packages/articollab/src/index.ts";
import { remoteSelections, textSync, type TextSyncOptions } from "../packages/articollab/src/prosemirror/index.ts";

// A DOM for prosemirror-view, which reads it when it is first imported.
const window = new Window();
Object.assign(globalThis, { window, document: window.document });
const { EditorView } = await import("prosemirror-view");

const href: PayloadSchema<string> = { "~standard": { version: 1, vendor: "test", validate: (value) =>
  typeof value === "string" ? { value } : { issues: [{ message: "Expected a URL string" }] } } };

/** A note with every mark and paragraph attribute `basicMapping` and Tiptap's `starterKitMapping` use. */
export const Note = defineDocument({
  body: text({
    marks: { bold: { expand: "after" }, italic: { expand: "after" }, strike: { expand: "after" }, underline: { expand: "after" },
      code: { expand: "after" }, link: { expand: "none", payload: href } },
    blocks: { heading: {}, list: {}, indent: {}, quote: {}, code: {} },
  }),
});
type Operation = DocumentOperation<typeof Note.definition>;
type Batch = ClientBatch<Operation>;

/** ProseMirror's basic schema with lists, as `basicMapping` expects. */
export const editorSchema = new Schema({ nodes: addListNodes(basic.spec.nodes, "paragraph block*", "block"), marks: basic.spec.marks });

/** The server's policy: links must use http: or https:, so a dropped link disappears from its writer. */
function keepSafeLinks({ batch }: { batch: { operations: readonly Operation[] } }): readonly Operation[] {
  return batch.operations.filter((operation) => operation.type !== "text/mark" || operation.key !== "link" ||
    operation.value === null || (typeof operation.value === "string" && /^https?:\/\//.test(operation.value)));
}

/** A server, and writers with editors whose batches and commits move only when a test says so. */
export function network(schema: Schema = editorSchema) {
  const server = createServer(Note, { resolve: keepSafeLinks });
  const writers: { send(): void; receive(): void; destroy(): void }[] = [];
  /** A writer; `options` can depend on its document, as an undo manager does. */
  function writer(options: TextSyncOptions | ((doc: ClientDocument<typeof Note.definition>) => TextSyncOptions) = {}) {
    const outbox: Batch[] = [];
    const doc = createClient(Note, { clientId: server.openClient(), onBatch: (batch) => outbox.push(batch) });
    let seen = 0;
    const sync = textSync(doc, "body", { onError(error) { throw error; }, ...(typeof options === "function" ? options(doc) : options) });
    const remote = remoteSelections();
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- happy-dom implements the DOM's HTMLElement.
    const view = new EditorView(window.document.createElement("div") as unknown as HTMLElement,
      { state: EditorState.create({ schema, plugins: [sync, remote] }) });
    const binding = sync.getState(view.state)!.binding;
    const entry = {
      doc, view, binding, remote, outbox,
      get state() { return view.state; },
      /** Runs a ProseMirror command as the user would; returns whether it applied. */
      run(command: Command) { return command(view.state, (tr) => { view.dispatch(tr); }, view); },
      type(value: string) { view.dispatch(view.state.tr.insertText(value)); },
      select(from: number, to = from) { view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to))); },
      /** Starts a composition at the selection and shows `candidates`, each replacing the one before. */
      compose(candidates: readonly string[]) {
        if (!binding.composing) binding.startComposition(view.state);
        for (const candidate of candidates) {
          const { from, to } = view.state.selection;
          const start = entry.composed ?? from;
          const tr = view.state.tr.insertText(candidate, start, to);
          view.dispatch(tr.setSelection(TextSelection.create(tr.doc, start + candidate.length)));
          entry.composed = start;
        }
      },
      composed: undefined as number | undefined,
      finish(cancelled = false) {
        if (cancelled) binding.cancelComposition();
        binding.finishComposition(view);
        entry.composed = undefined;
      },
      send() { for (const batch of outbox.splice(0)) server.receive(batch); },
      receive() { for (const commit of server.commitsSince(seen) ?? []) { doc.receive(commit); seen = commit.serverSeq; } },
      destroy() { view.destroy(); },
    };
    writers.push(entry);
    return entry;
  }
  /** Sends everything, then delivers every commit to every writer. */
  const sync = () => { for (const each of writers) each.send(); for (const each of writers) each.receive(); };
  const destroy = () => { for (const each of writers) each.destroy(); };
  return { writer, sync, destroy, EditorView };
}

export const json = (state: EditorState): string => JSON.stringify(state.doc.toJSON());
export const end = (state: EditorState): number => TextSelection.atEnd(state.doc).from;
