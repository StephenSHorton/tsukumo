import type { Taken } from "./take.ts";

/**
 * New work a chat hasn't engaged with (its turn never started) moves on after
 * this long: to the front desk, or, if the front desk itself is the one not
 * engaging, to the next chat along with the front-desk role.
 */
export const UNENGAGED_LIMIT_MS = 10 * 60_000;
/**
 * A chat that engaged (or whose own work it is) decides when to answer; after
 * this long with no reply and no deferral, the user gets a toast and the chat a
 * reminder. Nothing is reassigned.
 */
export const QUIET_LIMIT_MS = 60 * 60_000;
/** A taker that has looked gone this long has really gone (not a restart or a sleep/wake blip). */
export const GONE_GRACE_MS = 3 * 60_000;
/** A mention sent to another session that hasn't taken it after this long comes back. */
export const PICKUP_GRACE_MS = 90_000;
/** Mentions older than this (counted from a deferral's time, if later) are history, not work. */
export const SWEEP_LOOKBACK_MS = 6 * 3_600_000;
/** The longest a chat may defer its answer. */
export const MAX_DEFER_MS = 12 * 3_600_000;

export type SweepAction =
  | { kind: "reroute"; messageId: string; channelId: string; messageChannelId: string; reason: string; retake: boolean; from: string; atMs: number }
  /** The front desk didn't engage with new work: hand it, and the role, to the next chat. */
  | { kind: "handoff"; messageId: string; channelId: string; messageChannelId: string; minutes: number; atMs: number }
  /** Unanswered past its limit: toast the user, remind the holder (`to`). Once per mention and holder. */
  | { kind: "overdue"; messageId: string; channelId: string; minutes: number; to: string }
  /** A pending hand-off that resolved (taken, answered or held); drop its record. */
  | { kind: "clear"; messageId: string };

/** What every plan needs to know about a mention, per holder. */
export interface MentionFacts {
  now: number;
  isAnswered: (messageId: string) => boolean;
  /** A person held or dismissed it in their pane (block list, allowlist): leave it alone. */
  isHeld: (messageId: string) => boolean;
  /** `by`'s turn for it started: it's engaged. */
  isSeen: (messageId: string, by: string) => boolean;
  /** When `by` said it would answer by (defer_mention), if it did. */
  deferredUntil: (messageId: string, by: string) => number | null;
  wasFlagged: (messageId: string, by: string) => boolean;
}

export interface SweepOptions extends MentionFacts {
  /** The front desk running this sweep. */
  me: string;
  /** Whether a watched channel is one this front desk sweeps. */
  inScope: (channelId: string) => boolean;
  /** How long a conversation has looked gone (0 while live). */
  goneFor: (conversation: string) => number;
  hasTaker: (messageId: string) => boolean;
  wasRerouted: (messageId: string) => boolean;
  nameOf: (conversation: string) => string;
  /** Whether the front desk can hand this channel on (another chat watches it and every other channel it fronts keeps a desk). */
  canHandOff?: (channelId: string) => boolean;
}

/** Still live work: in a channel we cover, not answered, not held by a person, and not history. */
function open(t: Taken, f: MentionFacts, inScope: (channelId: string) => boolean): boolean {
  if (!t.channelId || !inScope(t.channelId)) return false;
  if (f.isAnswered(t.messageId) || f.isHeld(t.messageId)) return false;
  const since = Math.max(t.atMs, f.deferredUntil(t.messageId, t.by) ?? 0);
  return f.now - since <= SWEEP_LOOKBACK_MS;
}

const engaged = (t: Taken, f: MentionFacts) => f.isSeen(t.messageId, t.by) || f.deferredUntil(t.messageId, t.by) !== null;

/**
 * What the front desk moves, so nothing is stranded but nobody with a reason
 * to wait is rushed:
 *
 * - The taker has been gone 3 minutes: the front desk takes it, whatever it is.
 * - New work the taker never engaged with (10 min): the front desk takes it;
 *   if the front desk is the taker, it and the role go to the next chat
 *   (once; otherwise the front desk's own reminder fires).
 * - Engaged, deferred, or the taker's own work: never moved (see planReminders).
 * - A hand-off another session never took (90 s): it comes back.
 */
export function planSweep(taken: readonly Taken[], pending: readonly Taken[], opts: SweepOptions): SweepAction[] {
  const actions: SweepAction[] = [];
  for (const t of taken) {
    if (!open(t, opts, opts.inScope)) continue;
    const age = opts.now - t.atMs;
    const where = { messageId: t.messageId, channelId: t.channelId!, messageChannelId: t.messageChannelId ?? t.channelId!, atMs: t.atMs };
    const mine = t.by === opts.me;

    if (!mine && opts.goneFor(t.by) > GONE_GRACE_MS) {
      actions.push({ kind: "reroute", ...where, retake: true, from: t.by, reason: `${opts.nameOf(t.by)} took it but went away before answering` });
      continue;
    }
    if (engaged(t, opts) || t.kind === "owned" || age <= UNENGAGED_LIMIT_MS) continue;

    // New work nobody has engaged with.
    const minutes = Math.floor(age / 60_000);
    if (!mine) {
      if (!opts.wasRerouted(t.messageId)) {
        actions.push({ kind: "reroute", ...where, retake: true, from: t.by, reason: `${opts.nameOf(t.by)} hadn't started on it after ${minutes} min` });
      }
      continue;
    }
    if (!opts.wasRerouted(t.messageId) && opts.canHandOff?.(t.channelId!)) {
      actions.push({ kind: "handoff", ...where, minutes });
    } else if (!opts.wasFlagged(t.messageId, t.by)) {
      actions.push({ kind: "overdue", messageId: t.messageId, channelId: t.channelId!, minutes, to: t.by });
    }
  }

  for (const p of pending) {
    if (opts.hasTaker(p.messageId) || !open(p, opts, opts.inScope)) {
      actions.push({ kind: "clear", messageId: p.messageId });
      continue;
    }
    if (opts.now - p.atMs > PICKUP_GRACE_MS) {
      actions.push({
        kind: "reroute",
        messageId: p.messageId,
        channelId: p.channelId!,
        messageChannelId: p.messageChannelId ?? p.channelId!,
        atMs: p.atMs,
        retake: false,
        from: p.by,
        reason: `routed to ${opts.nameOf(p.by)}, which never picked it up`,
      });
    }
  }
  return actions;
}

/**
 * Reminders, run by whichever process holds the mention (it can reach that
 * chat): once a holder is past its deferral, or an hour on anything without
 * one, the user gets a toast and the holder a reminder. Nothing moves.
 */
export function planReminders(
  taken: readonly Taken[],
  opts: MentionFacts & { holds: (conversation: string) => boolean },
): SweepAction[] {
  const actions: SweepAction[] = [];
  for (const t of taken) {
    if (!opts.holds(t.by) || !open(t, opts, () => true)) continue;
    if (opts.wasFlagged(t.messageId, t.by)) continue;
    const deferred = opts.deferredUntil(t.messageId, t.by);
    const due = deferred ?? t.atMs + QUIET_LIMIT_MS;
    if (opts.now > due) {
      actions.push({ kind: "overdue", messageId: t.messageId, channelId: t.channelId!, minutes: Math.floor((opts.now - t.atMs) / 60_000), to: t.by });
    }
  }
  return actions;
}
