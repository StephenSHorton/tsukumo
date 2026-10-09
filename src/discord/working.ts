import { Routes } from "discord-api-types/v10";
import type { Client } from "discord.js";

/** Discord unicode :eyes: — "I saw this and I'm on it." */
export const ACK_EMOJI = "👀";

/** Discord typing indicators last ~10s; refresh before they expire. */
export const TYPING_INTERVAL_MS = 8_000;

/** Drop 👀 + typing if the agent never posts (stuck / chose not to reply). */
export const WORKING_TIMEOUT_MS = 15 * 60 * 1000;

export interface WorkingApi {
  react(channelId: string, messageId: string, emoji: string): Promise<void>;
  unreact(channelId: string, messageId: string, emoji: string): Promise<void>;
  sendTyping(channelId: string): Promise<void>;
}

export interface WorkingSnapshot {
  channelId: string;
  messageIds: string[];
}

type TimerHandle = unknown;

export interface TimerFns {
  setTimeout: (fn: () => void, ms: number) => TimerHandle;
  clearTimeout: (id: TimerHandle) => void;
  setInterval: (fn: () => void, ms: number) => TimerHandle;
  clearInterval: (id: TimerHandle) => void;
}

const defaultTimers: TimerFns = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (id) => globalThis.clearTimeout(id as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
  clearInterval: (id) => globalThis.clearInterval(id as ReturnType<typeof setInterval>),
};

type Ack = {
  messageId: string;
  cancelled: boolean;
  timeout: TimerHandle | null;
};

type ChannelWork = {
  messages: Map<string, Ack>;
  typingTimer: TimerHandle | null;
  typingInFlight: boolean;
};

const logErr = (...args: unknown[]) => console.error("[tsukumo]", ...args);

/**
 * Per-channel "I'm working" presence: 👀 on the source message(s) plus a
 * typing indicator that refreshes until send_message, clear, or timeout.
 */
export class WorkingPresence {
  private readonly channels = new Map<string, ChannelWork>();
  private readonly emoji: string;
  private readonly typingIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly timers: TimerFns;

  constructor(
    private readonly api: WorkingApi,
    opts: {
      emoji?: string;
      typingIntervalMs?: number;
      timeoutMs?: number;
      timers?: TimerFns;
    } = {},
  ) {
    this.emoji = opts.emoji ?? ACK_EMOJI;
    this.typingIntervalMs = opts.typingIntervalMs ?? TYPING_INTERVAL_MS;
    this.timeoutMs = opts.timeoutMs ?? WORKING_TIMEOUT_MS;
    this.timers = opts.timers ?? defaultTimers;
  }

  snapshot(): WorkingSnapshot[] {
    return [...this.channels.entries()].map(([channelId, work]) => ({
      channelId,
      messageIds: [...work.messages.keys()],
    }));
  }

  /**
   * Ack a message and keep typing in its channel. Idempotent per message:
   * a second start only refreshes the timeout and typing.
   */
  async start(channelId: string, messageId: string): Promise<{
    ok: true;
    channelId: string;
    messageId: string;
    emoji: string;
  }> {
    const work = this.ensureChannel(channelId);
    const existing = work.messages.get(messageId);
    if (existing && !existing.cancelled) {
      this.armTimeout(channelId, existing);
      this.ensureTyping(channelId, work);
      return { ok: true, channelId, messageId, emoji: this.emoji };
    }

    const ack: Ack = { messageId, cancelled: false, timeout: null };
    work.messages.set(messageId, ack);
    this.armTimeout(channelId, ack);
    this.ensureTyping(channelId, work);
    logErr(`ack ${this.emoji} ${channelId}/${messageId}`);

    await this.safe(() => this.api.react(channelId, messageId, this.emoji));
    if (ack.cancelled) {
      const current = this.channels.get(channelId)?.messages.get(messageId);
      if (current && current !== ack) {
        return { ok: true, channelId, messageId, emoji: this.emoji };
      }
      await this.safe(() => this.api.unreact(channelId, messageId, this.emoji));
    }

    return { ok: true, channelId, messageId, emoji: this.emoji };
  }

