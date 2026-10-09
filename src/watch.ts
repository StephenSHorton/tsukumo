#!/usr/bin/env bun
/**
 * Channel watcher for the Claude Code mod (claude-mod/).
 *
 * The mod spawns one of these per Claude conversation that watches Discord:
 *
 *   TSUKUMO_SESSION_ID=<claude session id> bun run src/watch.ts <channelId>[,<channelId>…]
 *
 * It claims the channels in .hooks.json as their owner, or as a listener when
 * another conversation owns them, keeps the claim live with a heartbeat,
 * prints one JSON line per event on stdout, and releases the claim when it
 * exits. Every watcher routes each mention the same way (src/lib/route.ts),
 * so exactly one session answers it. It never posts; replies go through
 * src/call.ts.
 *
 * Events: ready · claims · mention (with its route) · message · history · error.
 * Control (unix socket, TSUKUMO_WATCH_SOCKET): POST /ack /own /listen
 * /claim-thread /release-thread /take, each with a small JSON body.
 */
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { ChannelType, Events, type Message } from "discord.js";
import { loadConfig, loadProjectEnv, projectRoot } from "./config.ts";
import { openSession, type TsukumoSession } from "./session.ts";
import { HookStore, conversationId, describeHook, isOwner, type HookScope } from "./lib/hook.ts";
import { GatewayError } from "./lib/errors.ts";
import { frontDesk, routeMention, ROUTING_VERSION } from "./lib/route.ts";
import { defer, deferredUntil, isMarked, isMarkedFor, listTaken, mark, pruneTaken, retake, takeMessage, takenBy, unmark } from "./lib/take.ts";
import { Ledger } from "./lib/ledger.ts";
import { repoFromTopic } from "./lib/refs.ts";
import { MAX_DEFER_MS, planReminders, planSweep, SWEEP_LOOKBACK_MS } from "./lib/sweep.ts";
import { DiscordRest, createRest } from "./discord/rest.ts";

/**
 * Below this many gateway logins left today, don't connect. Running out
 * disconnects every session and resets the bot's token.
 */
const MIN_LOGINS_LEFT = 25;
import type { GatewayMessage } from "./lib/types.ts";
import { parseAckRequest } from "./lib/ack.ts";

const HEARTBEAT_MS = 30_000;
/** How often to look for other sessions' claim changes (ownership, threads). */
const CLAIMS_POLL_MS = 5_000;
const WATCH_DIR = join(projectRoot, ".watch");
/** Who took each mention (lock files). */
const TAKEN_DIR = join(WATCH_DIR, "taken");
/** Mentions Tsukumo has replied to. */
const DONE_DIR = join(WATCH_DIR, "done");
/** Mentions the front desk's sweeper took over, or flagged as overdue (each once). */
const REROUTED_DIR = join(WATCH_DIR, "rerouted");
const FLAGGED_DIR = join(WATCH_DIR, "flagged");
/** Mentions a person held or dismissed in their pane: the sweeper leaves them alone. */
const HELD_DIR = join(WATCH_DIR, "held");
/** Mentions whose turn started in the taker, and ones a chat deferred (defer_mention). */
const SEEN_DIR = join(WATCH_DIR, "seen");
const DEFERRED_DIR = join(WATCH_DIR, "deferred");
/** Mentions the front desk routed to another session, until that session takes them. */
const PENDING_DIR = join(WATCH_DIR, "pending");
/** How often to read new pr-link rows into the ledger. */
const LEDGER_SYNC_MS = 2 * 60_000;
/** How often the front desk sweeps for unanswered mentions. */
const SWEEP_MS = 60_000;

// stdout carries the event stream only.
console.log = console.info = console.debug = console.warn = console.error;

