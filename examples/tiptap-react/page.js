// @ts-check
import { createUndoManager } from "articollab";
import { connectSync, createWebSocketTransport } from "articollab/sync";
import { selectionSchema } from "../shared/presence.js";
import { createOfflineSwitch } from "../shared/sync-ui.js";
import { Note } from "./schema.js";

/**
 * Connects two writers to the host at `url` and renders them into `root`. The sync clients are made
 * here, outside React, so that StrictMode or a re-render never opens a second writer session.
 * @param {Element} root @param {string | URL} url
 */
export async function mountEditors(root, url) {
  /** @type {import("./app.js").Writer[]} */
  const writers = [];
  /** @type {Map<string, string>} */
  const names = new Map();
  const socketUrl = new URL("/sync/socket", url);
  socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";
  for (const label of ["Writer A", "Writer B"]) {
    const network = createOfflineSwitch();
    const sync = await connectSync(Note, {
      transport: createWebSocketTransport({ url: socketUrl, WebSocket: network.WebSocket }),
      presence: { schema: selectionSchema },
    });
    names.set(sync.doc.checkpoint().clientId, label);
    writers.push({ label, sync, network, history: createUndoManager(sync.doc, { paths: ["body"] }) });
  }
  // Loaded here: React DOM, Tiptap and ProseMirror look for the DOM as soon as they are imported.
  const [{ createElement }, { createRoot }, { App }] = await Promise.all([import("react"), import("react-dom/client"), import("./app.js")]);
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
