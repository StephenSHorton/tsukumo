import { describe, expect, test } from "bun:test";
import { extractPrRefs, prKey, repoAliases, repoFromTopic } from "./refs.ts";

const WEB = "acme/webapp";

// Bun loads .env into tests; these must not depend on the local setup.
delete process.env.TSUKUMO_GITHUB_OWNER;
delete process.env.TSUKUMO_REPO_ALIASES;

describe("extractPrRefs", () => {
  test("URLs, repo#N, aliases and bare #N in order, without repeats", () => {
    const text =
      "APPROVED webapp#1407 (3ff5049c7). See https://github.com/acme/webapp/pull/1407 and WEB#1408, SHOP#498, api-server#143, then #1414.";
    expect(extractPrRefs(text, { defaultRepo: WEB, aliases: repoAliases("web=webapp, shop=acme/storefront") }).map(prKey)).toEqual([
      "pr:acme/webapp#1407",
      "pr:acme/webapp#1408",
      "pr:acme/storefront#498",
      "pr:acme/api-server#143",
      "pr:acme/webapp#1414",
    ]);
  });

  test("bare #N needs the channel's repo; channel and role mentions are not PRs", () => {
    expect(extractPrRefs("REVIEW-PLEASE #492")).toEqual([]);
    expect(extractPrRefs("<#100000000000000001> <@&100000000000000014> hi", { defaultRepo: WEB })).toEqual([]);
    expect(extractPrRefs("REVIEW-PLEASE #492", { defaultRepo: WEB })).toEqual([{ repo: WEB, number: 492 }]);
  });

  test("owner/repo#N, PR#N, code spans and long numbers", () => {
    expect(extractPrRefs("APPROVED acme/webapp#1407").map(prKey)).toEqual(["pr:acme/webapp#1407"]);
    expect(extractPrRefs("PR#1407 and pull#1408", { defaultRepo: WEB }).map(prKey)).toEqual([
      "pr:acme/webapp#1407",
      "pr:acme/webapp#1408",
    ]);
    expect(extractPrRefs("see `#12` and ```\n#13\n``` and order #333333", { defaultRepo: WEB })).toEqual([]);
  });

  test("a channel topic names its repo", () => {
    expect(
      repoFromTopic("This channel is for AI working discussion for the [web app](https://github.com/acme/webapp)."),
    ).toBe(WEB);
    expect(repoFromTopic("repo: https://github.com/acme/webapp.")).toBe(WEB);
    expect(repoFromTopic(null)).toBeUndefined();
  });

  test("a repo without an owner needs one from somewhere", () => {
    expect(extractPrRefs("webapp#12", { aliases: {} })).toEqual([]);
    expect(extractPrRefs("webapp#12", { owner: "acme", aliases: {} }).map(prKey)).toEqual(["pr:acme/webapp#12"]);
  });
});
