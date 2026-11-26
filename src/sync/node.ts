import { randomUUID } from "node:crypto";
import * as nodeFs from "node:fs/promises";
import { dirname, basename, join, resolve } from "node:path";

import { acquireLock, closable, type CheckpointStore, type LockManagerLike } from "./store.ts";

export { CheckpointLockedError, type CheckpointStore } from "./store.ts";
export { openFileServerStore, type FileServerStoreOptions } from "./server-file-store.ts";
export type { ServerStore } from "./server-store.ts";

/** The `node:fs/promises` functions the file store uses. */
export interface FileStoreFileSystem {
  readFile(path: string, encoding: "utf8"): Promise<string>;
  open(path: string, flags: "wx"): Promise<{
    writeFile(data: string, encoding: "utf8"): Promise<void>;
    sync(): Promise<void>;
    close(): Promise<void>;
  }>;
  rename(from: string, to: string): Promise<void>;
  rm(path: string, options: { readonly force: true }): Promise<void>;
}

export interface FileStoreOptions {
  /** Defaults to `navigator.locks`; it excludes other stores in this process only. */
  readonly locks?: LockManagerLike;
  /** Defaults to `node:fs/promises`. */
  readonly fs?: FileStoreFileSystem;
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

/**
 * Opens a checkpoint file. Each save writes a temporary file in the same directory, flushes it and
 * renames it over `path`, so the file always holds a complete checkpoint. Opening the same path
 * twice in one process throws `CheckpointLockedError`; separate processes are not coordinated, so
 * give each process its own file. Power-loss durability depends on the file system and is not promised.
 */
export async function openFileStore(path: string, options: FileStoreOptions = {}): Promise<CheckpointStore> {
  if (typeof path !== "string" || path.length === 0) throw new TypeError("path must be a nonempty string");
  const target = resolve(path);
  const fs = options.fs ?? nodeFs;
  const state = closable(await acquireLock(`articollab:file:${target}`, options.locks));

  return {
    load: () => state.run(async () => {
      let text: string;
      try { text = await fs.readFile(target, "utf8"); }
      catch (error) {
        if (isMissing(error)) return undefined;
        throw error;
      }
      try { return JSON.parse(text) as unknown; }
      catch (cause) { throw new Error(`Checkpoint file is not valid JSON: ${target}`, { cause }); }
    }),
    save: (checkpoint) => state.run(async () => {
      const temporary = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`);
      try {
        const file = await fs.open(temporary, "wx");
        try {
          await file.writeFile(JSON.stringify(checkpoint), "utf8");
          await file.sync();
        } finally {
          await file.close();
        }
        await fs.rename(temporary, target);
      } catch (error) {
        await fs.rm(temporary, { force: true }).catch(() => {});
        throw error;
      }
    }),
    clear: () => state.run(async () => { await fs.rm(target, { force: true }); }),
    close: () => state.close(),
  };
}
