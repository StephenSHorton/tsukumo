#!/usr/bin/env bun
/**
 * Tsukumo MCP server (stdio) — primary entrypoint.
 *
 * Any MCP client (Grok, Claude Code, Cursor, …) spawns this process on demand.
 * It logs into Discord as the bot, answers tool calls, then exits when the
 * client closes stdin. No background daemon or deploy required.
 *
 * Reading and posting work in every client. Live watching (`bind`, then
 * mentions pushed as `notifications/claude/channel`) only wakes a session in
 * Grok run as `grok-fork --channels`; other clients ignore the notification.
 * For Claude Code, use the mod in claude-mod/ instead of `bind`.
 *
 * Grok config (~/.grok/config.toml):
 *
 *   [mcp_servers.tsukumo]
 *   command = "bun"
 *   args = ["run", "/Users/YOU/projects/tsukumo/src/mcp.ts"]
 *   # DISCORD_TOKEN loaded from the project's .env automatically
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig, loadProjectEnv } from "./config.ts";
import { openSession, type TsukumoSession } from "./session.ts";
import { GatewayError } from "./gateway/service.ts";
import { toChannelNotification } from "./lib/channel.ts";
import { HookStore, conversationId } from "./lib/hook.ts";
import type { GatewayMessage } from "./lib/types.ts";

// MCP uses stdio — never write to stdout except protocol messages
const logErr = (...args: unknown[]) => console.error("[tsukumo]", ...args);

function text(data: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof data === "string" ? data : JSON.stringify(data, null, 2),
      },
    ],
  };
}

function fail(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    isError: true as const,
  };
}

let sessionPromise: Promise<TsukumoSession> | null = null;

async function getSession(): Promise<TsukumoSession> {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      await loadProjectEnv();
      const config = loadConfig();
      logErr("logging into Discord…");
      const session = await openSession(config, {
        enforceHook: true,
        onChannelInbound: emitChannelInbound,
      });
      logErr(
        `ready as ${session.client.user?.tag} · ${session.client.guilds.cache.size} guild(s)`,
      );
      return session;
    })().catch((err) => {
      sessionPromise = null;
      throw err;
    });
  }
  return sessionPromise;
}

function emitChannelInbound(msg: GatewayMessage): void {
  const notification = toChannelNotification(msg);
  logErr(
    `channel inbound ${msg.authorUsername} in ${msg.channelId}: ${msg.content.slice(0, 80)}`,
  );
  void server.server
    .notification(notification as never)
    .catch((err) => logErr("channel notify failed", err));
}

const server = new McpServer({
  name: "tsukumo",
  version: "0.5.1",
});

server.tool(
  "tsukumo_status",
  "Check Tsukumo connection, bot identity, and whether THIS conversation is watching a Discord place. send_message, get_messages, and get_message work without a hook; get_mentions / get_recent need bind.",
  {},
  async () => {
    try {
      const { service } = await getSession();
      return text(service.status());
    } catch (err) {
      return fail(err);
    }
  },
);

server.tool(
  "list_guilds",
  "List Discord servers the bot is in. Does not watch or answer pings. After the user picks a server/channel, call bind so only this conversation sees it.",
  {},
  async () => {
    try {
      const { service } = await getSession();
      return text({ guilds: service.listGuilds() });
    } catch (err) {
      return fail(err);
    }
  },
);

server.tool(
  "list_channels",
  "List text-capable channels in a Discord guild. Use an id with bind. Does not watch pings by itself.",
  {
    guild_id: z.string().describe("Discord guild (server) id"),
  },
  async ({ guild_id }) => {
    try {
      const { service } = await getSession();
      return text({ channels: service.listChannels(guild_id) });
    } catch (err) {
      return fail(err);
    }
  },
);

// Built for Grok: a bound conversation keeps its claim while its Grok session
// exists on disk (lib/hook.ts), and pushed mentions only wake grok-fork --channels.
server.tool(
  "bind",
  "Watch a Discord server or channel from THIS conversation. Required before get_mentions / get_recent. Not required to send_message, get_messages, or get_message. Other conversations will not see those pings. Survives resume of this same conversation; gone if you start a new one. Call only when the user asks to watch a place.",
  {
    guild_id: z.string().describe("Discord server id from list_guilds"),
    channel_id: z
      .string()
      .optional()
      .describe("If set, only this channel (and its threads). Omit to watch the whole server."),
    channel_ids: z
      .array(z.string())
      .optional()
      .describe("Multiple channel ids in the same server. Ignored if channel_id is set."),
  },
  async ({ guild_id, channel_id, channel_ids }) => {
    try {
      const { service } = await getSession();
      const ids = channel_id ? [channel_id] : channel_ids;
      const hook = service.bind({ guildId: guild_id, channelIds: ids });
      return text({
        ok: true,
        persisted: Boolean(hook.conversationId && !hook.conversationId.startsWith("ephemeral:")),
        hook,
      });
    } catch (err) {
      return fail(err);
    }
  },
);

server.tool(
  "unbind",
  "Stop watching. Does not kick the bot from the server. send_message still works.",
  {},
  async () => {
    try {
      const { service } = await getSession();
      return text({ ok: true, removed: service.unbind() });
    } catch (err) {
      return fail(err);
    }
  },
);

server.tool(
  "get_mentions",
  "Pings and replies to the bot inside this conversation's hook only. Empty until bind. Use after the user asked this conversation to watch Discord.",
  {
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe("How many mentions (default 50)"),
  },
  async ({ limit }) => {
    try {
      const { service } = await getSession();
      return text({ messages: await service.getMentions({ limit }) });
    } catch (err) {
      return fail(err);
    }
  },
);

server.tool(
  "get_messages",
  "Fetch recent message history from a Discord channel the bot can see. Does not require bind. Fails if the bot cannot access the channel.",
  {
    channel_id: z.string().describe("Discord channel id"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe("How many messages (1–100, default 50)"),
    before: z
      .string()
      .optional()
      .describe("Snowflake id — fetch messages older than this"),
    after: z
      .string()
      .optional()
      .describe("Snowflake id — fetch messages newer than this"),
    include_bots: z
      .boolean()
      .optional()
      .describe("Include bot messages (default true)"),
  },
  async ({ channel_id, limit, before, after, include_bots }) => {
    try {
      const { service } = await getSession();
      const messages = await service.getMessages({
        channelId: channel_id,
        limit,
        before,
        after,
        includeBots: include_bots,
      });
      return text({ messages });
    } catch (err) {
      return fail(err);
    }
  },
);

server.tool(
  "get_recent",
  "Live messages in this conversation's watch hook since this process logged in. Fails without bind. Use get_messages for history.",
  {
    channel_id: z
      .string()
      .optional()
      .describe("Limit to one channel; omit for all buffered channels"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .describe("How many messages (default 50)"),
    include_bots: z.boolean().optional(),
  },
  async ({ channel_id, limit, include_bots }) => {
    try {
      const { service } = await getSession();
      return text({
        messages: service.getRecent({
          channelId: channel_id,
          limit,
          includeBots: include_bots,
        }),
      });
    } catch (err) {
      return fail(err);
    }
  },
);

server.tool(
  "get_message",
  "Fetch a single Discord message by channel_id and message_id. Does not require bind. Fails if the bot cannot access the channel.",
  {
    channel_id: z.string(),
    message_id: z.string(),
  },
  async ({ channel_id, message_id }) => {
    try {
      const { service } = await getSession();
      return text({
        message: await service.getMessage(channel_id, message_id),
      });
    } catch (err) {
      return fail(err);
    }
  },
);

server.tool(
  "send_message",
  "Post as the Tsukumo bot. Any channel the bot can see — no watch hook required. Set `from` to the client only — Grok, Cursor, Claude. Prefixed in bold. Optionally reply. Optional `files` are absolute local paths (max 10, each a regular file ≤ 25 MB) sent as Discord attachments with the original filename; can be sent with content. Clears 👀 and typing for that channel.",
  {
    channel_id: z.string().describe("Discord channel id to post in"),
    from: z
      .string()
      .min(1)
      .max(80)
      .describe(
        'Client that is speaking (Grok, Cursor, Claude, …). Required. The bot\'s nickname already says whose it is, so do not put that in `from`. Prefixed in bold onto the message.',
      ),
    content: z
      .string()
      .min(1)
      .max(2000)
      .describe("Message body (max 2000 chars including the from prefix)"),
    reply_to_id: z
      .string()
      .optional()
      .describe("Message id to reply to (same channel)"),
    files: z
      .array(z.string())
      .max(10)
      .optional()
      .describe(
        "Optional absolute local file paths on the machine running Tsukumo (max 10). Each must exist, be a regular file, and be 25 MB or smaller. Uploaded as Discord attachments using the original filename. Can be sent together with content.",
      ),
  },
  async ({ channel_id, from, content, reply_to_id, files }) => {
    try {
      const { service } = await getSession();
      return text(
        await service.sendMessage({
          channelId: channel_id,
          from,
          content,
          replyToId: reply_to_id,
          files,
        }),
      );
    } catch (err) {
      return fail(err);
    }
  },
);

server.tool(
  "ack_message",
  "Mark a Discord message as being handled: add 👀 and show typing in that channel. Hooked @mentions already do this automatically. Call when you start work on a message you found yourself (poll/history). send_message clears it.",
  {
    channel_id: z.string().describe("Discord channel id"),
    message_id: z.string().describe("Message id to ack with 👀"),
  },
  async ({ channel_id, message_id }) => {
    try {
      const { service } = await getSession();
      return text(await service.ackMessage(channel_id, message_id));
    } catch (err) {
      return fail(err);
    }
  },
);

server.tool(
  "clear_ack",
  "Remove this conversation's 👀 and stop typing in the channel. send_message already does this. Call when you will not reply.",
  {
    channel_id: z.string().describe("Discord channel id"),
    message_id: z
      .string()
      .optional()
      .describe("If set, only this message. Omit to clear every ack in the channel."),
  },
  async ({ channel_id, message_id }) => {
    try {
      const { service } = await getSession();
      return text(await service.clearAck(channel_id, message_id));
    } catch (err) {
      return fail(err);
    }
  },
);

async function main() {
  await loadProjectEnv();

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const conv = conversationId();
  const restored = conv ? new HookStore().load(conv) : null;
  if (restored) {
    const where =
      restored.channelNames.length > 0
        ? `${restored.guildName} / ${restored.channelNames.join(", ")}`
        : restored.guildName;
    logErr(`stdio MCP ready; restoring hook on ${where}`);
    void getSession();
  } else {
    logErr("stdio MCP ready (Discord login on first tool call / bind)");
  }

  const cleanup = async () => {
    if (sessionPromise) {
      try {
        const s = await sessionPromise;
        await s.destroy();
      } catch {
        /* ignore */
      }
    }
  };

  process.on("SIGINT", () => {
    void cleanup().finally(() => process.exit(0));
  });
  process.on("SIGTERM", () => {
    void cleanup().finally(() => process.exit(0));
  });
}

main().catch((err) => {
  logErr("fatal", err);
  if (err instanceof GatewayError) logErr(err.message);
  process.exit(1);
});
