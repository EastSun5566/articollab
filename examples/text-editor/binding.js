// @ts-check
import { Annotation, EditorState } from "@codemirror/state";
import { editorEdits, textEdits } from "./changes.js";

const fromText = Annotation.define();

/** This example-only bridge also runs with EditorState alone in Node tests.
 * @param {{state: {body: import("../../dist/index.js").Text},
 *   transact: (callback: () => void) => void, readonly replayConflict: unknown}} doc
 * @param {{update: (transactions: readonly import("@codemirror/state").Transaction[]) => void,
 *   canEdit: () => boolean, onError: (error: unknown) => void,
 *   onLocalEdit?: () => void, extensions?: import("@codemirror/state").Extension}} options
 */
export function createTextBinding(doc, options) {
  let elements = Array.from(doc.state.body);
  let state = EditorState.create({ doc: elements.join(""), extensions: [
    EditorState.lineSeparator.of("\n"), options.extensions ?? [],
  ] });
  let local = false, destroyed = false, failed = false;
  /** @type {unknown} */
  let failure;
  /** @param {unknown} error @returns {never} */
  function stop(error) {
    if (failed) throw failure;
    failed = true;
    failure = error;
    try { options.onError(error); }
    catch { /* Reporting a failure must not replace it. */ }
    throw failure;
  }

  /** @param {readonly import("@codemirror/state").Transaction[]} transactions */
  function dispatch(transactions) {
    if (destroyed) throw new Error("Text binding is destroyed");
    for (const transaction of transactions) {
      if (transaction.startState !== state) stop(new Error("Stale editor transaction"));
      if (transaction.docChanged && failed) throw failure;
      const external = transaction.annotation(fromText) === true;
      // Busy is a precondition, not a permanent failure of an in-flight sync.
      if (transaction.docChanged && !external && (!options.canEdit() || doc.replayConflict !== null)) {
        throw new Error("Editor is read-only");
      }
      try {
        if (transaction.docChanged && !external) {
          const edits = editorEdits(elements, transaction);
          local = true;
          try {
            if (edits.length !== 0) doc.transact(() => {
              for (const edit of edits) {
                if (edit.deleteCount !== 0) doc.state.body.delete(edit.index, edit.deleteCount);
                if (edit.insert !== "") doc.state.body.insert(edit.index, edit.insert);
              }
            });
          } finally { local = false; }
          if (edits.length !== 0) options.onLocalEdit?.();
        }
        state = transaction.state;
        options.update([transaction]);
      } catch (error) { stop(error); }
    }
  }

  const unsubscribe = doc.state.body.observe((event) => {
    try {
      if (failed) throw failure;
      const next = textEdits(elements, event);
      elements = next.elements;
      if (local) return; // The original editor transaction will be applied once.
      const changes = next.changes.filter(({ from, to, insert }) => state.doc.sliceString(from, to, "\n") !== insert);
      if (changes.length !== 0) dispatch([state.update({ changes, annotations: fromText.of(true) })]);
    } catch (error) { stop(error); }
  });

  return {
    get state() { return state; },
    get elements() { return elements.slice(); },
    dispatch,
    destroy() { if (!destroyed) { destroyed = true; unsubscribe(); } },
  };
}
