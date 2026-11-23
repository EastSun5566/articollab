import type { DocumentOperation, ServerResolveContext } from "../../dist/index.js";
import type { Shape } from "./board.js";

type Operation = DocumentOperation<Shape>;

/**
 * Drops a title, column or vote for a card that is no longer on the board, unless the same batch
 * adds the card back; otherwise a late edit would recreate data for a deleted card. Not authorization.
 */
export function resolveBoard({ batch, snapshot }: ServerResolveContext<Shape>): readonly Operation[] {
  const present = new Set(snapshot.data.order.values);
  for (const operation of batch.operations) if (operation.type === "list/insert") present.add(operation.value);
  const kept = batch.operations.filter((operation) =>
    (operation.type !== "map/set" && operation.type !== "counterMap/add") || present.has(operation.key));
  return kept.length === batch.operations.length ? batch.operations : kept;
}
