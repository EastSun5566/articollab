// @ts-check
// Browser helpers shared by the live examples. Types only: importing this module loads no runtime code.

/** What a writer's status badge says, from its sync status and push channel.
 * @param {import("../../dist/sync/index.js").SyncStatus} status
 * @param {import("../../dist/sync/index.js").SyncPushState} push
 * @param {boolean} offline
 */
export function describeSync(status, push, offline) {
  if (status === "failed") return { state: "failed", text: "Failed" };
  if (status === "closed") return { state: "closed", text: "Closed" };
  if (status === "gap") return { state: "failed", text: "History gap: preserve the checkpoint" };
  if (status === "blocked") return { state: "blocked", text: "Blocked by a rejected edit" };
  if (offline || status === "retrying") return { state: "offline", text: offline ? "Offline" : "Reconnecting" };
  if (status === "syncing") return { state: "syncing", text: "Syncing" };
  return push === "open" ? { state: "live", text: "Live" } : { state: "polling", text: "Polling" };
}

/**
 * A fetch and a WebSocket that can be taken offline: new requests and sockets fail, and open event
 * streams and sockets close.
 * @param {typeof globalThis.fetch} [base]
 */
export function createOfflineSwitch(base = globalThis.fetch) {
  let offline = false;
  /** @type {Set<AbortController>} */
  const streams = new Set();
  /** @type {Set<WebSocket>} */
  const sockets = new Set();
  /** @type {typeof globalThis.fetch} */
  const fetch = async (input, init) => {
    if (offline) throw new TypeError("Network unavailable (simulated offline)");
    const url = input instanceof Request ? input.url : input.toString();
    if (!url.includes("/events?")) return base(input, init);
    const controller = new AbortController();
    streams.add(controller);
    const signal = init?.signal;
    signal?.addEventListener("abort", () => { streams.delete(controller); controller.abort(); }, { once: true });
    return base(input, { ...init, signal: controller.signal });
  };
  /** @typedef {(event: unknown) => void} Listener */
  /** A WebSocket that fails to connect while offline, without trying the network. */
  class SwitchedWebSocket {
    /** @type {WebSocket | undefined} */
    #socket;
    /** @type {[string, Listener][]} */
    #listeners = [];
    /** @param {string} url */
    constructor(url) {
      if (offline) {
        setTimeout(() => { for (const [type, listener] of this.#listeners) if (type === "close") listener({}); });
        return;
      }
      const socket = new WebSocket(url);
      this.#socket = socket;
      sockets.add(socket);
      socket.addEventListener("close", () => { sockets.delete(socket); });
    }
    /** @param {"open" | "message" | "close" | "error"} type @param {Listener} listener */
    addEventListener(type, listener) {
      if (this.#socket === undefined) this.#listeners.push([type, listener]);
      else this.#socket.addEventListener(type, listener);
    }
    /** @param {string} data */
    send(data) {
      if (this.#socket === undefined) throw new TypeError("Network unavailable (simulated offline)");
      this.#socket.send(data);
    }
    /** @param {number} [code] @param {string} [reason] */
    close(code, reason) { this.#socket?.close(code, reason); }
  }
  return {
    fetch,
    WebSocket: SwitchedWebSocket,
    get offline() { return offline; },
    /** @param {boolean} next */
    set(next) {
      offline = next;
      if (!next) return;
      for (const controller of streams) controller.abort();
      streams.clear();
      for (const socket of sockets) socket.close(4000, "Offline");
      sockets.clear();
    },
  };
}
