import type { GatewayMessage } from "../lib/types.ts";

/**
 * Per-channel ring buffer of recent messages seen over the gateway.
 * Lets AI tools pull "what's been said lately" without a Discord REST round-trip.
 */
export class MessageBuffer {
  private channels = new Map<string, GatewayMessage[]>();
  private readonly maxPerChannel: number;

  constructor(maxPerChannel = 200) {
    this.maxPerChannel = maxPerChannel;
  }

  push(msg: GatewayMessage): void {
    let list = this.channels.get(msg.channelId);
    if (!list) {
      list = [];
      this.channels.set(msg.channelId, list);
    }
    list.push(msg);
    if (list.length > this.maxPerChannel) {
      list.splice(0, list.length - this.maxPerChannel);
    }
  }

  /**
   * Recent messages for a channel, oldest → newest.
   * If channelId is omitted, returns a flat merge across channels (still capped).
   */
  recent(opts: {
    channelId?: string;
    limit?: number;
    includeBots?: boolean;
  } = {}): GatewayMessage[] {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), this.maxPerChannel);
    const includeBots = opts.includeBots ?? true;

    let msgs: GatewayMessage[];
    if (opts.channelId) {
      msgs = [...(this.channels.get(opts.channelId) ?? [])];
    } else {
      msgs = [...this.channels.values()].flat().sort((a, b) =>
        a.createdAt.localeCompare(b.createdAt),
      );
    }

    if (!includeBots) {
      msgs = msgs.filter((m) => !m.authorBot);
    }

    return msgs.slice(-limit);
  }

  stats(): { channels: number; messages: number } {
    let messages = 0;
    for (const list of this.channels.values()) messages += list.length;
    return { channels: this.channels.size, messages };
  }
}
