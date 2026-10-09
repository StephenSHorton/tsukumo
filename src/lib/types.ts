/** Normalized message exposed to AI tools. */
export interface GatewayMessage {
  id: string;
  content: string;
  authorId: string;
  authorTag: string;
  authorUsername: string;
  authorBot: boolean;
  channelId: string;
  guildId: string | null;
  /** Parent channel when this message is in a thread */
  threadParentId: string | null;
  /** True when the Tsukumo bot was mentioned or replied to */
  mentionsBot: boolean;
  /** Parent message id when this is a reply */
  replyToId: string | null;
  createdAt: string;
  attachments: Array<{
    id: string;
    filename: string;
    url: string;
    contentType: string | null;
    size: number;
  }>;
}

export interface GatewayGuild {
  id: string;
  name: string;
  memberCount: number | null;
}

export interface GatewayChannel {
  id: string;
  name: string;
  type: string;
  guildId: string;
  parentId: string | null;
  topic: string | null;
  position: number;
}

export interface SendMessageInput {
  channelId: string;
  content: string;
  /**
   * Client that is speaking (Grok, Cursor, Claude, …). The bot nickname is
   * already says whose it is.
   */
  from: string;
  /** Reply to an existing message id in the same channel */
  replyToId?: string;
  /**
   * Absolute local file paths on the machine running the Discord client.
   * Max 10. Each must exist, be a regular file, and be 25 MB or smaller.
   */
  files?: string[];
}

export interface SendMessageResult {
  message: GatewayMessage;
}

export interface GetMessagesInput {
  channelId: string;
  /** 1–100, default 50 */
  limit?: number;
  before?: string;
  after?: string;
  /** Include bot messages (default true for tool use) */
  includeBots?: boolean;
}
