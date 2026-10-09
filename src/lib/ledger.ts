/**
 * The authorship ledger: which Claude session made which thing, so a mention
 * about that thing goes to that session. It outlives sessions on purpose:
 * PR follow-ups arrive hours or days later, and liveness (hook.ts) is a
 * separate question from ownership.
 *
 * Sources:
 * - the mod, as a session acts: Discord messages it posts (`poster`), PRs it
 *   opens (`author`) or reviews (`reviewer`), branches it pushes (`author`);
 * - Claude Code's own `pr-link` rows in session transcripts (`touched`),
 *   written when a session opens, comments on, checks out or pushes to a PR.
 *   The earliest session to touch a PR is almost always the one that opened it.
 */
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { projectRoot } from "../config.ts";
import { withLock, writeJsonAtomic } from "./filelock.ts";

export type LedgerRole = "author" | "poster" | "reviewer" | "touched";

export interface LedgerEntry {
  /** `msg:<discord id>`, `pr:<owner/repo>#<n>` (lowercase), `branch:<owner/repo>:<name>` */
  key: string;
  sessionId: string;
  role: LedgerRole;
  at: string;
  /** How the session appears to others: "api work", or folder · short id. */
  label?: string;
  source: "mod" | "pr-link";
}

interface LedgerFile {
  version: 1;
  entries: LedgerEntry[];
  /** Bytes of each transcript already scanned for pr-link rows. */
  scanned: Record<string, number>;
}

export const ledgerPath = join(projectRoot, ".ledger.json");
/** Entries older than this are dropped; follow-ups past it go to the front desk. */
const KEEP_MS = 45 * 86_400_000;
/** Who owns a key, best first: who made it, then who reviewed it, then who merely touched it. */
const ROLE_RANK: Record<LedgerRole, number> = { author: 0, poster: 0, reviewer: 2, touched: 1 };

const empty = (): LedgerFile => ({ version: 1, entries: [], scanned: {} });

function read(path: string): LedgerFile {
  if (!existsSync(path)) return empty();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as LedgerFile;
    return parsed?.version === 1 && Array.isArray(parsed.entries) ? { ...parsed, scanned: parsed.scanned ?? {} } : empty();
  } catch {
    return empty();
  }
}

export class Ledger {
  constructor(private readonly path: string = ledgerPath) {}

  /** Adds entries; a key/session/role already recorded keeps its earliest time. */
  record(entries: Array<Omit<LedgerEntry, "at"> & { at?: string }>, now = new Date()): void {
    if (entries.length === 0) return;
    withLock(this.path, () => {
      const data = read(this.path);
      this.merge(data, entries, now);
      writeJsonAtomic(this.path, data);
    });
  }

  private merge(data: LedgerFile, entries: Array<Omit<LedgerEntry, "at"> & { at?: string }>, now: Date): void {
    const at = now.toISOString();
    const index = new Map(data.entries.map((e, i) => [`${e.key}\u0000${e.sessionId}\u0000${e.role}`, i]));
    for (const entry of entries) {
      const id = `${entry.key}\u0000${entry.sessionId}\u0000${entry.role}`;
      const existing = index.get(id);
      const next: LedgerEntry = { ...entry, at: entry.at ?? at };
      if (existing === undefined) {
        index.set(id, data.entries.length);
        data.entries.push(next);
      } else {
        const old = data.entries[existing]!;
        data.entries[existing] = {
          ...old,
          at: old.at < next.at ? old.at : next.at,
          label: next.label ?? old.label,
          source: old.source === "mod" ? "mod" : next.source,
        };
      }
    }
    const cutoff = new Date(now.getTime() - KEEP_MS).toISOString();
    data.entries = data.entries.filter((e) => e.at >= cutoff);
  }

  /** Who owns `key`, best first (role, then earliest). */
  owners(key: string): LedgerEntry[] {
    return read(this.path)
      .entries.filter((e) => e.key === key)
      .sort((a, b) => ROLE_RANK[a.role] - ROLE_RANK[b.role] || a.at.localeCompare(b.at));
  }

  /**
   * Reads new `pr-link` rows from Claude Code session transcripts
   * (`<projectsDir>/<project>/<session>.jsonl`), only the bytes added since
   * the last scan. Returns how many rows it recorded.
   */
  syncPrLinks(projectsDir = join(homedir(), ".claude", "projects"), now = new Date()): number {
    return withLock(this.path, () => {
      const data = read(this.path);
      const found: Array<Omit<LedgerEntry, "at"> & { at?: string }> = [];
      for (const file of transcriptFiles(projectsDir)) {
        let size: number;
        try {
          size = statSync(file).size;
        } catch {
          continue;
        }
        const from = data.scanned[file] ?? 0;
        if (size <= from) {
          if (size < from) data.scanned[file] = 0; // rewritten; start over next time
          continue;
        }
        const { text, end } = readNewLines(file, from, size);
        data.scanned[file] = end;
        if (!text.includes('"pr-link"')) continue;
        for (const line of text.split("\n")) {
          if (!line.includes('"type":"pr-link"')) continue;
          try {
            const row = JSON.parse(line) as { sessionId?: string; prNumber?: number; prRepository?: string; timestamp?: string };
            if (!row.sessionId || !row.prNumber || !row.prRepository) continue;
            found.push({
              key: `pr:${row.prRepository.toLowerCase()}#${row.prNumber}`,
              sessionId: row.sessionId,
              role: "touched",
              at: row.timestamp,
              label: labelFor(file, row.sessionId),
              source: "pr-link",
            });
          } catch {
            // A partial or foreign line.
          }
        }
      }
      this.merge(data, found, now);
      writeJsonAtomic(this.path, data);
      return found.length;
    });
  }
}

function transcriptFiles(projectsDir: string): string[] {
  let projects: string[];
  try {
    projects = readdirSync(projectsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
  return projects.flatMap((project) => {
    try {
      return readdirSync(join(projectsDir, project))
        .filter((name) => name.endsWith(".jsonl"))
        .map((name) => join(projectsDir, project, name));
    } catch {
      return [];
    }
  });
}

/** Bytes [from, size) up to the last newline, so a line being written is read next time. */
function readNewLines(file: string, from: number, size: number): { text: string; end: number } {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(size - from);
    readSync(fd, buf, 0, buf.length, from);
    const lastNewline = buf.lastIndexOf(0x0a);
    if (lastNewline < 0) return { text: "", end: from };
    return { text: buf.subarray(0, lastNewline).toString("utf8"), end: from + lastNewline + 1 };
  } finally {
    closeSync(fd);
  }
}

/** "development-webapp · ac2b9a60" from a transcript path. */
function labelFor(file: string, sessionId: string): string {
  const project = basename(dirname(file)).replace(/^-Users-[^-]+-?/, "") || "home";
  return `${project} · ${sessionId.slice(0, 8)}`;
}
