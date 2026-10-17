/**
 * The router's decisions, apart from Discord and the socket: which attached
 * session each message and mention goes to, the front desk's sweeper, and
 * keeping claims live. src/router.ts feeds it messages and wires its output
 * to each session's event stream (src/attach.ts → the mod).
 *
 * Routing is the same function every older per-session watcher runs
 * (src/lib/route.ts over .hooks.json and the ledger), so sessions attached
 * here, old-style watchers and Grok's bind all agree on who answers.
 */
import { shouldNotifyChannel } from "../lib/channel.ts";
import { describeHook, HookStore, hookAllowsChannel, hookGuildIds, isOwner, type HookScope } from "../lib/hook.ts";
import { GatewayError } from "../lib/errors.ts";
import { frontDesk, routeMention, ROUTING_VERSION, type OwnerLookup, type Route } from "../lib/route.ts";
import { MAX_DEFER_MS, planReminders, planSweep, SWEEP_LOOKBACK_MS } from "../lib/sweep.ts";
import { defer, deferredUntil, isMarked, isMarkedFor, listTaken, mark, retake, takeMessage, takenBy, unmark } from "../lib/take.ts";
import type { GatewayMessage } from "../lib/types.ts";

/** One line of an attached session's stream; the same events the per-session watcher prints. */
export type RouterEvent =
  | {
      type: "ready";
      bot: string;
      botId: string;
      /** The first server; `guildName` names them all ("A + B") when there are several. */
      guildId: string;
      guildName: string;
      guilds: Array<{ id: string; name: string }>;
      channels: Array<{ id: string; name: string }>;
    }
  | { type: "claims"; role: "owner" | "listener"; threadIds: string[]; owner: string | null; listeners: number }
  | {
      type: "mention";
      channelName: string;
      message: GatewayMessage;
      route: "mine" | "other" | "none";
      routedTo?: string;
      reason?: string;
    }
  | { type: "overdue"; messageId: string; channelId: string; channelName: string; minutes: number }
  /** A mention this chat held went to another chat; don't answer it unless the user asks. */
  | { type: "moved"; messageId: string; channelName: string; to: string }
  /** This chat, as front desk, sat on a mention; it and the front-desk role went to `to`. */
  | { type: "handoff"; messageId: string; channelId: string; channelName: string; minutes: number; to: string }
  | { type: "message"; channelName: string; message: GatewayMessage }
  /**
   * A message straight from another chat attached to this router: agent to agent on one machine, never posted
   * on Discord (chats sharing the bot can't wake each other there; the bot's own posts never notify).
   */
  | {
      type: "direct";
      id: string;
      /** The name it was sent under (its `from`), else the sender's label. */
      from: string;
      fromSession: string;
      content: string;
      /** The direct message this answers, if any. */
      replyToId?: string;
      /** The Discord message it replies to, when it began as a reply there. */
      about?: { channelId: string; messageId: string };
      sentAt: string;
    }
  | { type: "history"; channelId: string; channelName: string; messages: GatewayMessage[] }
  /** `fatal`: the router dropped this chat (its claim was removed); the attach process should stop. */
  | { type: "error"; message: string; fatal?: boolean };

export interface Sink {
  send(event: RouterEvent): void;
  /** Ends the stream (the router dropped this chat). */
  close?(): void;
}

export interface Dirs {
  taken: string;
  done: string;
  pending: string;
  held: string;
  rerouted: string;
  flagged: string;
  /** Mentions whose turn started in the taker (it engaged). */
  seen: string;
  /** Mentions a chat said it will answer later (defer_mention). */
  deferred: string;
}

export interface CoreDeps {
  store: HookStore;
  ledger: OwnerLookup;
  dirs: Dirs;
  now: () => number;
  botId: () => string | undefined;
  channelName: (channelId: string) => string;
  /** The parent channel of a thread, if known (from the gateway cache or the message). */
  parentOf: (channelId: string) => string | null;
  repoOf: (channelId: string) => string | undefined;
  fetchMessage: (channelId: string, messageId: string) => Promise<GatewayMessage | null>;
  /** Optional: where the names chats post under are kept, so a router restart still finds chats by them. */
  aliasStore?: { get(sessionId: string): string[]; set(sessionId: string, names: string[]): void };
  /** Optional: keep a record of direct messages (they appear nowhere else). */
  logDirect?: (entry: Extract<RouterEvent, { type: "direct" }> & { to: string }) => void;
  /** Optional: refine a route's reason (e.g. a PR a Cursor agent opened). */
  enrich?: (route: Route, msg: GatewayMessage) => Promise<Route>;
}

/** Direct messages allowed between two chats (either way) in DIRECT_WINDOW_MS, so two agents can't wake each other forever. */
export const DIRECT_LIMIT = 8;
export const DIRECT_WINDOW_MS = 10 * 60_000;
const MAX_DIRECT_CHARS = 8_000;

