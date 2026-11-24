import type { ClientBatch, JsonValue } from "../index.ts";
import type { SyncSubscription, SyncTransport } from "./client.ts";
import { SyncRequestError, SyncResponseError } from "./errors.ts";
import { readRegistration } from "./http-client.ts";
import { isJsonObject } from "../json.ts";

/** The part of the standard `WebSocket` the transport uses. */
export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  /** `message` events carry the text in `data`. */
  addEventListener(type: "open" | "message" | "close" | "error", listener: (event: unknown) => void): void;
}

export interface WebSocketTransportOptions {
  /**
   * The `accept`ed socket's URL, usually `ws:` or `wss:`. A function is called before each
   * connection, for example to add a fresh token: browsers cannot set headers on a WebSocket.
   */
  readonly url: string | URL | (() => string | URL | Promise<string | URL>);
  /** Default: the global `WebSocket`. */
  readonly WebSocket?: new (url: string) => WebSocketLike;
}

/** The socket closed before a request was answered: the outcome is unknown, so the client retries. */
class SyncConnectionError extends Error {}

interface Answer { readonly status: number; readonly body?: unknown }

function expect(answer: Answer, status: number): Answer {
  if (answer.status !== status) throw new SyncRequestError(answer.status);
  return answer;
}

/**
 * WebSocket transport for `connectSync`, served by `SyncHandler.accept`. Requests and pushes share
 * one socket, opened on first use and again after it closes. `sync.close()` closes it.
 */
