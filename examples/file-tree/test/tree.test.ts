import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createClient, createUndoManager, PayloadValidationError, type DocumentOperation, type ServerCommit, type ServerDocument,
} from "../../../dist/index.js";
import { createTreeServer } from "../server.ts";
import {
  childrenOf, createNode, deleteNode, describeTransform, moveNode, normalizeName, pathOf, renameNode, ROOT, Tree, uniqueName,
  type Shape, type TreeDocument,
} from "../tree.js";

/** Explicit, ordered delivery: tests decide when each writer sends and receives. */
function network(server: ServerDocument<Shape> = createTreeServer()) {
  const log: ServerCommit<DocumentOperation<Shape>>[] = [];
  function writer() {
    let sent = 0, received = server.snapshot().serverSeq;
    const notices: string[] = [];
    const doc = createClient(Tree, { clientId: server.openClient(), snapshot: server.snapshot(), onBatch() {} });
    doc.on("transform", (event) => { notices.push(...describeTransform(event, doc)); });
    return {
      doc, notices,
      /** Sends every unsent pending batch, never past a replay conflict. */
      send() {
        for (let batch = doc.checkpoint().pendingBatches.find(({ seq }) => seq > sent); batch !== undefined;
          batch = doc.checkpoint().pendingBatches.find(({ seq }) => seq > sent)) {
          assert.equal(doc.replayConflict, null);
          sent = batch.seq;
          log.push(server.receive(batch).commit);
        }
      },
      /** Receives every commit it has not seen yet, in order. */
      receive() {
        for (const commit of log) {
          if (commit.serverSeq <= received) continue;
          doc.receive(commit);
          received = commit.serverSeq;
        }
      },
      paths: () => allPaths(doc),
    };
  }
  /** The server's tree as paths, checking that every node's parent exists. */
  function serverPaths() {
    const { data } = server.snapshot();
    const doc = createClient(Tree, { clientId: server.openClient(), snapshot: server.snapshot(), onBatch() {} });
    for (const parent of Object.values(data.parents)) assert.ok(parent === ROOT || parent in data.parents, "no orphans");
    return allPaths(doc);
  }
  return { server, writer, serverPaths };
}

/** Every node as "folder/" or "file" paths, depth first in display order. */
function allPaths(doc: TreeDocument): string[] {
  const out: string[] = [];
  const visit = (parent: string) => {
    for (const id of childrenOf(doc, parent)) {
      out.push(pathOf(doc, id)! + (doc.state.kinds.get(id) === "folder" ? "/" : ""));
      visit(id);
    }
  };
  visit(ROOT);
  return out;
}

const SEEDED = ["docs/", "docs/notes.md", "src/", "src/index.ts", "README.md"];

describe("Folder tree helpers", () => {
  it("lists folders first, then names in natural order, and builds paths", () => {
    const n = network(), w = n.writer();
    assert.deepEqual(w.paths(), SEEDED);
    for (const name of ["file10.txt", "file2.txt", "a"]) createNode(w.doc, ROOT, "file", name);
    createNode(w.doc, ROOT, "folder", "zeta");
    assert.deepEqual(childrenOf(w.doc, ROOT).map((id) => w.doc.state.names.get(id)),
      ["docs", "src", "zeta", "a", "file2.txt", "file10.txt", "README.md"]);
    assert.equal(pathOf(w.doc, "seed-notes"), "docs/notes.md");
    assert.equal(pathOf(w.doc, "missing"), undefined);
  });

  it("makes names unique, validates them and refuses a move into the node itself", () => {
    assert.equal(uniqueName(new Set(["notes.md", "notes (2).md"]), "notes.md"), "notes (3).md");
    assert.equal(uniqueName(new Set([".env"]), ".env"), ".env (2)");
    assert.equal(uniqueName(new Set(), "x"), "x");
    for (const bad of ["", "  ", "a/b", "x".repeat(101)]) assert.throws(() => normalizeName(bad), RangeError);
    const n = network(), w = n.writer();
    assert.throws(() => { w.doc.state.names.set("seed-notes", "a/b"); }, PayloadValidationError);
    assert.throws(() => createNode(w.doc, "seed-notes", "file", "x"), RangeError, "files hold nothing");
    const sub = createNode(w.doc, "seed-docs", "folder", "sub");
    assert.equal(moveNode(w.doc, "seed-docs", sub), false, "not below itself");
    assert.equal(moveNode(w.doc, "seed-docs", "seed-docs"), false);
    assert.equal(moveNode(w.doc, "seed-docs", ROOT), false, "already there");
    assert.equal(createNode(w.doc, ROOT, "file", "README.md") !== "", true);
    assert.ok(w.paths().includes("README (2).md"), "a taken name is made unique locally too");
  });
});

