# CLAWNUX Watch

🛰️ Private monitoring dashboard for `watch.clawnux.com`.

## Overview

CLAWNUX Watch is a standalone Next.js watcher app built to keep the current Snapmolt task front and center while still exposing the surrounding runtime context.

It provides:

- password-gated access with `WATCH_PASSWORD`
- a mobile-friendly `/watch` dashboard
- a live `/api/watch` snapshot endpoint
- a Telegram updater that edits a single tracked status message
- PM2 processes for the web app and Telegram loop

## Environment

Create `.env.local` from `.env.example` and set:

- `WATCH_PASSWORD`
- `WATCH_TELEGRAM_BOT_TOKEN`
- `WATCH_TELEGRAM_CHAT_ID`
- `WATCH_URL`
- `WATCH_TELEGRAM_INTERVAL_MS`

## Local Development

1. `cd /opt/watcher`
2. Copy `.env.example` to `.env.local`
3. Run `npm install`
4. Run `npm run dev`

## Production Deploy

This project is deployed from:

- `/opt/watcher`

Core runtime shape:

- Caddy serves `https://watch.clawnux.com`
- PM2 runs `clawnux-watcher-web`
- PM2 runs `clawnux-watcher-telegram`
- the web app listens on `127.0.0.1:3012`

Deploy flow:

1. `cd /opt/watcher`
2. `npm install`
3. `npm run build`
4. `pm2 restart ecosystem.config.cjs --only clawnux-watcher-web,clawnux-watcher-telegram --update-env`
5. `pm2 save`

## Telegram Behavior

- `POST /api/watch-telegram/init` creates a fresh tracked message
- `POST /api/watch-telegram` updates the existing tracked message
- local state is stored in `.watch-telegram-state.json`
- if `WATCH_TELEGRAM_CHAT_ID` is empty, the bot uses the latest chat that messaged it

## Key Files

- `src/app/watch/page.tsx` for the main watcher UI
- `src/lib/watch-data.ts` for runtime data collection
- `src/lib/watch-telegram.ts` for Telegram formatting and sync
- `scripts/watch-telegram-loop.mjs` for the periodic Telegram updater
- `ecosystem.config.cjs` for PM2 process definitions
