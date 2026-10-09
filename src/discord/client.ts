import {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  MessageType,
  type Message,
} from "discord.js";
import type { MessageBuffer } from "./buffer.ts";
import { toGatewayMessage } from "../gateway/serialize.ts";
import type { GatewayMessage } from "../lib/types.ts";
import { log } from "../lib/logger.ts";

export function createDiscordClient(): Client {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Channel, Partials.Message],
  });
}

/** Wire live traffic into the message buffer. */
export function attachBuffer(
  client: Client,
  buffer: MessageBuffer,
  accept: (msg: GatewayMessage) => boolean = () => true,
  onAccepted?: (msg: GatewayMessage) => void,
): void {
  client.on(Events.MessageCreate, (message: Message) => {
    // A thread's starter echo is an empty message that "replies" to the
    // thread's first post (often ours), which reads as a mention. Skip it,
    // and anything else with nothing in it.
    if (message.type === MessageType.ThreadStarterMessage) return;
    if (!message.content.trim() && message.attachments.size === 0 && message.embeds.length === 0) return;
    try {
      const msg = toGatewayMessage(message);
      if (!accept(msg)) return;
      buffer.push(msg);
      onAccepted?.(msg);
    } catch (err) {
      log.warn("Failed to buffer message", err);
    }
  });
}

export function waitUntilReady(client: Client): Promise<Client> {
  if (client.isReady()) return Promise.resolve(client);
  return new Promise((resolve, reject) => {
    const onReady = () => {
      cleanup();
      resolve(client);
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const cleanup = () => {
      client.off(Events.ClientReady, onReady);
      client.off(Events.Error, onError);
    };
    client.once(Events.ClientReady, onReady);
    client.once(Events.Error, onError);
  });
}