describe("Folder tree under concurrent edits", () => {
  it("never lets two moves make a cycle: the later one is dropped and its writer told", () => {
    const n = network(), a = n.writer(), b = n.writer();
    assert.ok(moveNode(a.doc, "seed-docs", "seed-src"));
    assert.ok(moveNode(b.doc, "seed-src", "seed-docs"));
    a.send(); b.send();
    a.receive(); b.receive();
    const expected = ["src/", "src/docs/", "src/docs/notes.md", "src/index.ts", "README.md"];
    assert.deepEqual([a.paths(), b.paths(), n.serverPaths()], [expected, expected, expected]);
    assert.deepEqual([a.notices, b.notices], [[], ["Not moved: “src”. A folder cannot go inside itself."]]);
  });

  it("drops a create or move into a folder another writer deleted first, leaving no orphan", () => {
    const n = network(), a = n.writer(), b = n.writer();
    assert.ok(deleteNode(a.doc, "seed-docs"));
    createNode(b.doc, "seed-docs", "file", "draft.md");
    assert.ok(moveNode(b.doc, "seed-readme", "seed-docs"));
    a.send(); b.send();
    a.receive(); b.receive();
    const expected = ["src/", "src/index.ts", "README.md"];
    assert.deepEqual([a.paths(), b.paths(), n.serverPaths()], [expected, expected, expected]);
    assert.deepEqual(b.notices, ["Not created: “draft.md”. Its folder was deleted.", "Not moved: “README.md”. The folder was deleted."]);
  });

  it("deletes what another writer put in a folder first, along with the folder", () => {
    const n = network(), a = n.writer(), b = n.writer();
    assert.ok(moveNode(b.doc, "seed-readme", "seed-docs"));
    createNode(b.doc, "seed-docs", "file", "new.md");
    assert.ok(deleteNode(a.doc, "seed-docs")); // A has not seen B's edits.
    b.send(); a.send();
    a.receive(); b.receive();
    const expected = ["src/", "src/index.ts"];
    assert.deepEqual([a.paths(), b.paths(), n.serverPaths()], [expected, expected, expected]);
    assert.deepEqual([a.notices, b.notices], [[], []], "the deleter asked for the folder to go");
  });

  it("renames a create, rename or move whose name is taken where it lands", () => {
    const n = network(), a = n.writer(), b = n.writer();
    createNode(a.doc, ROOT, "file", "todo.md");
    createNode(b.doc, ROOT, "file", "todo.md");
    assert.ok(renameNode(b.doc, "seed-index", "notes.md"));
    assert.ok(moveNode(b.doc, "seed-index", "seed-docs")); // docs/notes.md exists.
    a.send(); b.send();
    a.receive(); b.receive();
    const expected = ["docs/", "docs/notes (2).md", "docs/notes.md", "src/", "README.md", "todo (2).md", "todo.md"];
    assert.deepEqual([a.paths(), b.paths(), n.serverPaths()], [expected, expected, expected]);
    assert.deepEqual(b.notices, ["Renamed to “todo (2).md”: the name was taken.", "Renamed to “notes (2).md”: the name was taken."]);
  });

  it("never changes a node's kind, so a folder with children cannot become a file", () => {
    const n = network(), a = n.writer();
    a.doc.state.kinds.set("seed-docs", "file"); // A writer that skips the helpers.
    a.send(); a.receive();
    assert.equal(n.server.snapshot().data.kinds["seed-docs"], "folder");
    assert.equal(a.doc.state.kinds.get("seed-docs"), "folder");
    assert.deepEqual(n.serverPaths(), SEEDED);
  });

  it("undoes a folder delete with everything in it, through the policy", () => {
    const n = network(), a = n.writer(), b = n.writer();
    const history = createUndoManager(a.doc, { captureTimeout: 0 });
    createNode(a.doc, "seed-src", "folder", "lib");
    const lib = childrenOf(a.doc, "seed-src").find((id) => a.doc.state.names.get(id) === "lib")!;
    createNode(a.doc, lib, "file", "util.ts");
    history.stopCapturing();
    assert.ok(deleteNode(a.doc, "seed-src"));
    a.send(); b.receive();
    assert.deepEqual(b.paths(), ["docs/", "docs/notes.md", "README.md"]);
    assert.ok(history.undo());
    a.send(); a.receive(); b.receive();
    const expected = ["docs/", "docs/notes.md", "src/", "src/lib/", "src/lib/util.ts", "src/index.ts", "README.md"];
    assert.deepEqual([a.paths(), b.paths(), n.serverPaths()], [expected, expected, expected]);
    assert.deepEqual(a.notices, []);
  });
});
