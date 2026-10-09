import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { GatewayError } from "./errors.ts";
import {
  HEARTBEAT_STALE_MS,
  HookStore,
  NO_HOOK_MESSAGE,
  heartbeatIsFresh,
  hookAllowsChannel,
  type HookScope,
} from "./hook.ts";

function scope(over: Partial<HookScope> & Pick<HookScope, "conversationId">): HookScope {
  return {
    guildId: "g1",
    guildName: "Example Guild",
    channelIds: ["c1"],
    channelNames: ["eng"],
    boundAt: "2026-09-10T00:00:00.000Z",
    ...over,
  };
}

describe("NO_HOOK_MESSAGE", () => {
  test("live watch still needs bind; REST history does not", () => {
    expect(NO_HOOK_MESSAGE).toContain("get_recent / get_mentions do");
    expect(NO_HOOK_MESSAGE).toContain("get_messages");
    expect(NO_HOOK_MESSAGE).toContain("do not need a hook");
  });
});

describe("hookAllowsChannel", () => {
  const guild = scope({ conversationId: "s", channelIds: null, channelNames: [] });
  const channel = scope({ conversationId: "s" });

  test("guild hook allows any channel in that guild", () => {
    expect(
      hookAllowsChannel(guild, { channelId: "x", guildId: "g1" }),
    ).toBe(true);
    expect(
      hookAllowsChannel(guild, { channelId: "x", guildId: "other" }),
    ).toBe(false);
  });

  test("channel hook allows the channel and its threads", () => {
    expect(
      hookAllowsChannel(channel, { channelId: "c1", guildId: "g1" }),
    ).toBe(true);
    expect(
      hookAllowsChannel(channel, {
        channelId: "thread",
        guildId: "g1",
        threadParentId: "c1",
      }),
    ).toBe(true);
    expect(
      hookAllowsChannel(channel, { channelId: "c2", guildId: "g1" }),
    ).toBe(false);
  });
});

describe("HookStore", () => {
  test("a row can own channels in several servers; a whole-server row in one of them conflicts", () => {
    const path = join(mkdtempSync(join(tmpdir(), "tsukumo-")), "hooks.json");
    const store = new HookStore(path, () => true);
    const both = scope({
      conversationId: "desk",
      guildName: "Example Guild + Other Guild",
      guilds: [
        { id: "g1", name: "Example Guild" },
        { id: "g2", name: "Other Guild" },
      ],
      channelIds: ["c1", "d1"],
      channelNames: ["eng", "general"],
    });
    store.save(both);
    expect(hookAllowsChannel(both, { channelId: "d1", guildId: "g2" })).toBe(true);
    expect(hookAllowsChannel(both, { channelId: "d1", guildId: "g9" })).toBe(false);

    // Another channel in Other Guild is free to own; the same one or the whole server isn't.
    store.save(scope({ conversationId: "other", guildId: "g2", guildName: "Other Guild", channelIds: ["d2"] }));
    expect(() => store.save(scope({ conversationId: "dup", guildId: "g2", channelIds: ["d1"] }))).toThrow(GatewayError);
    expect(() => store.save(scope({ conversationId: "grok", guildId: "g2", channelIds: null }))).toThrow(GatewayError);
  });

  test("round-trip save/load and exclusive claim", () => {
    const path = join(mkdtempSync(join(tmpdir(), "tsukumo-")), "hooks.json");
    const live = () => true;
    const store = new HookStore(path, live);
    store.save(scope({ conversationId: "sess-a" }));
    expect(store.load("sess-a")?.channelIds).toEqual(["c1"]);

    expect(() => store.save(scope({ conversationId: "sess-b" }))).toThrow(
      GatewayError,
    );

    store.save(
      scope({
        conversationId: "sess-b",
        channelIds: ["c2"],
        channelNames: ["random"],
      }),
    );
    expect(store.load("sess-b")?.channelNames).toEqual(["random"]);

    store.clear("sess-a");
    expect(store.load("sess-a")).toBeNull();
    store.save(scope({ conversationId: "sess-b", channelIds: ["c1"] }));
  });

  test("prunes hooks whose conversations are gone", () => {
    const path = join(mkdtempSync(join(tmpdir(), "tsukumo-")), "hooks.json");
    new HookStore(path, () => true).save(scope({ conversationId: "dead" }));
    const next = new HookStore(path, (id, current) => id === current);
    next.save(scope({ conversationId: "alive" }));
    expect(next.load("dead")).toBeNull();
    expect(next.load("alive")?.channelIds).toEqual(["c1"]);
  });

  test("a fresh heartbeat keeps a non-Grok claim live", () => {
    const path = join(mkdtempSync(join(tmpdir(), "tsukumo-")), "hooks.json");
    const claude = new HookStore(path, () => true);
    claude.save(scope({ conversationId: "claude-sess" }));
    expect(claude.heartbeat("claude-sess")).toBe(true);
    expect(claude.heartbeat("nobody")).toBe(false);

    // Default liveness: no Grok session on disk, so only the heartbeat counts.
    const grok = new HookStore(path);
    expect(() => grok.save(scope({ conversationId: "grok-sess" }))).toThrow(GatewayError);
  });

  test("a stale heartbeat is pruned", () => {
    const path = join(mkdtempSync(join(tmpdir(), "tsukumo-")), "hooks.json");
    const claude = new HookStore(path, () => true);
    claude.save(scope({ conversationId: "claude-sess" }));
    claude.heartbeat("claude-sess", new Date(Date.now() - HEARTBEAT_STALE_MS - 1000));

    const grok = new HookStore(path);
    grok.save(scope({ conversationId: "grok-sess" }));
    expect(grok.load("claude-sess")).toBeNull();
  });
});

