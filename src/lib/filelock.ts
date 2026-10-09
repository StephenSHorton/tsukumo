import { closeSync, openSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { GatewayError } from "./errors.ts";

const LOCK_WAIT_MS = 2_000;
const LOCK_STALE_MS = 5_000;
/** Re-entrancy per file: holding one file's lock must not skip another's. */
const depth = new Map<string, number>();

/**
 * Runs a read-modify-write of a shared JSON file under `<path>.lock`, so
 * several watchers changing it at once don't drop each other's writes.
 * Re-entrant per path; a lock left by a crashed process is taken over after
 * a few seconds.
 */
export function withLock<T>(path: string, fn: () => T): T {
  const held = depth.get(path) ?? 0;
  if (held > 0) {
    depth.set(path, held + 1);
    try {
      return fn();
    } finally {
      depth.set(path, held);
    }
  }
  const lock = `${path}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      closeSync(openSync(lock, "wx"));
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) rmSync(lock, { force: true });
      } catch {
        // Released between the open and the stat.
      }
      if (Date.now() > deadline) throw new GatewayError(`${path} is busy; try again.`, 503);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  depth.set(path, 1);
  try {
    return fn();
  } finally {
    depth.delete(path);
    rmSync(lock, { force: true });
  }
}

/** Writes JSON through a temp file of our own and a rename, so readers never see half a file. */
export function writeJsonAtomic(path: string, data: unknown): void {
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8" });
  renameSync(tmp, path);
}
