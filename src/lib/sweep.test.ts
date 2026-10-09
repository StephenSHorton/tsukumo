import { describe, expect, test } from "bun:test";
import { planReminders, planSweep, type MentionFacts, type SweepOptions } from "./sweep.ts";
import type { Taken, TakeKind } from "./take.ts";

const NOW = Date.parse("2026-10-09T18:00:00.000Z");
const C = "100000000000000001";
const T = "100000000000000003";
const t = (
  messageId: string,
  by: string,
  minutesAgo: number,
  kind: TakeKind = "new",
  channelId: string | null = C,
  messageChannelId: string | null = channelId,
): Taken => ({ messageId, by, channelId, messageChannelId, atMs: NOW - minutesAgo * 60_000, kind });

const facts: MentionFacts = {
  now: NOW,
  isAnswered: () => false,
  isHeld: () => false,
  isSeen: () => false,
  deferredUntil: () => null,
  wasFlagged: () => false,
};

function plan(taken: Taken[], over: Partial<SweepOptions> = {}, pending: Taken[] = []) {
  return planSweep(taken, pending, {
    ...facts,
    me: "desk",
    inScope: (id) => id === C,
    goneFor: (c) => (c === "gone" ? 4 * 60_000 : c === "blip" ? 10_000 : 0),
    hasTaker: () => false,
    wasRerouted: () => false,
    nameOf: (c) => `chat ${c}`,
    canHandOff: () => true,
    ...over,
  });
}

function remind(taken: Taken[], over: Partial<MentionFacts> = {}, holds = (c: string) => c !== "elsewhere") {
  return planReminders(taken, { ...facts, ...over, holds });
}

describe("planSweep (what the front desk moves)", () => {
  test("a taker gone 3 minutes loses it, whatever it is, however long it held it; a restart blip doesn't", () => {
    expect(plan([t("1550000000000000001", "gone", 40, "owned")])).toMatchObject([
      { kind: "reroute", from: "gone", reason: "chat gone took it but went away before answering" },
    ]);
    // Held 40 min, gone 10 s: not gone yet.
    expect(plan([t("1550000000000000001", "blip", 40, "owned")])).toEqual([]);
  });

  test("new work a chat hasn't started on moves to the front desk after 10 minutes", () => {
    expect(plan([t("1550000000000000002", "api", 9)])).toEqual([]);
    expect(plan([t("1550000000000000002", "api", 11)])[0]).toMatchObject({ kind: "reroute", reason: "chat api hadn't started on it after 11 min" });
  });

  test("engaged, deferred, or the chat's own work is never moved while the chat is around", () => {
    expect(plan([t("1550000000000000003", "api", 300)], { isSeen: () => true })).toEqual([]);
    expect(plan([t("1550000000000000003", "api", 300)], { deferredUntil: () => NOW + 60_000 })).toEqual([]);
    expect(plan([t("1550000000000000003", "api", 300, "owned")])).toEqual([]);
    expect(plan([t("1550000000000000003", "desk", 300)], { isSeen: () => true })).toEqual([]);
  });

  test("the front desk not starting on new work hands it and the role on, once; otherwise it's flagged", () => {
    expect(plan([t("1550000000000000006", "desk", 11)])).toEqual([
      { kind: "handoff", messageId: "1550000000000000006", channelId: C, messageChannelId: C, minutes: 11, atMs: NOW - 11 * 60_000 },
    ]);
    expect(plan([t("1550000000000000006", "desk", 11)], { wasRerouted: () => true })).toEqual([
      { kind: "overdue", messageId: "1550000000000000006", channelId: C, minutes: 11, to: "desk" },
    ]);
    expect(plan([t("1550000000000000006", "desk", 11)], { canHandOff: () => false })[0]).toMatchObject({ kind: "overdue", to: "desk" });
  });

  test("a thread message keeps its own channel for fetching and its parent for scope", () => {
    expect(plan([t("1550000000000000007", "gone", 5, "new", C, T)])[0]).toMatchObject({ channelId: C, messageChannelId: T });
  });

  test("answered, held by a person, other channels, unknown channels and history are left alone", () => {
    expect(plan([t("1550000000000000008", "gone", 5)], { isAnswered: () => true })).toEqual([]);
    expect(plan([t("1550000000000000008", "gone", 5)], { isHeld: () => true })).toEqual([]);
    expect(plan([t("1550000000000000008", "gone", 5, "new", "999999999999999999")])).toEqual([]);
    expect(plan([t("1550000000000000008", "gone", 5, "new", null)])).toEqual([]);
    expect(plan([t("1550000000000000008", "gone", 7 * 60)])).toEqual([]);
  });

  test("a long deferral keeps the mention in view: its holder dying at hour 7 still moves it", () => {
    const deferredToHour8 = (_id: string, by: string) => (by === "gone" ? NOW + 60 * 60_000 : null);
    expect(plan([t("1550000000000000009", "gone", 7 * 60)], { deferredUntil: deferredToHour8 })[0]).toMatchObject({ kind: "reroute" });
  });

  test("a mention sent to a session that never took it comes back after 90s; one it took clears", () => {
    expect(plan([], {}, [t("1550000000000000010", "api", 1)])).toEqual([]);
    expect(plan([], {}, [t("1550000000000000010", "api", 2)])).toMatchObject([
      { kind: "reroute", retake: false, from: "api", reason: "routed to chat api, which never picked it up" },
    ]);
    expect(plan([], { hasTaker: () => true }, [t("1550000000000000010", "api", 2)])).toEqual([{ kind: "clear", messageId: "1550000000000000010" }]);
  });
});

describe("planReminders (the holder's own process)", () => {
  test("an hour with no reply and no deferral: remind the holder, once", () => {
    expect(remind([t("1550000000000000020", "api", 59, "owned")])).toEqual([]);
    expect(remind([t("1550000000000000020", "api", 61, "owned")])).toEqual([
      { kind: "overdue", messageId: "1550000000000000020", channelId: C, minutes: 61, to: "api" },
    ]);
    expect(remind([t("1550000000000000020", "api", 61, "owned")], { wasFlagged: () => true })).toEqual([]);
  });

  test("a deferral moves the reminder to its time, even past the usual lookback", () => {
    const until = NOW - 60_000;
    expect(remind([t("1550000000000000021", "api", 8 * 60)], { deferredUntil: () => until })[0]).toMatchObject({ kind: "overdue", to: "api" });
    expect(remind([t("1550000000000000021", "api", 30)], { deferredUntil: () => NOW + 60_000 })).toEqual([]);
  });

  test("an earlier holder's deferral or flag doesn't count for the new holder", () => {
    const byOld = (_id: string, by: string) => (by === "old" ? NOW + 5 * 3_600_000 : null);
    expect(remind([t("1550000000000000022", "desk", 61)], { deferredUntil: byOld })[0]).toMatchObject({ kind: "overdue", to: "desk" });
    expect(remind([t("1550000000000000022", "desk", 61)], { wasFlagged: (_id, by) => by === "old" })[0]).toMatchObject({ to: "desk" });
  });

  test("only holders this process can reach are reminded", () => {
    expect(remind([t("1550000000000000023", "elsewhere", 90)])).toEqual([]);
  });
});
