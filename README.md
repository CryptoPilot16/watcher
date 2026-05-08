# Watcher

Self-hosted mission control for live OpenClaw agent teams.

Landing page: https://cryptopilot.dev/watcher
Live app example: intentionally private / self-hosted

![Watcher website screenshot](docs/images/readme-website-screenshot-2026-04-17.png)

## What it is

Watcher is a real operator surface for a live OpenClaw setup, not a mock dashboard.
It gives you one place to read the active session, see lane state, inspect recent runs and flows, watch service health, and steer the right lane from the browser when something needs intervention.

## Quick setup

```bash
# 1. install deps
npm install

# 2. fetch 3D assets (idempotent; skips anything already present)
bash scripts/fetch-models.sh

# 3. copy env template and set your values
cp .env.example .env.local

# 4. run dev
npm run dev
```

Required for dashboard access:

```bash
WATCH_PASSWORD=choose-your-own-password
```

Fast local showcase mode:

```bash
WATCH_PASSWORD=demo
WATCH_DEMO_MODE=1
npm run dev
```

## What ships today

- Root route `/` redirects straight to the password-gated dashboard flow at `/watch`
- Password-gated dashboard at `/watch`
- Five dashboard tabs:
  - **status**: mission banner, live session feed, auth health, session freshness, recent runs, cron state, stale-fault clearing
  - **office**: interactive 3D team office with desk ownership, progress bars, camera controls, and office or dungeon scene styles
  - **team**: lane cards plus a task board view of what each topic is doing
  - **activity**: recent runs, flows, cron-derived signals, and useful service log lines
  - **processes**: readable PM2 service health cards
- Interactive Team Office with lane-aware placement:
  - running lanes stay at their own desks
  - recent lanes linger briefly after delivery or after a fresh lane nudge
  - idle lanes park in standby spots
  - missing lanes remain visible as offline
  - House Keeping can visibly discipline bad lanes with punch, flying kick, or finisher reactions
  - discipline selection can auto-escalate from light to severe based on lane staleness, missing reports, low progress, and context pressure
  - House Keeping discipline now shows feedback bubbles, forces a victim reaction, and can send a real correction back into the attacked lane session
- Context awareness in the office view:
  - lane context percentage is surfaced in the avatar info card
  - high-context lanes tint red above 80 percent
  - offline or missing lanes use a distinct muted color so they do not look like context danger
- Mobile-safe office behavior:
  - Telegram/mobile or weak WebGL environments can fall back to a simplified office view instead of rendering a broken blank canvas
  - the simplified fallback renders the full lane roster instead of truncating the team view on mobile
- Lane progress parsing from plans and inline progress text, surfaced as progress bars in the office scene
- Web relay from the office UI into the exact bound lane session, including Telegram topic sessions and ACP-bound Telegram sessions
- Public office preview at `/office-preview` with sanitized labels and stripped task text
- Public debug HUD at `/office-preview?debug=1` for reliable DOM-side verification when WebGL is flaky
- Optional Telegram mirror loop for Watcher summaries
- Portable self-host config:
  - configurable OpenClaw root, orchestration file, PM2 home, and binary paths
  - no source edits required just to point Watcher at a different box layout
- Optional demo mode for OSS onboarding when you want to showcase the product without a live OpenClaw install
- Low-friction auth hardening:
  - signed browser session cookies
  - rate-limited login
  - optional separate bearer token for automation
  - logout route for clearing browser access
- Mobile-friendly layout across landing page, dashboard, and office view

## AXIOM Office — 41-agent operations floor (showcase)

A separate admin zone at `/axiom` runs a 3D office staffed by 41 AI agents — a CEO, 10 managers, and 30 coders, laid out in 10 cubicle compartments around a central CEO podium. Built as a generic startup-org showcase of how to dispatch agent work from a 3D operator surface. Behind its own password (`WATCH_AXIOM_PASSWORD`, default `axiom`) and its own browser session cookie, separate from `/watch`. Agents are filesystem-sandboxed via bubblewrap so they can only write inside the configured project directory — they cannot edit other projects on the host or delete arbitrary files.

