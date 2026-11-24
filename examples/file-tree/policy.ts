import type { ServerResolveContext } from "../../dist/index.js";
import { isWithin, ROOT, uniqueName, type Shape, type TreeOperation } from "./tree.js";

/**
 * Keeps the tree valid whatever writers send at the same time, by walking the batch in order
 * against the tree as the server has it:
 * - a move or create into a missing folder, a file or the node itself is dropped, with the new
 *   node's name and kind;
 * - a node's kind is set once: a change, such as a folder with children turning into a file, is dropped;
 * - a name taken in the folder becomes `name (2)`;
 * - a name or kind is deleted only with its node, so no node is left without one;
 * - deleting a folder also deletes whatever the server has below it.
 * Not authorization.
 */
export function resolveTree({ batch, snapshot }: ServerResolveContext<Shape>): readonly TreeOperation[] {
  const parents = new Map(Object.entries(snapshot.data.parents));
  const names = new Map(Object.entries(snapshot.data.names));
  const kinds = new Map(Object.entries(snapshot.data.kinds));
  const deletedByBatch = new Set(batch.operations.flatMap((operation) =>
    operation.path === "parents" && operation.type === "map/delete" ? [operation.key] : []));
  const kept: TreeOperation[] = [];
  let changed = false;

  const takenBeside = (id: string, parent: string) => {
    const taken = new Set<string>();
    for (const [other, of] of parents) if (of === parent && other !== id) taken.add(names.get(other) ?? "");
    return taken;
  };
  /** Renames `id` if its name is taken where it now is. */
  const keepUnique = (id: string) => {
    const parent = parents.get(id), name = names.get(id);
    if (parent === undefined || name === undefined) return;
    const unique = uniqueName(takenBeside(id, parent), name);
    if (unique === name) return;
    names.set(id, unique);
    kept.push({ type: "map/set", path: "names", key: id, value: unique });
    changed = true;
  };
  const below = (id: string) => {
    const found: string[] = [];
    for (let queue = [id]; queue.length > 0;) {
      const next = queue.shift()!;
      for (const [child, of] of parents) if (of === next) { found.push(child); queue.push(child); }
    }
    return found;
  };

  for (const operation of batch.operations) {
    if (operation.path === "parents" && operation.type === "map/set") {
      const target = operation.value;
      const valid = (target === ROOT || (parents.has(target) && kinds.get(target) !== "file")) &&
        !isWithin((node) => parents.get(node), target, operation.key);
      if (!valid) { changed = true; continue; }
      parents.set(operation.key, target);
      kept.push(operation);
      keepUnique(operation.key);
    } else if (operation.type === "map/set") {
      // A name or kind for a node that does not exist, including one whose create was just dropped.
      if (!parents.has(operation.key)) { changed = true; continue; }
      if (operation.path === "kinds") {
        if (kinds.has(operation.key) && kinds.get(operation.key) !== operation.value) { changed = true; continue; }
        kinds.set(operation.key, operation.value);
        kept.push(operation);
        continue;
      }
      const unique = uniqueName(takenBeside(operation.key, parents.get(operation.key)!), operation.value);
      names.set(operation.key, unique);
      kept.push(unique === operation.value ? operation : { ...operation, value: unique });
      if (unique !== operation.value) changed = true;
    } else if (operation.path === "parents") {
      // Whatever other writers put below the folder goes with it.
      const orphans = below(operation.key).filter((id) => !deletedByBatch.has(id));
      for (const id of [operation.key, ...orphans]) { parents.delete(id); names.delete(id); kinds.delete(id); }
      kept.push(operation);
      for (const id of orphans) {
        kept.push({ type: "map/delete", path: "parents", key: id }, { type: "map/delete", path: "names", key: id },
          { type: "map/delete", path: "kinds", key: id });
        changed = true;
      }
    } else {
      // An undone create whose node another writer has since moved keeps its parent, so it keeps these too.
      if (parents.has(operation.key)) { changed = true; continue; }
      (operation.path === "names" ? names : kinds).delete(operation.key);
      kept.push(operation);
    }
  }
  return changed ? kept : batch.operations;
}
