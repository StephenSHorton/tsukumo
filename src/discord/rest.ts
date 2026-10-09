/**
 * Discord over plain REST: no gateway connection, so no IDENTIFY.
 *
 * Every gateway login spends one of the bot's 1,000 IDENTIFYs a day, and
 * running out disconnects every session and resets the token. One-shot calls
 * (src/call.ts) only need request/response, so they go through here.
 */
import { REST, Routes } from "discord.js";
import { formatPostedContent } from "../gateway/service.ts";
import { GatewayError } from "../lib/errors.ts";
import type { GatewayChannel, GatewayGuild, GatewayMessage } from "../lib/types.ts";

/** The slice of discord.js's REST client we use; tests pass a fake. */
export interface RestLike {
  get(route: `/${string}`, options?: { query?: URLSearchParams }): Promise<unknown>;
  post(route: `/${string}`, options?: { body?: unknown }): Promise<unknown>;
}

export function createRest(token: string): RestLike {
  return new REST({ version: "10" }).setToken(token) as unknown as RestLike;
}

const CHANNEL_TYPE_NAME: Record<number, string> = {
  0: "text",
  2: "voice",
  4: "category",
  5: "announcement",
  10: "announcement_thread",
  11: "public_thread",
  12: "private_thread",
  13: "stage",
  15: "forum",
  16: "media",
};
/** Text channels, announcements, threads and forums: what list_channels has always shown. */
const LISTED_TYPES = new Set([0, 5, 10, 11, 12, 15]);
/** Discord's "thread starter message": an empty echo pointing at the thread's first post. */
export const THREAD_STARTER_MESSAGE = 21;

interface RawUser {
  id: string;
  username: string;
  discriminator?: string;
  bot?: boolean;
}
export interface RawMessage {
  id: string;
  type?: number;
  content: string;
  channel_id: string;
  guild_id?: string;
  author: RawUser;
  timestamp: string;
  nonce?: string | number;
  mentions?: RawUser[];
  message_reference?: { message_id?: string };
  referenced_message?: { author?: RawUser } | null;
  attachments?: Array<{ id: string; filename: string; url: string; content_type?: string; size: number }>;
}
interface RawChannel {
  id: string;
  name?: string;
  type: number;
  guild_id?: string;
  parent_id?: string | null;
  topic?: string | null;
  position?: number;
}

/** A REST message in the same shape the gateway path produces (src/gateway/serialize.ts). */
export function messageFromRest(
  raw: RawMessage,
  ctx: { botId: string; guildId: string | null; threadParentId: string | null },
): GatewayMessage {
  const { botId } = ctx;
  const mentionsBot =
    (raw.mentions ?? []).some((u) => u.id === botId) ||
    raw.referenced_message?.author?.id === botId ||
    raw.content.includes(`<@${botId}>`) ||
    raw.content.includes(`<@!${botId}>`);
  const tag =
    raw.author.discriminator && raw.author.discriminator !== "0"
      ? `${raw.author.username}#${raw.author.discriminator}`
      : raw.author.username;
  return {
    id: raw.id,
    content: raw.content,
    authorId: raw.author.id,
    authorTag: tag,
    authorUsername: raw.author.username,
    authorBot: Boolean(raw.author.bot),
    channelId: raw.channel_id,
    guildId: raw.guild_id ?? ctx.guildId,
    threadParentId: ctx.threadParentId,
    mentionsBot,
    replyToId: raw.message_reference?.message_id ?? null,
    createdAt: new Date(raw.timestamp).toISOString(),
    attachments: (raw.attachments ?? []).map((a) => ({
      id: a.id,
      filename: a.filename,
      url: a.url,
      contentType: a.content_type ?? null,
      size: a.size,
    })),
  };
}

function channelFromRest(raw: RawChannel, guildId: string): GatewayChannel {
  return {
    id: raw.id,
    name: raw.name ?? raw.id,
    type: CHANNEL_TYPE_NAME[raw.type] ?? String(raw.type),
    guildId: raw.guild_id ?? guildId,
    parentId: raw.parent_id ?? null,
    topic: raw.topic ?? null,
    position: raw.position ?? 0,
  };
}

export interface SendResult {
  message: GatewayMessage;
  /**
   * True when Discord returned an earlier reply instead of posting: another
   * send (another session, or a retry) already replied to this message.
   */
  duplicate: boolean;
}

/** One-shot Discord operations over REST, for src/call.ts. */
export class DiscordRest {
  private bot: RawUser | null = null;
  private readonly channels = new Map<string, RawChannel>();

  constructor(private readonly rest: RestLike) {}

  async botUser(): Promise<RawUser> {
    this.bot ??= (await this.rest.get("/users/@me")) as RawUser;
    return this.bot;
  }