type WatchEvent =
  | {
      type: "ready";
      bot: string;
      botId: string;
      guildId: string;
      guildName: string;
      channels: Array<{ id: string; name: string }>;
    }
  /**
   * `mine`: this session answers it. `other`: another session does (`routedTo`).
   * `none`: nobody owns the place; it's held for whoever takes it.
   */
  | {
      type: "mention";
      channelName: string;
      message: GatewayMessage;
      route: "mine" | "other" | "none";
      routedTo?: string;
      /** Why it went where it did, for the woken session and the pane. */
      reason?: string;
    }
  /** The front desk's own mention has gone unanswered past the deadline. */
  | { type: "overdue"; messageId: string; channelId: string; channelName: string; minutes: number }
  /** This session's standing: owner or listener, its threads, and who else is here. */
  | {
      type: "claims";
      role: "owner" | "listener";
      threadIds: string[];
      owner: string | null;
      listeners: number;
    }
  /** Every message in a watched channel, live; `history` is the backfill on connect. */
  | { type: "message"; channelName: string; message: GatewayMessage }
  | { type: "history"; channelId: string; channelName: string; messages: GatewayMessage[] }
  | { type: "error"; message: string };

function emit(event: WatchEvent): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

const channelIds = process.argv
  .slice(2)
  .flatMap((arg) => arg.split(","))
  .map((id) => id.trim())
  .filter(Boolean);

const conv = conversationId();
const store = new HookStore();
const ledger = new Ledger();
/** Each watched channel's repo, from its topic's GitHub link: what a bare "#1437" means there. */
const repoByChannel = new Map<string, string>();
let session: TsukumoSession | null = null;
let stopping = false;
/** Our claim's boundAt; a newer watcher for the same session replaces it, and we must not clear that one. */
let claimedAt: string | null = null;
/**
 * Where the mod reaches us once a mention is delivered: `POST /ack` shows 👀 and
 * typing on it until Tsukumo's reply lands in that channel (or 15 minutes pass).
 */
const socketPath = process.env.TSUKUMO_WATCH_SOCKET?.trim() || null;
/** The chat's title, shown to other sessions as "handled by …". */
const label = process.env.TSUKUMO_SESSION_LABEL?.trim() || undefined;
let ackServer: ReturnType<typeof Bun.serve> | null = null;

async function stop(code: number): Promise<never> {
  if (!stopping) {
    stopping = true;
    // Each step on its own: one failing must not leave the socket or the claim behind.
    try {
      if (conv && claimedAt && store.load(conv)?.boundAt === claimedAt) store.clear(conv);
    } catch {
      // The heartbeat lapses and other sessions prune the row within 90s.
    }
    try {
      ackServer?.stop(true);
    } catch {
      // Already stopped.
    }
    if (socketPath) rmSync(socketPath, { force: true });
    await session?.destroy().catch(() => {});
  }
  process.exit(code);
}

function channelNameOf(channelId: string): string {
  const channel = session?.client.channels.cache.get(channelId);
  return channel && "name" in channel && channel.name ? channel.name : channelId;
}

function nameOf(conversation: string): string {
  const hook = store.liveHooks(conv!).find((h) => h.conversationId === conversation);
  return hook ? describeHook(hook) : `${conversation.slice(0, 8)}…`;
}

/** The watched channel a message belongs to: itself, or the channel its thread hangs off. */
function watchedChannelOf(message: Pick<GatewayMessage, "channelId" | "threadParentId">): string {
  if (channelIds.includes(message.channelId)) return message.channelId;
  const cached = session?.client.channels.cache.get(message.channelId);
  const parent = cached && "parentId" in cached ? cached.parentId : message.threadParentId;
  return parent && channelIds.includes(parent) ? parent : message.channelId;
}

