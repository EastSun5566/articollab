import type { DocumentOperation, DocumentSnapshot, ServerResolveContext } from "../../dist/index.js";
import { COLUMNS, type Card, type Column, type Shape } from "./board.js";

type Operation = DocumentOperation<Shape>;
type ElementId = Operation["id"];
type Located = { readonly path: Column; readonly id: ElementId; readonly card: Card };

function key(id: ElementId): string {
  return id.bunchId + "\u0000" + id.counter;
}

/** Visible cards by element and by card ID. Built from the saved ID ranges, so O(cards) per batch. */
function visibleCards(snapshot: DocumentSnapshot<Shape>) {
  const byElement = new Map<string, Located>(), byCard = new Map<string, Located>();
  for (const path of COLUMNS) {
    const { idList, values } = snapshot.data[path];
    let next = 0;
    for (const range of idList) {
      if (range.isDeleted) continue;
      for (let offset = 0; offset < range.count; offset++) {
        const located = { path, id: { bunchId: range.bunchId, counter: range.startCounter + offset }, card: values[next++]! };
        byElement.set(key(located.id), located);
        byCard.set(located.card.id, located);
      }
    }
  }
  return { byElement, byCard };
}

/**
 * Example server policy for card moves, which are a delete plus an insert of the same card:
 * - a move whose source element is already gone (moved or deleted by someone else) loses its insert,
 *   so a card is never duplicated or brought back by a concurrent move;
 * - a title `set()` aimed at a card's old element follows the card ID to where the card is now.
 * Everything else is accepted unchanged. A `set()` on a deleted card still changes nothing, which the
 * writer sees as a `discard` event. This is not authorization or payload validation.
 */
export function resolveBoard({ batch, snapshot }: ServerResolveContext<Shape>): readonly Operation[] {
  const { byElement, byCard } = visibleCards(snapshot);
  const resolved: Operation[] = [];
  let changed = false, staleDelete = false;
  for (const operation of batch.operations) {
    const target = byElement.get(key(operation.id));
    if (operation.type === "list/delete") {
      if (target === undefined) staleDelete = true;
      else { byElement.delete(key(operation.id)); byCard.delete(target.card.id); }
    } else if (operation.type === "list/insert") {
      if (staleDelete) { changed = true; continue; }
      const located = { path: operation.path, id: operation.id, card: operation.value };
      byElement.set(key(operation.id), located);
      byCard.set(operation.value.id, located);
    } else if (target === undefined) {
      const moved = byCard.get(operation.value.id);
      if (moved !== undefined) {
        // The same card, now at another element; same type and value, another path and ID.
        const retargeted = { ...operation, path: moved.path, id: moved.id } as Operation;
        resolved.push(retargeted);
        byElement.set(key(moved.id), { ...moved, card: operation.value });
        byCard.set(operation.value.id, { ...moved, card: operation.value });
        changed = true;
        continue;
      }
    } else {
      const located = { ...target, card: operation.value };
      byElement.set(key(operation.id), located);
      byCard.set(operation.value.id, located);
    }
    resolved.push(operation);
  }
  return changed ? resolved : batch.operations;
}
