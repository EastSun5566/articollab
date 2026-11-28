import { Plugin, PluginKey, type EditorState, type Transaction } from "prosemirror-state";
import { Decoration, DecorationSet, type EditorView } from "prosemirror-view";

import { bindingOf, isFromText, type CursorSelection } from "./sync.ts";

/** Another writer's selection, as shared through presence. */
export interface RemoteSelection {
  /** Shown on the caret, and used to tell the writers apart. */
  readonly label: string;
  readonly selection: CursorSelection;
}

/** Whether a remote selection could be shown: false while its text has not reached this writer. */
export interface RemoteSelectionStatus {
  readonly label: string;
  readonly resolved: boolean;
}

export interface RemoteSelectionsOptions {
  /** The class of a selected range; "articollab-selection" by default. */
  readonly selectionClass?: string;
  /** Makes the caret element; a `span.articollab-caret` with `data-label` by default. */
  readonly caret?: (label: string) => HTMLElement;
}

interface RemoteState {
  readonly selections: readonly RemoteSelection[];
  readonly decorations: DecorationSet;
}

const remoteKey = new PluginKey<RemoteState>("articollab-remote-selections");

function defaultCaret(label: string): HTMLElement {
  const caret = document.createElement("span");
  caret.className = "articollab-caret";
  caret.dataset.label = label;
  caret.setAttribute("aria-hidden", "true");
  return caret;
}

/**
 * A plugin that draws other writers' selections, placed from their cursors whenever the editor shows
 * a change from the Text, and moved with local edits in between. Needs `textSync` before it.
 */
export function remoteSelections(options: RemoteSelectionsOptions = {}): Plugin<RemoteState> {
  const selectionClass = options.selectionClass ?? "articollab-selection", caret = options.caret ?? defaultCaret;
  const draw = (state: Pick<EditorState, "doc">, from: EditorState, selections: readonly RemoteSelection[]): DecorationSet => {
    const binding = bindingOf(from);
    if (binding === undefined || binding.composing) return DecorationSet.empty;
    const decorations: Decoration[] = [];
    for (const { label, selection } of selections) {
      const range = binding.resolve(selection, state.doc);
      if (range === undefined) continue;
      if (range.from < range.to) decorations.push(Decoration.inline(range.from, range.to, { class: selectionClass, title: label }));
      decorations.push(Decoration.widget(range.to, () => caret(label), { key: `${label}:${String(range.to)}`, side: range.from < range.to ? 1 : -1 }));
    }
    return DecorationSet.create(state.doc, decorations);
  };
  return new Plugin<RemoteState>({
    key: remoteKey,
    state: {
      init: () => ({ selections: [], decorations: DecorationSet.empty }),
      apply(tr: Transaction, value, oldState) {
        const next: unknown = tr.getMeta(remoteKey);
        const selections = Array.isArray(next) ? (next as readonly RemoteSelection[]) : value.selections;
        // Cursors match the Text, and the editor shows it again only after a change from it.
        if (next !== undefined || isFromText(tr)) return { selections, decorations: draw(tr, oldState, selections) };
        return tr.docChanged ? { selections, decorations: value.decorations.map(tr.mapping, tr.doc) } : value;
      },
    },
    props: { decorations: (state) => remoteKey.getState(state)?.decorations },
  });
}

/**
 * Replaces the other writers' selections the editor shows. Returns whether each could be placed;
 * one whose text has not reached this writer yet is left out until it can be.
 */
export function setRemoteSelections(view: EditorView, selections: readonly RemoteSelection[]): RemoteSelectionStatus[] {
  view.dispatch(view.state.tr.setMeta(remoteKey, selections));
  const binding = bindingOf(view.state);
  return selections.map(({ label, selection }) => ({
    label, resolved: binding !== undefined && !binding.composing && binding.resolve(selection, view.state.doc) !== undefined,
  }));
}
