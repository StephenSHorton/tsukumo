# tsukumo-discord (Claude Code mod)

Watch a Discord channel through Tsukumo from **Claude Code**: the desktop app's Code tab or the terminal. When someone @mentions the bot in the watched channel, the mod wakes the session with the message, unless you've blocked them (or, in allowlist mode, haven't allowed them). Grok keeps using Tsukumo's MCP server and `grok-fork --channels`; this mod is for Claude only.

```
Discord ──gateway──► bun src/watch.ts ──JSON lines──► mod (this folder) ──► $.prompt.submit → a new turn
                     claims the channel                checks block/allow
                     in .hooks.json                    band · pane · toasts
```

- **Several chats can watch a channel; the right one answers each mention.** Tsukumo keeps an **authorship ledger** (`.ledger.json`): the Discord messages each chat posted, the PRs it opened or reviewed (from its `gh pr create` / `gh pr review` commands), and the PRs Claude Code itself links to each session. Each mention goes, in order, to:
  1. the chat that posted the message it replies to;
  2. the chat that claimed the thread it's in;
  3. the chat that opened (else worked on, else reviewed) a PR it names (`acme/webapp#1437`, `webapp#1437`, an alias like `WEB#1437`, a PR link, or a bare `#1437`, read as the channel's own repo from its topic; see [PR references](#pr-references));
  4. otherwise the channel's **front desk**: the first chat to watch it, or whichever chat you make the front desk. It handles new work itself and anything whose owner isn't watching (closed or archived chats), and may recommend a new session.

  Every watcher routes the same way from the ledger and `.hooks.json`, and the answering chat takes a per-message lock, so exactly one wakes. The woken chat is told why it got the mention. Chats running an older watcher (or Grok) are never sent ledger-routed mentions, and if the front desk itself is on older code, everyone falls back to the old rules so nothing is answered twice.
- **Nothing goes unanswered, and nobody is rushed.** A reply from Tsukumo marks a mention answered, and so does `skip_mention` when it needs no reply. 👀 and typing last only while the mention's turn runs. A mention is *engaged* once its turn starts in the chat that got it (actually starts, not just queued behind another), or once that chat calls `defer_mention` (say privately "I'll answer in 45 min, waiting on CI"; nothing is posted). Then:
  - **Engaged, deferred, or the chat's own work** (its PR, its post, its thread, or one you handed it with Deliver / Take it): it stays with that chat however long it takes. Past its deferral, or an hour with none, you get a toast and the chat a reminder (which offers deferring, not only replying); nothing is reassigned.
  - **New work nobody has engaged with for 10 minutes** (the chat is stuck in a long turn, wedged, or archived but still running): it moves to the front desk. If the front desk itself hasn't started on it, the mention *and the front-desk role* go to the longest-connected other chat (once; after that it's flagged to you).
  - **The chat has gone** (3 minutes after it went away, so a reload or a laptop waking up doesn't count): the front desk takes it, whatever it is. A hand-off to a chat that didn't pick it up within 90 seconds comes back too.
  - When a mention moves, the chat it left is told (a toast, and its pane shows who has it). If that chat later tries to reply anyway (its queued turn finally ran), `send_message` refuses and names the chat that has it; `allow_duplicate: true` overrides when you asked it to reply.
  - Mentions you hold or dismiss in a pane are left alone. Mentions sent while no chat was watching are caught up (last 6 hours) when one connects. Claims keep a heartbeat (30s); one older than 90s counts as gone. Grok's `bind` counts as a front desk.
- **You choose who wakes the session.** Two modes:
  - **everyone** (the default): every @mention wakes the session except from senders on the **block list** (`/discord block`).
  - **allowlist**: only senders on the **allow list** wake it (`/discord allow`).
  Mentions that don't wake it are **held** in the pane. The mode and both lists persist across sessions. They change only when you type `/discord mode|block|unblock|allow|deny` or press a pane button, never because the model or a Discord message asked. In everyone mode, any member or bot in the server can wake the session; their text still arrives fenced as untrusted.
- **Discord text is untrusted.** A delivered mention is fenced in `<discord-message>` and labelled as not coming from you.
- **Discord sees that a reply is coming.** When a mention wakes the session, Tsukumo adds 👀 to it and shows the bot typing in the channel until its reply lands (or 15 minutes pass). Held mentions get neither until you deliver them. The mod asks the watcher for this over a private socket in `.watch/` (git-ignored).
- **Claude can read and post on any channel, watched or not.** The mod gives Claude tools for that (see below). The watcher itself never posts.
- **Messages sent while no session is watching are lost**, not queued.

## Install for Claude desktop

You need a working Tsukumo checkout first: `.env` with `DISCORD_TOKEN`, and `bun install` (see the main README).

### 1. Install the mod

Pick one.

**A. Load the checkout directly (recommended on the machine you develop on).** Add this to `~/.claude/settings.json`, merging with any existing `env` block, then start a new Code tab session:

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "/Users/you/projects/tsukumo/claude-mod",
    "CLAUDE_CODE_PLUGIN_DIR_WATCH": "1"
  }
}
```

Every session (desktop Code tab or terminal) loads the mod from the folder as it is when the session starts, and `CLAUDE_CODE_PLUGIN_DIR_WATCH=1` reloads it in running sessions when its files change. Don't also install it from the marketplace (option B), or it loads twice. Check: `claude plugin list` shows `tsukumo-discord@inline`, the version in `.claude-plugin/plugin.json`, and `Path: …/tsukumo/claude-mod`; in a session, `/discord` prints `tsukumo-discord <version>`.

**B. Install from a marketplace (another machine, no local edits).** In a terminal:

```sh
claude plugin marketplace add StephenSHorton/tsukumo      # or a local path to a checkout
claude plugin install tsukumo-discord@tsukumo
```

Desktop sessions run the **copy made at install time** (`~/.claude/plugins/cache/tsukumo/…`), whatever `claude plugin list` says about the folder: an edit or a `git pull` changes nothing until you bump `version` in `.claude-plugin/plugin.json` and run `claude plugin update tsukumo-discord@tsukumo`. That's why option A is the one for development. The watcher and tool calls still run from a Tsukumo checkout either way: clone the repo, set up `.env` and `bun install`, and point `tsukumoDir` at it (step 2) if it isn't `~/projects/tsukumo`.

No `claude` on your PATH? The desktop app ships one: `"$(ls -d "$HOME/Library/Application Support/Claude/claude-code"/*/*/claude.app/Contents/MacOS/claude | tail -1)"`. `/plugin` commands are not available inside the desktop Code tab.

**Remove.** Option A: delete the two `env` lines. Option B: `claude plugin uninstall tsukumo-discord@tsukumo` (and `claude plugin marketplace remove tsukumo`).

### 2. Options (only if your paths differ)

| Option | Default | Meaning |
| --- | --- | --- |
| `tsukumoDir` | `~/projects/tsukumo` | Checkout with `package.json` and `.env`; the watcher runs here |
| `bunPath` | `~/.bun/bin/bun` | Bun executable. The desktop app's PATH often lacks `~/.bun/bin`, so it's absolute by default |

Set them with `claude plugin configure tsukumo-discord`, or in `/config` in a terminal session.

### 3. Use it

In a Code tab session:

```
/discord watch 123456789012345678      # or <#channel> or a channel link; several at once is fine, from any servers
/discord block 234567890123456789     # everyone mode: hold this sender's mentions
/discord mode allowlist                # switch: only allowed senders wake the session
/discord allow 345678901234567890 Alice
/discord                               # open the pane: mode, lists, held mentions
/discord stop                          # release the claim
/discord own | listen                  # answer this channel's mentions, or only watch it
/discord claim <thread> | release <thread>
/discord name api work                 # how other chats see this one ("api work answers")
```

Or just ask Claude ("watch #dev", "what's the latest in #general?", "post the PR link in #dev"). The mod gives Claude these tools:

| Tool | Does |
| --- | --- |
| `watch` | Watch, stop, or report status (same as `/discord watch` / `stop`). It can't change who wakes the session |
| `list_servers` | Servers the bot is in |
| `list_channels` | Channels and threads in a server, with names |
| `get_messages` | Recent messages from **any** channel the bot can see, no watch needed |
| `get_message` | One message by id |
| `defer_mention` | Say privately that this chat will answer a mention later (up to 12 h); it stays here, and you're only reminded if the time passes |
| `skip_mention` | Choose not to reply to a mention that needs no answer (a thanks, a 👍, a GIF); nothing is posted, 👀 and typing come off, and it counts as answered |
| `send_message` | Post (or reply) in any channel the bot can see, prefixed with the bold `from` name (default `Claude`). A reply is refused if Tsukumo already replied to that message in the last few minutes (another chat got there first); `allow_duplicate: true` for a deliberate second reply. `gif` (a Tenor or Giphy page link, or a direct .gif URL) uploads the GIF itself, with or without text. A reply to a message **another chat on this machine posted** goes to that chat directly (see `message_chat`) instead of Discord, where it would never wake it; `post: true` posts it anyway |
| `message_chat` | Message another chat on this machine directly: it wakes that chat, and nothing is posted on Discord. `to` is the name it posts under (its `from`), its label or session id. The woken chat answers with `message_chat` too. At most 8 messages between two chats (both ways) per 10 minutes, so two agents can't wake each other forever. Every one is logged in `.watch/direct.jsonl` |
| `list_chats` | The other chats attached to the router, with the names they post under |
| `start_thread` | Open a thread for a work item in a watched channel and claim it for this chat |
| `claim_thread` / `release_thread` | Answer (or stop answering) a thread's mentions from this chat |

Each tool call is a one-shot `bun run src/call.ts …` over Discord's REST API: no gateway login, so it doesn't spend the bot's 1,000-a-day login budget (running out disconnects everything and resets the token). Watchers do log in, and refuse to when fewer than 25 logins are left today; `bun run call budget` shows the count. You don't need Tsukumo's MCP server in Claude Code; if you add it anyway, don't `bind` a channel the mod is watching (different conversation id, so 409).

While watching, a card above the prompt shows the Discord logo, the channel, the held count and a spinner, with open (☰) and stop (■) buttons. The pane (☰) is a live view of the watched channel: the last 25 messages on connect and new ones as they arrive, with mentions tagged (woke this chat, held, dismissed) and held ones carrying **Deliver**, **Unblock & deliver** (or **Allow & deliver**) and **Dismiss**. Its message box posts to the channel under your name (`TSUKUMO_YOUR_NAME` in Tsukumo's `.env`, default "Me"). Who-wakes-this-chat settings sit folded under **Change**. Not watching, it offers the channels it knows as one-click buttons.

## How it is built

| File | Role |
| --- | --- |
| `.claude-plugin/plugin.json` | Manifest and options |
| `hooks/register.tsx` | The hooks: `/discord`, watcher lifecycle, band, pane |
| `hooks/spinner.tsx` | The card's spinner, run on the surface's own clock (a `Client`) |
| `hooks/icon.ts` | Discord's logo mark for the rows (from Simple Icons; Discord's trademark) |
| `hooks/wake.ts` | Pure helpers: stdout parsing, the wake prompt, argument parsing |
| `types/index.d.ts` | The mod's `$.state` contract |
| `tests/discord.test.tsx` | `claude plugin test` suite |
| `../src/router.ts`, `../src/router/core.ts` | The router: the one Discord connection all watching chats share; routing, sweeper, catch-up, ledger sync |
| `../src/attach.ts` | A chat's line to the router (what the mod runs); starts the router if none is running |
| `../src/watch.ts` | A chat's own watcher with its own Discord connection (the `direct` setting; the pre-router design) |
| `../src/call.ts` | One-shot calls behind the tools: guilds, channels, messages, message, send, thread |
| `../src/lib/route.ts`, `take.ts`, `sweep.ts` | Who answers a mention, the per-message take lock, the front desk's sweeper |
| `../src/lib/ledger.ts`, `refs.ts`, `prmeta.ts` | The authorship ledger, PR references, Cursor-agent PR detection |
| `../.claude-plugin/marketplace.json` | Makes the repo a marketplace for install options A and C |

**The router.** Every watching chat shares one Discord connection: the first chat to watch starts `src/router.ts` (detached; log in `.watch/router.log`), later chats attach to it, and it exits 30 minutes after the last chat leaves. It is not an always-on service, and it loses nothing while down: it saves the last message it saw in each channel and routes everything since when it next starts. A chat that reloads keeps its claim for 2 minutes and gets whatever was routed to it meanwhile. One Discord login per router start, not per chat. Set the mod's `transport` option to `direct` to give a chat its own connection instead (the older design; both kinds interoperate). One chat can watch, and be front desk for, channels in several servers at once through the router; a `direct` watcher takes one server. `curl --unix-socket .watch/router.sock http://router/status` shows who's attached; `POST /stop` shuts it down.

