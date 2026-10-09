import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { cursorAgentFrom, PrMetaCache } from "./prmeta.ts";

const FOOTER =
  '<div><a href="https://cursor.com/agents/bc-cbeb9c52-0050-5fee-8a64-a1f50b05efaf?cursor_ref=pr_footer&cursor_cta=open_in_web"><picture></picture></a></div>';

describe("PR metadata", () => {
  test("Cursor's PR footer names the agent", () => {
    expect(cursorAgentFrom(`Fixes the thing.\n\n${FOOTER}`)).toBe("https://cursor.com/agents/bc-cbeb9c52-0050-5fee-8a64-a1f50b05efaf");
    expect(cursorAgentFrom("A PR written by a person.")).toBeUndefined();
  });

  test("lookups are cached, and failures are retried later", async () => {
    let now = 0;
    const calls: string[][] = [];
    let fail = true;
    const cache = new PrMetaCache(
      join(mkdtempSync(join(tmpdir(), "tsukumo-prmeta-")), "prmeta.json"),
      async (args) => {
        calls.push(args);
        return fail ? { ok: false, stdout: "" } : { ok: true, stdout: JSON.stringify({ body: FOOTER, author: { login: "octocat" } }) };
      },
      () => now,
    );
    const ref = { repo: "acme/webapp", number: 1434 };
    expect(await cache.get(ref)).toBeNull();
    expect(await cache.get(ref)).toBeNull(); // failure cached briefly
    expect(calls).toHaveLength(1);
    fail = false;
    now += 11 * 60_000;
    expect((await cache.get(ref))?.cursorAgentUrl).toContain("bc-cbeb9c52");
    expect(await cache.get(ref)).toMatchObject({ author: "octocat" });
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(["pr", "view", "1434", "--repo", "acme/webapp", "--json", "body,author"]);
  });
});
