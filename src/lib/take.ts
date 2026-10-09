import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";

const SNOWFLAKE = /^\d{15,22}$/;

/** Who took a mention, where, and when. */
export interface Taken {
  messageId: string;
  by: string;
  /** The watched channel it belongs to (a thread's parent), for the sweeper's scope. */
  channelId: string | null;
  /** Where the message itself lives (the thread, for a thread message), to fetch it again. */
  messageChannelId: string | null;
  atMs: number;
  /**
   * `owned`: routed to the chat whose work it's about (its PR, its post, its
   * thread), which may take its time. `new`: front-desk work nobody owns,
   * which moves on if the taker doesn't engage.
   */
  kind: TakeKind;
}

export type TakeKind = "owned" | "new";

interface Row {
  by: string;
  channelId: string | null;
  messageChannelId: string | null;
  atMs: number;
  kind?: TakeKind;
}

function parse(messageId: string, text: string, mtimeMs: number): Taken {
  try {
    const row = JSON.parse(text) as Partial<Row>;
    if (row.by) {
      const channelId = row.channelId ?? null;
      return {
        messageId,
        by: row.by,
        channelId,
        messageChannelId: row.messageChannelId ?? channelId,
        atMs: row.atMs ?? mtimeMs,
        kind: row.kind ?? "new",
      };
    }
  } catch {
    // Older locks held just the conversation id.
  }
  return { messageId, by: text.trim(), channelId: null, messageChannelId: null, atMs: mtimeMs, kind: "new" };
}

const row = (by: string, channelId: string | null, messageChannelId: string | null, atMs: number, kind: TakeKind): string =>
  JSON.stringify({ by, channelId, messageChannelId: messageChannelId ?? channelId, atMs, kind } satisfies Row);

/**
 * Takes a mention for one conversation: an exclusive lock file per message, so
 * when two sessions reach for the same mention only the first gets it.
 */
export function takeMessage(
  dir: string,
  messageId: string,
  conversationId: string,
  channelId: string | null = null,
  now = Date.now(),
  messageChannelId: string | null = null,
  kind: TakeKind = "new",
): { ok: true } | { ok: false; takenBy: string } {
  if (!SNOWFLAKE.test(messageId)) return { ok: false, takenBy: "nobody (not a message id)" };
  mkdirSync(dir, { recursive: true });
  const path = join(dir, messageId);
  try {
    const fd = openSync(path, "wx");
    writeSync(fd, row(conversationId, channelId, messageChannelId, now, kind));
    closeSync(fd);
    return { ok: true };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    const taken = takenBy(dir, messageId);
    return taken?.by === conversationId ? { ok: true } : { ok: false, takenBy: taken?.by ?? "someone" };
  }
}

/** Hands a taken mention to another conversation (the front desk's sweeper, when the taker never answered). */
export function retake(
  dir: string,
  messageId: string,
  conversationId: string,
  channelId: string | null,
  now = Date.now(),
  messageChannelId: string | null = null,
  kind: TakeKind = "new",
): void {
  if (!SNOWFLAKE.test(messageId)) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, messageId), row(conversationId, channelId, messageChannelId, now, kind));
}

/** A chat (`by`) said it will answer later: when (ms), and why, for the reminder. */
export function defer(dir: string, messageId: string, by: string, untilMs: number, note: string): void {
  if (!SNOWFLAKE.test(messageId)) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, messageId), JSON.stringify({ by, untilMs, note: note.slice(0, 500) }));
}

/** When `by` said it would answer by; a deferral by an earlier holder doesn't count. */
export function deferredUntil(dir: string, messageId: string, by: string): number | null {
  if (!SNOWFLAKE.test(messageId)) return null;
  try {
    const row = JSON.parse(readFileSync(join(dir, messageId), "utf8")) as { untilMs?: number; by?: string };
    if (row.by && row.by !== by) return null;
    return typeof row.untilMs === "number" ? row.untilMs : null;
  } catch {
    return null;
  }
}

/** Clears a flag or record file. */
export function unmark(dir: string, messageId: string): void {
  if (!SNOWFLAKE.test(messageId)) return;
  rmSync(join(dir, messageId), { force: true });
}

export function takenBy(dir: string, messageId: string): Taken | null {
  if (!SNOWFLAKE.test(messageId)) return null;
  const path = join(dir, messageId);
  try {
    return parse(messageId, readFileSync(path, "utf8"), statSync(path).mtimeMs);
  } catch {
    return null;
  }
}

export function listTaken(dir: string): Taken[] {
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => SNOWFLAKE.test(n));
  } catch {
    return [];
  }
  return names.map((n) => takenBy(dir, n)).filter((t): t is Taken => t !== null);
}

/**
 * A flag file per message (answered, re-routed, seen, flagged overdue). `by`
 * records whose it is, for flags that belong to one holder (seen, flagged):
 * when a mention changes hands, the old holder's flags no longer count.
 */
export function mark(dir: string, messageId: string, by = ""): void {
  if (!SNOWFLAKE.test(messageId)) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, messageId), by);
}

/** Whether `messageId` is flagged for `by` (a flag written with no holder counts for anyone). */
export function isMarkedFor(dir: string, messageId: string, by: string): boolean {
  if (!SNOWFLAKE.test(messageId)) return false;
  try {
    const owner = readFileSync(join(dir, messageId), "utf8").trim();
    return owner === "" || owner === by;
  } catch {
    return false;
  }
}

export function isMarked(dir: string, messageId: string): boolean {
  if (!SNOWFLAKE.test(messageId)) return false;
  try {
    statSync(join(dir, messageId));
    return true;
  } catch {
    return false;
  }
}

/** Drops locks and flags older than `maxAgeMs`; a mention is only contested while it's fresh. */
export function pruneTaken(dir: string, maxAgeMs: number, now = Date.now()): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const path = join(dir, name);
    try {
      if (now - statSync(path).mtimeMs > maxAgeMs) rmSync(path, { force: true });
    } catch {
      // Another watcher pruned it first.
    }
  }
}
