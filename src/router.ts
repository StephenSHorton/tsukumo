#!/usr/bin/env bun
/**
 * The Tsukumo router: one Discord gateway connection shared by every Claude
 * session that watches a channel, instead of one per session.
 *
 * Not a service. The first `src/attach.ts` that finds no router starts one
 * (detached), and it exits 30 minutes after the last session detaches. While
 * it's down nothing is lost: it saves the last message seen in each channel
 * and, on its next start, routes everything since through REST.
 *
 * Unix socket at .watch/router.sock:
 *   GET  /status                       who's attached, which channels
 *   POST /attach {sessionId,label,channelIds}   → a stream of JSON event lines
 *   POST /control {sessionId,op,…}     ack · own · listen · claim-thread ·
 *                                      release-thread · take · hold
 *   POST /stop                         release every claim and exit
 */
import { existsSync, linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ChannelType } from "discord.js";
import { loadConfig, loadProjectEnv, projectRoot } from "./config.ts";
import { DiscordRest, createRest } from "./discord/rest.ts";
import { HookStore } from "./lib/hook.ts";
import { Ledger } from "./lib/ledger.ts";
import { PrMetaCache } from "./lib/prmeta.ts";
import { extractPrRefs, repoFromTopic } from "./lib/refs.ts";
import { pruneTaken } from "./lib/take.ts";
import { parseAckRequest } from "./lib/ack.ts";
import type { GatewayMessage } from "./lib/types.ts";
import { openSession, type TsukumoSession } from "./session.ts";
import { RouterCore, type RouterEvent, type Sink } from "./router/core.ts";

export const WATCH_DIR = join(projectRoot, ".watch");
export const ROUTER_SOCKET = join(WATCH_DIR, "router.sock");
export const ROUTER_PID = join(WATCH_DIR, "router.pid");
export const ROUTER_ERROR = join(WATCH_DIR, "router-error.txt");
const STATE_FILE = join(WATCH_DIR, "router-state.json");

/** Exit after this long with nobody attached. */
const LINGER_MS = 30 * 60_000;
/** Below this many gateway logins left today, don't connect. */
const MIN_LOGINS_LEFT = 25;
const HISTORY_LIMIT = 25;

// The router has no terminal; everything goes to its log (stderr).
console.log = console.info = console.debug = console.warn = console.error;
const log = (...args: unknown[]) => console.error(`[router ${new Date().toISOString()}]`, ...args);

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function socketAnswers(): Promise<boolean> {
  try {
    return (await fetch("http://router/status", { unix: ROUTER_SOCKET } as RequestInit)).ok;
  } catch {
    return false;
  }
}

/**
 * One router per checkout. The pid file appears whole or not at all (written
 * aside, then hard-linked into place, which fails if it exists), so a racing
 * starter never reads it half-written; a live router answering on the socket
 * is the real test, and a dead one's file is reclaimed.
 */
async function claimSingleInstance(): Promise<boolean> {
  mkdirSync(WATCH_DIR, { recursive: true });
  if (await socketAnswers()) return false;
  const tmp = `${ROUTER_PID}.${process.pid}.tmp`;
  writeFileSync(tmp, String(process.pid));
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        linkSync(tmp, ROUTER_PID);
        return true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        const pid = Number(readFileSync(ROUTER_PID, "utf8").trim());
        if (pid && pidAlive(pid)) return false;
        // Its owner is gone. Only one of several reclaimers wins the next link.
        rmSync(ROUTER_PID, { force: true });
        await Bun.sleep(20 + Math.floor(Math.random() * 80));
      }
    }
    return false;
  } finally {
    rmSync(tmp, { force: true });
  }
}

interface State {
  /** Last message id seen in each watched channel: where catch-up starts next time. */
  watermarks: Record<string, string>;
}

function readState(): State {
  try {
    return { watermarks: {}, ...(JSON.parse(readFileSync(STATE_FILE, "utf8")) as Partial<State>) };
  } catch {
    return { watermarks: {} };
  }
}

const later = (a: string, b: string) => a.length > b.length || (a.length === b.length && a > b);
/** The smallest Discord id at a given time, for "messages after 6 hours ago". */
const snowflakeAt = (ms: number) => ((BigInt(ms) - 1420070400000n) << 22n).toString();
/** How far back a catch-up looks, whatever the saved position says. */
const CATCH_UP_WINDOW_MS = 6 * 3_600_000;

