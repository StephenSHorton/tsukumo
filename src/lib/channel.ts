import type { GatewayMessage } from "./types.ts";

/** Claude Code / grok-fork `--channels` inbound method. */
export const CLAUDE_CHANNEL_METHOD = "notifications/claude/channel";

export interface ChannelNotification {
  method: typeof CLAUDE_CHANNEL_METHOD;
  params: {
    content: string;
    meta: Record<string, string>;
  };
}

/**
 * Mentions/replies to us in a hooked channel become a same-session turn.
 * Other bots (Robo AI, etc.) count. Our own posts never do — that would
 * loop. If `botId` is missing, fall back to humans only.
 */
export function shouldNotifyChannel(
  msg: GatewayMessage,
  botId?: string | null,
): boolean {
  if (!msg.mentionsBot || msg.content.trim().length === 0) return false;
  if (botId) return msg.authorId !== botId;
  return !msg.authorBot;
}

/** Shape grok-fork `ChannelInbound::from_params` accepts. Meta keys must be identifiers. */
export function toChannelNotification(msg: GatewayMessage): ChannelNotification {
  const meta: Record<string, string> = {
    chat_id: msg.channelId,
    message_id: msg.id,
    user: msg.authorUsername,
    user_id: msg.authorId,
    ts: msg.createdAt,
  };
  if (msg.guildId) meta.guild_id = msg.guildId;
  if (msg.replyToId) meta.reply_to_id = msg.replyToId;
  return {
    method: CLAUDE_CHANNEL_METHOD,
    params: {
      content: msg.content,
      meta,
    },
  };
}