  /**
   * Remove 👀 and stop typing when nothing in the channel is still in flight.
   * Omit `messageId` to clear every ack in the channel.
   */
  async complete(
    channelId: string,
    messageId?: string,
  ): Promise<{ cleared: string[] }> {
    const work = this.channels.get(channelId);
    if (!work) return { cleared: [] };

    const ids = messageId ? [messageId] : [...work.messages.keys()];
    const cleared: string[] = [];
    for (const id of ids) {
      const ack = work.messages.get(id);
      if (!ack) continue;
      ack.cancelled = true;
      if (ack.timeout != null) this.timers.clearTimeout(ack.timeout);
      work.messages.delete(id);
      cleared.push(id);
    }

    if (work.messages.size === 0) {
      this.stopTyping(work);
      this.channels.delete(channelId);
    }
    for (const id of cleared) {
      await this.safe(() => this.api.unreact(channelId, id, this.emoji));
    }
    if (cleared.length > 0) {
      logErr(`clear ${this.emoji} ${channelId} ${cleared.join(",")}`);
    }
    return { cleared };
  }

  async completeAll(): Promise<void> {
    for (const channelId of [...this.channels.keys()]) {
      await this.complete(channelId);
    }
  }

  private ensureChannel(channelId: string): ChannelWork {
    let work = this.channels.get(channelId);
    if (!work) {
      work = { messages: new Map(), typingTimer: null, typingInFlight: false };
      this.channels.set(channelId, work);
    }
    return work;
  }

  private armTimeout(channelId: string, ack: Ack): void {
    if (ack.timeout != null) this.timers.clearTimeout(ack.timeout);
    ack.timeout = this.timers.setTimeout(() => {
      logErr(`ack timeout ${channelId}/${ack.messageId}`);
      void this.complete(channelId, ack.messageId);
    }, this.timeoutMs);
  }

  private ensureTyping(channelId: string, work: ChannelWork): void {
    void this.tickTyping(channelId, work);
    if (work.typingTimer != null) return;
    work.typingTimer = this.timers.setInterval(() => {
      void this.tickTyping(channelId, work);
    }, this.typingIntervalMs);
  }

  private stopTyping(work: ChannelWork): void {
    if (work.typingTimer != null) {
      this.timers.clearInterval(work.typingTimer);
      work.typingTimer = null;
    }
  }

  private async tickTyping(channelId: string, work: ChannelWork): Promise<void> {
    if (work.typingInFlight || work.messages.size === 0) return;
    work.typingInFlight = true;
    try {
      await this.api.sendTyping(channelId);
    } catch (err) {
      logErr("sendTyping failed", err);
    } finally {
      work.typingInFlight = false;
    }
  }

  private async safe(fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logErr("working presence", message);
    }
  }
}

function encodeReactionEmoji(emoji: string): string {
  return encodeURIComponent(emoji);
}

async function fetchTextChannel(client: Client, channelId: string) {
  const channel =
    client.channels.cache.get(channelId) ??
    (await client.channels.fetch(channelId).catch(() => null));
  if (!channel || !channel.isTextBased() || !("sendTyping" in channel)) {
    throw new Error(`Channel ${channelId} is not a text channel`);
  }
  return channel;
}

/** discord.js REST implementation used by the live MCP / HTTP session. */
export function createDiscordWorkingApi(client: Client): WorkingApi {
  return {
    async react(channelId, messageId, emoji) {
      const channel = await fetchTextChannel(client, channelId);
      const message = await channel.messages.fetch(messageId);
      await message.react(emoji);
    },
    async unreact(channelId, messageId, emoji) {
      const userId = client.user?.id;
      try {
        const channel = await fetchTextChannel(client, channelId);
        const message = await channel.messages.fetch(messageId);
        const reaction =
          message.reactions.resolve(emoji) ??
          message.reactions.cache.find(
            (r) => r.emoji.name === emoji || r.emoji.toString() === emoji,
          );
        if (reaction && userId) {
          await reaction.users.remove(userId);
          return;
        }
      } catch {
        /* fall through to REST — cache misses / unknown message */
      }
      await client.rest.delete(
        Routes.channelMessageOwnReaction(
          channelId,
          messageId,
          encodeReactionEmoji(emoji),
        ),
      );
    },
    async sendTyping(channelId) {
      const channel = await fetchTextChannel(client, channelId);
      await channel.sendTyping();
    },
  };
}
