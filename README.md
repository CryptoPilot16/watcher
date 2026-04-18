# Watcher

Self-hosted mission control for live OpenClaw agent teams.

Website: https://cryptopilot.dev/watcher

![Watcher website screenshot](docs/images/readme-website-screenshot-2026-04-17.png)

## What it is

Watcher is a real operator surface for a live OpenClaw setup, not a mock dashboard.
It gives you one place to read the active session, see lane state, inspect recent runs and flows, watch service health, and steer the right lane from the browser when something needs intervention.

## What ships today

- Public landing page at `/`
- Password-gated dashboard at `/watch`
- Five dashboard tabs:
  - **status**: mission banner, live session feed, auth health, session freshness, recent runs, cron state, stale-fault clearing
  - **office**: interactive 3D team office with desk ownership, progress bars, camera controls, and office or dungeon scene styles
  - **team**: lane cards plus a task board view of what each topic is doing
  - **activity**: recent runs, flows, cron-derived signals, and useful service log lines
  - **processes**: readable PM2 service health cards
- Interactive Team Office with lane-aware placement:
  - running lanes stay at their own desks
  - recent lanes linger briefly after delivery
  - idle lanes park in standby spots
  - missing lanes remain visible as offline
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

## Main surfaces

### App routes

- `/` — public landing page
- `/login` — password gate for the dashboard
- `/watch` — authenticated operations dashboard
- `/docs` — authenticated in-app reference
- `/office-preview` — public sanitized office visualization
- `/office-preview?debug=1` — public DOM debug HUD

### API routes

- `/api/auth/login` — browser login endpoint
- `/api/auth/logout` — clears the browser session cookie
- `/api/watch` — JSON snapshot of the current Watcher state
- `/api/watch/faults/clear` — clears stale run/session fault banners
- `/api/team-office/instruct` — injects instructions into the bound lane session
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
- **runs** capture discrete task executions and outcomes
- the **office** and **team** views combine topology, recent messages, and tool events to infer live state and progress

## Team office and routing

The Team Office is the main differentiator in this repo.

- Workers keep stable visual identities instead of reshuffling on refresh
- Camera modes support overview, focus, and free pan
- The floor view supports desk selection and lane inspection
- The office panel can send instructions directly into the bound lane session instead of broadcasting to a generic target
- Session resolution supports standard Telegram topic keys and ACP Telegram-bound sessions
- Public preview mode strips private task text and exposes only generic role and activity information
- Scene styles can switch between the voxel office and the dungeon layout

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

## Setup

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
