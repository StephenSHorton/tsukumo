#!/usr/bin/env bun
/**
 * A session's line to the router (src/router.ts), spawned by the Claude Code
 * mod in place of the per-session watcher (src/watch.ts). Same contract with
 * the mod: JSON event lines on stdout, and the same control socket
 * (TSUKUMO_WATCH_SOCKET) for /ack /quiet /skip /own /listen /claim-thread
 * /release-thread /take /hold, forwarded to the router. No Discord login of its own.
 *
 *   TSUKUMO_SESSION_ID=<claude session id> bun run src/attach.ts <channelId>[,<channelId>…]
 *
 * Starts the router if none is running, and reconnects (restarting it) if it
 * goes away.
 */
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, truncateSync } from "node:fs";
import { dirname, join } from "node:path";
import { projectRoot } from "./config.ts";
import { conversationId } from "./lib/hook.ts";

const WATCH_DIR = join(projectRoot, ".watch");
const ROUTER_SOCKET = join(WATCH_DIR, "router.sock");
const ROUTER_ERROR = join(WATCH_DIR, "router-error.txt");
const ROUTER_LOG = join(WATCH_DIR, "router.log");

// stdout carries the event stream only.
console.log = console.info = console.debug = console.warn = console.error;
const emit = (event: object) => process.stdout.write(`${JSON.stringify(event)}\n`);

const channelIds = process.argv
  .slice(2)
  .flatMap((arg) => arg.split(","))
  .map((id) => id.trim())
  .filter(Boolean);
const sessionId = conversationId();
const label = process.env.TSUKUMO_SESSION_LABEL?.trim() || undefined;
const controlSocket = process.env.TSUKUMO_WATCH_SOCKET?.trim() || null;

let stopping = false;
let abort: AbortController | null = null;
let control: ReturnType<typeof Bun.serve> | null = null;

function stop(code: number): never {
  stopping = true;
  abort?.abort();
  try {
    control?.stop(true);
  } catch {
    // Already stopped.
  }
  if (controlSocket) rmSync(controlSocket, { force: true });
  process.exit(code);
}
function fail(message: string): never {
  emit({ type: "error", message });
  return stop(1);
}
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, () => stop(0));

async function routerUp(): Promise<boolean> {
  try {
    const res = await fetch("http://router/status", { unix: ROUTER_SOCKET } as RequestInit);
    return res.ok;
  } catch {
    return false;
  }
}

/** Starts the router, detached so it outlives this process and this session. */
function startRouter(): void {
  mkdirSync(WATCH_DIR, { recursive: true });
  try {
    if (existsSync(ROUTER_LOG) && statSync(ROUTER_LOG).size > 2_000_000) truncateSync(ROUTER_LOG, 0);
  } catch {
    // A log we can't trim is still a log.
  }
  rmSync(ROUTER_ERROR, { force: true });
  const out = openSync(ROUTER_LOG, "a");
  const child = spawn(process.execPath, ["run", join(projectRoot, "src", "router.ts")], {
    cwd: projectRoot,
    detached: true,
    stdio: ["ignore", out, out],
    env: process.env,
  });
  child.unref();
  closeSync(out);
}

async function ensureRouter(): Promise<void> {
  if (await routerUp()) return;
  startRouter();
  for (let i = 0; i < 60; i++) {
    await Bun.sleep(250);
    if (await routerUp()) return;
    if (existsSync(ROUTER_ERROR)) fail(readFileSync(ROUTER_ERROR, "utf8").trim());
  }
  fail(`The Tsukumo router didn't start; see ${ROUTER_LOG}.`);
}

/** The mod's control socket, forwarded to the router with this session's id. */
function serveControl(): void {
  if (!controlSocket) return;
  mkdirSync(dirname(controlSocket), { recursive: true });
  rmSync(controlSocket, { force: true });
  control = Bun.serve({
    unix: controlSocket,
    async fetch(request) {
      if (request.method !== "POST") return new Response("not found", { status: 404 });
      const op = new URL(request.url).pathname.replace(/^\//, "");
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      try {
        const res = await fetch("http://router/control", {
          unix: ROUTER_SOCKET,
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...body, sessionId, op }),
        } as RequestInit);
        return new Response(await res.text(), { status: res.status, headers: { "content-type": "application/json" } });
      } catch (err) {
        return Response.json({ ok: false, error: `The router isn't reachable: ${err instanceof Error ? err.message : String(err)}` }, { status: 503 });
      }
    },
  });
}

/**
 * Streams this session's events from the router to stdout until it ends.
 * Returns whether it got as far as `ready` (a router that later goes away is
 * a normal reconnect, not a failure). A fatal error from the router (it
 * dropped this chat) is passed on and ends this process.
 */
async function stream(): Promise<boolean> {
  abort = new AbortController();
  const res = await fetch("http://router/attach", {
    unix: ROUTER_SOCKET,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId, label, channelIds }),
    signal: abort.signal,
  } as RequestInit);
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => "");
    let message = `The router refused to attach (${res.status}).`;
    try {
      message = (JSON.parse(detail) as { error?: string }).error ?? message;
    } catch {
      // Not JSON.
    }
    fail(message);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let ready = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return ready;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        process.stdout.write(`${line}\n`);
        if (line.includes('"type":"ready"')) ready = true;
        if (line.includes('"type":"error"') && line.includes('"fatal":true')) stop(1);
      }
    }
  } catch (err) {
    // The router exited or was killed mid-stream (Bun throws rather than ending the read).
    if (ready) return true;
    throw err;
  }
}

if (channelIds.length === 0) fail("Name at least one channel id to watch.");
if (!sessionId) fail("TSUKUMO_SESSION_ID is not set; the mod passes the Claude session id.");

serveControl();
// Orphaned (the Claude process died without signalling us): let go.
setInterval(() => {
  if (process.ppid === 1) stop(0);
}, 30_000);

let failures = 0;
let lastProblem = "it closed the stream before the chat was ready";
while (!stopping) {
  try {
    await ensureRouter();
    // Got going and then lost the router: reconnect without counting it against us.
    if (await stream()) failures = 0;
    else failures++;
  } catch (err) {
    if (stopping) break;
    failures++;
    lastProblem = err instanceof Error ? err.message : String(err);
  }
  if (failures > 5) fail(`Lost the Tsukumo router: ${lastProblem}`);
  if (!stopping) await Bun.sleep(Math.min(16_000, 1_000 * 2 ** failures));
}