- Click any avatar → opens a per-agent chat box with persistent transcript (24h retention, in-thread reply history, clear button, 32k char message limit)
- CEO + managers run on **OpenAI Codex (gpt-5.5) in `/goal` mode** — autonomous, workspace-write sandbox in the project directory; they don't stop until the goal is done
- Coders run on **Claude Code** with a sonnet/haiku/opus rotation, full Read/Glob/Grep/Write/Edit/Bash tooling, `acceptEdits` permission mode (root-friendly)
- Persistent per-agent sessions: claude `--session-id` / `--resume` and codex `exec resume <thread-id>`. Stale-session fallback retries on a fresh session if a resume fails
- Live state polling: when you send a directive, the agent's avatar walks to its desk, sits down, and a progress bar ticks above its head until the call completes; auto-decays back to idle after 30 seconds
- A `/tasks` tab shows the full live feed of every directive across the floor with role filters (CEO / manager / coder), reply transcripts, and timestamps, auto-refreshed every 5 seconds
- Department names default to a generic startup org (Platform, Frontend, Backend, Data, Infra, Security, ML, Mobile, Growth, Research) and can be overridden by setting `NEXT_PUBLIC_AXIOM_DEPARTMENTS` (comma-separated, exactly 10 names)
- Project root for agent work defaults to `/opt/axiom`; override via `WATCH_AXIOM_PROJECT_DIR`. Mailbox / session state lives at `/var/lib/watcher/axiom-mailbox` (override via `WATCH_AXIOM_MAILBOX_DIR`)
- Per-call timeout configurable via `WATCH_AXIOM_CLAUDE_TIMEOUT_MS` (defaults to 600000 = 10 minutes)

### CEO over Telegram (voice + chat + autonomous missions)

A dedicated Telegram bot pairs the operator 1:1 with the AXIOM CEO so you can run the floor from your phone. Text or voice both round-trip to the same CEO conversation as the web `/axiom` UI.