/** Decides who answers a mention, taking the lock when it's ours. */
function routeOf(message: GatewayMessage): { route: "mine" | "other" | "none"; routedTo?: string; reason: string } {
  const routed = routeMention(store.liveHooks(conv!), message, ledger, {
    defaultRepo: repoByChannel.get(watchedChannelOf(message)),
  });
  if (!routed.to) return { route: "none", reason: routed.reason };
  const watched = watchedChannelOf(message);
  if (routed.to.conversationId !== conv) {
    // The front desk keeps a note of what it handed off, so its sweeper can take
    // it back if that session never picks it up (crashed, or racing a restart).
    if (frontDesk(store.liveHooks(conv!), message)?.conversationId === conv && !takenBy(TAKEN_DIR, message.id)) {
      retake(PENDING_DIR, message.id, routed.to.conversationId, watched, Date.now(), message.channelId);
    }
    return { route: "other", routedTo: describeHook(routed.to), reason: routed.reason };
  }
  const taken = takeMessage(TAKEN_DIR, message.id, conv!, watched, Date.now(), message.channelId, routed.owned ? "owned" : "new");
  return taken.ok
    ? { route: "mine", reason: routed.reason }
    : { route: "other", routedTo: nameOf(taken.takenBy), reason: "already taken" };
}

/**
 * Mentions sent while nobody was watching are not lost: on connect, any recent
 * one in the backfill with no Tsukumo reply and no taker is routed as if new.
 */
function catchUp(messages: GatewayMessage[], botId: string | undefined): void {
  for (const m of messages) if (m.authorId === botId && m.replyToId) mark(DONE_DIR, m.replyToId);
  for (const m of messages) {
    if (!m.mentionsBot || m.authorId === botId || !m.content.trim()) continue;
    if (Date.now() - Date.parse(m.createdAt) > SWEEP_LOOKBACK_MS) continue;
    if (isMarked(DONE_DIR, m.id) || takenBy(TAKEN_DIR, m.id)) continue;
    const routed = routeOf(m);
    if (routed.route !== "mine") continue;
    emit({
      type: "mention",
      channelName: channelNameOf(m.channelId),
      message: m,
      route: "mine",
      reason: `missed while no chat was watching; ${routed.reason}`,
    });
  }
}

/** When each conversation first looked gone, so "gone 3 minutes" means gone, not a blip. */
const goneSince = new Map<string, number>();

function facts() {
  return {
    now: Date.now(),
    isAnswered: (id: string) => isMarked(DONE_DIR, id),
    isHeld: (id: string) => isMarked(HELD_DIR, id),
    isSeen: (id: string, by: string) => isMarkedFor(SEEN_DIR, id, by),
    deferredUntil: (id: string, by: string) => deferredUntil(DEFERRED_DIR, id, by),
    wasFlagged: (id: string, by: string) => isMarkedFor(FLAGGED_DIR, id, by),
  };
}

function remind(action: { messageId: string; channelId: string; minutes: number; to: string }): void {
  // This watcher can only reach its own chat; another holder's reminder comes from its own process.
  if (action.to !== conv || isMarkedFor(FLAGGED_DIR, action.messageId, conv)) return;
  mark(FLAGGED_DIR, action.messageId, conv);
  emit({ type: "overdue", messageId: action.messageId, channelId: action.channelId, channelName: channelNameOf(action.channelId), minutes: action.minutes });
}

/**
 * Every minute: if this chat is the front desk, it takes over what's stranded
 * in its channels (a taker gone, or new work nobody started on); either way,
 * it's reminded about its own overdue mentions.
 */
