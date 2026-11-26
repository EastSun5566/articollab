import type { ServerStore } from "./server-store.ts";
import { CheckpointLockedError } from "./store.ts";

export { CheckpointLockedError } from "./store.ts";
export type { ServerStore } from "./server-store.ts";

/** The part of a Postgres connection the store uses; node-postgres `Client` and PGlite both fit. */
export interface PostgresClient {
  query(text: string, values?: unknown[]): Promise<{ readonly rows: readonly unknown[] }>;
}

export interface PostgresServerStoreOptions {
  /** One dedicated connection, not a pool: the lock and transactions belong to its session. */
  readonly client: PostgresClient;
  /** The document's key; one server per document. */
  readonly document: string;
  /** Prefix of the two tables, `<table>_checkpoints` and `<table>_entries`. Default `"articollab"`. */
  readonly table?: string;
}

const TABLE = /^[a-z_][a-z0-9_]{0,47}$/;

/**
 * Documents open on each connection, or the release of one closing: advisory locks do not exclude
 * their own session.
 */
const opened = new WeakMap<object, Map<string, true | Promise<void>>>();

/**
 * The advisory lock key of a document: the first 64 bits of a SHA-256 of the table prefix and the
 * document, as Postgres's two signed 32-bit halves, so distinct documents practically never share one.
 */
async function lockKey(table: string, document: string): Promise<[number, number]> {
  const digest = new DataView(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`articollab\0${table}\0${document}`)));
  return [digest.getInt32(0), digest.getInt32(4)];
}

function column(rows: readonly unknown[], index: number, name: string): unknown {
  const row = rows[index];
  if (typeof row !== "object" || row === null || !(name in row)) throw new Error(`Postgres returned no ${name} column`);
  const value: unknown = Reflect.get(row, name);
  return value;
}

function textColumn(rows: readonly unknown[], index: number, name: string): string {
  const value = column(rows, index, name);
  if (typeof value !== "string") throw new Error(`Postgres returned a non-text ${name} column`);
  return value;
}

/**
 * Opens one document's server log in Postgres: its checkpoint in `<table>_checkpoints` and the
 * entries after it in `<table>_entries`, created when missing. Values are `json`, kept exactly as
 * written. An append is one insert; a compaction replaces the checkpoint and deletes the entries
 * in one transaction.
 *
 * An advisory lock, held until `close()`, keeps a second store of the same document, on any
 * connection to the database, from opening: it throws `CheckpointLockedError`. The caller owns the
 * connection; `close()` releases the lock but does not end it.
 */
export async function openPostgresServerStore(options: PostgresServerStoreOptions): Promise<ServerStore> {
  const { client, document, table = "articollab" } = options;
  if (typeof client !== "object" || client === null || typeof client.query !== "function") {
    throw new TypeError("client must have a query() method");
  }
  if (typeof document !== "string" || document.length === 0) throw new TypeError("document must be a nonempty string");
  if (typeof table !== "string" || !TABLE.test(table)) {
    throw new TypeError("table must be lowercase letters, digits and underscores, starting with a letter or underscore");
  }
  const checkpoints = `${table}_checkpoints`, entries = `${table}_entries`;
  const key = await lockKey(table, document);
  const documents = opened.get(client) ?? new Map<string, true | Promise<void>>();
  opened.set(client, documents);
  const name = `${table}\0${document}`;
  // Reopening right after close() waits for its release instead of failing.
  const previous = documents.get(name);
  if (previous === true) throw new CheckpointLockedError(`Server store is in use elsewhere: ${table} ${document}`);
  await previous;
  if (documents.has(name)) throw new CheckpointLockedError(`Server store is in use elsewhere: ${table} ${document}`);
  documents.set(name, true);
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS ${checkpoints} (document text PRIMARY KEY, checkpoint json NOT NULL)`);
    await client.query(`CREATE TABLE IF NOT EXISTS ${entries} (document text NOT NULL, position bigint NOT NULL, ` +
      "entry json NOT NULL, PRIMARY KEY (document, position))");
    const { rows } = await client.query("SELECT pg_try_advisory_lock($1, $2) AS locked", key);
    if (column(rows, 0, "locked") !== true) throw new CheckpointLockedError(`Server store is in use elsewhere: ${table} ${document}`);
  } catch (error) {
    documents.delete(name);
    throw error;
  }

  /** The position of the next entry, once known. */
  let next: number | undefined;
  let closed = false;
  let queue: Promise<unknown> = Promise.resolve();
  function serialized<T>(work: () => Promise<T>): Promise<T> {
    if (closed) return Promise.reject(new Error("Checkpoint store is closed"));
    const result = queue.then(work);
    queue = result.catch(() => {});
    return result;
  }
  async function position(): Promise<number> {
    if (next !== undefined) return next;
    const { rows } = await client.query(`SELECT (SELECT count(*) FROM ${checkpoints} WHERE document = $1)::text AS saved, ` +
      `(SELECT coalesce(max(position) + 1, 0) FROM ${entries} WHERE document = $1)::text AS next`, [document]);
    if (textColumn(rows, 0, "saved") === "0") throw new Error(`Server store has no checkpoint yet; compact first: ${table} ${document}`);
    next = Number(textColumn(rows, 0, "next"));
    return next;
  }

  return {
    load: () => serialized(async () => {
      const saved = await client.query(`SELECT checkpoint::text AS checkpoint FROM ${checkpoints} WHERE document = $1`, [document]);
      if (saved.rows.length === 0) { next = undefined; return undefined; }
      const checkpoint: unknown = JSON.parse(textColumn(saved.rows, 0, "checkpoint"));
      const { rows } = await client.query(`SELECT entry::text AS entry, (position + 1)::text AS next FROM ${entries} ` +
        "WHERE document = $1 ORDER BY position", [document]);
      next = rows.length === 0 ? 0 : Number(textColumn(rows, rows.length - 1, "next"));
      return { checkpoint, entries: rows.map((_row, index): unknown => JSON.parse(textColumn(rows, index, "entry"))) };
    }),
    append: (added) => serialized(async () => {
      if (!Array.isArray(added)) throw new TypeError("entries must be an array");
      if (added.length === 0) return;
      const start = await position();
      await client.query(`INSERT INTO ${entries} (document, position, entry) ` +
        "SELECT $1, $2::bigint + ordinality - 1, value FROM json_array_elements($3::json) WITH ORDINALITY AS t(value, ordinality)",
      [document, start, JSON.stringify(added)]);
      next = start + added.length;
    }),
    compact: (checkpoint) => serialized(async () => {
      await client.query("BEGIN");
      try {
        await client.query(`INSERT INTO ${checkpoints} (document, checkpoint) VALUES ($1, $2::json) ` +
          "ON CONFLICT (document) DO UPDATE SET checkpoint = EXCLUDED.checkpoint", [document, JSON.stringify(checkpoint)]);
        await client.query(`DELETE FROM ${entries} WHERE document = $1`, [document]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      }
      next = 0;
    }),
    close() {
      if (closed) return;
      closed = true;
      const released: Promise<void> = queue.then(() => client.query("SELECT pg_advisory_unlock($1, $2)", key))
        .then(() => {}, () => {})
        .finally(() => { if (documents.get(name) === released) documents.delete(name); });
      documents.set(name, released);
    },
  };
}
