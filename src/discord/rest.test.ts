import { describe, expect, test } from "bun:test";
import { DiscordRest, type RawMessage, type RestLike } from "./rest.ts";

const BOT = "100000000000000007";
const CHANNEL = "100000000000000002";

function fakeRest(handlers: Record<string, (body?: any, query?: URLSearchParams) => unknown>) {
  const calls: Array<{ method: string; route: string; body?: any; query?: string }> = [];
  const rest: RestLike = {
    async get(route, options) {
      calls.push({ method: "GET", route, query: options?.query?.toString() });
      const h = handlers[`GET ${route}`];
      if (!h) throw new Error(`unexpected GET ${route}`);
      return h(undefined, options?.query);
    },
    async post(route, options) {
      calls.push({ method: "POST", route, body: options?.body });
      const h = handlers[`POST ${route}`];
      if (!h) throw new Error(`unexpected POST ${route}`);
      return h(options?.body);
    },
  };
  return { rest, calls };
}

const base = {
  "GET /users/@me": () => ({ id: BOT, username: "Tsukumo", bot: true }),
  [`GET /channels/${CHANNEL}`]: () => ({ id: CHANNEL, type: 0, guild_id: "g1", parent_id: "cat1" }),
};

function raw(id: string, content: string, extra: Partial<RawMessage> = {}): RawMessage {
  return {
    id,
    content,
    channel_id: CHANNEL,
    author: { id: "100000000000000008", username: "alice" },
    timestamp: "2026-10-08T22:23:54.096000+00:00",
    ...extra,
  };
}

describe("DiscordRest", () => {
  test("messages come back oldest first, shaped like the gateway's, with mentions detected", async () => {
    const { rest, calls } = fakeRest({
      ...base,
      [`GET /channels/${CHANNEL}/messages`]: () => [
        raw("3", "reply to us", { referenced_message: { author: { id: BOT, username: "Tsukumo" } }, message_reference: { message_id: "2" } }),
        raw("2", `<@${BOT}> hello`, { mentions: [{ id: BOT, username: "Tsukumo" }] }),
        raw("1", "unrelated"),
      ],
    });
    const msgs = await new DiscordRest(rest).messages(CHANNEL, { limit: 3 });
    expect(msgs.map((m) => [m.id, m.mentionsBot, m.replyToId])).toEqual([
      ["1", false, null],
      ["2", true, null],
      ["3", true, "2"],
    ]);
    expect(msgs[0]).toMatchObject({ guildId: "g1", threadParentId: "cat1", authorTag: "alice", createdAt: "2026-10-08T22:23:54.096Z" });
    expect(calls.find((c) => c.route.endsWith("/messages"))?.query).toBe("limit=3");
  });

  test("a reply carries a nonce with enforce_nonce; a returned earlier reply is reported as a duplicate", async () => {
    let existing: string | null = null;
    const { rest, calls } = fakeRest({
      ...base,
      [`POST /channels/${CHANNEL}/messages`]: (body) => {
        // Discord: same author + same nonce within minutes returns the first message.
        const content = existing ?? body.content;
        existing ??= body.content;
        return raw("9", content, { author: { id: BOT, username: "Tsukumo", bot: true }, nonce: body.nonce });
      },
    });
    const discord = new DiscordRest(rest);
    const first = await discord.send({ channelId: CHANNEL, from: "Claude", content: "on it", replyToId: "2" });
    expect(first.duplicate).toBe(false);
    expect(calls.filter((c) => c.method === "POST").at(-1)?.body).toEqual({
      content: "**Claude**\non it",
      message_reference: { message_id: "2", fail_if_not_exists: false },
      nonce: "r2",
      enforce_nonce: true,
    });
    const second = await discord.send({ channelId: CHANNEL, from: "Claude", content: "me too", replyToId: "2" });
    expect(second.duplicate).toBe(true);
    expect(second.message.content).toBe("**Claude**\non it");
  });

  test("a deliberate second reply, or a plain post, carries no nonce", async () => {
    const { rest, calls } = fakeRest({
      ...base,
      [`POST /channels/${CHANNEL}/messages`]: (body) => raw("9", body.content, { author: { id: BOT, username: "Tsukumo", bot: true } }),
    });
    const discord = new DiscordRest(rest);
    await discord.send({ channelId: CHANNEL, from: "Claude", content: "follow-up", replyToId: "2", allowDuplicate: true });
    await discord.send({ channelId: CHANNEL, from: "Claude", content: "fresh post" });
    expect(calls.filter((c) => c.method === "POST").map((c) => c.body.nonce)).toEqual([undefined, undefined]);
  });

  test("channels merge the guild's channels with its active threads, readable kinds only", async () => {
    const { rest } = fakeRest({
      "GET /guilds/g1/channels": () => [
        { id: "c1", name: "general", type: 0, position: 0 },
        { id: "v1", name: "voice", type: 2, position: 1 },
        { id: "k1", name: "Text", type: 4, position: 0 },
        { id: "c2", name: "managed", type: 0, position: 2 },
      ],
      "GET /guilds/g1/threads/active": () => ({ threads: [{ id: "t1", name: "eng-5881", type: 11, parent_id: "c2" }] }),
    });
    const channels = await new DiscordRest(rest).channelsOf("g1");
    expect(channels.map((c) => [c.name, c.type, c.parentId])).toEqual([
      ["eng-5881", "public_thread", "c2"],
      ["general", "text", null],
      ["managed", "text", null],
    ]);
  });

  test("threads open only off text or announcement channels", async () => {
    const { rest, calls } = fakeRest({
      [`GET /channels/${CHANNEL}`]: () => ({ id: CHANNEL, type: 0, guild_id: "g1" }),
      "GET /channels/f1": () => ({ id: "f1", type: 15, guild_id: "g1" }),
      [`POST /channels/${CHANNEL}/threads`]: (body) => ({ id: "t9", name: body.name, type: 11 }),
    });
    const discord = new DiscordRest(rest);
    expect(await discord.thread({ channelId: CHANNEL, name: "eng-5881" })).toEqual({ id: "t9", name: "eng-5881", parentId: CHANNEL });
    expect(calls.filter((c) => c.method === "POST").at(-1)?.body).toEqual({ name: "eng-5881", type: 11, auto_archive_duration: 1440 });
    await expect(discord.thread({ channelId: "f1", name: "x" })).rejects.toThrow("can't hold threads");
  });
});