describe("heartbeatIsFresh", () => {
  test("missing, stale and fresh", () => {
    const now = Date.parse("2026-10-08T12:00:00.000Z");
    expect(heartbeatIsFresh({}, now)).toBe(false);
    expect(heartbeatIsFresh({ heartbeatAt: "2026-10-08T11:58:00.000Z" }, now)).toBe(false);
    expect(heartbeatIsFresh({ heartbeatAt: "2026-10-08T11:59:30.000Z" }, now)).toBe(true);
  });
});

describe("listeners and threads", () => {
  test("many conversations can listen to an owned channel; a second owner cannot", () => {
    const path = join(mkdtempSync(join(tmpdir(), "tsukumo-")), "hooks.json");
    const store = new HookStore(path, () => true);
    store.save(scope({ conversationId: "owner" }));
    store.save(scope({ conversationId: "l1", role: "listener" }));
    store.save(scope({ conversationId: "l2", role: "listener" }));
    expect(() => store.save(scope({ conversationId: "owner2", role: "owner" }))).toThrow(GatewayError);
    expect(store.liveHooks("owner").map((h) => h.conversationId).sort()).toEqual(["l1", "l2", "owner"]);
  });

  test("a thread has one owner at a time", () => {
    const path = join(mkdtempSync(join(tmpdir(), "tsukumo-")), "hooks.json");
    const store = new HookStore(path, () => true);
    store.save(scope({ conversationId: "a", role: "listener", threadIds: ["t1"] }));
    expect(() => store.save(scope({ conversationId: "b", role: "listener", threadIds: ["t1"] }))).toThrow(GatewayError);
    store.update("a", (h) => ({ ...h, threadIds: [] }));
    store.save(scope({ conversationId: "b", role: "listener", threadIds: ["t1"] }));
    expect(store.load("b")?.threadIds).toEqual(["t1"]);
  });

  test("a listener can take ownership once the owner is gone", () => {
    const path = join(mkdtempSync(join(tmpdir(), "tsukumo-")), "hooks.json");
    const store = new HookStore(path, () => true);
    store.save(scope({ conversationId: "owner" }));
    store.save(scope({ conversationId: "l1", role: "listener" }));
    expect(() => store.update("l1", (h) => ({ ...h, role: "owner" }))).toThrow(GatewayError);
    store.clear("owner");
    store.update("l1", (h) => ({ ...h, role: "owner" }));
    expect(store.load("l1")?.role).toBe("owner");
  });
});