async function sweep(rest: DiscordRest): Promise<void> {
  const mine = store.load(conv!);
  if (!mine) return;
  const now = Date.now();
  const liveIds = new Set(store.liveHooks(conv!).map((h) => h.conversationId));
  for (const t of listTaken(TAKEN_DIR)) {
    if (liveIds.has(t.by)) goneSince.delete(t.by);
    else if (!goneSince.has(t.by)) goneSince.set(t.by, now);
  }
  const actions = isOwner(mine)
    ? planSweep(listTaken(TAKEN_DIR), listTaken(PENDING_DIR), {
        ...facts(),
        me: conv!,
        inScope: (id) => channelIds.includes(id),
        goneFor: (c) => (liveIds.has(c) ? 0 : now - (goneSince.get(c) ?? now)),
        hasTaker: (id) => takenBy(TAKEN_DIR, id) !== null,
        wasRerouted: (id) => isMarked(REROUTED_DIR, id),
        nameOf,
        // Handing the role on needs the router (it knows which chats are attached).
        canHandOff: () => false,
      })
    : [];
  for (const action of actions) {
    if (action.kind === "clear") {
      unmark(PENDING_DIR, action.messageId);
      continue;
    }
    if (action.kind === "overdue") {
      remind(action);
      continue;
    }
    if (action.kind === "handoff") continue;
    if (action.retake) {
      // Re-check against now, not the plan: the holder may have engaged, deferred or answered since.
      const current = takenBy(TAKEN_DIR, action.messageId);
      const f = facts();
      if (!current || current.by !== action.from || current.atMs !== action.atMs) continue;
      if (f.isAnswered(action.messageId) || f.isSeen(action.messageId, action.from) || f.deferredUntil(action.messageId, action.from) !== null) continue;
      retake(TAKEN_DIR, action.messageId, conv!, action.channelId, Date.now(), action.messageChannelId, "new");
    } else if (!takeMessage(TAKEN_DIR, action.messageId, conv!, action.channelId, Date.now(), action.messageChannelId, "new").ok) {
      unmark(PENDING_DIR, action.messageId); // the session took it after all
      continue;
    }
    for (const dir of [PENDING_DIR, SEEN_DIR, DEFERRED_DIR, FLAGGED_DIR]) unmark(dir, action.messageId);
    mark(REROUTED_DIR, action.messageId);
    const message = await rest.message(action.messageChannelId, action.messageId).catch(() => null);
    if (!message) continue;
    emit({
      type: "mention",
      channelName: channelNameOf(action.messageChannelId),
      message,
      route: "mine",
      reason: `${action.reason}; front desk takes it`,
    });
  }

  for (const r of planReminders(listTaken(TAKEN_DIR), { ...facts(), holds: (c) => c === conv })) {
    if (r.kind === "overdue") remind(r);
  }
}

let lastClaims = "";
function emitClaims(): void {
  const mine = store.load(conv!);
  if (!mine) return;
  const others = store.liveHooks(conv!).filter((h) => h.conversationId !== conv && sharesChannel(h, mine));
  const owner = isOwner(mine) ? null : others.find(isOwner);
  const event = {
    type: "claims" as const,
    role: isOwner(mine) ? ("owner" as const) : ("listener" as const),
    threadIds: mine.threadIds ?? [],
    owner: owner ? describeHook(owner) : null,
    listeners: others.filter((h) => !isOwner(h)).length + (isOwner(mine) ? 0 : 1),
  };
  const text = JSON.stringify(event);
  if (text === lastClaims) return;
  lastClaims = text;
  emit(event);
}

function sharesChannel(a: HookScope, b: HookScope): boolean {
  if (a.guildId !== b.guildId) return false;
  if (!a.channelIds || !b.channelIds) return true;
  return a.channelIds.some((id) => b.channelIds!.includes(id));
}

/** Messages per channel sent as `history` when the watch starts. */
const HISTORY_LIMIT = 25;

async function fail(message: string): Promise<never> {
  emit({ type: "error", message });
  return stop(1);
}

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
  process.on(signal, () => void stop(0));
}

if (channelIds.length === 0) await fail("Name at least one channel id to watch.");
if (!conv) await fail("TSUKUMO_SESSION_ID is not set; the mod passes the Claude session id.");