- **Hybrid model split**: chat replies stream from Claude Sonnet (Anthropic Max subscription, ~10s typical) for fast back-and-forth. When the CEO judges a request needs autonomous execution — building features, editing files, running commands — it tags its reply with `<<DISPATCH: brief>>`. The bot strips the tag, spawns Codex `gpt-5.5 --enable goals` (ChatGPT subscription, `/goal` autonomous mode, `--sandbox workspace-write` inside the project dir) in the background, and DMs the result back when codex finishes (typically 2–15 min)
- Decision split is enforced architecturally: the CEO's claude call has narrow Write/Edit access (only for memory + reports — see below) so substantive code work must dispatch to codex
- **Voice messages** are transcribed locally via a long-running `faster-whisper` Python sidecar (CTranslate2, `small.en` int8 model kept warm in process). First transcription pays a ~3s model-load cost; subsequent voice notes transcribe in <1s. No cloud API, no key, no per-clip charge
- Bot pairing: `WATCH_AXIOM_CEO_OPERATOR_ID` locks the bot to one Telegram user ID. If unset, the first user to `/start` is auto-paired and persisted to `/var/lib/watcher/axiom-ceo-bot-state.json`
- Commands: `/start` (pair), `/status` (CEO + floor health), `/floor` (per-manager m1..m10 status), `/missions` (recent dispatches), `/memory` (show CEO_MEMORY.md), `/compact` (force a memory flush + session reset now), `/forget` (clear memory file), `/who`, `/reset`
- Engine override: set `WATCH_AXIOM_CEO_ENGINE=claude` (default `codex` in code) to keep the CEO on Claude even if the route's role-default would pick something else; same for managers via `WATCH_AXIOM_MANAGER_ENGINE`
- Run as a pm2 service: `npm run axiom-ceo:bot` (entry registered in `ecosystem.config.cjs` as `clawnux-axiom-ceo-bot`)
- **Subprocess env hygiene**: when watcher-web is launched from a Claude-Code-aware shell (PM2 inherits the launching shell's env), `CLAUDECODE=1` / `CLAUDE_CODE_SESSION_ID` / `CLAUDE_CODE_EXECPATH` would leak into the spawned `claude -p` subprocess and the CLI silently exits thinking it is nested inside another Claude Code session. The instruct route strips all `CLAUDE_CODE_*`, `CLAUDECODE`, `AI_AGENT`, and `CLAUDE_AGENT_SDK_VERSION` from the child env before spawn, so `(empty reply from claude)` does not surface for that reason

#### Manager delegation — keeping the floor busy

The CEO is your single interface to the project. When you give Ace a directive, he decides whether it's chat, a one-shot mission, or work that should be split across the manager floor — and routes accordingly.

- **`<<DELEGATE: m1,m4,m7 :: brief>>`** — fan out to a subset of managers (m1..m10). The bot dispatches each in parallel via `/api/team-office/instruct` with their session key (`axiom:axiom-mgr-{N}`), each manager receives the brief plus their department context and the path to their `D{N}_GOAL.md`, and runs autonomously
- **`<<DELEGATE-ALL: brief>>`** — same fan-out but to every manager. This is the CEO's default heartbeat when the operator says something open-ended like "go" or "make progress" with no specific target
- **Round-trip orchestration** — when all managers in a round have replied, the bot bundles their outputs into a single `MANAGER REPORTS` SYSTEM message and re-invokes the CEO. He then either (a) emits another `<<DELEGATE:>>` with sharper follow-up briefs (e.g., to fix a blocker one team flagged), or (b) finalises a tight rollup to the operator. Cap = 5 rounds per operator turn to prevent runaway delegation
- **Per-manager progress in chat** — as each manager finishes their slice, the bot DMs a one-line status with a 240-char preview, so the operator sees the floor moving in real time instead of waiting in silence for the rollup
- **`<<DISPATCH:>>` is now the fallback**, not the default. Use it only for one-shot work that doesn't fit any manager's domain (e.g. infra tweaks outside the project, repo-wide migrations). For anything that touches department surfaces, the CEO uses DELEGATE
- **Each manager's binding goal lives at `${WATCH_AXIOM_PROJECT_DIR}/departments/D{1..10}_GOAL.md`**. The CEO references these when shaping briefs; the manager re-reads its own before acting

#### Persistent CEO memory + auto-compaction

Every claude turn carries the full conversation as input tokens, so a long Telegram chat balloons cost. To keep that bounded, the CEO maintains a persistent `CEO_MEMORY.md` at the project root and the bot auto-compacts the live session when it grows too large.

- **`CEO_MEMORY.md`** lives at `${WATCH_AXIOM_PROJECT_DIR}/CEO_MEMORY.md` with structured sections (Mission, Operator, Decisions, Open threads, Recent wins). The CEO's system prompt instructs it to read this file before any non-trivial reply and update it as it learns operator preferences, decisions, and stakeholders. Survives every kind of session reset
- The CEO's claude tools are scoped to `Read,Glob,Grep,Write,Edit,WebFetch,WebSearch` and the system prompt enforces that Write/Edit may only target `CEO_MEMORY.md` and the `reports/` directory — anything else (code, configs, README) must dispatch to codex via `<<DISPATCH:>>`. Bwrap also kernel-restricts writes to the project dir
- **Auto-compaction**: bot tracks `inputTokens` from each claude response. When the conversation crosses `WATCH_AXIOM_CEO_COMPACT_THRESHOLD` (default 40000 tokens), the bot fires a background SYSTEM-COMPACT directive asking Ace to flush a recap to `CEO_MEMORY.md`, then deletes the session file. The next turn boots fresh but reads memory first, so the chat continues without losing the why
- Manual override: `/compact` triggers compaction now; `/memory` shows the current memory state in chat; `/forget` resets the memory file to a blank template

#### Long-form report attachments

For replies that would be reports / plans / design memos / multi-section docs, dumping the whole text into chat bloats every subsequent turn's context (since claude resumes the full transcript). Instead the CEO writes the document to `${WATCH_AXIOM_PROJECT_DIR}/reports/<slug>-<YYYY-MM-DD-HHmm>.md` and emits `<<REPORT_FILE: reports/...md>>` after a 2–3 sentence chat summary.

The bot detects the tag, strips it, and uses Telegram's `sendDocument` to attach the markdown file with the chat summary as caption. The file also persists in `/axiom/project` where the markdown viewer renders it inline with diff support against the previous version.

Required env for the Telegram path:

```bash
WATCH_AXIOM_CEO_BOT_TOKEN=        # @AxiomCEO_TheBuilder_Bot or your own bot token
WATCH_AXIOM_CEO_OPERATOR_ID=      # your Telegram user id (numeric)
WATCH_AXIOM_CEO_WHISPER_PYTHON=   # path to a venv with faster-whisper installed; voice disabled if unset
```

Optional knobs: `WATCH_AXIOM_CEO_ENGINE`, `WATCH_AXIOM_CEO_MODEL`, `WATCH_AXIOM_CODEX_MISSION_MODEL`, `WATCH_AXIOM_MISSION_TIMEOUT_MS`, `WATCH_AXIOM_CEO_WHISPER_MODEL` (default `small.en`), `WATCH_AXIOM_MISSION_DIR`, `WATCH_AXIOM_CEO_COMPACT_THRESHOLD` (default 40000).

### `/axiom/project` — live file tree, change feed, diff viewer

A separate admin tab at `/axiom/project` shows what the agents are actually building in real time. Three panes (file tree, recent file events, file viewer) backed by a long-running `fs.watch` sidecar that streams events over SSE, plus per-file before/after snapshots so the viewer can show a unified diff of the most recent edit.

- **Tree** — collapsible `/opt/axiom` file tree polled every 5s, with size + amber tint on recently-touched files
- **Events feed** — chronological list of created / modified / deleted events, streamed via SSE so updates land in <1s. Click any event to jump to the file
- **Viewer** — three modes selectable per file:
  - **source** — raw text, monospace
  - **rendered markdown** for `.md` files (sanitized agent-authored HTML) — auto-selected when there's no diff to show
  - **diff** — unified diff against the previous snapshot, with `+N/-M` summary and green/red gutter markers; auto-selected for any file the watcher has captured at least two snapshots of
- **Mobile** — three panes collapse to a tab switcher (tree | events | viewer) on phones; tapping a file auto-flips to viewer
- **Auth** — same admin cookie as the rest of `/axiom/*`, plus the `WATCH_API_KEY`/`WATCH_PASSWORD` bearer for scriptable access

Backed by a pm2 sidecar (`clawnux-axiom-project-watcher`) that writes events to `/var/lib/watcher/axiom-project-events.jsonl` (auto-truncates at 10MB → 4MB) and snapshots to `/var/lib/watcher/axiom-project-snapshots/<sha1>/`. New API routes: `/api/axiom/project/{tree,file,diff,events,events/stream}`.

Configurable via `WATCH_AXIOM_PROJECT_EVENT_LOG`, `WATCH_AXIOM_PROJECT_SNAPSHOT_DIR`, `WATCH_AXIOM_PROJECT_SNAPSHOT_MAX` (256KB default), `WATCH_AXIOM_PROJECT_EVENT_LOG_MAX`, `WATCH_AXIOM_PROJECT_EVENT_LOG_KEEP`.

### `/axiom/settings` — daily allowance + usage telemetry

Live view of the AXIOM office's daily spend (computed from each claude turn's `total_cost_usd`), per-agent call rate over the last hour, and a breakdown of recent agent actions by category (image / pdf / document / voice / code / text) with average cost and duration. Override the default daily cap (`WATCH_AXIOM_MAX_DAILY_USD`, default $10) at runtime via the page or the `/budget` Telegram command — no restart required.

