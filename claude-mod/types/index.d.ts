export type Channel = { id: string; name: string }

export type Watch = {
  status: 'starting' | 'watching' | 'stopped' | 'error'
  channelIds: string[]
  channels: Channel[]
  guildName: string
  bot: string
  /** The bot's own user id, to tell its posts apart in the feed. */
  botId?: string
  /** This chat's standing in the channel; several chats can listen, one owns. */
  role?: 'owner' | 'listener'
  /** Threads this chat answers. */
  threadIds?: string[]
  /** Who owns the channel, when it isn't this chat. */
  owner?: string | null
  /** Other chats listening here. */
  listeners?: number
  error?: string
}

/** One message in the pane's live feed of the watched channel. */
export type FeedMessage = {
  id: string
  channelId: string
  channelName: string
  authorId: string
  author: string
  isBot: boolean
  /** Posted by Tsukumo itself; `from` is the bold name it was posted under (Claude, Sam, …). */
  isSelf: boolean
  from?: string
  text: string
  createdAt: string
  mentionsBot: boolean
  files: number
}

export type Sender = { id: string; name: string }

/** Who wakes the session: everyone but `blocked`, or only `allowed`. */
export type WakeMode = 'everyone' | 'allowlist'

export type Mention = {
  id: string
  channelId: string
  channelName: string
  authorId: string
  authorName: string
  authorBot: boolean
  content: string
  createdAt: string
  /** `elsewhere`: another session answers it (`routedTo`). `skipped`: this chat chose not to reply. */
  status: 'delivered' | 'held' | 'dismissed' | 'elsewhere' | 'skipped'
  routedTo?: string
  /** Why the watcher routed it here (or elsewhere): "about webapp#1437, which this chat opened". */
  reason?: string
  /** Held because nobody owns the place, rather than by this chat's block/allow rules. */
  unowned?: boolean
  /** Delivered, and its wake prompt's turn hasn't started yet (it may be queued behind another). */
  awaitingStart?: boolean
  /** The turn its wake prompt started; when that turn ends, 👀 and typing come off. */
  turnId?: string
}

declare module 'claude-code' {
  interface PluginState {
    'tsukumo-discord': {
      watch: Watch | null
      mentions: Mention[]
      allowed: Sender[]
      blocked: Sender[]
      mode: WakeMode
      /** Channel id → name, learned from list_channels and the watcher, for the inline rows. */
      channelNames: Record<string, string>
      /** tool_use_ids of Discord rows the person expanded. */
      expandedRows: string[]
      /** The watched channel's recent messages, oldest first. */
      feed: FeedMessage[]
      /** The pane's "who wakes this chat" settings are unfolded. */
      settingsOpen: boolean
      /** Bumped after each send so the pane's message box starts empty. */
      composerRev: number
    }
  }
}
