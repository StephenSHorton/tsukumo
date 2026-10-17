import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { HookStore } from "../lib/hook.ts";
import type { LedgerEntry } from "../lib/ledger.ts";
import type { GatewayMessage } from "../lib/types.ts";
import { DIRECT_LIMIT, DIRECT_WINDOW_MS, REATTACH_GRACE_MS, RouterCore, type CoreDeps, type RouterEvent, type Sink } from "./core.ts";

const BOT = "100000000000000007";
const MANAGED = "100000000000000001";
const ALICE = "100000000000000008";
const ACME = { id: "g1", name: "Example Guild" };
const OTHER = { id: "g2", name: "Other Guild" };
const OTHER_GENERAL = "100000000000000020";

function setup(ledgerEntries: Array<Pick<LedgerEntry, "key" | "sessionId"> & Partial<LedgerEntry>> = [], extra: Partial<CoreDeps> = {}) {
  const root = mkdtempSync(join(tmpdir(), "tsukumo-router-"));
  let now = Date.parse("2026-10-09T18:00:00.000Z");
  const store = new HookStore(join(root, "hooks.json"), (id, current, hook) => id === current || (!!hook.heartbeatAt && now - Date.parse(hook.heartbeatAt) < 90_000));
  const entries = ledgerEntries.map((e) => ({ role: "author" as const, at: "2026-10-09T00:00:00.000Z", source: "mod" as const, ...e }));
  const fetched: GatewayMessage[] = [];
  const core = new RouterCore({
    store,
    ledger: { owners: (key) => entries.filter((e) => e.key === key) },
    dirs: Object.fromEntries(["taken", "done", "pending", "held", "rerouted", "flagged", "seen", "deferred"].map((d) => [d, join(root, d)])) as never,
    now: () => now,
    botId: () => BOT,
    channelName: (id) => (id === MANAGED ? "managed" : id === OTHER_GENERAL ? "general" : id),
    parentOf: () => null,
    repoOf: (id) => (id === MANAGED ? "acme/webapp" : undefined),
    fetchMessage: async (_c, id) => fetched.find((m) => m.id === id) ?? null,
    ...extra,
  });
  const sinks: Record<string, RouterEvent[]> = {};
  const sink = (name: string): Sink => {
    sinks[name] = [];
    return { send: (e) => sinks[name]!.push(e) };
  };
  const attach = (sessionId: string, label: string, s: Sink) =>
    core.attach({ sessionId, label, channelIds: [MANAGED], channelNames: ["managed"], channelGuilds: [ACME], sink: s });
  const advance = (ms: number) => {
    now += ms;
  };
  /** A chat watching #managed (Example Guild) and #general (Other Guild) at once. */
  const attachBoth = (sessionId: string, label: string, s: Sink) =>
    core.attach({ sessionId, label, channelIds: [MANAGED, OTHER_GENERAL], channelNames: ["managed", "general"], channelGuilds: [ACME, OTHER], sink: s });
  return { core, store, sinks, sink, attach, attachBoth, advance, fetched, now: () => now };
}

let n = 0;
function mention(content: string, extra: Partial<GatewayMessage> = {}): GatewayMessage {
  n++;
  return {
    id: `15570000000000${String(n).padStart(5, "0")}`,
    content: `<@${BOT}> ${content}`,
    authorId: ALICE,
    authorTag: "alice",
    authorUsername: "alice",
    authorBot: false,
    channelId: MANAGED,
    guildId: "g1",
    threadParentId: null,
    mentionsBot: true,
    replyToId: null,
    createdAt: "2026-10-09T17:59:00.000Z",
    attachments: [],
    ...extra,
  };
}
const mentions = (events: RouterEvent[] | undefined) => (events ?? []).filter((e) => e.type === "mention") as Extract<RouterEvent, { type: "mention" }>[];

