import type { ElementId, IdList } from "articulated";

/**
 * A stable position in the gap between two elements of one Text or List.
 * It follows its anchor element through concurrent edits instead of keeping a fixed index.
 */
export interface Cursor {
  /** The element left ("left") or right ("right") of the gap; null for the list start or end. */
  readonly anchor: Readonly<ElementId> | null;
  readonly bind: "left" | "right";
}

function requireBind(bind: unknown): asserts bind is Cursor["bind"] {
  if (bind !== "left" && bind !== "right") {
    throw new Error(`Cursor bind must be "left" or "right"`);
  }
}

function requireCursor(cursor: unknown): asserts cursor is Cursor {
  if (typeof cursor !== "object" || cursor === null || Array.isArray(cursor)) {
    throw new Error("Cursor must be an object");
  }
  const { anchor, bind } = cursor as Partial<Cursor>;
  requireBind(bind);
  if (anchor === null) return;
  if (typeof anchor !== "object" || anchor === undefined || Array.isArray(anchor)) {
    throw new Error("Cursor anchor must be an ElementId or null");
  }
  if (typeof anchor.bunchId !== "string" || anchor.bunchId.length === 0) {
    throw new Error("Cursor anchor bunchId must not be empty");
  }
  if (!Number.isSafeInteger(anchor.counter) || anchor.counter < 0) {
    throw new Error("Cursor anchor counter must be a non-negative safe integer");
  }
}

/** A frozen cursor for the gap before `index`, bound to the element on the `bind` side. */
export function cursorAt(idList: IdList, index: number, bind: Cursor["bind"] = "left"): Cursor {
  requireBind(bind);
  if (!Number.isSafeInteger(index) || index < 0 || index > idList.length) {
    throw new Error(`Index out of bounds: ${index} (length: ${idList.length})`);
  }
  const anchor = idList.cursorAt(index, bind);
  return Object.freeze({
    anchor: anchor === null ? null : Object.freeze({ bunchId: anchor.bunchId, counter: anchor.counter }),
    bind,
  });
}

/** The cursor's current gap index, or undefined while its anchor is not known here. */
export function cursorIndex(idList: IdList, cursor: Cursor): number | undefined {
  requireCursor(cursor);
  if (cursor.anchor !== null && !idList.isKnown(cursor.anchor)) return undefined;
  return idList.cursorIndex(cursor.anchor, cursor.bind);
}