## Main surfaces

### App routes

- `/` — redirects to `/watch`
- `/login` — password gate for the dashboard
- `/watch` — authenticated operations dashboard (gated by WATCH_PASSWORD)
- `/axiom/login` — separate password gate for the AXIOM admin zone (gated by WATCH_AXIOM_PASSWORD)
- `/axiom` — admin-authenticated 41-agent AXIOM Office showcase floor
- `/axiom/tasks` — admin-authenticated live feed of directives + agent replies across the AXIOM floor
- `/axiom/project` — admin-authenticated live file tree + change feed + diff viewer for `/opt/axiom`
- `/axiom/settings` — admin-authenticated daily allowance + per-agent + per-action usage telemetry
- `/docs` — authenticated in-app reference
- `/office-preview` — public sanitized office visualization
- `/office-preview?debug=1` — public DOM debug HUD

### API routes

- `/api/auth/login` — watch browser login endpoint
- `/api/auth/logout` — clears the watch browser session cookie
- `/api/admin/auth/login` — admin browser login endpoint (AXIOM zone)
- `/api/admin/auth/logout` — clears the admin browser session cookie
- `/api/watch` — JSON snapshot of the current Watcher state
- `/api/watch/faults/clear` — clears stale run/session fault banners
- `/api/team-office/instruct` — injects instructions into the bound lane session (or, for AXIOM session keys, dispatches to claude / codex with persistent sessions)
- `/api/axiom/state` — live status of every active AXIOM agent (running / recent / error) with progress estimates
- `/api/axiom/transcript?sessionKey=...` — fetch (GET) or clear (DELETE) the per-agent chat transcript with 24h auto-purge
- `/api/axiom/tasks` — JSON feed of every AXIOM directive ever sent, role-tagged, sorted newest-first
- `/api/axiom/project/tree` — JSON file tree of the AXIOM project dir
- `/api/axiom/project/file?path=...` — text/binary preview of any file under the project dir (256KB cap, traversal-protected)
- `/api/axiom/project/diff?path=...` — before / after snapshots for the most recent change to a file (client renders unified diff)
- `/api/axiom/project/events` — JSON tail of recent file-change events
- `/api/axiom/project/events/stream` — Server-Sent Events stream of file changes (instant updates)
- `/api/axiom/settings` — daily allowance, today's spend, per-agent call rate, per-action cost/duration breakdown; supports POST to override the cap
- `/api/watch-telegram` — Telegram mirror sync endpoint
- `/api/watch-telegram/init` — forces a fresh Telegram summary message

