/**
 * What GitHub says about a PR nobody in the ledger owns: today, whether a
 * Cursor cloud agent opened it. Those PRs' review verdicts arrive on Discord
 * addressed to Tsukumo, but the code change belongs to that agent, so the
 * front desk gets a specific brief instead of a generic "no owner".
 *
 * Looked up with the `gh` CLI (your GitHub login), cached on disk.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { projectRoot } from "../config.ts";
import { withLock, writeJsonAtomic } from "./filelock.ts";
import { prKey, type PrRef } from "./refs.ts";

export interface PrMeta {
  /** The Cursor agent's page, when a Cursor cloud agent opened the PR. */
  cursorAgentUrl?: string;
  author?: string;
  fetchedAt: number;
}

const HIT_TTL_MS = 24 * 3_600_000;
const MISS_TTL_MS = 10 * 60_000;

/** The `cursor.com/agents/bc-…` link Cursor puts in the footer of PRs its cloud agents open. */
export function cursorAgentFrom(body: string): string | undefined {
  const m = body.match(/https?:\/\/(?:www\.)?cursor\.com\/agents\/(bc-[\w-]+)/);
  return m ? `https://cursor.com/agents/${m[1]}` : undefined;
}

export type Runner = (args: string[]) => Promise<{ ok: boolean; stdout: string }>;

/** `gh`, from Homebrew's usual path if PATH (a desktop app's) lacks it. */
export const ghRunner: Runner = async (args) => {
  const gh = ["/opt/homebrew/bin/gh", "/usr/local/bin/gh"].find((p) => existsSync(p)) ?? "gh";
  try {
    const proc = Bun.spawn([gh, ...args], { stdout: "pipe", stderr: "ignore" });
    const timer = setTimeout(() => proc.kill(), 10_000);
    const stdout = await new Response(proc.stdout).text();
    const code = await proc.exited;
    clearTimeout(timer);
    return { ok: code === 0, stdout };
  } catch {
    return { ok: false, stdout: "" };
  }
};

export class PrMetaCache {
  constructor(
    private readonly path: string = join(projectRoot, ".watch", "prmeta.json"),
    private readonly run: Runner = ghRunner,
    private readonly now: () => number = Date.now,
  ) {}

  private read(): Record<string, PrMeta & { miss?: boolean }> {
    try {
      return existsSync(this.path) ? JSON.parse(readFileSync(this.path, "utf8")) : {};
    } catch {
      return {};
    }
  }

  async get(ref: PrRef): Promise<PrMeta | null> {
    const key = prKey(ref);
    const cached = this.read()[key];
    if (cached && this.now() - cached.fetchedAt < (cached.miss ? MISS_TTL_MS : HIT_TTL_MS)) return cached.miss ? null : cached;
    const res = await this.run(["pr", "view", String(ref.number), "--repo", ref.repo, "--json", "body,author"]);
    let meta: (PrMeta & { miss?: boolean }) | null = null;
    if (res.ok) {
      try {
        const pr = JSON.parse(res.stdout) as { body?: string; author?: { login?: string } };
        meta = { cursorAgentUrl: cursorAgentFrom(pr.body ?? ""), author: pr.author?.login, fetchedAt: this.now() };
      } catch {
        meta = null;
      }
    }
    const entry = meta ?? { fetchedAt: this.now(), miss: true };
    try {
      withLock(this.path, () => {
        const all = this.read();
        all[key] = entry;
        writeJsonAtomic(this.path, all);
      });
    } catch {
      // A cache write that loses a race costs one more lookup later.
    }
    return meta;
  }
}
