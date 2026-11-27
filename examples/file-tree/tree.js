// @ts-check
// Shared by the page, the server and the tests: no DOM and no network.
import { defineDocument, map } from "articollab";

/** The parent of top-level nodes. It is not a node itself. */
export const ROOT = "root";
const MAX_NAME_LENGTH = 100;

/** @typedef {"folder" | "file"} Kind */

/**
 * A hand-written Standard Schema; Zod, Valibot or ArkType schemas work the same way.
 * @template {import("articollab").JsonValue} T
 * @param {(input: unknown) => input is T} accepts @param {string} message
 * @returns {import("articollab").StandardSchemaV1<T>}
 */
function standardSchema(accepts, message) {
  return { "~standard": { version: 1, vendor: "articollab-file-tree",
    validate: (input) => accepts(input) ? { value: input } : { issues: [{ message }] } } };
}

/** @param {unknown} input @returns {input is string} */
const isName = (input) => typeof input === "string" && input === input.trim() && input.length > 0 &&
  input.length <= MAX_NAME_LENGTH && !input.includes("/");

/**
 * A node exists while it has a parent. Moves, renames and kinds are separate Maps, so a move and a
 * rename of the same node never conflict. The server policy keeps the tree acyclic.
 */
export const Tree = defineDocument({
  parents: map(standardSchema(/** @returns {input is string} */ (input) =>
    typeof input === "string" && input.length > 0 && input.length <= 100, "A parent is a node ID or \"root\"")),
  names: map(standardSchema(isName, `A name needs 1–${MAX_NAME_LENGTH} characters, no "/" and no surrounding spaces`)),
  kinds: map(standardSchema(/** @returns {input is Kind} */ (input) => input === "folder" || input === "file",
    "A kind is folder or file")),
});
/** @typedef {typeof Tree.definition} Shape */
/** @typedef {import("articollab").ClientDocument<Shape>} TreeDocument */
/** @typedef {import("articollab").DocumentOperation<Shape>} TreeOperation */

/** @param {string} name */
export function normalizeName(name) {
  const trimmed = name.trim();
  if (!isName(trimmed)) throw new RangeError(`A name needs 1–${MAX_NAME_LENGTH} characters and no "/"`);
  return trimmed;
}

/**
 * Whether `id` is `ancestor` or lies below it, following `parentOf` up to the root.
 * @param {(id: string) => string | undefined} parentOf @param {string} id @param {string} ancestor
 */
export function isWithin(parentOf, id, ancestor) {
  for (let current = /** @type {string | undefined} */ (id), steps = 0; current !== undefined && current !== ROOT; steps++) {
    if (current === ancestor) return true;
    // A cycle in the input itself; the policy never lets one into the document.
    if (steps > 10_000) return true;
    current = parentOf(current);
  }
  return false;
}

/**
 * `name`, or the first of `name (2)`, `name (3)`… that is not taken. The number goes before the extension.
 * @param {ReadonlySet<string>} taken @param {string} name
 */