try {
  await loadProjectEnv();
  const config = loadConfig();
  const rest = new DiscordRest(createRest(config.DISCORD_TOKEN));
  const budget = await rest.loginBudget().catch(() => null);
  if (budget && budget.remaining < MIN_LOGINS_LEFT) {
    const minutes = Math.ceil(budget.resetAfterMs / 60_000);
    await fail(
      `Discord login budget nearly used up (${budget.remaining} of ${budget.total} left; resets in ${minutes} min). Not connecting.`,
    );
  }
  session = await openSession(config, {
    enforceHook: true,
    ackInbound: false,
    onChannelInbound: (message) => {
      emit({ type: "mention", channelName: channelNameOf(message.channelId), message, ...routeOf(message) });
    },
    onHookedMessage: (message) => {
      emit({ type: "message", channelName: channelNameOf(message.channelId), message });
    },
  });

  const first = await session.client.channels.fetch(channelIds[0]!).catch(() => null);
  if (!first || first.type === ChannelType.DM || !("guildId" in first)) {
    await fail(`Channel ${channelIds[0]} is not a server channel the bot can see.`);
  }
  const guildId = (first as { guildId: string }).guildId;
  let hook: HookScope;
  try {
    hook = session.service.bind({ guildId, channelIds, role: "owner", label, routing: ROUTING_VERSION });
  } catch (err) {
    // Someone else owns it: listen, and answer only threads this session claims.
    if (!(err instanceof GatewayError) || err.status !== 409) throw err;
    hook = session.service.bind({ guildId, channelIds, role: "listener", label, routing: ROUTING_VERSION });
  }
  for (const dir of [TAKEN_DIR, DONE_DIR, REROUTED_DIR, FLAGGED_DIR, HELD_DIR, PENDING_DIR, SEEN_DIR, DEFERRED_DIR]) pruneTaken(dir, 2 * 86_400_000);
  for (const id of channelIds) {
    const channel = session.client.channels.cache.get(id);
    const repo = repoFromTopic(channel && "topic" in channel ? (channel.topic as string | null) : null);
    if (repo) repoByChannel.set(id, repo);
  }
  const syncLedger = () => {
    try {
      ledger.syncPrLinks();
    } catch (err) {
      console.error("[watch] ledger sync failed", err);
    }
  };
  syncLedger();
  setInterval(syncLedger, LEDGER_SYNC_MS);
  claimedAt = hook.boundAt;
  store.heartbeat(conv!);

  const live = session;
  // Our own reply landing in a channel ends its 👀 and typing; the post itself comes from src/call.ts.
  live.client.on(Events.MessageCreate, (message: Message) => {
    if (message.author.id !== live.client.user?.id) return;
    void live.working.complete(message.channelId);
    // A reply from Tsukumo answers the mention it replies to.
    if (message.reference?.messageId) mark(DONE_DIR, message.reference.messageId);
  });
  if (socketPath) {
    mkdirSync(dirname(socketPath), { recursive: true });
    rmSync(socketPath, { force: true });
    ackServer = Bun.serve({
      unix: socketPath,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (request.method !== "POST") return new Response("not found", { status: 404 });
        const body = await request.text();
        if (path === "/ack") {
          const ack = parseAckRequest(body);
          if (!ack) return new Response("bad request", { status: 400 });
          await live.working.start(ack.channelId, ack.messageId).catch(() => {});
          return Response.json({ ok: true });
        }
        const input = (() => {
          try {
            return JSON.parse(body || "{}") as { threadId?: string; messageId?: string };
          } catch {
            return {};
          }
        })();
        try {
          if (path === "/own" || path === "/listen") {
            store.update(conv!, (h) => ({ ...h, role: path === "/own" ? "owner" : "listener" }));
          } else if (path === "/claim-thread" || path === "/release-thread") {
            const threadId = String(input.threadId ?? "");
            if (!/^\d{15,22}$/.test(threadId)) return Response.json({ ok: false, error: "Give a thread id." }, { status: 400 });
            if (path === "/claim-thread") {
              const thread = await live.client.channels.fetch(threadId).catch(() => null);
              if (!thread?.isThread() || !thread.parentId || !channelIds.includes(thread.parentId)) {
                return Response.json({ ok: false, error: "That isn't a thread in a watched channel." }, { status: 400 });
              }
            }
            store.update(conv!, (h) => {
              const rest = (h.threadIds ?? []).filter((id) => id !== threadId);
              return { ...h, threadIds: path === "/claim-thread" ? [...rest, threadId] : rest };
            });
          } else if (path === "/seen") {
            const messageId = String(input.messageId ?? "");
            if (takenBy(TAKEN_DIR, messageId)?.by === conv) mark(SEEN_DIR, messageId, conv!);
            return Response.json({ ok: true });
          } else if (path === "/holder") {
            // Who holds a mention now, so a chat about to reply can tell it moved on.
            const by = takenBy(TAKEN_DIR, String(input.messageId ?? ""))?.by ?? null;
            return Response.json({ ok: true, holder: by, label: by ? nameOf(by) : null, mine: by === conv });
          } else if (path === "/defer") {
            const messageId = String(input.messageId ?? "");
            const untilMs = Number((input as { untilMs?: unknown }).untilMs);
            if (takenBy(TAKEN_DIR, messageId)?.by !== conv) return Response.json({ ok: false, error: "This chat isn't the one handling that mention." }, { status: 409 });
            if (!Number.isFinite(untilMs) || untilMs <= Date.now()) return Response.json({ ok: false, error: "Give a time in the future." }, { status: 400 });
            defer(DEFERRED_DIR, messageId, conv!, Math.min(untilMs, Date.now() + MAX_DEFER_MS), String((input as { note?: unknown }).note ?? ""));
            // A new deferral gets its own reminder when it passes.
            unmark(FLAGGED_DIR, messageId);
            return Response.json({ ok: true });
          } else if (path === "/hold") {
            // A person held or dismissed it: the sweeper must not push it back at anyone.
            mark(HELD_DIR, String(input.messageId ?? ""));
            return Response.json({ ok: true });
          } else if (path === "/take") {
            const messageChannelId = (input as { channelId?: string }).channelId ?? null;
            const watched = messageChannelId ? watchedChannelOf({ channelId: messageChannelId, threadParentId: null }) : null;
            // A person handed it to this chat (Deliver, Take it): it's the chat's to answer, not new work to move on.
            const taken = takeMessage(TAKEN_DIR, String(input.messageId ?? ""), conv!, watched, Date.now(), messageChannelId, "owned");
            // Taking a held mention (Deliver, Take it) makes it live work again.
            if (taken.ok) unmark(HELD_DIR, String(input.messageId ?? ""));
            if (!taken.ok) return Response.json({ ok: false, error: `Already taken by ${nameOf(taken.takenBy)}.` }, { status: 409 });
            return Response.json({ ok: true });
          } else {
            return new Response("not found", { status: 404 });
          }
        } catch (err) {
          const status = err instanceof GatewayError ? err.status : 500;
          return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status });
        }
        emitClaims();
        return Response.json({ ok: true });
      },
    });
  }

  emit({
    type: "ready",
    bot: session.client.user?.tag ?? "unknown",
    botId: session.client.user?.id ?? "",
    guildId: hook.guildId,
    guildName: hook.guildName,
    channels: (hook.channelIds ?? []).map((id, i) => ({
      id,
      name: hook.channelNames[i] ?? id,
    })),
  });

  emitClaims();
  setInterval(emitClaims, CLAIMS_POLL_MS);

  for (const channelId of hook.channelIds ?? []) {
    const messages = await live.service
      .getMessages({ channelId, limit: HISTORY_LIMIT })
      .catch(() => []);
    emit({ type: "history", channelId, channelName: channelNameOf(channelId), messages });
    catchUp(messages, live.client.user?.id);
  }

  setInterval(() => void sweep(rest).catch((err) => console.error("[watch] sweep failed", err)), SWEEP_MS);

  setInterval(() => {
    // Orphaned (the Claude process died without signalling us): let the claim go.
    if (process.ppid === 1) return void stop(0);
    if (store.load(conv!)?.boundAt !== claimedAt || !store.heartbeat(conv!)) {
      void fail("The watch claim was removed or replaced in .hooks.json; stopping.");
    }
  }, HEARTBEAT_MS);
} catch (err) {
  await fail(err instanceof Error ? err.message : String(err));
}