/** How long a session that dropped its stream (a hot reload, a restart) keeps its claim and queue. */
export const REATTACH_GRACE_MS = 2 * 60_000;
/** Mentions held for a session during that grace, at most. */
const QUEUE_LIMIT = 50;

interface Attached {
  sessionId: string;
  /** The claim row's boundAt, so we only ever clear the row we wrote. */
  boundAt: string;
  label?: string;
  /** The servers its channels are in (several are fine). */
  guilds: Array<{ id: string; name: string }>;
  /** Each watched channel's server. */
  guildOf: Map<string, string>;
  channelIds: string[];
  sinks: Set<Sink>;
  /** Events while it has no stream (within the grace window), delivered on reattach. */
  queue: RouterEvent[];
  detachedAt: number | null;
  lastClaims: string;
  /** Names it has posted under (send_message's `from`), lowercased: how other chats address it. */
  aliases: Set<string>;
}

/** Remembered routed message ids, so a mention seen live and in catch-up wakes one chat once. */
const ROUTED_MEMORY = 2_000;

export class RouterCore {
  private readonly sessions = new Map<string, Attached>();
  private readonly routed = new Set<string>();
  /** When each pair of chats last messaged each other directly, for DIRECT_LIMIT. */
  private readonly directTimes = new Map<string, number[]>();

  constructor(private readonly deps: CoreDeps) {}

  attachedIds(): string[] {
    return [...this.sessions.keys()];
  }

  /** Sessions that still hold a claim (attached, or inside their reattach grace). */
  hasSessions(): boolean {
    return this.sessions.size > 0;
  }

  /** Channels any attached session watches. */
  watchedChannels(): Set<string> {
    return new Set([...this.sessions.values()].flatMap((s) => s.channelIds));
  }

  /**
   * A session's stream connects. Claims its channels as front desk if free,
   * else as listener, and returns whether it's new (so the caller sends history).
   */
  attach(input: {
    sessionId: string;
    label?: string;
    channelIds: string[];
    channelNames: string[];
    /** Each channel's server, in `channelIds` order. */
    channelGuilds: Array<{ id: string; name: string }>;
    sink: Sink;
  }): { fresh: boolean } {
    const guilds = [...new Map(input.channelGuilds.map((g) => [g.id, g])).values()];
    const existing = this.sessions.get(input.sessionId);
    const sameChannels =
      existing && existing.channelIds.length === input.channelIds.length && existing.channelIds.every((id) => input.channelIds.includes(id));
    if (existing && sameChannels) {
      existing.sinks.add(input.sink);
      existing.detachedAt = null;
      if (input.label && input.label !== existing.label) {
        existing.label = input.label;
        try {
          this.deps.store.update(input.sessionId, (h) => ({ ...h, label: input.label }));
        } catch {
          // The name shows on the next claim refresh instead.
        }
      }
      for (const event of existing.queue.splice(0)) input.sink.send(event);
      existing.lastClaims = "";
      this.emitClaims(existing);
      return { fresh: false };
    }
    if (existing) this.forget(input.sessionId);

    // A row that survived a router restart keeps its role and thread claims.
    const previous = this.deps.store.load(input.sessionId);
    const keepThreads =
      previous && hookGuildIds(previous).some((id) => guilds.some((g) => g.id === id)) ? previous.threadIds : undefined;
    const base = {
      conversationId: input.sessionId,
      guildId: guilds[0]!.id,
      guildName: guilds.map((g) => g.name).join(" + "),
      ...(guilds.length > 1 ? { guilds } : {}),
      channelIds: input.channelIds,
      channelNames: input.channelNames,
      boundAt: new Date(this.deps.now()).toISOString(),
      routing: ROUTING_VERSION,
      ...(input.label ? { label: input.label } : {}),
      ...(keepThreads?.length ? { threadIds: keepThreads } : {}),
    };
    const roles: Array<"owner" | "listener"> = previous?.role === "listener" ? ["listener"] : ["owner", "listener"];
    for (const [i, role] of roles.entries()) {
      try {
        this.deps.store.save({ ...base, role });
        break;
      } catch (err) {
        if (!(err instanceof GatewayError) || err.status !== 409 || i === roles.length - 1) throw err;
      }
    }
    this.deps.store.heartbeat(input.sessionId, new Date(this.deps.now()));
    const session: Attached = {
      sessionId: input.sessionId,
      boundAt: base.boundAt,
      label: input.label,
      guilds,
      guildOf: new Map(input.channelIds.map((id, i) => [id, input.channelGuilds[i]!.id])),
      channelIds: input.channelIds,
      sinks: new Set([input.sink]),
      queue: [],
      detachedAt: null,
      lastClaims: "",
      aliases: existing?.aliases ?? new Set(this.deps.aliasStore?.get(input.sessionId) ?? []),
    };
    this.sessions.set(input.sessionId, session);
    this.emitClaims(session);
    return { fresh: true };
  }

