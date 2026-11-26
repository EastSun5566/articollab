import { randomUUID } from "node:crypto";
import * as nodeFs from "node:fs/promises";
import { join, resolve } from "node:path";

import type { ServerStore } from "./server-store.ts";
import { acquireLock, closable, type LockManagerLike } from "./store.ts";

export interface FileServerStoreOptions {
  /** Defaults to `navigator.locks`; it excludes other stores in this process only. */
  readonly locks?: LockManagerLike;
}

const CHECKPOINT = /^checkpoint-(\d+)\.json$/;

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

/**
 * Opens a directory that holds one server: `checkpoint-<n>.json` and the entries after it, one JSON
 * line each, in `log-<n>.jsonl`. Appends are flushed to disk before they resolve. A compaction
 * writes `checkpoint-<n+1>.json` through a temporary file and a rename, starts a new log and then
 * removes generation `n`, so an interrupted step leaves either the old or the new generation
 * complete. A line cut short by a crash was never reported as saved and is dropped on load.
 *
 * Opening the same directory twice in one process throws `CheckpointLockedError`; separate
 * processes are not coordinated, so give each process its own directory. Power-loss durability
 * depends on the file system and is not promised.
 */
export async function openFileServerStore(directory: string, options: FileServerStoreOptions = {}): Promise<ServerStore> {
  if (typeof directory !== "string" || directory.length === 0) throw new TypeError("directory must be a nonempty string");
  const target = resolve(directory);
  const release = await acquireLock(`articollab:server-file:${target}`, options.locks);
  try { await nodeFs.mkdir(target, { recursive: true }); }
  catch (error) { release(); throw error; }
  /** The generation of the newest checkpoint, once known. */
  let generation: number | undefined;
  let log: nodeFs.FileHandle | undefined;
  const state = closable(release, async () => { await log?.close(); log = undefined; });
  // Appends and compactions must not interleave.
  let queue: Promise<unknown> = Promise.resolve();
  function serialized<T>(work: () => Promise<T>): Promise<T> {
    return state.run(() => {
      const result = queue.then(work);
      queue = result.catch(() => {});
      return result;
    });
  }
  const checkpointPath = (n: number) => join(target, `checkpoint-${n}.json`);
  const logPath = (n: number) => join(target, `log-${n}.jsonl`);

  /** The newest complete generation, and the files that belong to older ones or were left half written. */
  async function scan(): Promise<{ newest: number | undefined; stale: string[] }> {
    const names = await nodeFs.readdir(target);
    const generations = names.flatMap((name) => { const match = CHECKPOINT.exec(name); return match === null ? [] : [Number(match[1])]; });
    const newest = generations.length === 0 ? undefined : Math.max(...generations);
    const stale = names.filter((name) => {
      if (name.endsWith(".tmp")) return true;
      const match = /^(?:checkpoint-(\d+)\.json|log-(\d+)\.jsonl)$/.exec(name);
      return match !== null && newest !== undefined && Number(match[1] ?? match[2]) < newest;
    });
    return { newest, stale };
  }
  async function current(): Promise<number> {
    generation ??= (await scan()).newest;
    if (generation === undefined) throw new Error(`Server store has no checkpoint yet; compact first: ${target}`);
    return generation;
  }

  return {
    load: () => serialized(async () => {
      const found = await scan();
      for (const name of found.stale) await nodeFs.rm(join(target, name), { force: true }).catch(() => {});
      generation = found.newest;
      if (generation === undefined) return undefined;
      let checkpoint: unknown;
      try { checkpoint = JSON.parse(await nodeFs.readFile(checkpointPath(generation), "utf8")); }
      catch (cause) { throw new Error(`Checkpoint file is not valid JSON: ${checkpointPath(generation)}`, { cause }); }
      let text = "";
      try { text = await nodeFs.readFile(logPath(generation), "utf8"); }
      catch (error) { if (!isMissing(error)) throw error; }
      const complete = text.slice(0, text.lastIndexOf("\n") + 1);
      // Drop a line cut short, so the next append starts on a line of its own.
      if (complete.length < text.length) await nodeFs.truncate(logPath(generation), Buffer.byteLength(complete));
      const entries = complete.split("\n").slice(0, -1).map((line, index): unknown => {
        try { return JSON.parse(line); }
        catch (cause) { throw new Error(`Log line ${index + 1} is not valid JSON: ${logPath(generation!)}`, { cause }); }
      });
      return { checkpoint, entries };
    }),
    append: (entries) => serialized(async () => {
      if (!Array.isArray(entries)) throw new TypeError("entries must be an array");
      if (entries.length === 0) return;
      const text = entries.map((entry) => JSON.stringify(entry) + "\n").join("");
      log ??= await nodeFs.open(logPath(await current()), "a");
      await log.appendFile(text, "utf8");
      await log.sync();
    }),
    compact: (checkpoint) => serialized(async () => {
      const next = (generation ?? (await scan()).newest ?? 0) + 1;
      const temporary = join(target, `.checkpoint-${next}.json.${randomUUID()}.tmp`);
      try {
        const file = await nodeFs.open(temporary, "wx");
        try {
          await file.writeFile(JSON.stringify(checkpoint), "utf8");
          await file.sync();
        } finally {
          await file.close();
        }
        await nodeFs.rename(temporary, checkpointPath(next));
      } catch (error) {
        await nodeFs.rm(temporary, { force: true }).catch(() => {});
        throw error;
      }
      await log?.close();
      log = undefined;
      generation = next;
      for (const name of (await scan()).stale) await nodeFs.rm(join(target, name), { force: true }).catch(() => {});
    }),
    close: () => state.close(),
  };
}
