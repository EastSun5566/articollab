import type { DocumentOperation, DocumentSnapshot, ServerResolveContext } from "../../dist/index.js";
import { COLUMNS, type Shape } from "./board.js";

type Operation = DocumentOperation<Shape>;
type ElementId = Extract<Operation, { type: "list/delete" }>["id"];

function key(id: ElementId): string {
  return id.bunchId + "\u0000" + id.counter;
}

/** Elements visible in any column, from the saved ID ranges. O(cards) per batch. */
function visibleElements(snapshot: DocumentSnapshot<Shape>): Set<string> {
  const visible = new Set<string>();
  for (const path of COLUMNS) {
    for (const range of snapshot.data[path].idList) {
      if (range.isDeleted) continue;
      for (let offset = 0; offset < range.count; offset++) {
        visible.add(key({ bunchId: range.bunchId, counter: range.startCounter + offset }));
      }
    }
  }
  return visible;
}

/**
 * Example server policy. A move is a delete plus an insert of the same card ID, and card data lives
 * in the `cards` Map, whose keys are last-writer-wins:
 * - a move whose source element is already gone (moved or deleted by someone else) loses its insert,
 *   so a card is never duplicated or brought back by a concurrent move;
 * - a `cards` set for a card that no longer exists is dropped, unless the same batch adds the card,
 *   so a rename that arrives after a delete does not leave data without a position.
 * Renames and moves touch different collections and need no rule. Everything else is accepted
 * unchanged. This is not authorization or payload validation.
 */
export function resolveBoard({ batch, snapshot }: ServerResolveContext<Shape>): readonly Operation[] {
  const visible = visibleElements(snapshot);
  const cards = new Set(Object.keys(snapshot.data.cards));
  const added = new Set(batch.operations.flatMap((operation) => operation.type === "list/insert" ? [operation.value] : []));
  const resolved: Operation[] = [];
  let changed = false, staleDelete = false;
  for (const operation of batch.operations) {
    switch (operation.type) {
      case "list/delete":
        if (!visible.delete(key(operation.id))) staleDelete = true;
        break;
      case "list/insert":
        if (staleDelete) { changed = true; continue; }
        visible.add(key(operation.id));
        break;
      case "map/set":
        if (!cards.has(operation.key) && !added.has(operation.key)) { changed = true; continue; }
        cards.add(operation.key);
        break;
      case "map/delete":
        cards.delete(operation.key);
        break;
      default:
        break;
    }
    resolved.push(operation);
  }
  return changed ? resolved : batch.operations;
}