  /** A stream closed. The session keeps its claim for the grace window, in case it's a reload. */
  detach(sessionId: string, sink: Sink): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.sinks.delete(sink);
    if (session.sinks.size === 0) session.detachedAt = this.deps.now();
  }

  /**
   * Drops a session's claim now: an explicit stop, its grace ran out, or the
   * router is shutting down. Mentions queued for it are routed again, and if
   * it was a front desk the longest-attached chat left takes over.
   */
  forget(sessionId: string, opts: { close?: boolean; requeue?: boolean } = {}): void {
    const session = this.sessions.get(sessionId);
    this.sessions.delete(sessionId);
    if (!session) return;
    // It's gone from now (the sweep would otherwise only notice on its next pass).
    if (!this.goneSince.has(sessionId)) this.goneSince.set(sessionId, this.deps.now());
    if (opts.close) for (const sink of session.sinks) sink.close?.();
    const wasDesk = (() => {
      try {
        const row = this.deps.store.load(sessionId);
        return row?.boundAt === session.boundAt && isOwner(row);
      } catch {
        return false;
      }
    })();
    try {
      if (this.deps.store.load(sessionId)?.boundAt === session.boundAt) this.deps.store.clear(sessionId);
    } catch {
      // Its heartbeat lapses and others prune it within 90s.
    }
    if (wasDesk) this.promoteSuccessor(session);
    if (opts.requeue) {
      for (const event of session.queue) {
        if (event.type !== "mention" || event.route !== "mine") continue;
        if (takenBy(this.deps.dirs.taken, event.message.id)?.by === sessionId) unmark(this.deps.dirs.taken, event.message.id);
        this.routed.delete(event.message.id);
        void this.routeAndDeliver(event.message, "its chat left before answering").catch(() => {});
      }
    }
  }

  /** Chats other than `me` connected now (not in a reload grace) and watching `channelId`, longest-attached first. */
  private othersWatching(me: string, channelId: string): Attached[] {
    return [...this.sessions.values()]
      .filter((s) => s.sessionId !== me && s.sinks.size > 0 && s.channelIds.includes(channelId))
      .sort((a, b) => a.boundAt.localeCompare(b.boundAt));
  }

  /**
   * Whether `desk` can step down: someone else can front `channelId`, and every
   * other channel it fronts would still have a desk. A role belongs to a chat,
   * not a channel, so stepping down anywhere means stepping down everywhere.
   */
  private canHandOff(desk: Attached, channelId: string): boolean {
    const hooks = this.liveHooks();
    return desk.channelIds.every((id) => {
      if (id !== channelId && frontDesk(hooks, { channelId: id, guildId: desk.guildOf.get(id) ?? null })?.conversationId !== desk.sessionId) return true;
      return this.othersWatching(desk.sessionId, id).length > 0;
    });
  }

  /**
   * The front desk sat on new work: it becomes a listener, the longest-attached
   * other chat in `channelId` becomes front desk, and each of its other
   * channels gets the next chat there. Returns the new desk for `channelId`,
   * or null with nothing changed if that can't be done.
   */
  private handOffDesk(desk: Attached, channelId: string): Attached | null {
    const { store } = this.deps;
    if (!this.canHandOff(desk, channelId)) return null;
    const fronted = desk.channelIds.filter(
      (id) => id === channelId || frontDesk(this.liveHooks(), { channelId: id, guildId: desk.guildOf.get(id) ?? null })?.conversationId === desk.sessionId,
    );
    try {
      store.update(desk.sessionId, (h) => ({ ...h, role: "listener" }));
    } catch {
      return null;
    }
    let next: Attached | null = null;
    const promoted: Attached[] = [];
    for (const id of [channelId, ...fronted.filter((c) => c !== channelId)]) {
      if (frontDesk(this.liveHooks(), { channelId: id, guildId: desk.guildOf.get(id) ?? null })) {
        if (id === channelId) next = this.sessions.get(frontDesk(this.liveHooks(), { channelId: id, guildId: desk.guildOf.get(id) ?? null })!.conversationId) ?? null;
        continue;
      }
      for (const candidate of this.othersWatching(desk.sessionId, id)) {
        try {
          store.update(candidate.sessionId, (h) => ({ ...h, role: "owner" }));
          promoted.push(candidate);
          if (id === channelId) next = candidate;
          break;
        } catch {
          // Another owner overlaps that chat's channels: try the next.
        }
      }
    }
    const uncovered = fronted.some((id) => !frontDesk(this.liveHooks(), { channelId: id, guildId: desk.guildOf.get(id) ?? null }));
    if (!next || uncovered) {
      // Undo: better a slow front desk than a channel with none.
      for (const s of promoted) {
        try {
          store.update(s.sessionId, (h) => ({ ...h, role: "listener" }));
        } catch {
          // It stays an owner; harmless.
        }
      }
      try {
        store.update(desk.sessionId, (h) => ({ ...h, role: "owner" }));
      } catch {
        // Someone took a channel meanwhile; the next sweep re-plans.
      }
      return null;
    }
    for (const s of [desk, ...promoted]) {
      s.lastClaims = "";
      this.emitClaims(s);
    }
    return next;
  }

  /** The front desk left: the longest-attached chat still watching those channels becomes front desk. */
  private promoteSuccessor(gone: Attached): void {
    const candidates = [...this.sessions.values()]
      .filter((s) => s.channelIds.some((id) => gone.channelIds.includes(id)))
      .sort((a, b) => a.boundAt.localeCompare(b.boundAt));
    for (const next of candidates) {
      if (next.sessionId === gone.sessionId) continue;
      try {
        this.deps.store.update(next.sessionId, (h) => ({ ...h, role: "owner" }));
        next.lastClaims = "";
        this.emitClaims(next);
        return;
      } catch {
        // Owned by someone else (an older watcher, Grok), or this one conflicts: try the next.
      }
    }
  }

  /** Every 30s: keep attached claims live, end lapsed graces, refresh claims. */
  tick(): void {
    const now = this.deps.now();
    for (const session of [...this.sessions.values()]) {
      if (session.detachedAt !== null && now - session.detachedAt > REATTACH_GRACE_MS) {
        this.forget(session.sessionId, { requeue: true });
        continue;
      }
      try {
        if (!this.deps.store.heartbeat(session.sessionId, new Date(now))) {
          // Someone removed the claim (a person clearing stale claims): stop routing to it.
          this.send(session, { type: "error", message: "This chat's watch claim was removed from .hooks.json; stopping.", fatal: true });
          this.forget(session.sessionId, { close: true, requeue: true });
          continue;
        }
      } catch {
        // The hooks file was busy; next tick.
      }
      this.emitClaims(session);
    }
  }

  private send(session: Attached, event: RouterEvent): void {
    if (session.sinks.size > 0) {
      for (const sink of session.sinks) sink.send(event);
    } else if (event.type === "mention" || event.type === "overdue" || event.type === "moved" || event.type === "direct") {
      session.queue.push(event);
      if (session.queue.length > QUEUE_LIMIT) session.queue.shift();
    }
  }

  sendTo(sessionId: string, event: RouterEvent): void {
    const session = this.sessions.get(sessionId);
    if (session) this.send(session, event);
  }

  private here(msg: Pick<GatewayMessage, "channelId" | "guildId" | "threadParentId">): Attached[] {
    return [...this.sessions.values()].filter((s) =>
      hookAllowsChannel(
        { conversationId: s.sessionId, guildId: s.guilds[0]!.id, guildName: "", guilds: s.guilds, channelIds: s.channelIds, channelNames: [], boundAt: "" },
        { ...msg, threadParentId: msg.threadParentId ?? this.deps.parentOf(msg.channelId) },
      ),
    );
  }

  /** The watched channel a message belongs to: a thread's parent, or itself. */
  watchedChannelOf(msg: Pick<GatewayMessage, "channelId" | "threadParentId">): string {
    const watched = this.watchedChannels();
    if (watched.has(msg.channelId)) return msg.channelId;
    const parent = this.deps.parentOf(msg.channelId) ?? msg.threadParentId;
    return parent && watched.has(parent) ? parent : msg.channelId;
  }

  private liveHooks(): HookScope[] {
    return this.deps.store.liveHooks("router");
  }

  /** Every message in a watched channel: the feed for everyone there, done-marking, and routing for mentions. */
  async onMessage(msg: GatewayMessage, opts: { reasonPrefix?: string; feed?: boolean } = {}): Promise<void> {
    const botId = this.deps.botId();
    const sessions = this.here(msg);
    if (sessions.length === 0) return;
    if (msg.authorId === botId && msg.replyToId) mark(this.deps.dirs.done, msg.replyToId);
    if (opts.feed !== false) {
      for (const s of sessions) this.send(s, { type: "message", channelName: this.deps.channelName(msg.channelId), message: msg });
    }
    if (!shouldNotifyChannel(msg, botId)) return;
    await this.routeAndDeliver(msg, opts.reasonPrefix);
  }

  private async routeAndDeliver(msg: GatewayMessage, reasonPrefix?: string): Promise<void> {
    // Seen live and again in catch-up (or twice live): route it once.
    if (this.routed.has(msg.id)) return;
    this.routed.add(msg.id);
    if (this.routed.size > ROUTED_MEMORY) this.routed.delete(this.routed.values().next().value!);
    const hooks = this.liveHooks();
    const watched = this.watchedChannelOf(msg);
    const forRouting = { ...msg, threadParentId: msg.threadParentId ?? this.deps.parentOf(msg.channelId) };
    let route = routeMention(hooks, forRouting, this.deps.ledger, { defaultRepo: this.deps.repoOf(watched) });
    if (this.deps.enrich) route = await this.deps.enrich(route, msg).catch(() => route);
    const reason = reasonPrefix ? `${reasonPrefix}; ${route.reason}` : route.reason;
    const channelName = this.deps.channelName(msg.channelId);
    const sessions = this.here(msg);
    const target = route.to ? this.sessions.get(route.to.conversationId) : undefined;

    if (route.to && target) {
      const taken = takeMessage(this.deps.dirs.taken, msg.id, target.sessionId, watched, this.deps.now(), msg.channelId, route.owned ? "owned" : "new");
      if (taken.ok) {
        unmark(this.deps.dirs.pending, msg.id);
        this.send(target, { type: "mention", channelName, message: msg, route: "mine", reason });
        for (const s of sessions) {
          if (s !== target) this.send(s, { type: "mention", channelName, message: msg, route: "other", routedTo: describeHook(route.to), reason });
        }
        return;
      }
      const by = takenBy(this.deps.dirs.taken, msg.id)?.by ?? "someone";
      for (const s of sessions) this.send(s, { type: "mention", channelName, message: msg, route: "other", routedTo: this.nameOf(by), reason: "already taken" });
      return;
    }

    // Routed to a session not attached here (an older watcher, Grok) or held.
    if (route.to) {
      const desk = frontDesk(hooks, forRouting);
      if (desk && this.sessions.has(desk.conversationId) && !takenBy(this.deps.dirs.taken, msg.id)) {
        retake(this.deps.dirs.pending, msg.id, route.to.conversationId, watched, this.deps.now(), msg.channelId);
      }
    }
    const kind = route.to ? "other" : "none";
    for (const s of sessions) {
      this.send(s, {
        type: "mention",
        channelName,
        message: msg,
        route: kind,
        ...(route.to ? { routedTo: describeHook(route.to) } : {}),
        reason,
      });
    }
  }

  /**
   * Mentions sent while the router was down: anything recent with no Tsukumo
   * reply and no taker is routed as if new. `messages` is oldest first.
   */
  async catchUp(messages: GatewayMessage[]): Promise<void> {
    const botId = this.deps.botId();
    for (const m of messages) if (m.authorId === botId && m.replyToId) mark(this.deps.dirs.done, m.replyToId);
    for (const m of messages) {
      if (!shouldNotifyChannel(m, botId)) continue;
      if (this.deps.now() - Date.parse(m.createdAt) > SWEEP_LOOKBACK_MS) continue;
      if (isMarked(this.deps.dirs.done, m.id) || takenBy(this.deps.dirs.taken, m.id)) continue;
      await this.routeAndDeliver(m, "missed while no chat was watching");
    }
  }

  private nameOf(conversation: string): string {
    const s = this.sessions.get(conversation);
    if (s?.label) return s.label;
    const hook = this.liveHooks().find((h) => h.conversationId === conversation);
    return hook ? describeHook(hook) : `${conversation.slice(0, 8)}…`;
  }

  /** When each conversation first looked gone, so "gone 3 minutes" means gone, not a blip. */
  private readonly goneSince = new Map<string, number>();

  private facts() {
    const { dirs } = this.deps;
    return {
      now: this.deps.now(),
      isAnswered: (id: string) => isMarked(dirs.done, id),
      isHeld: (id: string) => isMarked(dirs.held, id),
      isSeen: (id: string, by: string) => isMarkedFor(dirs.seen, id, by),
      deferredUntil: (id: string, by: string) => deferredUntil(dirs.deferred, id, by),
      wasFlagged: (id: string, by: string) => isMarkedFor(dirs.flagged, id, by),
    };
  }

  /**
   * Every minute: each attached front desk moves what's stranded in its
   * channels, and every attached chat is reminded about its own overdue
   * mentions (the user gets a toast).
   */
  async sweep(): Promise<void> {
    const hooks = this.liveHooks();
    const now = this.deps.now();
    const liveIds = new Set(hooks.map((h) => h.conversationId));
    const { dirs } = this.deps;
    const taken = listTaken(dirs.taken);
    for (const t of taken) {
      if (liveIds.has(t.by)) this.goneSince.delete(t.by);
      else if (!this.goneSince.has(t.by)) this.goneSince.set(t.by, now);
    }
    const facts = this.facts();

    for (const session of [...this.sessions.values()]) {
      if (!this.sessions.has(session.sessionId)) continue;
      const deskOf = (channelId: string) => frontDesk(this.liveHooks(), { channelId, guildId: session.guildOf.get(channelId) ?? null })?.conversationId;
      const myChannels = session.channelIds.filter((id) => deskOf(id) === session.sessionId);
      if (myChannels.length === 0) continue;
      const actions = planSweep(listTaken(dirs.taken), listTaken(dirs.pending), {
        ...facts,
        me: session.sessionId,
        inScope: (id) => myChannels.includes(id),
        goneFor: (c) => (liveIds.has(c) ? 0 : now - (this.goneSince.get(c) ?? now)),
        hasTaker: (id) => takenBy(dirs.taken, id) !== null,
        wasRerouted: (id) => isMarked(dirs.rerouted, id),
        nameOf: (c) => this.nameOf(c),
        canHandOff: (channelId) => this.canHandOff(session, channelId),
      });
      for (const action of actions) {
        if (action.kind === "clear") {
          unmark(dirs.pending, action.messageId);
          continue;
        }
        if (action.kind === "overdue") {
          this.remind(action);
          continue;
        }
        // Re-check against now, not the plan: the holder may have engaged,
        // deferred or answered since, or the mention moved already.
        const current = takenBy(dirs.taken, action.messageId);
        const facts2 = this.facts();
        if (action.kind === "handoff" || (action.kind === "reroute" && action.retake)) {
          const by = action.kind === "handoff" ? session.sessionId : action.from;
          if (!current || current.by !== by || current.atMs !== action.atMs) continue;
          if (facts2.isAnswered(action.messageId) || facts2.isSeen(action.messageId, by) || facts2.deferredUntil(action.messageId, by) !== null) continue;
        }

        if (action.kind === "handoff") {
          const next = this.handOffDesk(session, action.channelId);
          if (!next) {
            this.remind({ messageId: action.messageId, channelId: action.channelId, minutes: action.minutes, to: session.sessionId });
            continue;
          }
          await this.moveTo(next, action, session.sessionId, `${this.nameOf(session.sessionId)} (front desk) hadn't started on it after ${action.minutes} min, so it and the front desk role came to this chat`);
          this.send(session, {
            type: "handoff",
            messageId: action.messageId,
            channelId: action.channelId,
            channelName: this.deps.channelName(action.messageChannelId),
            minutes: action.minutes,
            to: this.nameOf(next.sessionId),
          });
          // This chat isn't the front desk any more; the next sweep re-plans.
          break;
        }

        if (!action.retake && !takeMessage(dirs.taken, action.messageId, session.sessionId, action.channelId, now, action.messageChannelId, "new").ok) {
          unmark(dirs.pending, action.messageId);
          continue;
        }
        await this.moveTo(session, action, action.from, `${action.reason}; front desk takes it`);
      }
    }

    // Reminders for every attached chat's own mentions, wherever they are.
    const reminders = planReminders(listTaken(dirs.taken), {
      ...this.facts(),
      holds: (c) => this.sessions.has(c),
    });
    for (const r of reminders) if (r.kind === "overdue") this.remind(r);
  }

  /** Gives a mention to `to` (front-desk work now), tells the chat it came from, and wakes `to`. */
  private async moveTo(
    to: Attached,
    action: { messageId: string; channelId: string; messageChannelId: string },
    from: string,
    reason: string,
  ): Promise<void> {
    const { dirs } = this.deps;
    retake(dirs.taken, action.messageId, to.sessionId, action.channelId, this.deps.now(), action.messageChannelId, "new");
    unmark(dirs.pending, action.messageId);
    for (const dir of [dirs.seen, dirs.deferred, dirs.flagged]) unmark(dir, action.messageId);
    mark(dirs.rerouted, action.messageId);
    const previous = this.sessions.get(from);
    if (previous && previous !== to) {
      this.send(previous, {
        type: "moved",
        messageId: action.messageId,
        channelName: this.deps.channelName(action.messageChannelId),
        to: this.nameOf(to.sessionId),
      });
    }
    const message = await this.deps.fetchMessage(action.messageChannelId, action.messageId).catch(() => null);
    if (!message) return;
    this.send(to, { type: "mention", channelName: this.deps.channelName(action.messageChannelId), message, route: "mine", reason });
  }

  /** Toast the user and remind the holder, once per mention and holder; only to a holder this router reaches. */
  private remind(action: { messageId: string; channelId: string; minutes: number; to: string }): void {
    const holder = this.sessions.get(action.to);
    if (!holder || isMarkedFor(this.deps.dirs.flagged, action.messageId, action.to)) return;
    mark(this.deps.dirs.flagged, action.messageId, action.to);
    this.send(holder, {
      type: "overdue",
      messageId: action.messageId,
      channelId: action.channelId,
      channelName: this.deps.channelName(action.channelId),
      minutes: action.minutes,
    });
  }

  /** Control requests from a session's mod (via its attach process). */
  control(
    sessionId: string,
    op: string,
    input: { threadId?: string; messageId?: string; channelId?: string; [key: string]: unknown },
    threadParent?: string | null,
  ):
    | { ok: true; [key: string]: unknown }
    | { ok: false; status: number; error: string } {
    const session = this.sessions.get(sessionId);
    if (!session) return { ok: false, status: 404, error: "This chat isn't attached to the router." };
    const { store, dirs } = this.deps;
    try {
      if (op === "release") {
        // An explicit stop (not a reload): let go now, no grace.
        this.forget(sessionId, { requeue: true });
        return { ok: true };
      } else if (op === "own" || op === "listen") {
        store.update(sessionId, (h) => ({ ...h, role: op === "own" ? "owner" : "listener" }));
      } else if (op === "claim-thread" || op === "release-thread") {
        const threadId = String(input.threadId ?? "");
        if (!/^\d{15,22}$/.test(threadId)) return { ok: false, status: 400, error: "Give a thread id." };
        if (op === "claim-thread" && !(threadParent && session.channelIds.includes(threadParent))) {
          return { ok: false, status: 400, error: "That isn't a thread in a watched channel." };
        }
        store.update(sessionId, (h) => {
          const rest = (h.threadIds ?? []).filter((id) => id !== threadId);
          return { ...h, threadIds: op === "claim-thread" ? [...rest, threadId] : rest };
        });
      } else if (op === "take") {
        const messageId = String(input.messageId ?? "");
        const messageChannelId = input.channelId ?? null;
        const watched = messageChannelId ? this.watchedChannelOf({ channelId: messageChannelId, threadParentId: null }) : null;
        // A person handed it to this chat (Deliver, Take it): it's the chat's to answer, not new work to move on.
        const taken = takeMessage(dirs.taken, messageId, sessionId, watched, this.deps.now(), messageChannelId, "owned");
        if (!taken.ok) return { ok: false, status: 409, error: `Already taken by ${this.nameOf(taken.takenBy)}.` };
        unmark(dirs.held, messageId);
        return { ok: true };
      } else if (op === "alias") {
        this.addAlias(session, String(input.name ?? ""));
        return { ok: true };
      } else if (op === "chats") {
        return { ok: true, chats: this.otherChats(sessionId) };
      } else if (op === "poster") {
        // Which other chat here posted a Discord message, so a reply to it can go to that chat directly.
        const poster = this.deps.ledger.owners(`msg:${String(input.messageId ?? "")}`)[0]?.sessionId;
        const local = poster && poster !== sessionId ? this.sessions.get(poster) : undefined;
        return { ok: true, session: local ? local.sessionId : null, label: local ? this.displayName(local) : null };
      } else if (op === "direct") {
        return this.direct(session, input);
      } else if (op === "hold") {
        mark(dirs.held, String(input.messageId ?? ""));
        return { ok: true };
      } else if (op === "seen") {
        // Only the chat holding it engages it.
        const messageId = String(input.messageId ?? "");
        if (takenBy(dirs.taken, messageId)?.by === sessionId) mark(dirs.seen, messageId, sessionId);
        return { ok: true };
      } else if (op === "holder") {
        // Who holds a mention now, so a chat about to reply can tell it moved on.
        const by = takenBy(dirs.taken, String(input.messageId ?? ""))?.by ?? null;
        return { ok: true, holder: by, label: by ? this.nameOf(by) : null, mine: by === sessionId } as never;
      } else if (op === "defer") {
        const messageId = String(input.messageId ?? "");
        const untilMs = Number((input as { untilMs?: unknown }).untilMs);
        if (takenBy(dirs.taken, messageId)?.by !== sessionId) {
          return { ok: false, status: 409, error: "This chat isn't the one handling that mention." };
        }
        if (!Number.isFinite(untilMs) || untilMs <= this.deps.now()) {
          return { ok: false, status: 400, error: "Give a time in the future." };
        }
        defer(dirs.deferred, messageId, sessionId, Math.min(untilMs, this.deps.now() + MAX_DEFER_MS), String((input as { note?: unknown }).note ?? ""));
        // A new deferral gets its own reminder when it passes.
        unmark(dirs.flagged, messageId);
        return { ok: true };
      } else if (op === "skip") {
        // The holder chose not to reply: answered, so it's never moved or reminded.
        const messageId = String(input.messageId ?? "");
        if (takenBy(dirs.taken, messageId)?.by !== sessionId) {
          return { ok: false, status: 409, error: "This chat isn't the one handling that mention." };
        }
        mark(dirs.done, messageId);
        return { ok: true };
      } else {
        return { ok: false, status: 404, error: `Unknown control "${op}".` };
      }
    } catch (err) {
      return { ok: false, status: err instanceof GatewayError ? err.status : 500, error: err instanceof Error ? err.message : String(err) };
    }
    session.lastClaims = "";
    this.emitClaims(session);
    return { ok: true };
  }

  private addAlias(session: Attached, raw: string): void {
    const name = raw.trim().toLowerCase();
    if (!name || name.length > 60) return;
    session.aliases.delete(name);
    session.aliases.add(name);
    if (session.aliases.size > 10) session.aliases.delete(session.aliases.values().next().value!);
    try {
      this.deps.aliasStore?.set(session.sessionId, [...session.aliases]);
    } catch {
      // Remembered for this run either way.
    }
  }

  /** How a chat is shown to others: the name it last posted under, else its label. */
  private displayName(session: Attached): string {
    return [...session.aliases].at(-1) ?? session.label ?? `${session.sessionId.slice(0, 8)}…`;
  }

  /** Other chats attached here, for list_chats. */
  private otherChats(me: string) {
    return [...this.sessions.values()]
      .filter((s) => s.sessionId !== me)
      .map((s) => ({
        session: s.sessionId,
        name: this.displayName(s),
        label: s.label ?? null,
        aliases: [...s.aliases],
        connected: s.sinks.size > 0,
      }));
  }

  /** The chat `to` names: a session id (or its first 8+ characters), a name it posts under, or its label. */
  private resolveChat(me: Attached, to: string): { ok: true; session: Attached } | { ok: false; status: number; error: string } {
    const wanted = to.trim().toLowerCase();
    if (!wanted) return { ok: false, status: 400, error: "Say which chat (`to`)." };
    if (me.sessionId.toLowerCase() === wanted || me.aliases.has(wanted)) return { ok: false, status: 400, error: "That's this chat." };
    const others = [...this.sessions.values()].filter((s) => s !== me);
    const byId = others.filter(
      (s) => s.sessionId.toLowerCase() === wanted || (wanted.length >= 8 && s.sessionId.toLowerCase().startsWith(wanted)),
    );
    const byName = others.filter((s) => s.aliases.has(wanted) || s.label?.toLowerCase() === wanted);
    const matches = byId.length ? byId : byName;
    if (matches.length === 1) return { ok: true, session: matches[0]! };
    if (matches.length > 1) {
      const which = matches.map((s) => `${this.displayName(s)} (${s.sessionId.slice(0, 8)})`).join(", ");
      return { ok: false, status: 409, error: `"${to}" matches ${matches.length} chats: ${which}. Use a session id.` };
    }
    const list = others.map((s) => this.displayName(s)).join(", ") || "none";
    return { ok: false, status: 404, error: `No chat here called "${to}". Chats attached now: ${list}.` };
  }

  /** Delivers a direct message to another attached chat (queued if it's mid-reload). */
  private direct(
    session: Attached,
    input: Record<string, unknown>,
  ): { ok: true; [key: string]: unknown } | { ok: false; status: number; error: string } {
    const content = String(input.content ?? "").trim();
    if (!content) return { ok: false, status: 400, error: "Give the message text." };
    if (content.length > MAX_DIRECT_CHARS) {
      return { ok: false, status: 400, error: `Too long (${content.length} characters; at most ${MAX_DIRECT_CHARS}).` };
    }
    const found = this.resolveChat(session, String(input.to ?? ""));
    if (!found.ok) return found;
    const target = found.session;

    const now = this.deps.now();
    const pair = [session.sessionId, target.sessionId].sort().join("|");
    const times = (this.directTimes.get(pair) ?? []).filter((t) => now - t < DIRECT_WINDOW_MS);
    if (times.length >= DIRECT_LIMIT) {
      this.directTimes.set(pair, times);
      return {
        ok: false,
        status: 429,
        error: `Not sent: ${times.length} direct messages between this chat and ${this.displayName(target)} in the last ${DIRECT_WINDOW_MS / 60_000} minutes. Stop the back-and-forth: post on Discord, or ask the person at your prompt.`,
      };
    }
    times.push(now);
    this.directTimes.set(pair, times);

    const from = String(input.from ?? "").trim();
    if (from) this.addAlias(session, from);
    const about = input.about as { channelId?: unknown; messageId?: unknown } | undefined;
    const aboutId = String(about?.messageId ?? "");
    const replyToId = typeof input.replyToId === "string" ? input.replyToId.trim() : "";
    const event: Extract<RouterEvent, { type: "direct" }> = {
      type: "direct",
      id: `d${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      from: from || this.displayName(session),
      fromSession: session.sessionId,
      content,
      ...(replyToId ? { replyToId } : {}),
      ...(/^[0-9]{15,22}$/.test(aboutId) ? { about: { channelId: String(about?.channelId ?? ""), messageId: aboutId } } : {}),
      sentAt: new Date(now).toISOString(),
    };
    this.send(target, event);
    try {
      this.deps.logDirect?.({ ...event, to: target.sessionId });
    } catch {
      // The record is a nicety; the message went.
    }
    return { ok: true, id: event.id, to: this.displayName(target), session: target.sessionId, queued: target.sinks.size === 0 };
  }

  private emitClaims(session: Attached): void {
    let mine: HookScope | null = null;
    let others: HookScope[] = [];
    try {
      mine = this.deps.store.load(session.sessionId);
      if (!mine) return;
      others = this.liveHooks().filter(
        (h) => h.conversationId !== session.sessionId && (h.channelIds ?? []).some((id) => mine!.channelIds?.includes(id)),
      );
    } catch {
      return;
    }
    const owner = isOwner(mine) ? null : others.find(isOwner);
    const event: RouterEvent = {
      type: "claims",
      role: isOwner(mine) ? "owner" : "listener",
      threadIds: mine.threadIds ?? [],
      owner: owner ? describeHook(owner) : null,
      listeners: others.filter((h) => !isOwner(h)).length + (isOwner(mine) ? 0 : 1),
    };
    const text = JSON.stringify(event);
    if (text === session.lastClaims) return;
    session.lastClaims = text;
    this.send(session, event);
  }

  /** Every attached session's claims, re-checked (others' ownership changes show up here). */
  refreshClaims(): void {
    for (const session of this.sessions.values()) this.emitClaims(session);
  }

  /** Shutting down: release every claim we hold. */
  releaseAll(): void {
    for (const id of [...this.sessions.keys()]) this.forget(id);
  }
}
