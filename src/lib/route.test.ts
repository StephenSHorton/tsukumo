import { describe, expect, test } from "bun:test";
import type { HookScope } from "./hook.ts";
import type { LedgerEntry } from "./ledger.ts";
import { routeMention, type OwnerLookup } from "./route.ts";

const CHANNEL = "100000000000000001";
const OTHER_CHANNEL = "100000000000000005";
const THREAD = "100000000000000015";
const WEB = "acme/webapp";

function hook(over: Partial<HookScope> & Pick<HookScope, "conversationId">): HookScope {
  return {
    guildId: "g1",
    guildName: "Example Guild",
    channelIds: [CHANNEL],
    channelNames: ["managed"],
    boundAt: "2026-10-08T22:00:00.000Z",
    routing: 2,
    ...over,
  };
}

function ledger(entries: Array<Partial<LedgerEntry> & Pick<LedgerEntry, "key" | "sessionId">>): OwnerLookup {
  const full = entries.map((e) => ({ role: "author" as const, at: "2026-10-09T00:00:00.000Z", source: "mod" as const, ...e }));
  return { owners: (key) => full.filter((e) => e.key === key) };
}

const msg = (content: string, extra: object = {}) => ({ channelId: CHANNEL, guildId: "g1", content, ...extra });
const to = (r: { to: HookScope | null }) => r.to?.conversationId ?? null;

describe("routeMention", () => {
  const desk = hook({ conversationId: "desk", role: "owner" });
  const api = hook({ conversationId: "api", role: "listener", label: "api work" });

  test("with nothing to go on, the front desk answers; listeners never do", () => {
    const route = routeMention([api, desk], msg("hey, are you there?"));
    expect(to(route)).toBe("desk");
    expect(route.reason).toContain("front desk");
  });

  test("a reply to a session's own post goes to that session", () => {
    const route = routeMention([desk, api], msg("thanks!", { replyToId: "900" }), ledger([{ key: "msg:900", sessionId: "api", role: "poster" }]));
    expect(to(route)).toBe("api");
    expect(route.reason).toContain("reply");
  });

  test("a verdict on a PR goes to the session that opened it, wherever it's mentioned", () => {
    const owners = ledger([{ key: "pr:acme/webapp#1437", sessionId: "api", role: "touched" }]);
    expect(to(routeMention([desk, api], msg("CHANGES on acme/webapp#1437 (98b5cb9cf)"), owners))).toBe("api");
    // A bare #N means the channel's own repo.
    expect(to(routeMention([desk, api], msg("APPROVED #1437"), owners, { defaultRepo: WEB }))).toBe("api");
    // Not one of ours: front desk.
    expect(to(routeMention([desk, api], msg("APPROVED #1500"), owners, { defaultRepo: WEB }))).toBe("desk");
  });

  test("an owner that isn't watching this channel loses it to the front desk, which is told whose it was", () => {
    const elsewhere = hook({ conversationId: "api", role: "owner", channelIds: [OTHER_CHANNEL], label: "api work" });
    const owners = ledger([{ key: "pr:acme/webapp#1437", sessionId: "api", label: "api work" }]);
    const route = routeMention([desk, elsewhere], msg("CHANGES on acme/webapp#1437"), owners);
    expect(to(route)).toBe("desk");
    expect(route.reason).toContain("api work isn't watching here");
  });

  test("a closed or archived owner (no live hook) also falls to the front desk", () => {
    const owners = ledger([{ key: "msg:900", sessionId: "gone", role: "poster", label: "old chat" }]);
    const route = routeMention([desk], msg("follow-up", { replyToId: "900" }), owners);
    expect(to(route)).toBe("desk");
    expect(route.reason).toContain("old chat");
  });

  test("a claimed thread goes to its claimant ahead of the front desk", () => {
    const worker = hook({ conversationId: "worker", role: "listener", threadIds: [THREAD] });
    expect(to(routeMention([desk, worker], { channelId: THREAD, guildId: "g1", threadParentId: CHANNEL, content: "status?" }))).toBe("worker");
  });

  test("the first PR named that has an owner decides", () => {
    const owners = ledger([{ key: "pr:acme/webapp#1438", sessionId: "api" }]);
    expect(to(routeMention([desk, api], msg("re #1500 and #1438"), owners, { defaultRepo: WEB }))).toBe("api");
  });

  test("no front desk and no owner: held, and every watcher agrees", () => {
    const route = routeMention([api], msg("new work for anyone"));
    expect(route.to).toBeNull();
    expect(route.reason).toContain("held");
  });

  test("if two rows both claim the front desk, the earliest wins everywhere", () => {
    const late = hook({ conversationId: "late", boundAt: "2026-10-08T23:00:00.000Z" });
    const early = hook({ conversationId: "early", boundAt: "2026-10-08T21:00:00.000Z" });
    expect(to(routeMention([late, early], msg("hi")))).toBe("early");
  });

  test("a session on older watcher code is never sent a mention by the ledger", () => {
    const old = hook({ conversationId: "api", role: "listener", routing: undefined });
    const owners = ledger([{ key: "pr:acme/webapp#1437", sessionId: "api" }]);
    const route = routeMention([desk, old], msg("CHANGES on acme/webapp#1437"), owners);
    expect(to(route)).toBe("desk");
  });

  test("with an older (or Grok) front desk, everyone falls back to the old rules so nobody double-answers", () => {
    const oldDesk = hook({ conversationId: "grok", role: "owner", routing: undefined });
    const owners = ledger([{ key: "pr:acme/webapp#1437", sessionId: "api" }]);
    expect(to(routeMention([oldDesk, api], msg("CHANGES on acme/webapp#1437"), owners))).toBe("grok");
  });
});
