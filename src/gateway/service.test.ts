import { truncateSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import type { Client } from "discord.js";
import { MessageBuffer } from "../discord/buffer.ts";
import { HookRef, NO_HOOK_MESSAGE, type HookScope } from "../lib/hook.ts";
import type { GatewayMessage } from "../lib/types.ts";
import {
  GatewayError,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_FILES,
  resolveAttachmentFiles,
  TsukumoService,
} from "./service.ts";

const BOT_ID = "bot1";
const CREATED_AT = new Date("2026-09-10T16:08:37.000Z");

function hook(over: Partial<HookScope> = {}): HookScope {
  return {
    conversationId: "sess-test",
    guildId: "g1",
    guildName: "Example Guild",
    channelIds: ["c1"],
    channelNames: ["eng"],
    boundAt: "2026-09-10T00:00:00.000Z",
    ...over,
  };
}

function fakeDiscordMessage(over: {
  id?: string;
  content?: string;
  channelId?: string;
  guildId?: string | null;
  parentId?: string | null;
  authorId?: string;
  authorBot?: boolean;
} = {}) {
  const channelId = over.channelId ?? "c1";
  return {
    id: over.id ?? "m1",
    content: over.content ?? "hello",
    author: {
      id: over.authorId ?? "u1",
      tag: "alice#0",
      username: "alice",
      bot: over.authorBot ?? false,
    },
    channel: { id: channelId, parentId: over.parentId ?? null },
    guildId: over.guildId ?? "g1",
    client: { user: { id: BOT_ID } },
    mentions: { users: { has: () => false }, repliedUser: null },
    reference: null,
    createdAt: CREATED_AT,
    attachments: { values: () => [] },
  };
}

function fakeTextChannel(
  id: string,
  opts: {
    messages?: ReturnType<typeof fakeDiscordMessage>[];
    fetchError?: Error;
    guildId?: string;
    onSend?: (payload: unknown) => void | Promise<void>;
  } = {},
) {
  const messages = opts.messages ?? [fakeDiscordMessage({ channelId: id })];
  return {
    id,
    guildId: opts.guildId ?? "g1",
    parentId: null,
    isTextBased: () => true,
    isVoiceBased: () => false,
    send: async (payload: unknown) => {
      await opts.onSend?.(payload);
      const content =
        payload && typeof payload === "object" && "content" in payload
          ? String((payload as { content: unknown }).content)
          : "";
      return fakeDiscordMessage({ channelId: id, content });
    },
    messages: {
      async fetch(arg: unknown) {
        if (opts.fetchError) throw opts.fetchError;
        if (typeof arg === "string") {
          const found = messages.find((m) => m.id === arg);
          if (!found) throw new Error("Unknown Message");
          return found;
        }
        // Discord returns newest-first; service reverses to chronological.
        return { values: () => [...messages].reverse() };
      },
    },
  };
}

function fakeClient(
  channels: Record<string, ReturnType<typeof fakeTextChannel>>,
) {
  return {
    isReady: () => true,
    user: { id: BOT_ID, tag: "tsukumo#0" },
    guilds: { cache: { size: 1, get: () => undefined, values: () => [] } },
    uptime: 1,
    channels: {
      cache: {
        get(id: string) {
          return channels[id];
        },
      },
      async fetch(id: string) {
        return channels[id] ?? null;
      },
    },
  } as unknown as Client;
}

function gatewayMsg(over: Partial<GatewayMessage> = {}): GatewayMessage {
  return {
    id: "live1",
    content: "buffered",
    authorId: "u1",
    authorTag: "alice#0",
    authorUsername: "alice",
    authorBot: false,
    channelId: "c1",
    guildId: "g1",
    threadParentId: null,
    mentionsBot: false,
    replyToId: null,
    createdAt: CREATED_AT.toISOString(),
    attachments: [],
    ...over,
  };
}

function service(opts: {
  enforceHook?: boolean;
  hook?: HookScope | null;
  channels?: Record<string, ReturnType<typeof fakeTextChannel>>;
  buffer?: MessageBuffer;
} = {}) {
  const channels = opts.channels ?? { c1: fakeTextChannel("c1") };
  const buffer = opts.buffer ?? new MessageBuffer();
  return new TsukumoService(fakeClient(channels), buffer, {
    ref: new HookRef(opts.hook ?? null),
    enforceHook: opts.enforceHook ?? true,
    conversationId: "sess-test",
  });
}

function expectGateway(err: unknown, status: number, message: string) {
  expect(err).toBeInstanceOf(GatewayError);
  const ge = err as GatewayError;
  expect(ge.status).toBe(status);
  expect(ge.message).toBe(message);
}

describe("REST history without bind", () => {
  test("getMessages succeeds unbound when the bot can see the channel", async () => {
    const svc = service({ hook: null });
    const messages = await svc.getMessages({ channelId: "c1", limit: 10 });
    expect(messages).toHaveLength(1);
    expect(messages[0]?.id).toBe("m1");
    expect(messages[0]?.content).toBe("hello");
    expect(messages[0]?.channelId).toBe("c1");
  });

  test("getMessage succeeds unbound when the bot can see the channel", async () => {
    const svc = service({ hook: null });
    const message = await svc.getMessage("c1", "m1");
    expect(message.id).toBe("m1");
    expect(message.channelId).toBe("c1");
  });

  test("getMessages fails on a channel the bot cannot see, not on missing bind", async () => {
    const svc = service({ hook: null, channels: {} });
    try {
      await svc.getMessages({ channelId: "missing" });
      throw new Error("expected getMessages to fail");
    } catch (err) {
      expectGateway(err, 404, "Channel not found: missing");
      expect((err as Error).message).not.toContain("watch hook");
    }
  });

  test("getMessage fails on a channel the bot cannot see, not on missing bind", async () => {
    const svc = service({ hook: null, channels: {} });
    try {
      await svc.getMessage("missing", "m1");
      throw new Error("expected getMessage to fail");
    } catch (err) {
      expectGateway(err, 404, "Channel not found: missing");
      expect((err as Error).message).not.toContain("watch hook");
    }
  });

  test("getMessages surfaces Discord permission errors without asking for bind", async () => {
    const svc = service({
      hook: null,
      channels: {
        c1: fakeTextChannel("c1", { fetchError: new Error("Missing Access") }),
      },
    });
    await expect(svc.getMessages({ channelId: "c1" })).rejects.toThrow(
      "Missing Access",
    );
  });

  test("getMessages works for a channel outside this conversation's hook", async () => {
    const svc = service({
      hook: hook({ channelIds: ["c1"], channelNames: ["eng"] }),
      channels: {
        c1: fakeTextChannel("c1"),
        c2: fakeTextChannel("c2", {
          messages: [fakeDiscordMessage({ id: "m2", channelId: "c2" })],
        }),
      },
    });
    const messages = await svc.getMessages({ channelId: "c2" });
    expect(messages[0]?.id).toBe("m2");
  });
});

describe("live watch still requires bind", () => {
  test("getRecent without bind fails", () => {
    const svc = service({ hook: null });
    try {
      svc.getRecent({ channelId: "c1" });
      throw new Error("expected getRecent to fail");
    } catch (err) {
      expectGateway(err, 403, NO_HOOK_MESSAGE);
    }
  });

  test("getMentions without bind fails", async () => {
    const svc = service({ hook: null });
    try {
      await svc.getMentions({ limit: 10 });
      throw new Error("expected getMentions to fail");
    } catch (err) {
      expectGateway(err, 403, NO_HOOK_MESSAGE);
    }
  });

  test("getRecent after bind returns hook-scoped live messages", () => {
    const buffer = new MessageBuffer();
    buffer.push(gatewayMsg({ id: "in", channelId: "c1" }));
    buffer.push(gatewayMsg({ id: "out", channelId: "c2" }));
    const svc = service({ hook: hook(), buffer });
    const recent = svc.getRecent({ limit: 50 });
    expect(recent.map((m) => m.id)).toEqual(["in"]);
  });

  test("getRecent after bind still rejects a channel outside the hook", () => {
    const svc = service({ hook: hook() });
    try {
      svc.getRecent({ channelId: "c2" });
      throw new Error("expected getRecent to fail");
    } catch (err) {
      expect(err).toBeInstanceOf(GatewayError);
      expect((err as GatewayError).status).toBe(403);
      expect((err as Error).message).toContain("outside this conversation's hook");
    }
  });

  test("getMentions after bind does not throw for missing bind", async () => {
    const svc = service({
      hook: hook(),
      channels: { c1: fakeTextChannel("c1") },
    });
    const mentions = await svc.getMentions({ limit: 10 });
    expect(Array.isArray(mentions)).toBe(true);
  });
});

describe("send_message file attachments", () => {
  test("resolveAttachmentFiles skips empty input", async () => {
    expect(await resolveAttachmentFiles(undefined)).toBeUndefined();
    expect(await resolveAttachmentFiles([])).toBeUndefined();
  });

  test("rejects more than 10 files, relative paths, missing files, and directories", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tsukumo-files-"));
    try {
      await expect(
        resolveAttachmentFiles(
          Array.from({ length: MAX_ATTACHMENT_FILES + 1 }, (_, i) =>
            join(dir, `f${i}.txt`),
          ),
        ),
      ).rejects.toMatchObject({
        message: "files cannot include more than 10 attachments",
      });

      await expect(resolveAttachmentFiles(["relative/path.txt"])).rejects.toMatchObject({
        message: "file path must be an absolute local path: relative/path.txt",
      });

      const missing = join(dir, "missing.txt");
      await expect(resolveAttachmentFiles([missing])).rejects.toMatchObject({
        message: `file not found: ${missing}`,
      });

      const nested = join(dir, "subdir");
      await mkdir(nested);
      await expect(resolveAttachmentFiles([nested])).rejects.toMatchObject({
        message: `not a regular file: ${nested}`,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("rejects files over 25 MB and keeps original filenames for valid files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tsukumo-files-"));
    const okPath = join(dir, "notes.txt");
    const bigPath = join(dir, "too-big.bin");
    try {
      await writeFile(okPath, "hello");
      await writeFile(bigPath, "");
      truncateSync(bigPath, MAX_ATTACHMENT_BYTES + 1);

      await expect(resolveAttachmentFiles([bigPath])).rejects.toMatchObject({
        message: `file exceeds 25 MB limit: ${bigPath} (${MAX_ATTACHMENT_BYTES + 1} bytes)`,
      });

      expect(await resolveAttachmentFiles([okPath])).toEqual([
        { attachment: okPath, name: "notes.txt" },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("sendMessage passes content, reply, and files through to channel.send", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tsukumo-send-"));
    const path = join(dir, "shot.png");
    await writeFile(path, "png");
    let sent: unknown;
    try {
      const svc = service({
        hook: null,
        channels: {
          c1: fakeTextChannel("c1", {
            onSend: (payload) => {
              sent = payload;
            },
          }),
        },
      });
      const result = await svc.sendMessage({
        channelId: "c1",
        from: "Cursor",
        content: "here",
        replyToId: "m9",
        files: [path],
      });
      expect(result.message.content).toBe("**Cursor**\nhere");
      expect(sent).toEqual({
        content: "**Cursor**\nhere",
        files: [{ attachment: path, name: "shot.png" }],
        reply: { messageReference: "m9" },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
