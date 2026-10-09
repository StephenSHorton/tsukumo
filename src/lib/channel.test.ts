import { describe, expect, test } from "bun:test";
import {
  CLAUDE_CHANNEL_METHOD,
  shouldNotifyChannel,
  toChannelNotification,
} from "./channel.ts";
import type { GatewayMessage } from "./types.ts";

function msg(over: Partial<GatewayMessage>): GatewayMessage {
  return {
    id: "99",
    content: "<@100000000000000007> hey",
    authorId: "1",
    authorTag: "poppingpopper#0",
    authorUsername: "poppingpopper",
    authorBot: false,
    channelId: "100000000000000002",
    guildId: "100000000000000006",
    threadParentId: null,
    mentionsBot: true,
    replyToId: null,
    createdAt: "2026-09-10T16:08:37.000Z",
    attachments: [],
    ...over,
  };
}

const US = "100000000000000007";

describe("channel notify", () => {
  test("without botId, only human mentions", () => {
    expect(shouldNotifyChannel(msg({}))).toBe(true);
    expect(shouldNotifyChannel(msg({ mentionsBot: false }))).toBe(false);
    expect(shouldNotifyChannel(msg({ authorBot: true }))).toBe(false);
    expect(shouldNotifyChannel(msg({ content: "   " }))).toBe(false);
  });

  test("with botId, other bots that mention us wake; our own posts do not", () => {
    expect(shouldNotifyChannel(msg({}), US)).toBe(true);
    expect(
      shouldNotifyChannel(
        msg({
          authorBot: true,
          authorId: "100000000000000013",
          authorUsername: "Robo AI",
        }),
        US,
      ),
    ).toBe(true);
    expect(
      shouldNotifyChannel(
        msg({ authorBot: true, authorId: US, authorUsername: "Tsukumo" }),
        US,
      ),
    ).toBe(false);
    expect(shouldNotifyChannel(msg({ mentionsBot: false }), US)).toBe(false);
    expect(shouldNotifyChannel(msg({ content: "   " }), US)).toBe(false);
  });

  test("payload matches grok-fork ChannelInbound", () => {
    const n = toChannelNotification(msg({}));
    expect(n.method).toBe(CLAUDE_CHANNEL_METHOD);
    expect(n.params.content).toContain("hey");
    expect(n.params.meta.chat_id).toBe("100000000000000002");
    expect(n.params.meta.message_id).toBe("99");
    expect(n.params.meta.user).toBe("poppingpopper");
    expect(Object.keys(n.params.meta).every((k) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k))).toBe(
      true,
    );
  });
});
