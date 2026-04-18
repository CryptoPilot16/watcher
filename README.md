# Watcher

Mission control for multi-agent operations.

Website: https://cryptopilot.dev/watcher

![Watcher website screenshot](docs/images/readme-website-screenshot-2026-04-17.png)

## What It Is

Watcher is a self-hosted operations dashboard for agent systems. It gives operators one place to monitor system health, team activity, and execution state, then intervene from the web UI when needed.

## Core Capabilities

- Live mission status with system-level health context
- Interactive 3D Team Office scene with two swappable styles:
  - **Office** — voxel-art modern workspace with workstations, break area, wall fixtures (MariaIsMe voxel pack)
  - **Dungeon** — medieval tavern with stone walls, torches, banners, treasure chest (KayKit Dungeon pack)
- Rigged character avatars (KayKit Adventurers: Knight, Barbarian, Mage, Rogue) with idle / walk / sit-at-desk / hit-reaction animations
- Explicit lane casting in the office scene:
  - `AI Clone` uses the hooded rogue
  - `General` uses the rogue
  - `Assistant` and `Coder 1/2/3` use the knight
  - `Skybuddy`, `Echoes`, and `OddsGap` use mage / wizard models
- Lane-aware seating model: running and recent workers stay at their own desks, idle workers return to standby, offline workers remain visible in-lane
- Progress bars with completion burst animation and short post-finish linger
- Camera controls: overview / focus / free pan (desktop arrow grid + mobile toggle)
- Authenticated web lane control (select lane, send instruction) with session-aware topic routing for Telegram forum lanes
- Live session feed (user, agent, tool events)
- Task runs and flow tracking
- Logs and process visibility
- Telegram sync support
- Mobile-friendly dashboard experience with toggleable pan controls

## Product Surfaces

- `/watch` — primary operations dashboard
- `/office-preview` — public read-only office visualization
- `/office-preview?debug=1` — public debug view for lane mode / target / progress inspection
- `/docs` — in-app reference

## Security Model

- Authenticated dashboard access
- Public preview intentionally sanitized (no private task text)
- Web lane control routes instructions into the exact bound lane session instead of broadcasting to a generic agent target
- Topic/session resolution accepts both standard topic sessions and ACP-bound Telegram sessions, so lanes like Echoes still count as correctly bound
- Topic/session resolution avoids cross-lane fallback, so one lane cannot inherit another lane's identity just because its own session file is missing
- Runtime secrets are environment variables and are not stored in this README

## Tech Stack

- Next.js 14
- React
- TypeScript
- Three.js / react-three-fiber / @react-three/drei
- OBJ + GLB asset loaders (three-stdlib)

## 3D Assets

All third-party 3D assets used in the scenes are CC0 / free commercial-use:

- **KayKit Character Pack: Adventurers** (CC0) — rigged adventurer models with animations
- **KayKit Dungeon Remastered** (CC0) — dungeon floor tiles, walls, banners, torches, barrels, chest, pillars
- **MariaIsMe 3D Voxel Office Pack** — office furniture (desks, chairs, cubicles, cabinets, coffee machines, plants, wall art)

Assets are not checked into the repo — they're downloaded on setup by `scripts/fetch-models.sh` (KayKit from GitHub, MariaIsMe from itch.io). Output goes to `public/models/{chars,env,voxel}`, which is gitignored.

## Setup

```bash
# 1. install deps
npm install

# 2. fetch 3D assets (idempotent; skips anything already present)
bash scripts/fetch-models.sh

# 3. copy env template and set WATCH_PASSWORD + optional Telegram token
cp .env.example .env.local
# edit .env.local — WATCH_PASSWORD is whatever you want; this is the
# password you'll type into /login to access your dashboard. There is
# no pre-set value; anyone self-hosting picks their own.

# 4. run dev
npm run dev
```

If `fetch-models.sh` can't reach itch.io for the voxel office pack, it prints a fallback note with the manual download URL — just drop the OBJ zip into `public/models/voxel/` and re-run.

## Development

```bash
npm run dev
```

## Build

```bash
npm run build
npm run start
```

## Recent Interaction Model Notes

- Web-to-chat transfer for Team Office lane control resolves the concrete session for the selected lane, including Telegram forum topics.
- Session-bound web relays now queue the lane run immediately and let the lane deliver the reply back into Telegram, so the web UI no longer blocks on the full agent turn before showing success.
- The public office preview can expose a lightweight debug HUD with `?debug=1` when you need to verify seating, targets, and progress behavior without relying on WebGL output alone.
- Recent deliveries are intentionally short-lived so workers celebrate completion, then clear the chair quickly.
- Character casting is deterministic by lane role now, so the public office view keeps a stable visual identity instead of reshuffling character classes between refreshes.

## Lane Binding Modes

- Standard Telegram topic lanes bind as `agent:<agent>:telegram:group:<groupId>:topic:<threadId>`.
- Some lanes, especially ACP-backed ones like Echoes, can bind through ACP Telegram session keys instead of the standard topic-key form.
- Watcher treats both binding styles as valid lane targets for web relays.
- For session-bound lanes, the web UI should feel closer to chat: the request is queued fast, the lane runs in the background, and the reply is delivered back into the Telegram topic.

