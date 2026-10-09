import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { projectRoot } from "../config.ts";
import { GatewayError } from "./errors.ts";
import { withLock, writeJsonAtomic } from "./filelock.ts";

export const hooksFilePath = join(projectRoot, ".hooks.json");

/** Grok injects this on stdio MCP spawn; stable across resume of the same conversation. */
export function conversationId(): string | null {
  for (const key of ["GROK_SESSION_ID", "TSUKUMO_SESSION_ID", "CLAUDE_SESSION_ID"]) {
    const value = process.env[key]?.trim();
    if (value) return value;
  }
  return null;
}

export interface HookScope {
  conversationId: string;
  /** The first server watched; `guilds` lists every one when there are several. */
  guildId: string;
  guildName: string;
  /** Every server this row watches channels in, when more than one (the router's chats). */
  guilds?: Array<{ id: string; name: string }>;
  /** null = entire guild */
  channelIds: string[] | null;
  channelNames: string[];
  boundAt: string;
  /** Set by long-running watchers (the Claude Code mod). Fresh = still live. */
  heartbeatAt?: string;
  /**
   * `owner` answers mentions in its channels; `listener` only sees them. Absent
   * means owner (Grok's `bind`). Many may listen; one owns a channel at a time.
   */
  role?: "owner" | "listener";
  /** Threads this conversation answers, ahead of the channel's owner. One owner per thread. */
  threadIds?: string[];
  /** A readable name for "handled by …" (a chat's title). */
  label?: string;
  /**
   * Routing version the watcher behind this row speaks. 2 = ledger routing
   * (Stage 1). Absent: an older watcher or Grok's bind, which only knows
   * thread → owner, so ledger routing must not send it anything.
   */
  routing?: number;
}

/** Every server a row covers: `guildId`, plus `guilds` when it watches several. */
export function hookGuildIds(hook: Pick<HookScope, "guildId" | "guilds">): string[] {
  return [...new Set([hook.guildId, ...(hook.guilds ?? []).map((g) => g.id)])];
}

export function isOwner(hook: Pick<HookScope, "role">): boolean {
  return hook.role !== "listener";
}

/** How another conversation appears in messages: its label, else a short id. */
export function describeHook(hook: Pick<HookScope, "conversationId" | "label">): string {
  return hook.label?.trim() || `${hook.conversationId.slice(0, 8)}…`;
}

/** A heartbeat older than this means the watcher is gone. */
export const HEARTBEAT_STALE_MS = 90_000;

export function heartbeatIsFresh(hook: Pick<HookScope, "heartbeatAt">, now = Date.now()): boolean {
  if (!hook.heartbeatAt) return false;
  const at = Date.parse(hook.heartbeatAt);
  return Number.isFinite(at) && now - at < HEARTBEAT_STALE_MS;
}

interface HooksFile {
  version: 1;
  hooks: Record<string, Omit<HookScope, "conversationId">>;
}

const emptyFile = (): HooksFile => ({ version: 1, hooks: {} });

function readFile(path: string): HooksFile {
  if (!existsSync(path)) return emptyFile();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as HooksFile;
    if (parsed?.version !== 1 || typeof parsed.hooks !== "object" || !parsed.hooks) {
      return emptyFile();
    }
    return parsed;
  } catch {
    return emptyFile();
  }
}

function writeFileAtomic(path: string, data: HooksFile): void {
  writeJsonAtomic(path, data);
}

/** True when this Grok conversation still exists on disk (resume-able). */
export function grokSessionExists(sessionId: string): boolean {
  const home = process.env.GROK_HOME?.trim() || join(homedir(), ".grok");
  const root = join(home, "sessions");
  if (!existsSync(root)) return false;
  let groups: string[];
  try {
    groups = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return false;
  }
  return groups.some((group) =>
    existsSync(join(root, group, sessionId, "summary.json")),
  );
}

function hookIsLive(id: string, currentId: string, hook: HookScope): boolean {
  if (id === currentId) return true;
  return heartbeatIsFresh(hook) || grokSessionExists(id);
}