## What the dashboard actually reads

Watcher reads from the live local system by default, but the paths are configurable so self-hosters do not need your exact `/root/.openclaw` layout.

Default data sources:

- OpenClaw session files for the active conversation feed
- OpenClaw `runs.sqlite` for task history
- OpenClaw flow registry for long-running multi-step work
- OpenClaw cron run logs for scheduled job snapshots
- PM2 for service and process health
- Team topology derived from lane bindings and recent activity

That split matters:

- the **live session feed** reads directly from the active session JSONL, so it captures real conversation turns
- the live feed prefers the most active bound topic first (`running`, then `recent`, then newest update); a dispatcher lane is only a fallback when nothing else is live
- live feed row timestamps and the mission banner clock render in the **browser's local timezone**, while the raw session JSONL stays in ISO UTC
- **runs** capture discrete task executions and outcomes
- the **office** and **team** views combine topology, recent messages, and tool events to infer live state and progress

## Team office and routing

The Team Office is the main differentiator in this repo.

- Workers keep stable visual identities instead of reshuffling on refresh
- Camera modes support overview, focus, and free pan
- The floor view supports desk selection and lane inspection
- The office panel can send instructions directly into the bound lane session instead of broadcasting to a generic target
- Session resolution supports standard Telegram topic keys and ACP Telegram-bound sessions
- When multiple historical sessions match one topic, Watcher resolves the newest matching session so stale bindings do not shadow the live lane
- The status view exposes the live feed source label (for example `coder1 · topic 7`) so operators can confirm exactly which bound lane session is being tailed
- Public preview mode strips private task text and exposes only generic role and activity information
- Scene styles can switch between the voxel office and the dungeon layout
- House Keeping discipline controls are available in the office UI, with automatic severity-based attack selection when manual override is not active
- Auto-discipline can generate concrete feedback from lane state, display it in the office scene, and inject a corrective instruction into the bound lane session
- Disciplined lanes now answer visually in-scene and are treated as recently touched for a short window so the office does not keep showing them as dead idle right after a correction
- Punch and flying kick use lighter victim hit-react shakes, while the finisher carries the larger knockback animation
- Context percentage is carried into topology data so lane warnings can show both visual alerts and exact percent text
- High-context alerts tint avatars and halos red without relying on transparency hacks that break model rendering

