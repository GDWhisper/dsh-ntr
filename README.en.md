# dsh-ntr

English | [简体中文](./README.md)

Chat with any **ACP agent** (CodeBuddy, Pi, Oh My Pi, Claude Code, OpenCode, Qoder, …) right inside the web/desktop app of [DSH (DeepSeek Harness)](https://github.com/deepseek-ai/deepseek-harness), using the interface you already know.

**DSH provides the interface; the agent provides the capability.** The conversation list, composer, side panel, and message rendering all come from DSH; reasoning, tool execution, file access, and permission decisions all belong to the agent you configured — it runs in its own process, fully autonomous. This plugin does exactly one thing: wire the two sides together, and render the agent's output faithfully in DSH's UI.

> Model selection, thinking level, and work modes are **the agent's own concepts**, not DSH's model catalog. The plugin never swaps models for you, and never writes the agent's choices into DSH's global settings.

---

## What is NTR

**NTR = Negotiated Target Routing.**

In one sentence: your host agent acts as an ACP client, negotiates capabilities and permissions with a target agent, and hands the turn over to it.

---

## Installation

This plugin is a DSH **bundle**: `package.json`'s `dsh.bundle.patch` declares the two patches shipped with the package — the plugin's own `cordis.patch.yml`, and the NTR-mode preset at `presets/acp/acp.patch.yml`. After `dsh plugin` installs it, the package joins the profile's `dsh.profile.bundles` and the patch layers take effect **automatically** — no config file needs editing by hand.

### Option 1: from the official UI

Open the **Plugins** page in DSH's sidebar, click **Add plugin**, enter `dsh-ntr`, and click install. Refresh the page and it's ready to use.

> DSH keeps a 24-hour safety window on the npm channel: a version published within it won't be picked as the latest, so entering plain `dsh-ntr` may install the previous release. To get the new version right away, include the explicit version in the box, e.g. `dsh-ntr@0.1.5`; otherwise wait out the window and install or upgrade as usual.

### Option 2: from the npm registry

```bash
dsh plugin --profile web add dsh-ntr@latest
```

Run the same command again to upgrade.

> **Always pass `@latest`**: without it the package manager keeps reusing the version it wrote the first time, and `update` won't get you off it afterwards.

### Option 3: via the [dsh-market](https://github.com/dsh-market/dsh-market) plugin market

First install the market itself:

```bash
dsh plugin --profile web add dshmarket
```

Restart `dsh web` and open the **Plugins** page: on dsh 0.2.1+ the market is the **Plugin Market** tab next to **Installed**; on older hosts it lives under **Settings → Plugin Market**. Search for `dsh-ntr`, confirm the source, and install in one click — refresh the page and it's live; update checks and upgrades afterwards also happen in the market. The official DSH Desktop app ships with this market preset, so just search and install from the app's **Plugins** page.

> The market's catalog comes from the curated [awesome-dsh-plugin](https://awesome-dsh-plugin.com) registry and refreshes daily. If `dsh-ntr` doesn't show up in search yet, install it from npm with Option 2 — nothing is lost.

### Option 4: from source

Requires Node.js ≥ 22.12.0.

```bash
git clone https://github.com/GDWhisper/dsh-ntr.git
cd dsh-ntr
npm install        # build dependencies (typescript, …)
npm run build      # compile host TS + browser bundle into lib/ (build output is not committed — this step is required)
dsh plugin --profile web add ./
```

To upgrade later: `git pull` → `npm run build` → restart `dsh web`. `add .` installs the directory as `link:`, so a rebuild plus a restart picks up the changes — no re-add needed.

> Before switching from the source install to the npm/market build, uninstall the old version and delete `node_modules/dsh-ntr` from the profile. pnpm's hoisted layout leaves the linked checkout's `node_modules` inside the package directory, and the stale dependencies shadow the newly installed SDK — see the `EPERM ... zod` entry in the FAQ.

> `dsh plugin` is a pnpm forwarder — `--profile <name>` is required, and `add .` installs the current directory as `link:`. The official desktop app's profile is owned by its own plugin manager; don't run the CLI against it.

---

## Quick start

### What you need

1. A working DSH install (web or desktop).
2. At least one ACP-capable agent, using its terminal build (CLI / TUI). For example Qoder CLI (`qodercli`), CodeBuddy Code (`codebuddy`), Claude Code, or OpenCode — presets for these ship with the plugin; any other agent that starts from the command line in the same `xxx --acp` style can be filled in directly.

### Three steps

1. Open **Settings → NTR**.
2. Pick a preset from the agent list to fill it in, or click "Create a custom agent from scratch" and type the launch command yourself.
3. Click **Test**. Success shows the agent's name and the handshake latency; failure shows an actionable error plus the tail of stderr.

After saving, the agent shows up in the NTR base at the end of the composer.

### Start talking

1. Create a conversation and pick **NTR mode** in the mode selector.
2. Pick an agent in the NTR base at the end of the composer.
3. Just talk.

The agent's replies and thinking appear in the main chat. Tool activity is interleaved in order: a line of `🛠️ **tool** · args`, with the output in a code block below. For full tool outputs, plans, and diffs, switch to the **NTR** tab in the conversation header.

---

## The UI you'll use

### NTR base (end of the composer)

Click it to choose which agent serves this conversation. The menu lists only agents — one control, one job. The agent's own model and thinking level are separate chips on the same row, each with its own menu; if the agent also publishes extra config options (temperature, provider toggles, …), an **Advanced** base appears to the left of the model chip, where you set them one by one. Before the first turn, the agent base sits pinned at the far right; once locked, it retires and model/thinking take over the right end. Those lists are reported by the agent itself — they are not your familiar DSH model list.

The base appears only in **NTR-mode** conversations. Normal conversations show DSH's native model selector.

**One conversation, one agent.** Until the first message is sent, the base stays put: pick, or change your mind freely. The moment the first turn **starts**, the conversation **locks** to that agent: the base collapses, and the name becomes a **small tag on the top edge of the composer card** (`NTR · <agent>`, straddling the edge) — display-only, not clickable. To switch agents, start a new conversation. The model, thinking-level, and Advanced chips stay in place; they belong to the same agent, so no context moves. If the first turn fails or is cancelled before producing any visible output, the lock rolls back automatically and the base returns for another pick.

### `/` commands belong to the agent

Type `/` in an NTR conversation and what pops up is **the agent's own command list** — the ones it declares over ACP (e.g. `compact`, `session`, `model`), not DSH's. Selecting one just inserts the command name into the composer; pressing Enter sends the whole line to the agent as-is, and it executes it. The list works **before the first message**: the host remembers the commands this agent declared in its last session (an agent that has never run has to wait until after the first turn).

DSH's own `/model`, `/permission`, `/export`, etc. are **not** intercepted by the host in this mode: same-named commands go to the agent too, and the host's command menu and skill completions never appear. Slash behavior in normal conversations is unchanged.

### Approvals and the agent's own permission modes

When the agent wants to touch something sensitive, it asks you. The ask appears in the conversation on a card just above the composer (the plugin's own card); the options are exactly the agent's, and what you click is what it receives. The Settings page's "Pending Permission Requests" card is the cross-session mirror — answer there when the conversation isn't open.

Every agent asks differently: some offer a set of options, some only allow/deny, some attach the exact command they are about to run. The plugin presents these as-is, and never pre-decides for you.

**Permission modes are defined by the agent.** Each agent puts its own mode list (e.g. `Always Ask`, `Accept Edits`, `Plan`, `Bypass Permissions`) in the composer's tool row; the option text is exactly what the agent sent. Switch a mode, and the agent decides accordingly when to ask you. The plugin adds no permission tier of its own, and doesn't translate mode names.

> **Note**: DSH's own "Access mode" (read-only / workspace write / full) has no power over external agents. The agent lives in its own process; DSH's file sandbox can't reach it. What actually applies is the agent's own permission mode, plus the approvals it sends you.

### NTR tab

The **NTR** tab in the conversation header shows the agent's raw stream:

- Plans and todo lists
- Every tool call's name, status, and output (collapsed by default; click to expand)
- Unified diffs of code changes, with `+N -M` line counts
- Usage readouts

The tab is read-only: it sends no messages, cancels no tasks, launches no processes. It follows live — no manual refresh.

**Division of labor between the main chat and the NTR tab**: your conversation with the agent lives in the main chat, and tool activity is inlined there in time order; the NTR tab holds what the main chat can't — plans, full outputs, diffs, usage.

### Settings → NTR

- **Connected NTR agents**: one row per agent, with process status. Click "Expand config & models" for the full detail.
- **`★ Default`**: which agent new NTR conversations use by default.
- **Each agent card**: display name, launch command, npm package, environment variables, working directory — all in plain sight, no hidden defaults.
- **The launch command is one line**: program plus arguments, e.g. `codebuddy --acp`. Quote paths that contain spaces. Below the input, the plugin live-shows the program/arguments it parsed.
- **Test button**: launches a one-shot process with the current form values to do a handshake — nothing saved, nothing registered. Good for validating before you commit a config change.
- **Workspace directory**: the directory the agent works in.
- **Models visible in conversations**: when an agent reports hundreds of models, check here which ones appear in the model chip's menu. Unchecked ones still work; they're just not listed.

### Your workspace

An NTR conversation started in chat uses the directory you selected in this DSH session (the one you clicked in the side panel) as its working directory. The agent's file reads, searches, and command execution all happen there; its process is also launched from there.

One class of agents pins the workspace the moment the process starts, and ignores session-parameter changes afterwards. The plugin relocates such an agent to the new directory when it has no active conversations; while conversations are live, it keeps the original process and doesn't interrupt you.

---

## FAQ

**Will the platform risk-control me? Will I get banned? Is this a reverse proxy?**

No, and it isn't a reverse proxy. dsh-ntr talks to agents over ACP — the officially supported protocol entry point of those agents. The plugin only launches your local agent process and talks to it; it never touches platform APIs and forwards no requests. Model calls are made by the agent itself, no different from you using it directly in a terminal. Reasonable use within what NTR provides is officially allowed, and won't get you banned.

**Why is DSH's model selector gone from the composer after I pick an agent?**

By design. In NTR conversations, models are the agent's own concept, so that spot becomes the NTR base. Switch back to a normal-mode conversation, and the native selector returns.

**Why does the agent name at the composer's end disappear once the first turn starts?**

One conversation, one agent. Before the first turn, the base stays so you can change your pick; the moment the first turn starts, the conversation locks to that agent, and the name becomes the read-only `NTR · <agent>` tag on the top edge of the composer card. Switching agents would lose this side's context, so once locked, you must start a new conversation. The model, thinking-level, and advanced-config chips are unaffected. If the first turn fails or is cancelled with no visible output, the lock rolls back and the base returns.

**How do I switch agents after locking?**

Start a new conversation and pick again. A locked conversation refuses rebinding via `session/chat-bind` (the host returns `agent_locked`) — deliberately: the new agent has no context of this conversation, and a fake switch would only yield an amnesiac chat. One exception: if the first turn failed without producing any visible output, the lock auto-rolls-back, and you can re-pick directly.

**Can't see the NTR tab at the top?**

Every conversation has this tab. If the conversation has never been bound to an agent, it's empty and prompts you to pick one. First select "NTR mode" in the mode picker, then pick an agent in the NTR base.

**Agent stuck?**

Click Stop without worry. The plugin cancels the turn, and force-finalizes it if the agent ignores the cancel — a conversation never hangs forever. A turn the agent goes silent in is finalized too (see constraint 23 in AGENTS.md): with `session/load` the next send restarts the agent and resumes the session; without it the session is reset and its context is lost. If that was the conversation's first turn and it produced nothing, the agent lock rolls back and the next send starts a new session. A crashed agent process behaves the same way — one that supports resume comes back with its history on the next message.

**Agent replied with an empty bubble?**

Some agents treat upstream failures (auth, billing, quota) as "normal completion". When the plugin detects this, it appends a warning instead of letting the failure pass silently.

**Agent unresponsive, and no error either?**

Check the Test button in Settings. It runs a full handshake on the host side and surfaces the real error (including the tail of stderr).

**Model list too long or too short?**

The model chip's menu has no search box, so models are **opt-in**. Check the ones you want on that settings card. Unchecked ones simply don't appear, sparing you a wall of hundreds of models.

**Why don't my messages appear in the NTR tab?**

That tab shows only the agent's raw stream (its plans, full tool outputs, diffs, usage). Your conversation with it lives in the main chat, with tool activity inlined there in order.

**Why is there an extra dropdown in the composer, with options I've never seen?**

That's the agent's own permission mode; the option text comes straight from it. Each agent names them differently, and the plugin lists them verbatim. It governs when the agent asks you — unrelated to DSH's "Access mode".

**Imported an agent, and its permission modes differ from other agents'?**

Normal. Mode lists are declared by each agent itself (sent via `session/set_mode`); the plugin lists them verbatim — no unified translation, no defaults filled in. To change the wording, edit the agent's own config.

**Activation fails with `EPERM ... zod` after switching from the source install to npm / the market?**

That's stale dependency state, not a missing plugin file: the failing path will contain `node_modules/dsh-ntr/node_modules/.pnpm/...`. The source install uses `link:` to your checkout; pnpm's hoisted layout replaces the package directory with the registry files but leaves the link target's `node_modules` behind. That old tree (an older `@agentclientprotocol/sdk` plus its broken `zod` symlink) shadows the freshly installed dependency, so DSH's import hits the bad link and fails with `EPERM`. Fix: uninstall `dsh-ntr` in the plugin manager, remove `~/.dsh/profiles/<profile>/node_modules/dsh-ntr` (or just its nested `node_modules`), then reinstall and restart. For the desktop app's profile, uninstall/reinstall from the app's Plugins page instead of the CLI.

---

## What it can do (feature list)

- **Any ACP agent**: common presets built in, and any stdio-capable ACP agent works. Custom agents carry a "Custom" badge.
- **Multi-conversation isolation**: several conversations can talk to different agents at the same time, fully independent.
- **Streaming everything**: user messages, agent replies, thinking, tool execution, and task plans are all streamed.
- **Inlined tool activity**: tool calls are inserted into the main chat in the order they happened, with thinking and replies on either side — no layering.
- **Real permissions**: the agent's permission modes are listed verbatim, and every permission request is presented as-is. What you answer is what it receives.
- **Slash commands belong to the agent**: in NTR conversations, `/` pops the agent's own declared commands; DSH's same-named commands don't hijack your input.
- **Reconnect**: after a browser refresh or a network drop, history backfills in order. If the agent process crashed, the next message recovers it when the agent declares `session/load`.
- **Idle release**: agent processes with no activity exit automatically after an idle window, freeing memory; idle conversations are parked and resumed by the next message via `session/load` (agents that do not declare `session/load` still need no live conversation before their process is released).
- **Windows works**: npm-globally-installed agents launch and get reaped correctly on Windows, leaving no stray background processes.

---

## Configuration reference (for developers)

That was the user part. What follows is for people modifying this plugin, or writing config files by hand.

### Minimal config

Mount it in your profile's `cordis.patch.yml`. When `cwd` / `allowedCwdRoots` are omitted, the plugin's own workspace `~/.dsh/dsh-ntr/workspaces` is used (created automatically on save); `command` is **one full command line** — quote paths that contain spaces.

```yaml
- id: dsh-ntr
  name: dsh-ntr
  config:
    agents:
      - id: pi
        title: pi coding agent (ACP)
        command: /path/to/bin/pi-acp     # e.g. "codebuddy --acp"
        cwd: ~/.dsh/dsh-ntr/workspaces
        allowedCwdRoots: [~/.dsh/dsh-ntr/workspaces]
```

Optional agent fields: `npmPackage` (auto `npm install -g` when not found on PATH), `exposedModels` (which variants the NTR seat menu lists), `idleTimeoutMs` (idle-release window for chat processes; `0` = never release, default 30 minutes), `mcpServers` (extra MCP servers handed to the agent). Plugin-level there are also `transcriptMaxEntries` (per-conversation event buffer cap, default 600) and `probeModelsOnBoot` (kept for compatibility; boot-time per-agent probing no longer happens — see the comment on `bootstrapCatalogs`). Reliability timeouts and retries (`startupTimeoutMs`, `cancelFallbackMs`, `staleCancelRetryDelayMs`, `staleCancelMaxRetries`, `permissionTimeoutMs`, `permissionTimeoutMode`, plus the stall watchdog's `turnStallMs` / `turnStallToolMs` / `turnStallTickMs`) are covered by [AGENTS.md](./AGENTS.md) constraints 12, 13 and 23; anything editable in the Settings page should be edited there — the three watchdog keys live in the config file only (`turnStallMs: 0` disables the whole watchdog).

`mcpServers` uses the plugin's OWN shape (every entry carries a `name` and a `transport`), not the ACP wire shape — the wire's stdio entry has no `type`, and an entry written in the wire shape is silently dropped by the agent:

```yaml
      - id: pi
        command: pi-acp
        mcpServers:
          - name: codegraph
            transport: stdio          # stdio needs command; http / sse need url
            command: /opt/bin/codegraph
            args: ["serve", "--mcp"]
            env: { CODEGRAPH_INDEX: /srv/index }
          - name: remote
            transport: http
            url: https://mcp.example.com/mcp
            headers: { Authorization: "Bearer …" }
```

These servers are handed to the agent when a session is created; the agent launches and uses them itself. The MCP servers the agent configures for itself are unaffected — this only adds more.

### Build & install

```bash
npm install          # dependencies
git config core.hooksPath .githooks   # enable the commit-msg check (rejects AI attribution)
npm run build        # host TS declarations + browser bundle
npm test             # test suite
dsh plugin --profile web add ./   # mount into the Web profile
```

`.githooks/commit-msg` only inspects the commit message: it rejects AI-tool attribution in `Co-Authored-By` / `Generated with` lines, while ordinary prose and human attribution pass. `core.hooksPath` is local config — run this once after cloning.

### Implementation notes

Each item below corresponds to a real past failure; read the linked doc before changing code. The browser half talks to the host half via `/acp` RPC and `/api/acp/stream` SSE; the host half runs one `AgentBridge` per conversation, driving the agent child process over stdio JSON-RPC.

Code map: `src/index.ts` (plugin entry) · `src/protocol.ts` (shared types) · `src/impl.ts` (pure host logic) · `src/bridge.ts` (child-process bridge) · `src/client/` (React extension) · `presets/acp/` (NTR mode declaration) · `~/.dsh/dsh-ntr/` (runtime state).

- **DSH renders, nothing more**: the plugin doesn't write DSH's model routing, doesn't take over the host's model catalog, and never lets ACP models appear in DSH's native selector.
- **Workspace = the side-panel path**: the directory opened in the side panel must become both the `session/new` cwd **and** the agent child's own cwd. One agent (codebuddy) pins its workspace at process startup.
- **NTR mode = an agent preset**: declared by `presets/acp/acp.patch.yml` shipped with the package — no tools, no injected project instructions, no compaction, so everything the model sees belongs to the remote agent.
- **Forwarding is strictly the user's text**: messages are picked by `source.kind === 'user'`; title generation, compaction, and other auxiliary calls aren't forwarded, and no boundary narration is ever spliced in.
- **Stepwise splitting = native interleaved tool cards**: an ACP turn is split into multiple host steps by tool activity — a segment that ends with a `tool-call` card closes its stream, the host settles the message and executes the card (real output answered through a guard virtual tool), then continues with the next step; continuation segments resume reading the same still-in-flight `session/prompt` and never send a new one. Cards thus sit between two assistant nodes, matching native multi-step conversations.
- **Binding must be wired into the request path**: the guard's `agent/request` waterfall (`prepend: true`) rewrites requests to the bound `acp/<agent>`, and the adapter double-checks.
- **Permission modes and approvals are two layers, both agent-owned**: the control in `composer-mode.tsx` renders only the `availableModes` the agent sends via `session/set_mode` — no visible label, no translated option names; `session/request_permission` maps straight to the user. The plugin has no permission switch of its own: if the agent asks, a human sees it. The earlier host-adjudicated semantics (`decidePermission`, the fs write fence) have been removed — see `docs/acp-convergence.md` §2.3.
- **Cross-platform paths**: `impl.ts` can't import `node:path`; absolute-path and containment checks are hand-written, with dedicated Windows and UNC cases.

### Documentation index

- [AGENTS.md](./AGENTS.md) — **read its "what this plugin is" section first**: which constraints are retired, which target shapes have landed
- [NTR mode: handing the conversation to another agent](./docs/acp-mode.md) — design, field evidence, and hard boundaries
- [ACP convergence: display layer only](./docs/acp-convergence.md) — **the single authoritative reference for code convergence**
- [General guide to DSH plugin development](./docs/dsh-plugin-development-guide.md)
- [DSH official source reference & architecture index](./docs/README.md)
