import { Extension, type CommandProps } from "@tiptap/core";
import type { Mark } from "prosemirror-model";

import type { ClientDocument, JsonValue, SchemaShape, UndoManager } from "../index.ts";
import { remoteSelections, type RemoteSelectionsOptions } from "../prosemirror/cursors.ts";
import type { TextMapping } from "../prosemirror/mapping.ts";
import { redo, textSync, undo, type TextPath } from "../prosemirror/sync.ts";

export {
  remoteSelections, setRemoteSelections, type RemoteSelection, type RemoteSelectionsOptions, type RemoteSelectionStatus,
} from "../prosemirror/cursors.ts";
export { basicMapping, type MarkMapping, type TextMapping } from "../prosemirror/mapping.ts";
export {
  isComposing, resolveSelection, selectionCursors, textToDoc, type CursorSelection, type TextPath,
} from "../prosemirror/sync.ts";

/** The nodes and marks of Tiptap's StarterKit. */
export const starterKitMapping: TextMapping = Object.freeze({
  paragraph: "paragraph",
  marks: Object.freeze({
    bold: Object.freeze({ mark: "bold" }),
    italic: Object.freeze({ mark: "italic" }),
    strike: Object.freeze({ mark: "strike" }),
    underline: Object.freeze({ mark: "underline" }),
    code: Object.freeze({ mark: "code" }),
    link: Object.freeze({
      mark: "link",
      value: (mark: Mark): JsonValue => String(mark.attrs.href),
      attrs: (value: JsonValue) => ({ href: typeof value === "string" ? value : JSON.stringify(value) }),
    }),
  }),
  heading: Object.freeze({ node: "heading", levels: Object.freeze([1, 2, 3, 4, 5, 6]) }),
  codeBlock: Object.freeze({ node: "codeBlock", language: "language" }),
  blockquote: Object.freeze({ node: "blockquote" }),
  lists: Object.freeze({ item: "listItem", bullet: "bulletList", ordered: "orderedList" }),
  lineBreak: Object.freeze({ node: "hardBreak" }),
});

/** The parts of a client document the extension uses; any `ClientDocument` has them. */
export interface CollaborativeDocument {
  readonly state: object;
  transact(callback: () => void): unknown;
  readonly replayConflict: unknown;
}

export interface ArticollabTextOptions {
  /** The writer's document; required. */
  document: CollaborativeDocument | null;
  /** The path of the Text the editor shows; required. */
  path: string;
  /** This writer's undo manager, for the `undo` and `redo` commands and their keys. */
  history: UndoManager | undefined;
  /** Which nodes and marks stand for the Text; `starterKitMapping` by default. */
  mapping: TextMapping;
  /** Whether local edits may be written now; an edit is refused while it returns false. */
  canEdit: (() => boolean) | undefined;
  /** Called with an error that stopped the extension; local edits are refused from then on. */
  onError: ((error: unknown) => void) | undefined;
  /** Called with the text of a composition that could not be written, for the user to copy. */
  onUnsentComposition: ((text: string) => void) | undefined;
  /** How to draw other writers' selections, or `false` to leave them out. */
  remoteSelections: RemoteSelectionsOptions | false;
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    articollabText: {
      /** Undoes this writer's latest change to the document. */
      undo: () => ReturnType;
      /** Redoes the latest undone change. */
      redo: () => ReturnType;
    };
  }
}

/** Extensions that cannot share an editor with this one, and why. */
const conflicts: Readonly<Record<string, string>> = {
  undoRedo: "its undo would take back other writers' changes",
  trailingNode: "each writer would add its own empty paragraph at the end",
};

/**
 * Keeps a Tiptap editor and an Articollab Text in step, with the `textSync` plugin. Turn off
 * StarterKit's `undoRedo` and `trailingNode`, and pass an undo manager as `history` for the
 * `undo` and `redo` commands.
 */
export const ArticollabText = Extension.create<ArticollabTextOptions>({
  name: "articollabText",

  addOptions() {
    return {
      document: null, path: "", history: undefined, mapping: starterKitMapping,
      canEdit: undefined, onError: undefined, onUnsentComposition: undefined, remoteSelections: {},
    };
  },

  onBeforeCreate() {
    for (const { name } of this.editor.extensionManager.extensions) {
      const reason = conflicts[name];
      if (reason !== undefined) {
        throw new TypeError(`Turn off the ${name} extension to use articollabText, such as with ` +
          `StarterKit.configure({ undoRedo: false, trailingNode: false }): ${reason}`);
      }
    }
  },

  addProseMirrorPlugins() {
    const { document, path, history, mapping, canEdit, onError, onUnsentComposition } = this.options;
    if (document === null) throw new TypeError("articollabText needs a document");
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- textSync checks the path against the document's own state.
    const doc = document as unknown as ClientDocument<SchemaShape>;
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- As above: a wide schema has no static Text paths.
    const sync = textSync(doc, path as TextPath<SchemaShape>, {
      mapping,
      ...(history === undefined ? {} : { history }),
      ...(canEdit === undefined ? {} : { canEdit }),
      ...(onError === undefined ? {} : { onError }),
      ...(onUnsentComposition === undefined ? {} : { onUnsentComposition }),
    });
    return this.options.remoteSelections === false ? [sync] : [sync, remoteSelections(this.options.remoteSelections)];
  },

  addCommands() {
    // The Text's change reaches the editor as a transaction of its own, so the command's is not dispatched.
    const run = (command: typeof undo) => () => ({ tr, state, dispatch, view }: CommandProps) => {
      const history = this.options.history;
      if (history === undefined) return false;
      const done = command(history)(state, dispatch, view);
      if (done && dispatch !== undefined) tr.setMeta("preventDispatch", true);
      return done;
    };
    return { undo: run(undo), redo: run(redo) };
  },

  addKeyboardShortcuts() {
    return {
      "Mod-z": () => this.editor.commands.undo(),
      "Shift-Mod-z": () => this.editor.commands.redo(),
      "Mod-y": () => this.editor.commands.redo(),
    };
  },
});
