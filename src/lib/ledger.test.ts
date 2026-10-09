import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { Ledger } from "./ledger.ts";

const PR = "pr:acme/webapp#1437";

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "tsukumo-ledger-"));
  return { dir, ledger: new Ledger(join(dir, "ledger.json")) };
}

describe("Ledger", () => {
  test("owners rank who made a thing over who touched or reviewed it, then earliest", () => {
    const { ledger } = fresh();
    ledger.record([
      { key: PR, sessionId: "reviewer", role: "reviewer", source: "mod", at: "2026-10-09T10:00:00.000Z" },
      { key: PR, sessionId: "late-toucher", role: "touched", source: "pr-link", at: "2026-10-09T12:00:00.000Z" },
      { key: PR, sessionId: "early-toucher", role: "touched", source: "pr-link", at: "2026-10-09T11:00:00.000Z" },
    ], new Date("2026-10-09T13:00:00.000Z"));
    expect(ledger.owners(PR).map((e) => e.sessionId)).toEqual(["early-toucher", "late-toucher", "reviewer"]);
    ledger.record([{ key: PR, sessionId: "creator", role: "author", source: "mod", at: "2026-10-09T12:30:00.000Z" }], new Date("2026-10-09T13:00:00.000Z"));
    expect(ledger.owners(PR)[0]?.sessionId).toBe("creator");
  });

  test("recording the same thing again keeps the earliest time", () => {
    const { ledger } = fresh();
    const now = new Date("2026-10-09T13:00:00.000Z");
    ledger.record([{ key: "msg:1", sessionId: "s", role: "poster", source: "mod", at: "2026-10-09T12:00:00.000Z" }], now);
    ledger.record([{ key: "msg:1", sessionId: "s", role: "poster", source: "mod", at: "2026-10-09T12:05:00.000Z", label: "api work" }], now);
    expect(ledger.owners("msg:1")).toEqual([
      { key: "msg:1", sessionId: "s", role: "poster", source: "mod", at: "2026-10-09T12:00:00.000Z", label: "api work" },
    ]);
  });

  test("pr-link rows are read from transcripts, only what's new, and a half-written line waits", () => {
    const { dir, ledger } = fresh();
    const project = join(dir, "projects", "-Users-sam-development-webapp");
    mkdirSync(project, { recursive: true });
    const file = join(project, "ac2b9a60-9bb0.jsonl");
    const row = (n: number, at: string) =>
      JSON.stringify({ type: "pr-link", sessionId: "ac2b9a60-9bb0", prNumber: n, prRepository: "acme/webapp", timestamp: at });
    writeFileSync(file, `${JSON.stringify({ type: "user", text: "pr-link mentioned in passing" })}\n${row(1437, "2026-10-09T16:06:35.281Z")}\n`);
    const now = new Date("2026-10-09T17:00:00.000Z");
    expect(ledger.syncPrLinks(join(dir, "projects"), now)).toBe(1);
    expect(ledger.owners(PR)[0]).toMatchObject({ sessionId: "ac2b9a60-9bb0", role: "touched", label: "development-webapp · ac2b9a60" });
    appendFileSync(file, row(1438, "2026-10-09T16:10:00.000Z").slice(0, 40)); // still being written
    expect(ledger.syncPrLinks(join(dir, "projects"), now)).toBe(0);
    appendFileSync(file, `${row(1438, "2026-10-09T16:10:00.000Z").slice(40)}\n`);
    expect(ledger.syncPrLinks(join(dir, "projects"), now)).toBe(1);
    expect(ledger.owners("pr:acme/webapp#1438")).toHaveLength(1);
  });

  test("entries older than 45 days are dropped", () => {
    const { ledger } = fresh();
    ledger.record([{ key: "msg:old", sessionId: "s", role: "poster", source: "mod", at: "2026-08-01T00:00:00.000Z" }], new Date("2026-10-09T00:00:00.000Z"));
    expect(ledger.owners("msg:old")).toEqual([]);
  });
});
