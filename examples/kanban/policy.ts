import type { DocumentOperation, ServerResolveContext } from "../../dist/index.js";
import type { Shape } from "./board.js";

type Operation = DocumentOperation<Shape>;

/**
 * Example server policy. Moves need none: List moves and column changes are decided by server
 * order, so concurrent moves never duplicate a card. Card data does: `columns` and `titles` are
 * last-writer-wins Maps, so a set that arrives after the card was deleted would recreate data with
 * no position. Such a set is dropped unless the same batch adds the card. Payloads need no check
 * here: the schemas in `board.js` reject a bad column or title before this policy runs. This is not
 * authorization.
 */
export function resolveBoard({ batch, snapshot }: ServerResolveContext<Shape>): readonly Operation[] {
  const present = new Set(snapshot.data.order.values);
  for (const operation of batch.operations) if (operation.type === "list/insert") present.add(operation.value);
  const kept = batch.operations.filter((operation) =>
    operation.type !== "map/set" || present.has(operation.key));
  return kept.length === batch.operations.length ? batch.operations : kept;
}