## Security model

- Dashboard access is gated by `WATCH_PASSWORD`
- Browser sessions use a signed `watch_access` cookie with a 7-day lifetime
- Set `WATCH_SESSION_SECRET` if you want browser session signing separate from the login password
- Login attempts are rate-limited server-side
- `WATCH_API_KEY` can be used as a separate bearer token for automation
- Query-string auth is intentionally not supported
- Public office preview intentionally strips private task text
- Runtime secrets stay in environment variables, not this repo

## Tech stack

- Next.js 14
- React
- TypeScript
- Three.js / react-three-fiber / @react-three/drei
- OBJ + GLB asset loaders

## 3D assets

Third-party 3D assets used in the scenes are free commercial-use / CC0:

- **KayKit Character Pack: Adventurers** — rigged adventurer models with animations
- **KayKit Dungeon Remastered** — dungeon floor tiles, walls, props, and fixtures
- **MariaIsMe 3D Voxel Office Pack** — office furniture and environment assets

Assets are not checked into the repo. Fetch them with `scripts/fetch-models.sh`. Output goes to `public/models/{chars,env,voxel}`, which is gitignored.

## Setup details

Optional env vars:

```bash
# auth
WATCH_API_KEY=
WATCH_SESSION_SECRET=

# onboarding / showcase
WATCH_DEMO_MODE=

# non-default self-host paths and binaries
WATCH_OPENCLAW_DIR=
WATCH_OPENCLAW_BIN=
WATCH_PM2_BIN=
WATCH_PM2_HOME=
WATCH_ORCHESTRATION_FILE=
WATCH_UPDATE_RESULT_PATH=
WATCH_SNAPMOLT_PROCESS=snapmolt
WATCH_ECHOES_PROCESS=echoes-backend

# telegram mirror
WATCH_TELEGRAM_BOT_TOKEN=
WATCH_TELEGRAM_CHAT_ID=
WATCH_URL=http://127.0.0.1:3012
WATCH_TELEGRAM_INTERVAL_MS=60000
```

If you just want a fast local showcase without wiring in OpenClaw yet:

```bash
WATCH_PASSWORD=demo
WATCH_DEMO_MODE=1
npm run dev
```

If `fetch-models.sh` cannot fetch the voxel office pack automatically, it prints the fallback or manual download path. Drop the required files into `public/models/voxel/` and rerun the script.

## Development

```bash
npm run dev
```

## Build

```bash
npm run build
npm run start
```

## Telegram mirror loop

Optional script:

```bash
npm run telegram:loop
```

Behavior:

- Uses `WATCH_TELEGRAM_BOT_TOKEN`
- Uses `WATCH_TELEGRAM_CHAT_ID` if set
- Falls back to the most recent bot chat if chat id is omitted
- Uses bearer auth against the Watcher API
- Works cleanly with a separate `WATCH_API_KEY` or falls back to `WATCH_PASSWORD`
- Tries Telegram draft streaming first, then falls back to editing a normal message when drafts are unavailable
- `/api/watch-telegram/init` can force a fresh summary message when you want to reset the mirror thread cleanly

## Notes

- The public debug HUD exists because headless Chromium and WebGL are not always trustworthy for validation on every host. The DOM debug view is the reliable path when you need to confirm avatar mode and progress state.
- Demo mode is intentionally read-only: it gives OSS users a working product surface without pretending lane relay or live ops control is active.
- Recent deliveries are intentionally short-lived so workers celebrate completion, then clear the chair quickly.
- Worker casting is deterministic by lane role so the office view does not reshuffle identities on refresh.
- The main live app is the Next.js Watcher surface. Public marketing or project pages can sit separately in front of it, but the authenticated ops experience should live on a hostname or route set that forwards `/watch`, `/login`, `/docs`, `/office-preview`, `/api/*`, and `/_next/*` together.
- If you put a static landing page in front of a `/watcher` path, make sure you are not accidentally shadowing the live Next app behind stale static files.
