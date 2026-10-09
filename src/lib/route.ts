import { describeHook, hookAllowsChannel, isOwner, type HookScope } from "./hook.ts";
import type { LedgerEntry } from "./ledger.ts";
import { extractPrRefs, prKey } from "./refs.ts";

export interface RoutableMessage {
  channelId: string;
  guildId: string | null;
  /** The parent channel when the message is in a thread. */
  threadParentId?: string | null;
}

export interface RoutableMention extends RoutableMessage {
  content: string;
  replyToId?: string | null;
}

/** The routing version this code speaks (see HookScope.routing). */
export const ROUTING_VERSION = 2;

export interface Route {
  /** The session that answers, or null: held until someone takes it. */
  to: HookScope | null;
  /** Why, in a phrase the woken session and the pane can show. */
  reason: string;
  /** True when it went to the chat whose work it's about (not front-desk work). */
  owned: boolean;
}

/** The ledger lookup the router needs; `Ledger` implements it. */
export interface OwnerLookup {
  owners(key: string): LedgerEntry[];
}

const none: OwnerLookup = { owners: () => [] };

/** The channel's front desk: its owner (the earliest, if two rows somehow both claim it). */
export function frontDesk(hooks: readonly HookScope[], msg: RoutableMessage): HookScope | null {
  return (
    hooks
      .filter((hook) => isOwner(hook) && hookAllowsChannel(hook, msg))
      .sort((a, b) => a.boundAt.localeCompare(b.boundAt))[0] ?? null
  );
}

/**
 * Which session answers a mention. Every watcher runs this on the same hooks,
 * the same ledger and the same message, so they agree on one:
 *
 * 1. a reply to a message a session posted → that session;
 * 2. a thread a session claimed → that session;
 * 3. a PR the message names → the session that opened it (else touched, else reviewed it);
 * 4. anything else → the channel's front desk.
 *
 * A session found in 1–3 only gets it if it is watching this channel now;
 * otherwise the front desk takes it, told whose it was. No front desk: held.
 */
export function routeMention(
  hooks: readonly HookScope[],
  msg: RoutableMention,
  ledger: OwnerLookup = none,
  opts: { defaultRepo?: string } = {},
): Route {
  // Only a watcher that speaks ledger routing may be sent a mention by it: an
  // older watcher (or Grok) would route the same mention to its own front desk.
  const here = (sessionId: string) =>
    hooks.find(
      (hook) =>
        hook.conversationId === sessionId &&
        hookAllowsChannel(hook, msg) &&
        (hook.routing ?? 0) >= ROUTING_VERSION,
    ) ?? null;
  const desk = frontDesk(hooks, msg);
  // A front desk on older code answers everything it owns, so ledger routing
  // would double-answer: fall back to the old rules (thread, then front desk).
  const ledgerRouting = !desk || (desk.routing ?? 0) >= ROUTING_VERSION;
  const toDesk = (reason: string): Route => ({ to: desk, reason: desk ? reason : `${reason}; no front desk, so it's held`, owned: false });
  const toOwner = (entry: LedgerEntry, what: string): Route => {
    const live = here(entry.sessionId);
    if (live) return { to: live, reason: what, owned: true };
    const who = entry.label ?? `${entry.sessionId.slice(0, 8)}…`;
    return toDesk(`${what}, but ${who} isn't watching here; front desk takes it`);
  };

  if (ledgerRouting && msg.replyToId) {
    const poster = ledger.owners(`msg:${msg.replyToId}`)[0];
    if (poster) return toOwner(poster, "a reply to a message this chat posted");
  }

  const threadOwner = hooks.find((hook) => hook.threadIds?.includes(msg.channelId) && hookAllowsChannel(hook, msg));
  if (threadOwner) return { to: threadOwner, reason: "in a thread this chat claimed", owned: true };

  for (const ref of ledgerRouting ? extractPrRefs(msg.content, { defaultRepo: opts.defaultRepo }) : []) {
    const owner = ledger.owners(prKey(ref))[0];
    if (!owner) continue;
    const verb = owner.role === "reviewer" ? "reviewed" : owner.role === "touched" ? "worked on" : "opened";
    return toOwner(owner, `about ${ref.repo.split("/")[1]}#${ref.number}, which this chat ${verb}`);
  }

  return toDesk(desk ? "no chat owns this; front desk" : "no chat owns this");
}

/** For logs and the pane: who a route went to. */
export function describeRoute(route: Route): string {
  return route.to ? `${describeHook(route.to)} (${route.reason})` : `held (${route.reason})`;
}
