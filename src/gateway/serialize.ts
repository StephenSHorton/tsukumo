import {
  ChannelType,
  type Channel,
  type Guild,
  type Message,
  type GuildBasedChannel,
} from "discord.js";
import type {
  GatewayChannel,
  GatewayGuild,
  GatewayMessage,
} from "../lib/types.ts";

const CHANNEL_TYPE_NAME: Record<number, string> = {
  [ChannelType.GuildText]: "text",
  [ChannelType.GuildVoice]: "voice",
  [ChannelType.GuildCategory]: "category",
  [ChannelType.GuildAnnouncement]: "announcement",
  [ChannelType.AnnouncementThread]: "announcement_thread",
  [ChannelType.PublicThread]: "public_thread",
  [ChannelType.PrivateThread]: "private_thread",
  [ChannelType.GuildStageVoice]: "stage",
  [ChannelType.GuildForum]: "forum",
  [ChannelType.GuildMedia]: "media",
  [ChannelType.DM]: "dm",
  [ChannelType.GroupDM]: "group_dm",
};

export function toGatewayMessage(message: Message): GatewayMessage {
  const botId = message.client.user?.id;
  const mentionsBot = Boolean(
    botId &&
      (message.mentions.users.has(botId) ||
        message.mentions.repliedUser?.id === botId ||
        message.content.includes(`<@${botId}>`) ||
        message.content.includes(`<@!${botId}>`)),
  );
  const channel = message.channel;
  const threadParentId =
    "parentId" in channel && typeof channel.parentId === "string"
      ? channel.parentId
      : null;

  return {
    id: message.id,
    content: message.content,
    authorId: message.author.id,
    authorTag: message.author.tag,
    authorUsername: message.author.username,
    authorBot: message.author.bot,
    channelId: message.channel.id,
    guildId: message.guildId,
    threadParentId,
    mentionsBot,
    replyToId: message.reference?.messageId ?? null,
    createdAt: message.createdAt.toISOString(),
    attachments: [...message.attachments.values()].map((a) => ({
      id: a.id,
      filename: a.name,
      url: a.url,
      contentType: a.contentType,
      size: a.size,
    })),
  };
}

export function toGatewayGuild(guild: Guild): GatewayGuild {
  return {
    id: guild.id,
    name: guild.name,
    memberCount: guild.memberCount ?? null,
  };
}

export function toGatewayChannel(channel: GuildBasedChannel): GatewayChannel {
  const topic =
    "topic" in channel && typeof channel.topic === "string"
      ? channel.topic
      : null;

  return {
    id: channel.id,
    name: channel.name,
    type: CHANNEL_TYPE_NAME[channel.type] ?? String(channel.type),
    guildId: channel.guildId,
    parentId: channel.parentId,
    topic,
    position: "position" in channel ? (channel.position as number) : 0,
  };
}

export function isReadableTextChannel(channel: Channel): boolean {
  return (
    channel.type === ChannelType.GuildText ||
    channel.type === ChannelType.GuildAnnouncement ||
    channel.type === ChannelType.PublicThread ||
    channel.type === ChannelType.PrivateThread ||
    channel.type === ChannelType.DM
  );
}
