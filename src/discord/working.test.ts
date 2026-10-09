import { describe, expect, test } from "bun:test";
import {
  ACK_EMOJI,
  TYPING_INTERVAL_MS,
  WORKING_TIMEOUT_MS,
  WorkingPresence,
  type TimerFns,
  type WorkingApi,
} from "./working.ts";

type Scheduled = { fn: () => void; ms: number; id: number; kind: "timeout" | "interval" };

function fakeTimers() {
  let nextId = 1;
  const scheduled: Scheduled[] = [];
  const timers: TimerFns = {
    setTimeout(fn, ms) {
      const id = nextId++;
      scheduled.push({ fn, ms, id, kind: "timeout" });
      return id;
    },
    clearTimeout(id) {
      const i = scheduled.findIndex((s) => s.id === id && s.kind === "timeout");
      if (i >= 0) scheduled.splice(i, 1);
    },
    setInterval(fn, ms) {
      const id = nextId++;
      scheduled.push({ fn, ms, id, kind: "interval" });
      return id;
    },
    clearInterval(id) {
      const i = scheduled.findIndex((s) => s.id === id && s.kind === "interval");
      if (i >= 0) scheduled.splice(i, 1);
    },
  };
  return { timers, scheduled };
}

function fakeApi(over: Partial<{
  react: WorkingApi["react"];
  unreact: WorkingApi["unreact"];
  sendTyping: WorkingApi["sendTyping"];
}> = {}) {
  const calls = {
    react: [] as Array<[string, string, string]>,
    unreact: [] as Array<[string, string, string]>,
    sendTyping: [] as string[],
  };
  const api: WorkingApi = {
    async react(channelId, messageId, emoji) {
      calls.react.push([channelId, messageId, emoji]);
      await over.react?.(channelId, messageId, emoji);
    },
    async unreact(channelId, messageId, emoji) {
      calls.unreact.push([channelId, messageId, emoji]);
      await over.unreact?.(channelId, messageId, emoji);
    },
    async sendTyping(channelId) {
      calls.sendTyping.push(channelId);
      await over.sendTyping?.(channelId);
    },
  };
  return { api, calls };
}

