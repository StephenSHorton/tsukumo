import { stat } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import {
  ChannelType,
  type AttachmentPayload,
  type Client,
  type TextChannel,
  type NewsChannel,
  type ThreadChannel,
  type DMChannel,
} from "discord.js";
import type { MessageBuffer } from "../discord/buffer.ts";
import {
  isReadableTextChannel,
  toGatewayChannel,
  toGatewayGuild,
  toGatewayMessage,
} from "./serialize.ts";
import type {
  GatewayChannel,
  GatewayGuild,
  GatewayMessage,
  GetMessagesInput,
  SendMessageInput,
  SendMessageResult,
} from "../lib/types.ts";
import { GatewayError } from "../lib/errors.ts";
import {
  HookStore,
  NO_HOOK_MESSAGE,
  conversationId,
  hookAllowsChannel,
  type HookScope,
} from "../lib/hook.ts";
import { ACK_EMOJI, type WorkingPresence } from "../discord/working.ts";
import { shouldNotifyChannel } from "../lib/channel.ts";

/** Discord's message body limit. */
const DISCORD_CONTENT_LIMIT = 2000;

/** Discord's default upload cap for bot attachments. */
export const MAX_ATTACHMENT_FILES = 10;
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/** `from` is the client. Strip a leftover "<Name>'s AI (…)" wrapper. */
function clientLabel(from: string): string {
  const speaker = from.trim();
  const wrapped = speaker.match(/^[\w .-]+?'?s\s+ai\s*\((.+)\)$/i);
  return (wrapped?.[1] ?? speaker).trim();
}

/**
 * Prefix `from` onto the body. The bot's server nickname is already
 * says whose bot it is (e.g. "Sam's AI"); `from` is only the client (Grok, Cursor, Claude, …).
 *
 * If the agent already led with the same bold label, leave the body alone.
 * Old "Sam's AI (Grok)" values are reduced to the client name.
 */
export function formatPostedContent(from: string, content: string, opts: { allowEmpty?: boolean } = {}): string {
  const speaker = clientLabel(from);
  const body = content.trim();
  if (!speaker) {
    throw new GatewayError(
      "from is required — the bot's nickname already says whose it is, so set from to the client (Grok, Cursor, Claude, …)",
    );
  }
  const label = `**${speaker}**`;
  // A post that is only an attachment (a GIF) still says who sent it.
  if (!body && opts.allowEmpty) return label;
  if (!body) {
    throw new GatewayError("content is required");
  }

  const posted = body.toLowerCase().startsWith(label.toLowerCase())
    ? body
    : `${label}\n${body}`;
  if (posted.length > DISCORD_CONTENT_LIMIT) {
    throw new GatewayError(
      `content plus speaker label exceeds Discord ${DISCORD_CONTENT_LIMIT} character limit`,
    );
  }
  return posted;
}

/**
 * Validate local paths and turn them into discord.js `files` payloads,
 * keeping each original filename. Read happens in this process (the one
 * that holds the Discord client).
 */
export async function resolveAttachmentFiles(
  paths: string[] | undefined,
): Promise<AttachmentPayload[] | undefined> {
  if (!paths || paths.length === 0) return undefined;
  if (paths.length > MAX_ATTACHMENT_FILES) {
    throw new GatewayError(
      `files cannot include more than ${MAX_ATTACHMENT_FILES} attachments`,
    );
  }

  const files: AttachmentPayload[] = [];
  for (const raw of paths) {
    const filePath = raw.trim();
    if (!filePath) {
      throw new GatewayError("each files entry must be a non-empty path");
    }
    if (!isAbsolute(filePath)) {
      throw new GatewayError(
        `file path must be an absolute local path: ${raw}`,
      );
    }

    let info;
    try {
      info = await stat(filePath);
    } catch (err) {
      const code =
        err && typeof err === "object" && "code" in err
          ? String(err.code)
          : "";
      if (code === "ENOENT") {
        throw new GatewayError(`file not found: ${filePath}`);
      }
      const reason = err instanceof Error ? err.message : String(err);
      throw new GatewayError(`cannot read file ${filePath}: ${reason}`);
    }

    if (!info.isFile()) {
      throw new GatewayError(`not a regular file: ${filePath}`);
    }
    if (info.size > MAX_ATTACHMENT_BYTES) {
      throw new GatewayError(
        `file exceeds 25 MB limit: ${filePath} (${info.size} bytes)`,
      );
    }

    files.push({ attachment: filePath, name: basename(filePath) });
  }
  return files;
}

export { GatewayError } from "../lib/errors.ts";

type SendableText =
  | TextChannel
  | NewsChannel
  | ThreadChannel
  | DMChannel;

export class TsukumoService {
  constructor(
    private readonly client: Client,
    private readonly buffer: MessageBuffer,
    private readonly opts: {
      store?: HookStore;
      ref?: { current: HookScope | null };
      conversationId?: string | null;
      enforceHook?: boolean;
      working?: WorkingPresence;
    } = {},
  ) {}

  private get enforceHook(): boolean {
    return this.opts.enforceHook === true;
  }

  private get convId(): string | null {
    return this.opts.conversationId ?? conversationId();
  }

  hook(): HookScope | null {
    return this.opts.ref?.current ?? null;
  }

  status() {
    const hook = this.hook();
    return {
      ok: this.client.isReady(),
      user: this.client.user
        ? { id: this.client.user.id, tag: this.client.user.tag }
        : null,
      guilds: this.client.guilds.cache.size,
      buffer: this.buffer.stats(),
      uptimeMs: this.client.uptime ?? 0,
      conversationId: this.convId,
      hook: hook
        ? {
            guildId: hook.guildId,
            guildName: hook.guildName,
            channelIds: hook.channelIds,
            channelNames: hook.channelNames,
            boundAt: hook.boundAt,
            persisted: Boolean(this.convId),
          }
        : null,
      working: this.opts.working?.snapshot() ?? [],
    };
  }

  listGuilds(): GatewayGuild[] {
    this.requireReady();
    return [...this.client.guilds.cache.values()]
      .map(toGatewayGuild)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  listChannels(guildId: string): GatewayChannel[] {
    this.requireReady();
    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) throw new GatewayError(`Guild not found: ${guildId}`, 404);

    return [...guild.channels.cache.values()]
      .filter((c) => isReadableTextChannel(c) || c.type === ChannelType.GuildForum)
      .map(toGatewayChannel)
      .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
  }

  /**
   * Hook this conversation to a guild (all text channels) or specific channels.
   * Persists under GROK_SESSION_ID so resume restores it. Other conversations
   * cannot bind the same channel while this session still exists.
   */
  bind(input: {
    guildId: string;
    channelIds?: string[];
    /** The Claude mod's watchers: owner if the channel is free, else listener. */
    role?: HookScope["role"];
    label?: string;
    routing?: number;
  }): HookScope {
    this.requireReady();
    const guild = this.client.guilds.cache.get(input.guildId);
    if (!guild) throw new GatewayError(`Guild not found: ${input.guildId}`, 404);

    let channelIds: string[] | null = null;
    let channelNames: string[] = [];
    if (input.channelIds && input.channelIds.length > 0) {
      channelIds = [];
      for (const id of input.channelIds) {
        const ch = guild.channels.cache.get(id);
        if (!ch) throw new GatewayError(`Channel not found in ${guild.name}: ${id}`, 404);
        if (!isReadableTextChannel(ch) && ch.type !== ChannelType.GuildForum) {
          throw new GatewayError(`Channel ${id} is not a text channel`, 400);
        }
        channelIds.push(id);
        channelNames.push(ch.name);
      }
    }

    const conv = this.convId;
    const hook: HookScope = {
      conversationId: conv ?? `ephemeral:${process.pid}`,
      guildId: guild.id,
      guildName: guild.name,
      channelIds,
      channelNames,
      boundAt: new Date().toISOString(),
      ...(input.role ? { role: input.role } : {}),
      ...(input.label ? { label: input.label } : {}),
      ...(input.routing ? { routing: input.routing } : {}),
    };

    if (this.opts.store && conv) {
      this.opts.store.save(hook);
    }
    if (this.opts.ref) this.opts.ref.current = hook;
    return hook;
  }

  unbind(): HookScope | null {
    const conv = this.convId;
    const previous = this.hook();
    if (this.opts.store && conv) this.opts.store.clear(conv);
    if (this.opts.ref) this.opts.ref.current = null;
    return previous;
  }

  /** Live buffer — messages seen since the gateway started, hook-scoped. */
  getRecent(opts: {
    channelId?: string;
    limit?: number;
    includeBots?: boolean;
  }): GatewayMessage[] {
    this.requireReady();
    const hook = this.requireHook();
    if (opts.channelId) this.assertChannelAllowed(opts.channelId);
    const recent = this.buffer.recent(opts);
    if (!hook || !this.enforceHook) return recent;
    return recent.filter((m) =>
      hookAllowsChannel(hook, {
        channelId: m.channelId,
        guildId: m.guildId,
        threadParentId: m.threadParentId,
      }),
    );
  }

  /** Fetch history from Discord REST. No watch hook — any text channel the bot can see. */
  async getMessages(input: GetMessagesInput): Promise<GatewayMessage[]> {
    this.requireReady();
    const channel = await this.resolveTextChannel(input.channelId);
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);

    const fetched = await channel.messages.fetch({
      limit,
      before: input.before,
      after: input.after,
    });

    let messages = [...fetched.values()].map(toGatewayMessage);
    // Discord returns newest-first; expose chronological
    messages = messages.reverse();

    if (input.includeBots === false) {
      messages = messages.filter((m) => !m.authorBot);
    }

    return messages;
  }

  async getMessage(
    channelId: string,
    messageId: string,
  ): Promise<GatewayMessage> {
    this.requireReady();
    const channel = await this.resolveTextChannel(channelId);
    const message = await channel.messages.fetch(messageId);
    return toGatewayMessage(message);
  }

  /** Post. No watch hook — any text channel the bot can see. */
  async sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
    this.requireReady();
    const content = formatPostedContent(input.from, input.content);
    const files = await resolveAttachmentFiles(input.files);

    const channel = await this.resolveTextChannel(input.channelId);

    const payload: {
      content: string;
      files?: AttachmentPayload[];
      reply?: { messageReference: string };
    } = { content };
    if (files) payload.files = files;
    if (input.replyToId) {
      payload.reply = { messageReference: input.replyToId };
    }

    const message = await channel.send(payload);

    const normalized = toGatewayMessage(message);
    this.buffer.push(normalized);
    await this.clearWorkingAfterSend(input.channelId, input.replyToId);
    return { message: normalized };
  }

  /**
   * 👀 + typing on a message. Hooked @mentions already call this.
   * Use for work started from history/poll.
   */
  async ackMessage(
    channelId: string,
    messageId: string,
  ): Promise<{ ok: true; channelId: string; messageId: string; emoji: string }> {
    this.requireReady();
    if (!this.opts.working) {
      return { ok: true, channelId, messageId, emoji: ACK_EMOJI };
    }
    return this.opts.working.start(channelId, messageId);
  }

  /** Remove 👀 / typing. send_message already does this. */
  async clearAck(
    channelId: string,
    messageId?: string,
  ): Promise<{ ok: true; channelId: string; cleared: string[] }> {
    this.requireReady();
    if (!this.opts.working) {
      return { ok: true, channelId, cleared: [] };
    }
    const { cleared } = await this.opts.working.complete(channelId, messageId);
    return { ok: true, channelId, cleared };
  }

  private async clearWorkingAfterSend(
    channelId: string,
    replyToId?: string,
  ): Promise<void> {
    if (!this.opts.working) return;
    if (replyToId) {
      const { cleared } = await this.opts.working.complete(channelId, replyToId);
      if (cleared.length > 0) return;
    }
    await this.opts.working.complete(channelId);
  }

  /** Pings / replies to this bot inside the hooked scope. */
  async getMentions(opts: { limit?: number } = {}): Promise<GatewayMessage[]> {
    this.requireReady();
    const hook = this.requireHook();
    if (!hook) return [];
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);

    const botId = this.client.user?.id;
    const live = this.buffer
      .recent({ limit: 200, includeBots: true })
      .filter((m) => shouldNotifyChannel(m, botId));

    const channelIds =
      hook.channelIds ??
      this.listChannels(hook.guildId)
        .filter((c) => c.type !== "forum" && c.type !== "category")
        .map((c) => c.id);
    const scanned = channelIds.slice(0, 15);
    const fromRest: GatewayMessage[] = [];
    for (const channelId of scanned) {
      try {
        const batch = await this.getMessages({
          channelId,
          limit: 30,
          includeBots: true,
        });
        fromRest.push(...batch.filter((m) => shouldNotifyChannel(m, botId)));
      } catch {
        /* channel gone or unreadable */
      }
    }

    const byId = new Map<string, GatewayMessage>();
    for (const m of [...fromRest, ...live]) byId.set(m.id, m);
    return [...byId.values()]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(-limit);
  }

  private requireHook(): HookScope | null {
    if (!this.enforceHook) return this.hook();
    const hook = this.hook();
    if (!hook) throw new GatewayError(NO_HOOK_MESSAGE, 403);
    return hook;
  }

  private assertChannelAllowed(channelId: string): void {
    const hook = this.requireHook();
    if (!hook) return;
    const cached = this.client.channels.cache.get(channelId);
    const guildId =
      cached && "guildId" in cached
        ? (cached.guildId as string | null)
        : hook.guildId;
    const threadParentId =
      cached && "parentId" in cached
        ? ((cached.parentId as string | null) ?? null)
        : null;
    if (
      !hookAllowsChannel(hook, {
        channelId,
        guildId: guildId ?? hook.guildId,
        threadParentId,
      })
    ) {
      throw new GatewayError(
        `Channel ${channelId} is outside this conversation's hook (${hook.guildName}${hook.channelNames.length ? ` / ${hook.channelNames.join(", ")}` : ""}).`,
        403,
      );
    }
  }

  private requireReady(): void {
    if (!this.client.isReady()) {
      throw new GatewayError("Discord client not ready yet", 503);
    }
  }

  private async resolveTextChannel(channelId: string): Promise<SendableText> {
    let channel =
      this.client.channels.cache.get(channelId) ??
      (await this.client.channels.fetch(channelId).catch(() => null));

    if (!channel) {
      throw new GatewayError(`Channel not found: ${channelId}`, 404);
    }

    if (!channel.isTextBased() || channel.isVoiceBased()) {
      throw new GatewayError(
        `Channel ${channelId} is not a text channel`,
        400,
      );
    }

    if (!("send" in channel)) {
      throw new GatewayError(`Channel ${channelId} is not sendable`, 400);
    }

    return channel as SendableText;
  }
}
