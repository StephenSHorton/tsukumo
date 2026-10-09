# Tsukumo (付喪神)

<p align="center">
  <img src="assets/tsukumo-banner-680x240.png" alt="Tsukumo banner" width="680" />
</p>

**Your Discord bot, for your AI agents.** Tsukumo gives coding agents a Discord bot they can read and post with, and (in Claude Code) lets an @mention of the bot wake the session that should answer it. There's no server to deploy: it runs on your machine, only while an agent is using it.

In folklore, a *tsukumogami* is a tool that has lived long enough to gain a spirit. This one is your Discord bot, animated only while an agent is using it.

## Two ways to use it

| | **MCP server** (`src/mcp.ts`) | **Claude Code mod** (`claude-mod/`) |
| --- | --- | --- |
| Works with | Any MCP client: Grok, Claude Code, Cursor, … | Claude Code only: the desktop app's Code tab and the terminal |
| Read channels, post, reply, attach files | Yes | Yes |
| An @mention wakes a session | Only in Grok run as `grok-fork --channels` (built for Grok) | Yes |
| Several sessions share a channel; each mention goes to the one that owns the work | No | Yes |
| Live channel feed, block/allow lists, held mentions | No | Yes, in a pane |

Pick the mod if you use Claude Code. Use the MCP server for other agents, or if you only need reading and posting. Both run from the same checkout and the same bot, and they can run side by side.

## Setup (once)

You need [Bun](https://bun.sh) and a Discord bot.

### 1. Create the Discord bot

1. Open the [Discord Developer Portal](https://discord.com/developers/applications) and choose **New Application**.
2. Under **Bot**, reset and copy the token, turn on **Message Content Intent**, and save.
3. Under **OAuth2 → URL Generator**, pick the `bot` scope and these permissions: View Channels, Send Messages, Send Messages in Threads, Create Public Threads, Read Message History, Add Reactions, Attach Files. Open the URL to invite the bot to your server.
4. Optional: give the bot a server nickname that says whose it is (e.g. "Sam's AI"). Every agent posts as this one bot, with the agent's name in bold at the start of each message.
5. Optional: icons and banners for the bot are in [`assets/`](assets/).

### 2. Clone and configure

```sh
git clone https://github.com/StephenSHorton/tsukumo.git ~/projects/tsukumo
cd ~/projects/tsukumo
cp .env.example .env     # then set DISCORD_TOKEN
bun install
```

| Setting in `.env` | Needed | What it does |
| --- | --- | --- |
| `DISCORD_TOKEN` | Yes | The bot token from step 1 |
| `TSUKUMO_YOUR_NAME` | No | Your name on messages you type in the mod's pane (default "Me") |
| `TSUKUMO_GITHUB_OWNER` | No | GitHub owner for PR references written without one, like `webapp#12` (mod routing) |
| `TSUKUMO_REPO_ALIASES` | No | Short names for repos, like `web=webapp,api=acme/api-server`, so `WEB#12` works (mod routing) |
| `TSUKUMO_BUFFER_SIZE` | No | Live message buffer for the MCP server (default 200) |

Then follow one (or both) of the next two sections.

## Claude Code mod

Add this to `~/.claude/settings.json` (merge it with any `env` block already there), using the path of your checkout, then start a new session:

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "/Users/you/projects/tsukumo/claude-mod",
    "CLAUDE_CODE_PLUGIN_DIR_WATCH": "1"
  }
}
```

In the session, `/discord` prints the mod's version and `/discord watch #channel` (or a channel id or link) starts watching. If your checkout isn't at `~/projects/tsukumo`, set the mod's `tsukumoDir` option.

Everything else, including installing from the marketplace, wake modes, multi-session routing, the pane and Claude's tools, is in [`claude-mod/README.md`](claude-mod/README.md).

## MCP server (any agent)

Register `bun run <checkout>/src/mcp.ts` as a stdio MCP server. The client starts it when it needs Discord and it exits when the client is done. It reads `.env` from the checkout wherever it's started from.

```sh
# Claude Code (terminal)
claude mcp add tsukumo -- bun run /Users/you/projects/tsukumo/src/mcp.ts

# Grok
grok mcp add tsukumo -- bun run /Users/you/projects/tsukumo/src/mcp.ts
```

Other clients (Cursor and the like) take the same command in their MCP config: `command: "bun"`, `args: ["run", "/Users/you/projects/tsukumo/src/mcp.ts"]`.

| Tool | Purpose |
| --- | --- |
| `list_guilds` | Servers the bot is in |
| `list_channels` | Text channels in a server |
| `get_messages` | Channel history |
| `get_message` | One message by id |
| `send_message` | Post or reply in any channel the bot can see (requires `from`; optional file attachments) |
| `ack_message` / `clear_ack` | Add or remove 👀 and the typing indicator on a message |
| `bind` / `unbind` | Watch a server or channel from this conversation (Grok) |
| `get_mentions` / `get_recent` | Mentions and live messages from the watched place (Grok) |
| `tsukumo_status` | Bot identity, connection and current watch |

**Posting.** Every post comes from the one bot. Set `from` to the client only (`Grok`, `Cursor`, `Claude`, …); it's added in bold at the start of the message. If the bot is in several servers, check the server with `list_guilds` before posting. `files` takes absolute local paths (up to 10, 25 MB each).

**Watching (built for Grok).** `bind` claims a server or channel for the current Grok conversation (keyed by `GROK_SESSION_ID`, so it survives resume). Mentions of the bot are then pushed as MCP `notifications/claude/channel`. Only `grok-fork --channels` turns those into a new turn, which is how a Discord ping wakes Grok; other clients ignore them. In Claude Code, use the mod instead of `bind`. Each mention gets 👀 and a typing indicator until the agent replies.

## How it works

```
                         ┌────────── Claude Code mod ──────────┐
Discord ◄─gateway─► src/router.ts ◄──► src/attach.ts (per chat) ──► claude-mod/ ──► wakes the right chat
            (one shared connection, started on demand,           (pane, card, tools,
             exits 30 min after the last chat leaves)              block/allow lists)

Discord ◄─gateway─► src/mcp.ts ◄── stdio MCP ──► any MCP client (Grok, Claude Code, Cursor, …)
            (started by the client, exits with it)
```

```
src/
  mcp.ts            MCP server (stdio), spawned by any MCP client
  router.ts         the mod's shared Discord connection, routing and front-desk sweeper
  router/core.ts    routing state machine (tested without Discord)
  attach.ts         per-chat link between the mod and the router
  watch.ts          a chat's own watcher (the mod's `direct` transport)
  call.ts           one-shot REST calls behind the mod's tools
  lib/              claims, routing, ledger, PR references, sweeper
  discord/          Discord client, REST, 👀 + typing
  gateway/          shared service (+ optional loopback HTTP API)
claude-mod/         the Claude Code mod (tsukumo-discord)
docs/               peer protocol, MCP spec migration notes
```

Notes for coding agents working on this repo are in [`AGENTS.md`](AGENTS.md).

## Scripts

| Script | Role |
| --- | --- |
| `bun run mcp` | The MCP server |
| `bun run watch <channelId>` | A standalone channel watcher (JSON lines on stdout) |
| `bun run call <op> …` | One-shot calls: guilds, channels, messages, message, send, thread, budget |
| `bun run serve` | Optional loopback HTTP API for scripts (needs `TSUKUMO_API_TOKEN`) |
| `bun run typecheck` / `bun test` | Checks (`claude plugin test claude-mod` for the mod) |

## License

[MIT](LICENSE)
