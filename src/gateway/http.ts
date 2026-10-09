import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { TsukumoService } from "./service.ts";
import { GatewayError } from "./service.ts";
import { log } from "../lib/logger.ts";

type Vars = { service: TsukumoService; token: string };

export function createHttpApp(service: TsukumoService, apiToken: string) {
  const app = new Hono<{ Variables: Vars }>();

  app.use("*", async (c, next) => {
    c.set("service", service);
    c.set("token", apiToken);
    await next();
  });

  // Auth on all /v1/* routes
  app.use("/v1/*", async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const match = /^Bearer\s+(.+)$/i.exec(header);
    const provided =
      match?.[1]?.trim() ?? c.req.header("x-tsukumo-token") ?? "";
    if (!provided || provided !== c.get("token")) {
      throw new HTTPException(401, { message: "Unauthorized" });
    }
    await next();
  });

  app.get("/health", (c) => {
    const status = c.get("service").status();
    return c.json(status, status.ok ? 200 : 503);
  });

  app.get("/v1/status", (c) => c.json(c.get("service").status()));

  app.get("/v1/guilds", (c) => {
    return c.json({ guilds: c.get("service").listGuilds() });
  });

  app.get("/v1/guilds/:guildId/channels", (c) => {
    const guildId = c.req.param("guildId");
    return c.json({ channels: c.get("service").listChannels(guildId) });
  });

  app.get("/v1/channels/:channelId/messages", async (c) => {
    const channelId = c.req.param("channelId");
    const limit = num(c.req.query("limit"), 50);
    const before = c.req.query("before") ?? undefined;
    const after = c.req.query("after") ?? undefined;
    const includeBots = c.req.query("include_bots") !== "false";

    const messages = await c.get("service").getMessages({
      channelId,
      limit,
      before,
      after,
      includeBots,
    });
    return c.json({ messages });
  });

  app.get("/v1/channels/:channelId/messages/:messageId", async (c) => {
    const message = await c.get("service").getMessage(
      c.req.param("channelId"),
      c.req.param("messageId"),
    );
    return c.json({ message });
  });

  /** Live buffer since gateway start (no Discord REST). */
  app.get("/v1/recent", (c) => {
    const channelId = c.req.query("channel_id") ?? undefined;
    const limit = num(c.req.query("limit"), 50);
    const includeBots = c.req.query("include_bots") !== "false";
    const messages = c.get("service").getRecent({
      channelId,
      limit,
      includeBots,
    });
    return c.json({ messages });
  });

  const sendSchema = z.object({
    from: z
      .string()
      .min(1)
      .max(80)
      .describe("Client (Grok, Cursor, Claude, …); the bot's nickname already says whose it is"),
    content: z.string().min(1).max(2000),
    reply_to_id: z.string().optional(),
    files: z
      .array(z.string())
      .max(10)
      .optional()
      .describe(
        "Absolute local file paths on this machine (max 10, each a regular file ≤ 25 MB)",
      ),
  });

  app.post("/v1/channels/:channelId/messages", async (c) => {
    const body = sendSchema.parse(await c.req.json());
    const result = await c.get("service").sendMessage({
      channelId: c.req.param("channelId"),
      from: body.from,
      content: body.content,
      replyToId: body.reply_to_id,
      files: body.files,
    });
    log.info(
      `posted → ${c.req.param("channelId")}: ${body.content.slice(0, 80)}`,
    );
    return c.json(result, 201);
  });

  app.onError((err, c) => {
    if (err instanceof GatewayError) {
      return c.json({ error: err.message }, err.status as 400);
    }
    if (err instanceof HTTPException) {
      return c.json({ error: err.message }, err.status);
    }
    if (err instanceof z.ZodError) {
      return c.json(
        { error: "Invalid request", details: err.flatten() },
        400,
      );
    }
    log.error("HTTP error", err);
    return c.json({ error: "Internal server error" }, 500);
  });

  return app;
}

function num(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}