export function createWebSocketTransport(options: WebSocketTransportOptions): SyncTransport {
  const { url } = options;
  // Fails now rather than on every retry.
  if (typeof url !== "function" && !URL.canParse(url)) throw new TypeError(`Invalid WebSocket URL: ${String(url)}`);
  const Socket = options.WebSocket ?? globalThis.WebSocket;
  let connecting: Promise<WebSocketLike> | undefined;
  let current: WebSocketLike | undefined;
  let closed = false;
  let nextId = 0;
  const waiting = new Map<number, { resolve(answer: Answer): void; reject(error: unknown): void }>();
  /** The latest subscription; it takes pushes only once its reply arrived, as the server sends that first. */
  let subscription: { readonly handlers: SyncSubscription; active: boolean; opened: boolean } | undefined;

  /** Ends everything the socket carried, with `cause` as the reason. */
  function lost(socket: WebSocketLike, cause: unknown): void {
    if (socket !== current) return;
    current = undefined;
    connecting = undefined;
    for (const waiter of waiting.values()) waiter.reject(cause);
    waiting.clear();
    const ended = subscription;
    subscription = undefined;
    if (ended?.active === true) { ended.active = false; ended.handlers.onEnd(cause); }
  }
  /** A message that breaks the protocol: retrying cannot repair it. */
  function invalid(socket: WebSocketLike, message: string, cause?: unknown): void {
    lost(socket, new SyncResponseError(message, { cause }));
    try { socket.close(1002, "Protocol error"); } catch { /* Already closing. */ }
  }
  function received(socket: WebSocketLike, data: unknown): void {
    if (socket !== current) return;
    let message: unknown;
    try { message = typeof data === "string" ? JSON.parse(data) : undefined; }
    catch (cause) { invalid(socket, "Invalid message JSON", cause); return; }
    if (!isJsonObject(message)) { invalid(socket, "Expected a JSON object message"); return; }
    if ("id" in message) {
      const { id, status } = message;
      const waiter = typeof id === "number" ? waiting.get(id) : undefined;
      if (waiter === undefined || typeof id !== "number" || typeof status !== "number") { invalid(socket, "Unexpected reply"); return; }
      waiting.delete(id);
      waiter.resolve({ status, body: message.body });
      return;
    }
    // Pushes before the reply belong to a subscription this one replaced.
    const handlers = subscription?.active === true && subscription.opened ? subscription.handlers : undefined;
    switch (message.type) {
      case "commits": handlers?.onCommits(message.commits); break;
      case "presence": handlers?.onPresence?.({ clientId: message.clientId, state: message.state }); break;
      case "gap":
        if (handlers === undefined || subscription === undefined) break;
        subscription.active = false;
        subscription = undefined;
        handlers.onGap();
        break;
      case "ping": handlers?.onActivity(); break;
      default: invalid(socket, "Unknown message type");
    }
  }
  async function open(): Promise<WebSocketLike> {
    const address = String(typeof url === "function" ? await url() : url);
    if (closed) throw new SyncConnectionError("WebSocket transport is closed");
    const socket = new Socket(address);
    current = socket;
    return new Promise((resolve, reject) => {
      let opened = false;
      socket.addEventListener("open", () => {
        opened = true;
        if (closed) socket.close(1000, "Client closed");
        resolve(socket);
      });
      socket.addEventListener("message", (event) => {
        received(socket, typeof event === "object" && event !== null && "data" in event ? event.data : undefined);
      });
      socket.addEventListener("close", () => {
        const cause = new SyncConnectionError(opened ? "WebSocket closed" : "WebSocket could not connect");
        lost(socket, cause);
        if (!opened) reject(cause);
      });
      // A close event follows every error.
      socket.addEventListener("error", () => {});
    });
  }
  function connect(): Promise<WebSocketLike> {
    if (closed) return Promise.reject(new SyncConnectionError("WebSocket transport is closed"));
    if (connecting === undefined) {
      const attempt = open();
      connecting = attempt;
      // A failed attempt is forgotten, so the next request tries again.
      attempt.catch(() => { if (connecting === attempt) connecting = undefined; });
    }
    return connecting;
  }
  async function request(message: Record<string, unknown>): Promise<Answer> {
    const socket = await connect();
    // It may have closed meanwhile; a closed WebSocket drops sends without an error.
    if (socket !== current) throw new SyncConnectionError("WebSocket closed");
    const id = nextId++;
    return new Promise((resolve, reject) => {
      waiting.set(id, { resolve, reject });
      try { socket.send(JSON.stringify({ id, ...message })); }
      catch (cause) { waiting.delete(id); reject(new SyncConnectionError("WebSocket send failed", { cause })); }
    });
  }

  return {
    async register() { return readRegistration(expect(await request({ type: "register" }), 201).body); },
    async submit(batch: ClientBatch) { expect(await request({ type: "submit", batch }), 204); },
    async reject(batch: ClientBatch) { expect(await request({ type: "reject", batch }), 204); },
    async commitsSince(watermark: number) { return expect(await request({ type: "commits", since: watermark }), 200).body; },
    async publishPresence(clientId: string, state: JsonValue | null) {
      expect(await request({ type: "presence", clientId, state }), 204);
    },
    subscribe(watermark: number, handlers: SyncSubscription) {
      const mine = { handlers, active: true, opened: false };
      subscription = mine;
      void request({ type: "subscribe", since: watermark }).then((answer) => {
        if (!mine.active) return;
        if (answer.status === 200) { mine.opened = true; handlers.onOpen(); return; }
        mine.active = false;
        if (subscription === mine) subscription = undefined;
        handlers.onEnd(new SyncRequestError(answer.status));
      }, (cause: unknown) => {
        if (!mine.active) return;
        mine.active = false;
        if (subscription === mine) subscription = undefined;
        handlers.onEnd(cause);
      });
      return () => {
        if (!mine.active) return;
        mine.active = false;
        if (subscription === mine) subscription = undefined;
        // The server opens only the latest subscribe, so this also cancels one still waiting.
        if (current !== undefined && !closed) void request({ type: "unsubscribe" }).catch(() => {});
      };
    },
    close() {
      if (closed) return;
      closed = true;
      const socket = current;
      if (socket !== undefined) {
        lost(socket, new SyncConnectionError("WebSocket transport is closed"));
        try { socket.close(1000, "Client closed"); } catch { /* Already closing. */ }
      }
    },
  };
}