**Cursor cloud agents' PRs.** When a mention names a PR nobody in the ledger owns, the router checks it on GitHub (`gh`, cached a day). If a Cursor cloud agent opened it, the front desk gets a specific brief: acknowledge, look for a newer push from the agent, and either make the requested changes or say you'll hand them back to the agent.

**Closed or archived chats.** A chat with no running process can't be woken (and sessions started through Dispatch refuse cross-session messages), so follow-ups for its work go to the front desk, which answers from the PR and the ledger and can recommend a new session. That's by design.

**Other agents.** [`docs/peer-protocol.md`](../docs/peer-protocol.md) is a two-habit convention (reply to the message you're answering; one PR per post, named first) to share with the other people whose agents are in your server.

<a id="pr-references"></a>**PR references.** Routing by PR reads GitHub PR links, `owner/repo#N`, `repo#N`, aliases and a bare `#N` (the repo linked in the channel's topic). `repo#N` without an owner uses `TSUKUMO_GITHUB_OWNER`, else the owner of the channel's repo. Aliases come from `TSUKUMO_REPO_ALIASES` (`web=webapp,api=acme/api-server`). Both live in Tsukumo's `.env`.

A hot reload of the mod restarts the chat's attach process on the same channels; the router keeps its claim across the reload.

## Develop

```sh
claude plugin validate claude-mod
claude plugin test claude-mod
bun test                     # Tsukumo's own tests (src/ only; see bunfig.toml)
```

Run the watcher alone to see its events:

```sh
TSUKUMO_SESSION_ID=manual-test bun run src/watch.ts <channelId>
```
