# Watcher

Self-hosted mission control for OpenClaw agent teams.

Website: https://cryptopilot.dev/watcher

![Watcher website screenshot](docs/images/readme-website-screenshot-2026-04-17.png)

## What ships today

Watcher is a real operator surface for a live OpenClaw setup. Right now the repo includes:

- Public landing page for the project
- Authenticated `/watch` dashboard with five tabs:
  - **status**: mission banner, live session feed, auth health, session freshness, recent runs, cron state
  - **office**: interactive 3D team office with camera controls, desk ownership, progress bars, and lane states
  - **team**: lane cards plus a task board view of what each topic is doing
  - **activity**: recent runs, flows, cron-derived signals, and useful service log lines
  - **processes**: readable PM2 service health cards
- Interactive Team Office scene with two styles:
  - **Office**: voxel workspace with desks, break area, and operator-floor layout
  - **Dungeon**: tavern-style scene using KayKit dungeon assets
- Lane-aware worker placement:
  - running lanes stay at their own desks
  - recent lanes linger at their desk briefly after delivery
  - idle lanes park in standby spots
  - missing lanes remain visible as offline
- Lane progress parsing from plans and inline progress text, surfaced as progress bars in the office scene
- Web relay from the office UI into the exact bound lane session, including Telegram topic sessions and ACP-bound Telegram sessions
- Public read-only office preview at `/office-preview` with sanitized labels and stripped task text
- Public debug HUD at `/office-preview?debug=1` for DOM-side verification of mode, target, and progress when WebGL is unreliable
- Optional Telegram mirror loop for Watcher summaries
- Mobile-friendly layout across landing page, dashboard, and office view

## Product surfaces

- `/` — public landing page
- `/login` — password gate for the dashboard
- `/watch` — authenticated operations dashboard
- `/office-preview` — public sanitized office visualization
- `/office-preview?debug=1` — public debug HUD
- `/docs` — authenticated in-app reference
- `/api/watch` — JSON snapshot of the current Watcher state
- `/api/watch-telegram` — Telegram mirror sync endpoint

## What the dashboard actually reads

Watcher is not a mock dashboard. It reads from the live local system:

- OpenClaw session files for the active conversation feed
- OpenClaw `runs.sqlite` for task history
- OpenClaw flow registry for long-running multi-step work
- OpenClaw cron run logs for scheduled job snapshots
- PM2 for service/process health
- Team topology derived from lane/session bindings and recent activity

That split matters:

- the **live session feed** shows real-time conversation turns from the active session JSONL
- **runs** only capture completed or discrete task executions
- the **office/team views** use lane topology plus recent messages/tool events to infer live state and progress

## Team office and routing

The Team Office is the main differentiator in this repo.

- Workers have stable visual identities and stay anchored to their own lanes
- Camera modes support overview, focus, and free pan
- The floor view supports desk selection and lane inspection
- The office panel can send instructions directly into the bound lane session instead of broadcasting to a generic agent target
- Session resolution supports standard Telegram topic keys and ACP Telegram-bound sessions
- Public preview mode strips private task text and exposes only sanitized role/activity information

## Security model

- Dashboard access is gated by `WATCH_PASSWORD`
- `WATCH_SESSION_SECRET` can be set for browser session signing
- `WATCH_API_KEY` can be used for separate automation access
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
WATCH_API_KEY=
WATCH_SESSION_SECRET=
WATCH_TELEGRAM_BOT_TOKEN=
WATCH_TELEGRAM_CHAT_ID=
WATCH_URL=http://127.0.0.1:3012
WATCH_TELEGRAM_INTERVAL_MS=60000
```

If `fetch-models.sh` cannot fetch the voxel office pack automatically, it prints the fallback/manual download path. Drop the required files into `public/models/voxel/` and rerun the script.

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
- Tries Telegram draft streaming first, then falls back to editing a normal message when drafts are unavailable

## Notes

- The public debug HUD exists because headless Chromium and WebGL are not always trustworthy for validation on every host. The DOM debug view is the reliable path when you need to confirm avatar mode and progress state.
- Recent deliveries are intentionally short-lived so workers celebrate completion, then clear the chair quickly.
- Worker casting is deterministic by lane role so the office view does not reshuffle identities on refresh.