export function uniqueName(taken, name) {
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf(".");
  const [base, extension] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  for (let n = 2; ; n++) {
    const candidate = `${base} (${n})${extension}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** @param {TreeDocument} doc @param {string} id */
export function isFolder(doc, id) {
  return id === ROOT || doc.state.kinds.get(id) === "folder";
}

/** Folders first, then by name. @param {TreeDocument} doc @param {string} parent */
export function childrenOf(doc, parent) {
  const children = [];
  for (const [id, of] of doc.state.parents) if (of === parent) children.push(id);
  const rank = (/** @type {string} */ id) => isFolder(doc, id) ? 0 : 1;
  const name = (/** @type {string} */ id) => doc.state.names.get(id) ?? "";
  return children.toSorted((a, b) => rank(a) - rank(b) || name(a).localeCompare(name(b), undefined, { numeric: true }) ||
    (a < b ? -1 : a > b ? 1 : 0));
}

/** "docs/notes.md", or undefined if the node is gone. @param {TreeDocument} doc @param {string} id */
export function pathOf(doc, id) {
  const names = [];
  for (let current = id; current !== ROOT;) {
    const parent = doc.state.parents.get(current);
    if (parent === undefined || names.length > 10_000) return undefined;
    names.unshift(doc.state.names.get(current) ?? "");
    current = parent;
  }
  return names.join("/");
}

/** The node and everything below it, parents before children. @param {TreeDocument} doc @param {string} id */
function subtree(doc, id) {
  const ids = [id];
  for (let index = 0; index < ids.length; index++) ids.push(...childrenOf(doc, ids[index] ?? ROOT));
  return ids;
}

/**
 * Creates a node in one batch; the server renames it if the name is taken there. Returns its ID.
 * @param {TreeDocument} doc @param {string} parent @param {Kind} kind @param {string} name @param {string} [id]
 */
export function createNode(doc, parent, kind, name, id = crypto.randomUUID()) {
  const normalized = normalizeName(name);
  if (!isFolder(doc, parent) || (parent !== ROOT && !doc.state.parents.has(parent))) {
    throw new RangeError("New nodes go into a folder");
  }
  const taken = new Set(childrenOf(doc, parent).map((child) => doc.state.names.get(child) ?? ""));
  doc.transact(() => {
    // The parent first: the policy checks it before accepting the node's name and kind.
    doc.state.parents.set(id, parent);
    doc.state.kinds.set(id, kind);
    doc.state.names.set(id, uniqueName(taken, normalized));
  });
  return id;
}

/** Writes only `names`. Returns false if the node is gone. @param {TreeDocument} doc @param {string} id @param {string} name */
export function renameNode(doc, id, name) {
  const normalized = normalizeName(name);
  const parent = doc.state.parents.get(id);
  if (parent === undefined) return false;
  if (doc.state.names.get(id) === normalized) return true;
  const taken = new Set(childrenOf(doc, parent).filter((child) => child !== id).map((child) => doc.state.names.get(child) ?? ""));
  doc.state.names.set(id, uniqueName(taken, normalized));
  return true;
}

/**
 * Writes only `parents`. Returns false if the node is gone, would not move, or would go inside itself
 * here; the server checks again against what it has, which may differ.
 * @param {TreeDocument} doc @param {string} id @param {string} parent
 */
export function moveNode(doc, id, parent) {
  const current = doc.state.parents.get(id);
  if (current === undefined || current === parent || !isFolder(doc, parent)) return false;
  if (parent !== ROOT && !doc.state.parents.has(parent)) return false;
  if (isWithin((node) => doc.state.parents.get(node), parent, id)) return false;
  doc.state.parents.set(id, parent);
  return true;
}

/**
 * Deletes a node and everything below it in one batch, parents before children, so undo restores
 * each parent before its children. Returns false if the node is gone.
 * @param {TreeDocument} doc @param {string} id
 */
export function deleteNode(doc, id) {
  if (!doc.state.parents.has(id)) return false;
  const ids = subtree(doc, id);
  doc.transact(() => {
    for (const node of ids) doc.state.parents.delete(node);
    for (const node of ids) doc.state.names.delete(node);
    for (const node of ids) doc.state.kinds.delete(node);
  });
  return true;
}

/**
 * What the server changed in one of this writer's batches, as notices: a dropped create, move or
 * rename, or a name the server made unique. Takes a `transform` event or a batch outcome.
 * @param {Pick<import("articollab").TransformEvent<TreeOperation>, "batch" | "dropped" | "added">} outcome
 * @param {TreeDocument} doc The writer's document, after it received the commit.
 * @returns {string[]}
 */
export function describeTransform(outcome, doc) {
  const notices = [];
  const created = new Set(outcome.batch.operations.flatMap((operation) =>
    operation.path === "kinds" && operation.type === "map/set" ? [operation.key] : []));
  for (const operation of outcome.dropped) {
    if (operation.path === "parents" && operation.type === "map/set") {
      const sentName = outcome.batch.operations.find((other) => other.path === "names" && other.type === "map/set" &&
        other.key === operation.key);
      const name = (sentName?.type === "map/set" ? sentName.value : undefined) ?? doc.state.names.get(operation.key) ?? "it";
      const gone = operation.value !== ROOT && !doc.state.parents.has(operation.value);
      if (created.has(operation.key)) notices.push(`Not created: “${name}”. Its folder was deleted.`);
      else notices.push(gone ? `Not moved: “${name}”. The folder was deleted.` : `Not moved: “${name}”. A folder cannot go inside itself.`);
    } else if (operation.path === "names" && operation.type === "map/set" && !created.has(operation.key) &&
      !outcome.added.some((added) => added.path === "names" && added.key === operation.key)) {
      notices.push(`Not renamed: “${operation.value}”. Another writer deleted it.`);
    }
  }
  for (const operation of outcome.added) {
    if (operation.path === "names" && operation.type === "map/set") notices.push(`Renamed to “${operation.value}”: the name was taken.`);
  }
  return notices;
}