describe("RouterCore", () => {
  test("the first chat is the front desk, the second listens; a mention about B's PR wakes B only", async () => {
    const { core, sinks, sink, attach } = setup([{ key: "pr:acme/webapp#1437", sessionId: "b" }]);
    attach("a", "desk", sink("a"));
    attach("b", "api work", sink("b"));
    expect(sinks.a!.find((e) => e.type === "claims")).toMatchObject({ role: "owner" });
    expect(sinks.b!.find((e) => e.type === "claims")).toMatchObject({ role: "listener", owner: "desk" });

    await core.onMessage(mention("CHANGES on #1437"));
    expect(mentions(sinks.b).map((e) => e.route)).toEqual(["mine"]);
    expect(mentions(sinks.b)[0]?.reason).toContain("webapp#1437");
    expect(mentions(sinks.a).map((e) => [e.route, e.routedTo])).toEqual([["other", "api work"]]);

    await core.onMessage(mention("anyone around?"));
    expect(mentions(sinks.a).at(-1)).toMatchObject({ route: "mine", reason: "no chat owns this; front desk" });
  });

  test("a chat reloading keeps its claim and gets what arrived meanwhile", async () => {
    const { core, sinks, sink, attach } = setup([{ key: "pr:acme/webapp#1437", sessionId: "b" }]);
    attach("a", "desk", sink("a"));
    const first = sink("b1");
    attach("b", "api work", first);
    core.detach("b", first);
    await core.onMessage(mention("APPROVED #1437"));
    expect(mentions(sinks.b1)).toEqual([]);
    attach("b", "api work", sink("b2"));
    expect(mentions(sinks.b2).map((e) => e.route)).toEqual(["mine"]);
  });

  test("a chat that doesn't come back loses its claim, and the front desk takes back its mention", async () => {
    const { core, sinks, sink, attach, advance, fetched, store } = setup([{ key: "pr:acme/webapp#1437", sessionId: "b" }]);
    attach("a", "desk", sink("a"));
    const s = sink("b");
    attach("b", "api work", s);
    const m = mention("APPROVED #1437");
    fetched.push(m);
    await core.onMessage(m); // b takes it, then goes away without answering
    core.detach("b", s);
    advance(REATTACH_GRACE_MS + 1_000);
    core.tick();
    expect(store.load("b")).toBeNull();
    advance(4 * 60_000);
    core.tick();
    await core.sweep();
    expect(mentions(sinks.a).at(-1)).toMatchObject({ route: "mine", message: { id: m.id } });
    expect(mentions(sinks.a).at(-1)?.reason).toContain("went away before answering");
  });

  test("a Tsukumo reply marks a mention answered, so the sweeper leaves it and catch-up skips it", async () => {
    const { core, sinks, sink, attach, advance } = setup();
    attach("a", "desk", sink("a"));
    const m = mention("ping");
    await core.onMessage(m);
    await core.onMessage({ ...mention("pong"), authorId: BOT, authorBot: true, mentionsBot: false, replyToId: m.id, content: "**Claude**\npong" });
    advance(20 * 60_000);
    core.tick();
    await core.sweep();
    expect(sinks.a!.filter((e) => e.type === "overdue")).toEqual([]);
    await core.catchUp([m]);
    expect(mentions(sinks.a)).toHaveLength(1);
  });

  test("a lone front desk that hasn't started on new work after 10 minutes is reminded once (nobody to hand it to)", async () => {
    const { core, sinks, sink, attach, advance } = setup();
    attach("a", "desk", sink("a"));
    await core.onMessage(mention("ping"));
    advance(11 * 60_000);
    core.tick();
    await core.sweep();
    await core.sweep();
    expect(sinks.a!.filter((e) => e.type === "overdue")).toHaveLength(1);
  });

  test("mentions missed while the router was down are routed on catch-up", async () => {
    const { core, sinks, sink, attach } = setup();
    attach("a", "desk", sink("a"));
    await core.catchUp([mention("are you there?")]);
    expect(mentions(sinks.a)[0]).toMatchObject({ route: "mine" });
    expect(mentions(sinks.a)[0]?.reason).toContain("missed while no chat was watching");
  });

  test("controls: listen and own, take conflicts, holds", async () => {
    const { core, sinks, sink, attach } = setup();
    attach("a", "desk", sink("a"));
    attach("b", "api work", sink("b"));
    expect(core.control("b", "own", {})).toMatchObject({ ok: false, status: 409 });
    expect(core.control("a", "listen", {})).toEqual({ ok: true });
    expect(core.control("b", "own", {})).toEqual({ ok: true });
    expect(sinks.b!.filter((e) => e.type === "claims").at(-1)).toMatchObject({ role: "owner" });
    expect(core.control("a", "take", { messageId: "1557000000000099999", channelId: MANAGED })).toEqual({ ok: true });
    expect(core.control("b", "take", { messageId: "1557000000000099999", channelId: MANAGED })).toMatchObject({ ok: false, status: 409 });
    expect(core.control("b", "hold", { messageId: "1557000000000099999" })).toEqual({ ok: true });
    expect(core.control("zzz", "own", {})).toMatchObject({ ok: false, status: 404 });
  });

  test("an explicit stop hands the front desk to the next chat at once", async () => {
    const { core, sinks, sink, attach, store } = setup();
    attach("a", "desk", sink("a"));
    attach("b", "api work", sink("b"));
    expect(core.control("a", "release", {})).toEqual({ ok: true });
    expect(store.load("a")).toBeNull();
    expect(store.load("b")?.role).toBe("owner");
    expect(sinks.b!.filter((e) => e.type === "claims").at(-1)).toMatchObject({ role: "owner" });
    await core.onMessage(mention("anyone?"));
    expect(mentions(sinks.b).at(-1)).toMatchObject({ route: "mine" });
  });

  test("a mention seen live and again in catch-up wakes its chat once", async () => {
    const { core, sinks, sink, attach } = setup();
    attach("a", "desk", sink("a"));
    const m = mention("ping");
    await core.onMessage(m);
    await core.catchUp([m]);
    await core.onMessage(m);
    expect(mentions(sinks.a)).toHaveLength(1);
  });

  test("mentions queued for a chat that never came back are routed again when its grace ends", async () => {
    const { core, sinks, sink, attach, advance } = setup([{ key: "pr:acme/webapp#1437", sessionId: "b" }]);
    attach("a", "desk", sink("a"));
    const s = sink("b");
    attach("b", "api work", s);
    core.detach("b", s);
    await core.onMessage(mention("APPROVED #1437"));
    advance(REATTACH_GRACE_MS + 1_000);
    core.tick();
    await Bun.sleep(5);
    expect(mentions(sinks.a).at(-1)).toMatchObject({ route: "mine" });
    expect(mentions(sinks.a).at(-1)?.reason).toContain("its chat left before answering");
  });

  test("a chat's role and thread claims survive a router restart", () => {
    const first = setup();
    first.attach("a", "desk", first.sink("a"));
    first.attach("b", "api work", first.sink("b"));
    first.core.control("a", "listen", {});
    first.core.control("b", "own", {});
    first.store.update("a", (h) => ({ ...h, threadIds: ["100000000000000003"] }));
    // A new router process over the same claims file (rows still heartbeated).
    const second = new RouterCore({ ...(first.core as unknown as { deps: ConstructorParameters<typeof RouterCore>[0] }).deps });
    second.attach({ sessionId: "a", label: "desk", channelIds: [MANAGED], channelNames: ["managed"], channelGuilds: [ACME], sink: first.sink("a2") });
    expect(first.store.load("a")).toMatchObject({ role: "listener", threadIds: ["100000000000000003"] });
  });

  test("a chat whose claim someone removed is told and its stream closed", () => {
    const { core, sinks, sink, attach, store } = setup();
    let closed = false;
    attach("a", "desk", { ...sink("a"), close: () => (closed = true) });
    store.clear("a");
    core.tick();
    expect(sinks.a!.at(-1)).toMatchObject({ type: "error", fatal: true });
    expect(closed).toBe(true);
  });

  test("a front desk that doesn't start on new work for 10 minutes hands it, and the role, to the next chat", async () => {
    const { core, sinks, sink, attach, advance, fetched, store } = setup();
    attach("a", "desk", sink("a"));
    attach("b", "api work", sink("b"));
    const m = mention("can someone review AP#1500?");
    fetched.push(m);
    await core.onMessage(m); // front-desk work, delivered to a, never started
    advance(11 * 60_000);
    core.tick();
    await core.sweep();
    expect(store.load("a")?.role).toBe("listener");
    expect(store.load("b")?.role).toBe("owner");
    expect(sinks.a!.find((e) => e.type === "handoff")).toMatchObject({ messageId: m.id, to: "api work" });
    expect(mentions(sinks.b).at(-1)).toMatchObject({ route: "mine", message: { id: m.id } });
    expect(mentions(sinks.b).at(-1)?.reason).toContain("hadn't started on it after 11 min");
    // The chat it left is told, and can look up where it went before replying.
    expect(sinks.a!.find((e) => e.type === "moved")).toMatchObject({ messageId: m.id, to: "api work" });
    expect(core.control("a", "holder", { messageId: m.id })).toMatchObject({ ok: true, holder: "b", label: "api work", mine: false });
    expect(core.control("b", "holder", { messageId: m.id })).toMatchObject({ holder: "b", mine: true });
  });

  test("only the holder's own turn counts as started on it", async () => {
    const { core, sink, attach, advance, store } = setup();
    attach("a", "desk", sink("a"));
    attach("b", "api work", sink("b"));
    const m = mention("can someone review AP#1500?");
    await core.onMessage(m);
    core.control("b", "seen", { messageId: m.id });
    advance(11 * 60_000);
    core.tick();
    await core.sweep();
    expect(store.load("b")?.role).toBe("owner");
  });

  test("a mention a person handed to a chat stays with it", async () => {
    const { core, sinks, sink, attach, advance } = setup();
    attach("a", "desk", sink("a"));
    attach("b", "api work", sink("b"));
    expect(core.control("b", "take", { messageId: "1557000000000088888", channelId: MANAGED })).toEqual({ ok: true });
    advance(30 * 60_000);
    core.tick();
    await core.sweep();
    expect(core.control("b", "holder", { messageId: "1557000000000088888" })).toMatchObject({ mine: true });
    expect(sinks.b!.filter((e) => e.type === "moved")).toEqual([]);
  });

  test("a front desk that started on it keeps it, however long it takes", async () => {
    const { core, sinks, sink, attach, advance, store } = setup();
    attach("a", "desk", sink("a"));
    attach("b", "api work", sink("b"));
    const m = mention("can someone review AP#1500?");
    await core.onMessage(m);
    expect(core.control("a", "seen", { messageId: m.id })).toEqual({ ok: true });
    advance(30 * 60_000);
    core.tick();
    await core.sweep();
    expect(store.load("a")?.role).toBe("owner");
    expect(sinks.a!.filter((e) => e.type === "handoff" || e.type === "overdue")).toEqual([]);
  });

  test("a verdict on a busy chat's own PR waits for it; only after an hour does it get a reminder", async () => {
    const { core, sinks, sink, attach, advance } = setup([{ key: "pr:acme/webapp#1437", sessionId: "b" }]);
    attach("a", "desk", sink("a"));
    attach("b", "api work", sink("b"));
    await core.onMessage(mention("CHANGES on #1437"));
    advance(30 * 60_000);
    core.tick();
    await core.sweep();
    expect(mentions(sinks.a).filter((e) => e.route === "mine")).toEqual([]);
    expect(sinks.b!.filter((e) => e.type === "overdue")).toEqual([]);
    advance(31 * 60_000);
    core.tick();
    await core.sweep();
    expect(sinks.b!.filter((e) => e.type === "overdue")).toHaveLength(1);
    expect(mentions(sinks.a).filter((e) => e.route === "mine")).toEqual([]);
  });

  test("only the chat holding a mention can defer it, and the sweeper honors it", async () => {
    const { core, sinks, sink, attach, advance } = setup();
    attach("a", "desk", sink("a"));
    attach("b", "api work", sink("b"));
    const m = mention("anyone?");
    await core.onMessage(m);
    expect(core.control("b", "defer", { messageId: m.id, untilMs: Date.parse("2026-10-09T19:00:00.000Z") } as never)).toMatchObject({ ok: false, status: 409 });
    expect(core.control("a", "defer", { messageId: m.id, untilMs: Date.parse("2026-10-09T17:00:00.000Z") } as never)).toMatchObject({ ok: false, status: 400 });
    expect(core.control("a", "defer", { messageId: m.id, untilMs: Date.parse("2026-10-09T18:45:00.000Z"), note: "waiting on CI" } as never)).toEqual({ ok: true });
    advance(30 * 60_000);
    core.tick();
    await core.sweep();
    expect(sinks.a!.filter((e) => e.type === "handoff" || e.type === "overdue")).toEqual([]);
    advance(20 * 60_000);
    core.tick();
    await core.sweep();
    expect(sinks.a!.filter((e) => e.type === "overdue")).toHaveLength(1);
    // Deferring again earns its own reminder when that passes too.
    expect(core.control("a", "defer", { messageId: m.id, untilMs: Date.parse("2026-10-09T19:30:00.000Z") } as never)).toEqual({ ok: true });
    advance(30 * 60_000);
    core.tick();
    await core.sweep();
    expect(sinks.a!.filter((e) => e.type === "overdue")).toHaveLength(1);
    advance(15 * 60_000);
    core.tick();
    await core.sweep();
    expect(sinks.a!.filter((e) => e.type === "overdue")).toHaveLength(2);
  });

  test("only the chat holding a mention can skip it, and a skipped mention is never moved or reminded", async () => {
    const { core, sinks, sink, attach, advance } = setup();
    attach("a", "desk", sink("a"));
    attach("b", "api work", sink("b"));
    const m = mention("👍");
    await core.onMessage(m);
    expect(core.control("b", "skip", { messageId: m.id } as never)).toMatchObject({ ok: false, status: 409 });
    expect(core.control("a", "skip", { messageId: m.id } as never)).toEqual({ ok: true });
    advance(2 * 60 * 60_000);
    core.tick();
    await core.sweep();
    expect(sinks.a!.filter((e) => e.type === "handoff" || e.type === "overdue" || e.type === "moved")).toEqual([]);
    expect(sinks.b!.filter((e) => e.type === "handoff" || e.type === "overdue")).toEqual([]);
  });

  test("one chat can be the front desk for channels in several servers", async () => {
    const { core, store, sinks, sink, attachBoth } = setup();
    attachBoth("a", "desk", sink("a"));
    expect(sinks.a!.find((e) => e.type === "claims")).toMatchObject({ role: "owner" });
    expect(store.load("a")).toMatchObject({
      guildId: "g1",
      guildName: "Example Guild + Other Guild",
      guilds: [ACME, OTHER],
      channelIds: [MANAGED, OTHER_GENERAL],
    });

    await core.onMessage(mention("in managed"));
    await core.onMessage(mention("in the other server", { channelId: OTHER_GENERAL, guildId: "g2" }));
    expect(mentions(sinks.a).map((e) => [e.route, e.channelName])).toEqual([
      ["mine", "managed"],
      ["mine", "general"],
    ]);

    // A channel id from the wrong server doesn't match.
    await core.onMessage(mention("spoofed", { channelId: OTHER_GENERAL, guildId: "g3" }));
    expect(mentions(sinks.a)).toHaveLength(2);
  });

  test("a second chat in one of a multi-server desk's channels listens there, and takes over when it stops", async () => {
    const { core, sinks, sink, attach, attachBoth, store } = setup();
    attachBoth("a", "desk", sink("a"));
    attach("b", "api work", sink("b"));
    expect(sinks.b!.find((e) => e.type === "claims")).toMatchObject({ role: "listener", owner: "desk" });
    core.control("a", "release", {});
    expect(store.load("b")).toMatchObject({ role: "owner" });
  });

  describe("direct messages between chats", () => {
    const directs = (events: RouterEvent[] | undefined) => (events ?? []).filter((e) => e.type === "direct") as Extract<RouterEvent, { type: "direct" }>[];

    test("go to the chat named by the name it posts under, and nowhere else", () => {
      const { core, sinks, sink, attach } = setup();
      attach("a", "desk", sink("a"));
      attach("b", "farm · 12345678", sink("b"));
      attach("c", "other", sink("c"));
      core.control("b", "alias", { name: "Garden Work" });

      const sent = core.control("a", "direct", { to: "garden work", content: "your build is broken", from: "front desk" });
      expect(sent).toMatchObject({ ok: true, to: "garden work", session: "b", queued: false });
      expect(directs(sinks.b)).toEqual([
        expect.objectContaining({ from: "front desk", fromSession: "a", content: "your build is broken" }),
      ]);
      expect(directs(sinks.a)).toEqual([]);
      expect(directs(sinks.c)).toEqual([]);

      // The sender is now addressable by the name it sent under, so the answer finds its way back.
      expect(core.control("b", "direct", { to: "Front Desk", content: "fixed", replyToId: directs(sinks.b)[0]!.id })).toMatchObject({ ok: true, session: "a" });
      expect(directs(sinks.a)[0]).toMatchObject({ content: "fixed", replyToId: directs(sinks.b)[0]!.id });
    });

    test("find a chat by session id or label, and refuse unknown, ambiguous and self", () => {
      const { core, sink, attach } = setup();
      attach("a", "desk", sink("a"));
      attach("bbbbbbbb-1111", "worker", sink("b"));
      attach("bbbbbbbb-2222", "worker", sink("c"));
      expect(core.control("a", "direct", { to: "bbbbbbbb-2222", content: "hi" })).toMatchObject({ ok: true, session: "bbbbbbbb-2222" });
      expect(core.control("a", "direct", { to: "worker", content: "hi" })).toMatchObject({ ok: false, status: 409 });
      expect(core.control("a", "direct", { to: "nobody", content: "hi" })).toMatchObject({ ok: false, status: 404 });
      expect(core.control("a", "direct", { to: "a", content: "hi" })).toMatchObject({ ok: false, status: 400 });
      expect(core.control("a", "direct", { to: "bbbbbbbb-2222", content: "  " })).toMatchObject({ ok: false, status: 400 });
    });

    test("a reply to a Discord message another chat posted can be told apart", () => {
      const { core, sink, attach } = setup([{ key: "msg:155700000000000999", sessionId: "b", label: "farm" }]);
      attach("a", "desk", sink("a"));
      attach("b", "farm", sink("b"));
      expect(core.control("a", "poster", { messageId: "155700000000000999" })).toMatchObject({ ok: true, session: "b", label: "farm" });
      // Its own post, or one no chat here made, isn't a chat-to-chat reply.
      expect(core.control("b", "poster", { messageId: "155700000000000999" })).toMatchObject({ ok: true, session: null });
      expect(core.control("a", "poster", { messageId: "155700000000000123" })).toMatchObject({ ok: true, session: null });
    });

    test("cap the back-and-forth between two chats, then allow it again after the window", () => {
      const { core, sinks, sink, attach, advance } = setup();
      attach("a", "desk", sink("a"));
      attach("b", "farm", sink("b"));
      for (let i = 0; i < DIRECT_LIMIT; i++) {
        const [from, to] = i % 2 ? ["b", "a"] : ["a", "b"];
        expect(core.control(from!, "direct", { to: to!, content: `ping ${i}` })).toMatchObject({ ok: true });
      }
      expect(core.control("a", "direct", { to: "b", content: "one more" })).toMatchObject({ ok: false, status: 429 });
      expect(directs(sinks.b).length).toBe(DIRECT_LIMIT / 2);
      advance(DIRECT_WINDOW_MS + 1_000);
      expect(core.control("a", "direct", { to: "b", content: "later" })).toMatchObject({ ok: true });
    });

    test("wait for a chat that's reloading, and arrive when it reattaches", () => {
      const { core, sinks, sink, attach } = setup();
      attach("a", "desk", sink("a"));
      const first = sink("b");
      attach("b", "farm", first);
      core.detach("b", first);
      expect(core.control("a", "direct", { to: "farm", content: "while you were out" })).toMatchObject({ ok: true, queued: true });
      attach("b", "farm", sink("b2"));
      expect(directs(sinks.b2).map((e) => e.content)).toEqual(["while you were out"]);
    });

    test("a restarted router still finds a chat by the name it posted under", () => {
      const saved = new Map<string, string[]>();
      const aliasStore = { get: (id: string) => saved.get(id) ?? [], set: (id: string, names: string[]) => void saved.set(id, names) };
      const before = setup([], { aliasStore });
      before.attach("b", "farm", before.sink("b"));
      before.core.control("b", "alias", { name: "garden work" });

      const after = setup([], { aliasStore });
      after.attach("a", "desk", after.sink("a"));
      after.attach("b", "farm", after.sink("b"));
      expect(after.core.control("a", "direct", { to: "garden work", content: "still there?" })).toMatchObject({ ok: true, session: "b" });
    });

    test("list the other chats with the names they go by", () => {
      const { core, sink, attach } = setup();
      attach("a", "desk", sink("a"));
      attach("b", "farm", sink("b"));
      core.control("b", "alias", { name: "garden work" });
      expect(core.control("a", "chats", {})).toMatchObject({
        ok: true,
        chats: [{ session: "b", name: "garden work", label: "farm", aliases: ["garden work"], connected: true }],
      });
    });
  });
});
