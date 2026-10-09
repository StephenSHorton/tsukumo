import type { Client } from "discord.js";
import {
  createDiscordClient,
  attachBuffer,
  waitUntilReady,
} from "./discord/client.ts";
import { MessageBuffer } from "./discord/buffer.ts";
import {
  WorkingPresence,
  createDiscordWorkingApi,
} from "./discord/working.ts";
import { TsukumoService } from "./gateway/service.ts";
import type { Config } from "./config.ts";
import {
  HookRef,
  HookStore,
  conversationId,
  hookAllowsChannel,
} from "./lib/hook.ts";
import { shouldNotifyChannel } from "./lib/channel.ts";
import type { GatewayMessage } from "./lib/types.ts";

export interface TsukumoSession {
  client: Client;
  service: TsukumoService;
  buffer: MessageBuffer;
  working: WorkingPresence;
  destroy: () => Promise<void>;
}

export interface OpenSessionOptions {
  /** MCP conversations enforce bind for live watch; HTTP scripts do not. */
  enforceHook?: boolean;
  /** Hooked @mentions of the bot (for grok-fork `--channels`). */
  onChannelInbound?: (msg: GatewayMessage) => void;
  /** Every message in the hooked place, mentions or not (the Claude mod's live feed). */
  onHookedMessage?: (msg: GatewayMessage) => void;
  /** 👀 + typing on hooked mentions (default true). The watcher turns it off: it never posts, so nothing would clear it. */
  ackInbound?: boolean;
}

/** Log into Discord and wire the service layer. Used by MCP (and optional HTTP serve). */
export async function openSession(
  config: Config,
  opts: OpenSessionOptions = {},
): Promise<TsukumoSession> {
  const enforceHook = opts.enforceHook === true;
  const store = enforceHook ? new HookStore() : undefined;
  const conv = conversationId();
  const ref = new HookRef(store && conv ? store.load(conv) : null);

  const client = createDiscordClient();
  const buffer = new MessageBuffer(config.TSUKUMO_BUFFER_SIZE);
  const working = new WorkingPresence(createDiscordWorkingApi(client));
  attachBuffer(
    client,
    buffer,
    (msg) => {
      if (!enforceHook) return true;
      const hook = ref.current;
      if (!hook) return false;
      return hookAllowsChannel(hook, {
        channelId: msg.channelId,
        guildId: msg.guildId,
        threadParentId: msg.threadParentId,
      });
    },
    (msg) => {
      opts.onHookedMessage?.(msg);
      if (!shouldNotifyChannel(msg, client.user?.id)) return;
      if (!opts.onChannelInbound) return;
      // Presence first so Discord shows 👀 / typing before the agent turn.
      // Do not await — a stuck reaction must not block the wake.
      if (opts.ackInbound !== false) void working.start(msg.channelId, msg.id);
      opts.onChannelInbound(msg);
    },
  );

  await client.login(config.DISCORD_TOKEN);
  await waitUntilReady(client);

  const service = new TsukumoService(client, buffer, {
    store,
    ref,
    conversationId: conv,
    enforceHook,
    working,
  });

  return {
    client,
    service,
    buffer,
    working,
    destroy: async () => {
      await working.completeAll();
      client.destroy();
    },
  };
}
