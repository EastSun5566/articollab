// @ts-check
import { createElement } from "react";
import { createUndoManager } from "../../dist/index.js";
import { connectSync, createHttpTransport } from "../../dist/sync/index.js";
import { createOfflineSwitch } from "../shared/sync-ui.js";
import { App } from "./app.js";
import { editingSchema, Todos } from "./schema.js";

/**
 * Connects two writers to the host at `url` and renders them into `root`. The sync clients are made
 * here, outside React, so that StrictMode or a re-render never opens a second writer session.
 * @param {Element} root @param {string | URL} url
 */
export async function mountTodos(root, url) {
  /** @type {import("./app.js").Writer[]} */
  const writers = [];
  /** @type {Map<string, string>} */
  const names = new Map();
  for (const label of ["Writer A", "Writer B"]) {
    const network = createOfflineSwitch();
    const sync = await connectSync(Todos, {
      transport: createHttpTransport({ url: new URL("/sync/", url), fetch: network.fetch }),
      presence: { schema: editingSchema },
    });
    names.set(sync.doc.checkpoint().clientId, label);
    writers.push({ label, sync, network, history: createUndoManager(sync.doc) });
  }
  // Loaded here: react-dom looks for the DOM as soon as it is imported.
  const { createRoot } = await import("react-dom/client");
  const app = createRoot(root);
  app.render(createElement(App, { writers, names }));
  return {
    writers,
    destroy() {
      app.unmount();
      for (const { sync, history } of writers) { history.destroy(); sync.close(); }
    },
  };
}