describe("WorkingPresence", () => {
  test("start reacts with eyes and types immediately", async () => {
    const { api, calls } = fakeApi();
    const { timers } = fakeTimers();
    const working = new WorkingPresence(api, { timers });

    await working.start("c1", "m1");

    expect(calls.react).toEqual([["c1", "m1", ACK_EMOJI]]);
    expect(calls.sendTyping).toEqual(["c1"]);
    expect(working.snapshot()).toEqual([{ channelId: "c1", messageIds: ["m1"] }]);
  });

  test("second start on the same message does not re-react", async () => {
    const { api, calls } = fakeApi();
    const { timers } = fakeTimers();
    const working = new WorkingPresence(api, { timers });

    await working.start("c1", "m1");
    await working.start("c1", "m1");

    expect(calls.react).toHaveLength(1);
    expect(calls.sendTyping.length).toBeGreaterThanOrEqual(2);
  });

  test("two messages in one channel share a typing loop", async () => {
    const { api, calls } = fakeApi();
    const { timers, scheduled } = fakeTimers();
    const working = new WorkingPresence(api, { timers });

    await working.start("c1", "m1");
    await working.start("c1", "m2");

    expect(calls.react).toHaveLength(2);
    expect(scheduled.filter((s) => s.kind === "interval")).toHaveLength(1);
    expect(working.snapshot()[0]?.messageIds).toEqual(["m1", "m2"]);
  });

  test("complete one of two keeps typing and only unreacts that message", async () => {
    const { api, calls } = fakeApi();
    const { timers, scheduled } = fakeTimers();
    const working = new WorkingPresence(api, { timers });

    await working.start("c1", "m1");
    await working.start("c1", "m2");
    const { cleared } = await working.complete("c1", "m1");

    expect(cleared).toEqual(["m1"]);
    expect(calls.unreact).toEqual([["c1", "m1", ACK_EMOJI]]);
    expect(working.snapshot()).toEqual([{ channelId: "c1", messageIds: ["m2"] }]);
    expect(scheduled.filter((s) => s.kind === "interval")).toHaveLength(1);
  });

  test("complete last message stops typing", async () => {
    const { api, calls } = fakeApi();
    const { timers, scheduled } = fakeTimers();
    const working = new WorkingPresence(api, { timers });

    await working.start("c1", "m1");
    await working.complete("c1", "m1");

    expect(calls.unreact).toEqual([["c1", "m1", ACK_EMOJI]]);
    expect(working.snapshot()).toEqual([]);
    expect(scheduled.filter((s) => s.kind === "interval")).toHaveLength(0);
  });

  test("complete without messageId clears the whole channel", async () => {
    const { api, calls } = fakeApi();
    const { timers } = fakeTimers();
    const working = new WorkingPresence(api, { timers });

    await working.start("c1", "m1");
    await working.start("c1", "m2");
    const { cleared } = await working.complete("c1");

    expect(cleared).toEqual(["m1", "m2"]);
    expect(calls.unreact).toHaveLength(2);
    expect(working.snapshot()).toEqual([]);
  });

  test("timeout clears the ack and stops typing", async () => {
    const { api, calls } = fakeApi();
    const { timers, scheduled } = fakeTimers();
    const working = new WorkingPresence(api, { timers });

    await working.start("c1", "m1");
    const timeout = scheduled.find(
      (s) => s.kind === "timeout" && s.ms === WORKING_TIMEOUT_MS,
    );
    expect(timeout).toBeDefined();
    timeout?.fn();
    await Promise.resolve();
    await Promise.resolve();

    expect(working.snapshot()).toEqual([]);
    expect(calls.unreact).toEqual([["c1", "m1", ACK_EMOJI]]);
  });

  test("typing interval refreshes sendTyping", async () => {
    const { api, calls } = fakeApi();
    const { timers, scheduled } = fakeTimers();
    const working = new WorkingPresence(api, { timers });

    await working.start("c1", "m1");
    expect(calls.sendTyping).toHaveLength(1);

    const interval = scheduled.find(
      (s) => s.kind === "interval" && s.ms === TYPING_INTERVAL_MS,
    );
    expect(interval).toBeDefined();
    interval?.fn();
    await Promise.resolve();
    await Promise.resolve();

    expect(calls.sendTyping).toHaveLength(2);
  });

  test("API errors on react do not throw and typing still starts", async () => {
    const { api, calls } = fakeApi({
      react: async () => {
        throw new Error("missing permissions");
      },
    });
    const { timers } = fakeTimers();
    const working = new WorkingPresence(api, { timers });

    await working.start("c1", "m1");
    expect(calls.sendTyping).toEqual(["c1"]);
    expect(working.snapshot()).toEqual([{ channelId: "c1", messageIds: ["m1"] }]);
  });

  test("complete during in-flight react still removes eyes after they land", async () => {
    let finishReact: () => void = () => {};
    const reactGate = new Promise<void>((resolve) => {
      finishReact = resolve;
    });
    const { api, calls } = fakeApi({
      react: () => reactGate,
    });
    const { timers } = fakeTimers();
    const working = new WorkingPresence(api, { timers });

    const started = working.start("c1", "m1");
    await Promise.resolve();
    const completed = working.complete("c1", "m1");
    finishReact();
    await started;
    await completed;

    expect(calls.unreact.length).toBeGreaterThanOrEqual(1);
    expect(working.snapshot()).toEqual([]);
  });

  test("completeAll clears every channel", async () => {
    const { api, calls } = fakeApi();
    const { timers } = fakeTimers();
    const working = new WorkingPresence(api, { timers });

    await working.start("c1", "m1");
    await working.start("c2", "m2");
    await working.completeAll();

    expect(calls.unreact).toHaveLength(2);
    expect(working.snapshot()).toEqual([]);
  });

  test("start after complete reacts again", async () => {
    const { api, calls } = fakeApi();
    const { timers } = fakeTimers();
    const working = new WorkingPresence(api, { timers });

    await working.start("c1", "m1");
    await working.complete("c1", "m1");
    await working.start("c1", "m1");

    expect(calls.react).toHaveLength(2);
    expect(working.snapshot()).toEqual([{ channelId: "c1", messageIds: ["m1"] }]);
  });

  test("unreact errors do not throw from complete", async () => {
    const { api } = fakeApi({
      unreact: async () => {
        throw new Error("unknown emoji");
      },
    });
    const { timers } = fakeTimers();
    const working = new WorkingPresence(api, { timers });

    await working.start("c1", "m1");
    await working.complete("c1", "m1");
    expect(working.snapshot()).toEqual([]);
  });

  test("independent channels keep their own typing loops", async () => {
    const { api } = fakeApi();
    const { timers, scheduled } = fakeTimers();
    const working = new WorkingPresence(api, { timers });

    await working.start("c1", "m1");
    await working.start("c2", "m2");
    expect(scheduled.filter((s) => s.kind === "interval")).toHaveLength(2);

    await working.complete("c1");
    expect(working.snapshot()).toEqual([{ channelId: "c2", messageIds: ["m2"] }]);
    expect(scheduled.filter((s) => s.kind === "interval")).toHaveLength(1);
  });
});
