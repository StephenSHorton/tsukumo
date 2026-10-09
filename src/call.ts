#!/usr/bin/env bun
/**
 * One-shot Discord calls for the Claude Code mod (claude-mod/), over REST only.
 *
 *   bun run src/call.ts guilds
 *   bun run src/call.ts channels <guildId>
 *   bun run src/call.ts messages <channelId> [limit] [beforeMessageId]
 *   bun run src/call.ts message <channelId> <messageId>
 *   bun run src/call.ts send <channelId> <from> [replyToId] [--allow-duplicate]   # content on stdin; from "-" = TSUKUMO_YOUR_NAME
 *   bun run src/call.ts thread <channelId> <from> <name…>     # optional first message on stdin
 *   bun run src/call.ts budget                                # gateway logins left today
 *   bun run src/call.ts record                                # ledger entries (JSON array) on stdin
 *
 * With TSUKUMO_SESSION_ID set (the mod sets it), what a session posts is
 * recorded in the authorship ledger (src/lib/ledger.ts) as it posts, so a reply
 * to it finds its way back to that session.
 *
 * No gateway login: each call used to IDENTIFY, and the bot gets 1,000 a day
 * (running out disconnects everything and resets the token). Any channel the
 * bot can see; no watch hook needed. Prints one JSON line:
 * {"ok":true,"data":…} or {"ok":false,"error":"…"}.
 */
import { loadConfig, loadProjectEnv } from "./config.ts";
import { DiscordRest, createRest } from "./discord/rest.ts";
import { Ledger, type LedgerRole } from "./lib/ledger.ts";

const sessionId = process.env.TSUKUMO_SESSION_ID?.trim() || null;
const label = process.env.TSUKUMO_SESSION_LABEL?.trim() || undefined;

/** Notes what this session made; best effort, never fails the call. */
function recordPosted(messageIds: string[]): void {
  if (!sessionId) return;
  try {
    new Ledger().record(messageIds.map((id) => ({ key: `msg:${id}`, sessionId, role: "poster" as const, label, source: "mod" as const })));
  } catch (err) {
    console.error("[call] ledger record failed", err);
  }
}

// stdout carries the one result line only.
console.log = console.info = console.debug = console.warn = console.error;

function print(result: { ok: true; data: unknown } | { ok: false; error: string }): void {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith("--")));
const [op, ...args] = argv.filter((a) => !a.startsWith("--"));

async function run(): Promise<unknown> {
  await loadProjectEnv();
  const discord = new DiscordRest(createRest(loadConfig().DISCORD_TOKEN));
  switch (op) {
    case "guilds":
      return discord.guilds();
    case "channels":
      if (!args[0]) throw new Error("channels needs a guild id");
      return discord.channelsOf(args[0]);
    case "messages": {
      if (!args[0]) throw new Error("messages needs a channel id");
      const limit = args[1] ? Number(args[1]) : undefined;
      return discord.messages(args[0], { limit, before: args[2] || undefined });
    }
    case "message":
      if (!args[0] || !args[1]) throw new Error("message needs a channel id and a message id");
      return discord.message(args[0], args[1]);
    case "send": {
      if (!args[0] || !args[1]) throw new Error("send needs a channel id and a from name");
      const content = (await Bun.stdin.text()).trim();
      if (!content) throw new Error("send needs the message text on stdin");
      const sent = await discord.send({
        channelId: args[0],
        // "-" is the person at the keyboard (the mod's message box), not an agent.
        from: args[1] === "-" ? process.env.TSUKUMO_YOUR_NAME || "Me" : args[1],
        content,
        replyToId: args[2] || undefined,
        allowDuplicate: flags.has("--allow-duplicate"),
      });
      if (!sent.duplicate) recordPosted([sent.message.id]);
      return sent;
    }
    case "thread": {
      const [channelId, from, ...words] = args;
      const name = words.join(" ").trim();
      if (!channelId || !from || !name) throw new Error("thread needs a channel id, a from name and a thread name");
      const thread = await discord.thread({ channelId, name });
      const first = (await Bun.stdin.text()).trim();
      if (first) recordPosted([(await discord.send({ channelId: thread.id, from, content: first })).message.id]);
      return thread;
    }
    case "budget":
      return discord.loginBudget();
    case "record": {
      if (!sessionId) throw new Error("record needs TSUKUMO_SESSION_ID");
      const rows = JSON.parse((await Bun.stdin.text()) || "[]") as Array<{ key: string; role: LedgerRole }>;
      const roles = new Set<LedgerRole>(["author", "poster", "reviewer", "touched"]);
      const entries = rows
        .filter((r) => typeof r.key === "string" && /^(msg|pr|branch):/.test(r.key) && roles.has(r.role))
        .map((r) => ({ key: r.key.toLowerCase(), sessionId, role: r.role, label, source: "mod" as const }));
      new Ledger().record(entries);
      return { recorded: entries.length };
    }
    default:
      throw new Error(`Unknown op "${op ?? ""}". Use guilds, channels, messages, message, send, thread, budget or record.`);
  }
}

try {
  print({ ok: true, data: await run() });
  process.exit(0);
} catch (err) {
  print({ ok: false, error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
}