function channelConflict(existing: HookScope, hook: HookScope): boolean {
  // Channel ids are unique across servers, so two channel lists overlap or they don't.
  if (existing.channelIds !== null && hook.channelIds !== null) {
    return existing.channelIds.some((id) => hook.channelIds!.includes(id));
  }
  // A whole-server row conflicts with anything in that server.
  const theirs = hookGuildIds(existing);
  return hookGuildIds(hook).some((id) => theirs.includes(id));
}

export function hookAllowsChannel(
  hook: HookScope,
  opts: {
    channelId: string;
    guildId: string | null;
    threadParentId?: string | null;
  },
): boolean {
  if (!opts.guildId || !hookGuildIds(hook).includes(opts.guildId)) return false;
  if (hook.channelIds === null) return true;
  if (hook.channelIds.includes(opts.channelId)) return true;
  if (opts.threadParentId && hook.channelIds.includes(opts.threadParentId)) {
    return true;
  }
  return false;
}

/** Mutable slot so the live buffer filter sees bind/unbind without rewiring. */
export class HookRef {
  constructor(public current: HookScope | null = null) {}
}

export class HookStore {
  constructor(
    private readonly path: string = hooksFilePath,
    private readonly isLive: (
      id: string,
      currentId: string,
      hook: HookScope,
    ) => boolean = hookIsLive,
  ) {}

  load(conversationId: string): HookScope | null {
    const row = readFile(this.path).hooks[conversationId];
    if (!row) return null;
    return { conversationId, ...row };
  }

  save(hook: HookScope): void {
    withLock(this.path, () => this.saveLocked(hook));
  }

  private saveLocked(hook: HookScope): void {
    const data = readFile(this.path);
    for (const [id, row] of Object.entries(data.hooks)) {
      if (id === hook.conversationId) continue;
      const other: HookScope = { conversationId: id, ...row };
      if (!this.isLive(id, hook.conversationId, other)) {
        delete data.hooks[id];
        continue;
      }
      const sharedThread = (hook.threadIds ?? []).find((id) => other.threadIds?.includes(id));
      if (sharedThread) {
        throw new GatewayError(
          `Thread ${sharedThread} is already claimed by ${describeHook(other)}. Release it there first.`,
          409,
        );
      }
      if (isOwner(hook) && isOwner(other) && channelConflict(other, hook)) {
        const where =
          other.channelIds === null
            ? `server ${other.guildName}`
            : `${other.guildName} / ${other.channelNames.join(", ") || other.channelIds.join(", ")}`;
        throw new GatewayError(
          `Already owned by ${describeHook(other)} (${where}). Listen instead, unbind there first, or pick a different channel.`,
          409,
        );
      }
    }
    const { conversationId: id, ...row } = hook;
    data.hooks[id] = row;
    writeFileAtomic(this.path, data);
  }

  /** Every live hook, this conversation's included, without pruning the file. */
  liveHooks(currentId: string): HookScope[] {
    const data = readFile(this.path);
    return Object.entries(data.hooks)
      .map(([id, row]) => ({ conversationId: id, ...row }) as HookScope)
      .filter((hook) => this.isLive(hook.conversationId, currentId, hook));
  }

  /** Changes this conversation's hook and saves it, with the usual conflict checks. */
  update(conversationId: string, change: (hook: HookScope) => HookScope): HookScope {
    return withLock(this.path, () => {
      const current = this.load(conversationId);
      if (!current) throw new GatewayError("This conversation has no hook to change.", 404);
      const next = change(current);
      this.saveLocked(next);
      return next;
    });
  }

  /** Mark this conversation's hook as still watched. False if it was removed. */
  heartbeat(conversationId: string, now = new Date()): boolean {
    return withLock(this.path, () => {
      const data = readFile(this.path);
      const row = data.hooks[conversationId];
      if (!row) return false;
      row.heartbeatAt = now.toISOString();
      writeFileAtomic(this.path, data);
      return true;
    });
  }

  clear(conversationId: string): HookScope | null {
    return withLock(this.path, () => {
      const data = readFile(this.path);
      const row = data.hooks[conversationId];
      if (!row) return null;
      delete data.hooks[conversationId];
      writeFileAtomic(this.path, data);
      return { conversationId, ...row };
    });
  }
}

export const NO_HOOK_MESSAGE =
  "This conversation has no Discord watch hook. Call bind after they ask to watch a server or channel. send_message, get_messages, and get_message do not need a hook; get_recent / get_mentions do.";
