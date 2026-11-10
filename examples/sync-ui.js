// @ts-check
// Browser helpers shared by the live examples. Types only: importing this module loads no runtime code.

/** What a writer's status badge says, from its sync status and push channel.
 * @param {import("../dist/sync/index.js").SyncStatus} status
 * @param {import("../dist/sync/index.js").SyncPushState} push
 * @param {boolean} offline
 */
export function describeSync(status, push, offline) {
  if (status === "failed") return { state: "failed", text: "Failed" };
  if (status === "stopped") return { state: "stopped", text: "Stopped" };
  if (status === "gap") return { state: "failed", text: "History gap: preserve the checkpoint" };
  if (status === "blocked") return { state: "blocked", text: "Blocked by a rejected edit" };
  if (offline || status === "retrying") return { state: "offline", text: offline ? "Offline" : "Reconnecting" };
  if (status === "syncing") return { state: "syncing", text: "Syncing" };
  return push === "open" ? { state: "live", text: "Live" } : { state: "polling", text: "Polling" };
}

/**
 * A fetch whose writer can be taken offline: new requests fail like a dropped network, and open
 * event streams are aborted. Only stream requests are tracked; others finish on their own.
 * @param {typeof globalThis.fetch} [base]
 */
export function createOfflineSwitch(base = globalThis.fetch) {
  let offline = false;
  /** @type {Set<AbortController>} */
  const streams = new Set();
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
  return {
    fetch,
    get offline() { return offline; },
    /** @param {boolean} next */
    set(next) {
      offline = next;
      if (!next) return;
      for (const controller of streams) controller.abort();
      streams.clear();
    },
  };
}