async function main(): Promise<void> {
  if (!(await claimSingleInstance())) {
    log("another router is running; exiting");
    process.exit(0);
  }
  rmSync(ROUTER_ERROR, { force: true });

  await loadProjectEnv();
  const config = loadConfig();
  const rest = new DiscordRest(createRest(config.DISCORD_TOKEN));
  const budget = await rest.loginBudget().catch(() => null);
  if (budget && budget.remaining < MIN_LOGINS_LEFT) {
    const minutes = Math.ceil(budget.resetAfterMs / 60_000);
    const message = `Discord login budget nearly used up (${budget.remaining} of ${budget.total} left; resets in ${minutes} min). Not connecting.`;
    writeFileSync(ROUTER_ERROR, message);
    rmSync(ROUTER_PID, { force: true });
    log(message);
    process.exit(1);
  }

  const state = readState();
  let stateDirty = false;
  const dirs = Object.fromEntries(
    ["taken", "done", "pending", "held", "rerouted", "flagged", "seen", "deferred"].map((d) => [d, join(WATCH_DIR, d)]),
  ) as Record<"taken" | "done" | "pending" | "held" | "rerouted" | "flagged" | "seen" | "deferred", string>;
  // Two days: well past the longest deferral (12 h) plus the sweep's lookback (6 h).
  for (const dir of Object.values(dirs)) pruneTaken(dir, 2 * 86_400_000);

  const store = new HookStore();
  const ledger = new Ledger();
  const prmeta = new PrMetaCache();
  let session: TsukumoSession | null = null;
  const cached = (id: string) => session?.client.channels.cache.get(id);

  const core: RouterCore = new RouterCore({
    store,
    ledger,
    dirs,
    now: Date.now,
    botId: () => session?.client.user?.id,
    channelName: (id) => {
      const c = cached(id);
      return c && "name" in c && c.name ? c.name : id;
    },
    parentOf: (id) => {
      const c = cached(id);
      return c?.isThread() ? c.parentId : null;
    },
    repoOf: (id) => {
      const c = cached(id);
      return repoFromTopic(c && "topic" in c ? (c.topic as string | null) : null);
    },
    fetchMessage: (channelId, messageId) => rest.message(channelId, messageId),
    enrich: async (route, msg) => {
      // Only for mentions nobody owns that name a PR: was it a Cursor cloud agent's?
      if (!route.to || !route.reason.startsWith("no chat owns this")) return route;
      const watched = core.watchedChannelOf(msg);
      const c = cached(watched);
      const repo = repoFromTopic(c && "topic" in c ? (c.topic as string | null) : null);
      for (const ref of extractPrRefs(msg.content, { defaultRepo: repo }).slice(0, 2)) {
        // Never hold routing on GitHub for long; a slow lookup still fills the cache for next time.
        const meta = await Promise.race([prmeta.get(ref), Bun.sleep(1_500).then(() => null)]);
        if (meta?.cursorAgentUrl) {
          return {
            ...route,
            reason: `about ${ref.repo.split("/")[1]}#${ref.number}, which a Cursor cloud agent opened (${meta.cursorAgentUrl}); front desk`,
          };
        }
      }
      return route;
    },
  });

  const seen = (msg: GatewayMessage) => {
    // Watched channels and threads under them each keep their own position.
    if (!core.watchedChannels().has(core.watchedChannelOf(msg))) return;
    const prev = state.watermarks[msg.channelId];
    if (!prev || later(msg.id, prev)) {
      state.watermarks[msg.channelId] = msg.id;
      stateDirty = true;
    }
  };

  session = await openSession(config, {
    enforceHook: false,
    ackInbound: false,
    onHookedMessage: (msg) => {
      seen(msg);
      void core.onMessage(msg).catch((err) => log("routing failed", err));
    },
  });
  const live = session;
  log(`connected as ${live.client.user?.tag}; ${budget ? `${budget.remaining - 1} logins left today` : "login budget unknown"}`);
  live.client.on("messageCreate", (message) => {
    if (message.author.id === live.client.user?.id) void live.working.complete(message.channelId);
  });

  /**
   * Routes what a channel (and its active threads) got while nobody here
   * watched it: everything after its saved position, but no further back
   * than the catch-up window. `marks` is the positions as they were before
   * this attach, so live messages arriving meanwhile can't move the start.
   */
  async function catchUpChannel(guildId: string, channelId: string, marks: Record<string, string>): Promise<void> {
    const floor = snowflakeAt(Date.now() - CATCH_UP_WINDOW_MS);
    const threads = (await rest.channelsOf(guildId).catch(() => []))
      .filter((c) => c.parentId === channelId && c.type.endsWith("thread"))
      .map((c) => c.id);
    for (const id of [channelId, ...threads]) {
      const mark = marks[id];
      let after = mark && later(mark, floor) ? mark : floor;
      const missed: GatewayMessage[] = [];
      for (let page = 0; page < 10; page++) {
        const batch = await rest.messages(id, { limit: 100, after }).catch(() => []);
        if (batch.length === 0) break;
        missed.push(...batch);
        after = batch[batch.length - 1]!.id;
        if (batch.length < 100) break;
      }
      for (const m of missed) seen(m);
      await core.catchUp(missed);
    }
  }

  const persist = () => {
    if (!stateDirty) return;
    stateDirty = false;
    try {
      writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
    } catch (err) {
      log("state write failed", err);
    }
  };

  let lastAttachedAt = Date.now();
  let stopping = false;
  async function shutdown(code: number): Promise<never> {
    if (!stopping) {
      stopping = true;
      log("shutting down");
      try {
        core.releaseAll();
      } catch (err) {
        log("release failed", err);
      }
      persist();
      try {
        server.stop(true);
      } catch {
        // Already stopped.
      }
      rmSync(ROUTER_SOCKET, { force: true });
      if (Number(readFileSync(ROUTER_PID, "utf8").trim()) === process.pid) rmSync(ROUTER_PID, { force: true });
      await live.destroy().catch(() => {});
    }
    process.exit(code);
  }
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, () => void shutdown(0));

  const encoder = new TextEncoder();
  rmSync(ROUTER_SOCKET, { force: true });
  const server = Bun.serve({
    unix: ROUTER_SOCKET,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (request.method === "GET" && path === "/status") {
        return Response.json({
          ok: true,
          pid: process.pid,
          bot: live.client.user?.tag,
          sessions: core.attachedIds(),
          channels: [...core.watchedChannels()],
        });
      }
      if (request.method !== "POST") return new Response("not found", { status: 404 });
      const input = (await request.json().catch(() => ({}))) as Record<string, unknown>;

      if (path === "/stop") {
        setTimeout(() => void shutdown(0), 50);
        return Response.json({ ok: true });
      }

      if (path === "/control") {
        const sessionId = String(input.sessionId ?? "");
        const op = String(input.op ?? "");
        if (op === "ack") {
          const ack = parseAckRequest(JSON.stringify(input));
          if (!ack) return Response.json({ ok: false, error: "bad request" }, { status: 400 });
          await live.working.start(ack.channelId, ack.messageId).catch(() => {});
          return Response.json({ ok: true });
        }
        let parent: string | null = null;
        if (op === "claim-thread") {
          const thread = await live.client.channels.fetch(String(input.threadId ?? "")).catch(() => null);
          parent = thread?.isThread() ? thread.parentId : null;
        }
        const result = core.control(sessionId, op, input as never, parent);
        return Response.json(result, { status: result.ok ? 200 : result.status });
      }

      if (path === "/attach") {
        const sessionId = String(input.sessionId ?? "");
        const label = typeof input.label === "string" && input.label.trim() ? input.label.trim() : undefined;
        const channelIds = Array.isArray(input.channelIds) ? input.channelIds.map(String).filter((id) => /^\d{15,22}$/.test(id)) : [];
        if (!sessionId || channelIds.length === 0) return Response.json({ ok: false, error: "Give a sessionId and channelIds." }, { status: 400 });

        const channels = await Promise.all(channelIds.map((id) => live.client.channels.fetch(id).catch(() => null)));
        // Channels from several servers are fine: each keeps its own server for routing.
        const unseen = channels.findIndex((c) => !c || c.type === ChannelType.DM || !("guildId" in c));
        if (unseen !== -1) {
          return Response.json({ ok: false, error: `Channel ${channelIds[unseen]} is not a server channel the bot can see.` }, { status: 400 });
        }
        const channelGuilds = channels.map((c) => {
          const g = (c as { guild: { id: string; name: string } }).guild;
          return { id: g.id, name: g.name };
        });
        const guilds = [...new Map(channelGuilds.map((g) => [g.id, g])).values()];
        const guildId = guilds[0]!.id;
        const guildName = guilds.map((g) => g.name).join(" + ");
        const names = channels.map((c, i) => (c && "name" in c && c.name ? c.name : channelIds[i]!));

        let sink: Sink | null = null;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            let open = true;
            sink = {
              close() {
                if (!open) return;
                open = false;
                try {
                  controller.close();
                } catch {
                  // Already closed.
                }
              },
              send(event: RouterEvent) {
                if (!open) return;
                try {
                  controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
                } catch {
                  open = false;
                  core.detach(sessionId, sink!);
                }
              },
            };
            const keepalive = setInterval(() => {
              if (!open) return clearInterval(keepalive);
              try {
                controller.enqueue(encoder.encode("\n"));
              } catch {
                open = false;
                clearInterval(keepalive);
                core.detach(sessionId, sink!);
              }
            }, 5_000);
          },
          cancel() {
            if (sink) core.detach(sessionId, sink);
          },
        });

        // Channels nobody here watched until now get caught up, from positions saved before this attach.
        const before = core.watchedChannels();
        const newlyWatched = channelIds.filter((id) => !before.has(id));
        const marks = { ...state.watermarks };

        // After the response starts streaming: claim, introduce, backfill, catch up.
        queueMicrotask(async () => {
          try {
            const { fresh } = core.attach({ sessionId, label, channelIds, channelNames: names, channelGuilds, sink: sink! });
            lastAttachedAt = Date.now();
            sink!.send({
              type: "ready",
              bot: live.client.user?.tag ?? "unknown",
              botId: live.client.user?.id ?? "",
              guildId,
              guildName,
              guilds,
              channels: channelIds.map((id, i) => ({ id, name: names[i]! })),
            });
            if (fresh) {
              for (const id of channelIds) {
                const history = await rest.messages(id, { limit: HISTORY_LIMIT }).catch(() => []);
                sink!.send({ type: "history", channelId: id, channelName: names[channelIds.indexOf(id)]!, messages: history });
              }
            }
            for (const id of newlyWatched) await catchUpChannel(channelGuilds[channelIds.indexOf(id)]!.id, id, marks);
          } catch (err) {
            sink?.send({ type: "error", message: err instanceof Error ? err.message : String(err), fatal: true });
            core.forget(sessionId, { close: true, requeue: true });
          }
        });

        return new Response(stream, { headers: { "content-type": "application/x-ndjson" } });
      }

      return new Response("not found", { status: 404 });
    },
  });
  log(`listening on ${ROUTER_SOCKET}`);

  const every = (ms: number, fn: () => unknown, name: string) =>
    setInterval(() => {
      try {
        const r = fn();
        if (r instanceof Promise) r.catch((err) => log(`${name} failed`, err));
      } catch (err) {
        log(`${name} failed`, err);
      }
    }, ms);

  every(30_000, () => core.tick(), "tick");
  every(5_000, () => core.refreshClaims(), "claims");
  // Tick first, so lapsed graces end and claims are fresh before anything is judged gone.
  every(
    60_000,
    async () => {
      core.tick();
      await core.sweep();
    },
    "sweep",
  );
  every(10_000, persist, "persist");
  const syncLedger = () => ledger.syncPrLinks();
  try {
    syncLedger();
  } catch (err) {
    log("ledger sync failed", err);
  }
  every(2 * 60_000, syncLedger, "ledger");
  every(60_000, () => {
    if (core.hasSessions()) lastAttachedAt = Date.now();
    else if (Date.now() - lastAttachedAt > LINGER_MS) void shutdown(0);
  }, "linger");
}

if (import.meta.main) {
  main().catch((err) => {
    log("fatal", err);
    try {
      writeFileSync(ROUTER_ERROR, err instanceof Error ? err.message : String(err));
      if (existsSync(ROUTER_PID) && Number(readFileSync(ROUTER_PID, "utf8").trim()) === process.pid) rmSync(ROUTER_PID, { force: true });
    } catch {
      // Best effort.
    }
    process.exit(1);
  });
}
