import { mkdtempSync, utimesSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { pruneTaken, takeMessage } from "./take.ts";

const MSG = "100000000000000009";

describe("takeMessage", () => {
  test("the first conversation wins; the second learns who has it", () => {
    const dir = mkdtempSync(join(tmpdir(), "tsukumo-take-"));
    expect(takeMessage(dir, MSG, "a")).toEqual({ ok: true });
    expect(takeMessage(dir, MSG, "b")).toEqual({ ok: false, takenBy: "a" });
    expect(takeMessage(dir, MSG, "a")).toEqual({ ok: true });
  });

  test("rejects a non-snowflake id instead of writing a path from it", () => {
    const dir = mkdtempSync(join(tmpdir(), "tsukumo-take-"));
    expect(takeMessage(dir, "../escape", "a").ok).toBe(false);
  });

  test("old locks are pruned", () => {
    const dir = mkdtempSync(join(tmpdir(), "tsukumo-take-"));
    takeMessage(dir, MSG, "a");
    const old = (Date.now() - 2 * 86_400_000) / 1000;
    utimesSync(join(dir, MSG), old, old);
    pruneTaken(dir, 86_400_000);
    expect(existsSync(join(dir, MSG))).toBe(false);
  });
});