  private async channel(channelId: string): Promise<RawChannel> {
    let raw = this.channels.get(channelId);
    if (!raw) {
      raw = (await this.rest.get(Routes.channel(channelId))) as RawChannel;
      this.channels.set(channelId, raw);
    }
    return raw;
  }

  private async context(channelId: string) {
    const [bot, channel] = await Promise.all([this.botUser(), this.channel(channelId)]);
    return { botId: bot.id, guildId: channel.guild_id ?? null, threadParentId: channel.parent_id ?? null };
  }

  /** IDENTIFYs left today, so a watcher can refuse to connect before the budget runs out. */
  async loginBudget(): Promise<{ total: number; remaining: number; resetAfterMs: number }> {
    const raw = (await this.rest.get(Routes.gatewayBot())) as {
      session_start_limit: { total: number; remaining: number; reset_after: number };
    };
    const limit = raw.session_start_limit;
    return { total: limit.total, remaining: limit.remaining, resetAfterMs: limit.reset_after };
  }

  async guilds(): Promise<GatewayGuild[]> {
    const raw = (await this.rest.get(Routes.userGuilds(), {
      query: new URLSearchParams({ with_counts: "true" }),
    })) as Array<{ id: string; name: string; approximate_member_count?: number }>;
    return raw.map((g) => ({ id: g.id, name: g.name, memberCount: g.approximate_member_count ?? null }));
  }

  async channelsOf(guildId: string): Promise<GatewayChannel[]> {
    const [channels, active] = await Promise.all([
      this.rest.get(Routes.guildChannels(guildId)) as Promise<RawChannel[]>,
      this.rest.get(Routes.guildActiveThreads(guildId)) as Promise<{ threads: RawChannel[] }>,
    ]);
    return [...channels, ...active.threads]
      .filter((c) => LISTED_TYPES.has(c.type))
      .map((c) => channelFromRest(c, guildId))
      .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
  }

  async messages(channelId: string, opts: { limit?: number; before?: string; after?: string } = {}): Promise<GatewayMessage[]> {
    const query = new URLSearchParams({ limit: String(Math.min(Math.max(opts.limit ?? 50, 1), 100)) });
    if (opts.before) query.set("before", opts.before);
    if (opts.after) query.set("after", opts.after);
    const [raw, ctx] = await Promise.all([
      this.rest.get(Routes.channelMessages(channelId), { query }) as Promise<RawMessage[]>,
      this.context(channelId),
    ]);
    // Callers read oldest first, whatever order Discord returned.
    return raw
      .map((m) => messageFromRest(m, ctx))
      .sort((a, b) => a.id.length - b.id.length || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  async message(channelId: string, messageId: string): Promise<GatewayMessage> {
    const [raw, ctx] = await Promise.all([
      this.rest.get(Routes.channelMessage(channelId, messageId)) as Promise<RawMessage>,
      this.context(channelId),
    ]);
    return messageFromRest(raw, ctx);
  }

  /**
   * Posts under the bold `from` label. A reply carries a nonce derived from the
   * message it answers, with enforce_nonce: if this bot already replied to that
   * message in the last few minutes, Discord hands back that reply instead of
   * posting again. `duplicate` says so; pass `allowDuplicate` for a deliberate
   * second reply.
   */
  async send(input: {
    channelId: string;
    from: string;
    content: string;
    replyToId?: string;
    allowDuplicate?: boolean;
  }): Promise<SendResult> {
    const content = formatPostedContent(input.from, input.content);
    const body: Record<string, unknown> = { content };
    if (input.replyToId) {
      body.message_reference = { message_id: input.replyToId, fail_if_not_exists: false };
      if (!input.allowDuplicate) {
        body.nonce = `r${input.replyToId}`;
        body.enforce_nonce = true;
      }
    }
    const [raw, ctx] = await Promise.all([
      this.rest.post(Routes.channelMessages(input.channelId), { body }) as Promise<RawMessage>,
      this.context(input.channelId),
    ]);
    return { message: messageFromRest(raw, ctx), duplicate: raw.content !== content };
  }

  /** Opens a public thread off a text or announcement channel. */
  async thread(input: { channelId: string; name: string }): Promise<{ id: string; name: string; parentId: string }> {
    const parent = await this.channel(input.channelId);
    if (parent.type !== 0 && parent.type !== 5) {
      throw new GatewayError(`Channel ${input.channelId} can't hold threads.`);
    }
    const raw = (await this.rest.post(Routes.threads(input.channelId), {
      body: { name: input.name.slice(0, 100), type: 11, auto_archive_duration: 1440 },
    })) as RawChannel;
    return { id: raw.id, name: raw.name ?? input.name, parentId: input.channelId };
  }
}
