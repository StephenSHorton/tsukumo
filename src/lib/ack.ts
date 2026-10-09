/** A request from the Claude Code mod to show 👀 + typing on a delivered mention. */
export interface AckRequest {
  channelId: string;
  messageId: string;
}

const SNOWFLAKE = /^\d{15,22}$/;

/** Parses the mod's `POST /ack` body; null when it isn't two snowflakes. */
export function parseAckRequest(body: string): AckRequest | null {
  try {
    const parsed = JSON.parse(body) as Partial<AckRequest>;
    if (typeof parsed.channelId !== "string" || !SNOWFLAKE.test(parsed.channelId)) return null;
    if (typeof parsed.messageId !== "string" || !SNOWFLAKE.test(parsed.messageId)) return null;
    return { channelId: parsed.channelId, messageId: parsed.messageId };
  } catch {
    return null;
  }
}
