// @ts-check
import { Compartment, EditorState } from "@codemirror/state";
import { createTextBinding } from "./binding.js";

/** @param {HTMLElement} parent
 * @param {Parameters<typeof createTextBinding>[0]} doc
 * @param {{label: string, canEdit: () => boolean, onError: (error: unknown) => void,
 *   onLocalEdit: () => void, onComposition: () => void}} options
 */
export async function createTextEditor(parent, doc, options) {
  const { EditorView } = await import("@codemirror/view");
  const readOnly = new Compartment();
  let composing = false;
  /** @type {import("@codemirror/view").EditorView | undefined} */
  let view;
  const binding = createTextBinding(doc, {
    canEdit: options.canEdit, onError: options.onError, onLocalEdit: options.onLocalEdit,
    extensions: [readOnly.of([EditorState.readOnly.of(true), EditorView.editable.of(false)]),
      EditorView.contentAttributes.of({ "aria-label": options.label }),
      EditorView.lineWrapping],
    update: (transactions) => { view?.update(transactions); },
  });
  try {
    view = new EditorView({ state: binding.state, parent, dispatchTransactions: binding.dispatch });
  } catch (error) { binding.destroy(); throw error; }
  const mounted = view;
  function compositionStart() { composing = true; options.onComposition(); }
  function compositionEnd() { composing = false; options.onComposition(); }
  mounted.contentDOM.addEventListener("compositionstart", compositionStart);
  mounted.contentDOM.addEventListener("compositionend", compositionEnd);
  let destroyed = false;
  return {
    isComposing: () => composing || mounted.compositionStarted || mounted.composing,
    /** @param {boolean} value */
    setReadOnly(value) {
      binding.dispatch([binding.state.update({ effects: readOnly.reconfigure([
        EditorState.readOnly.of(value), EditorView.editable.of(!value),
      ]) })]);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      binding.destroy();
      mounted.contentDOM.removeEventListener("compositionstart", compositionStart);
      mounted.contentDOM.removeEventListener("compositionend", compositionEnd);
      mounted.destroy();
    },
  };
}
