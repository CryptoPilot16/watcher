# CLAWNUX Watch

Private monitoring dashboard.

## Overview

CLAWNUX Watch is a standalone Next.js watcher app built to keep the current Snapmolt task front and center while still exposing the surrounding runtime context.

It provides:

- password-gated access with `WATCH_PASSWORD`
- a mobile-friendly `/watch` dashboard
- an in-app `/docs` tab that explains the dashboard and Telegram behavior
- a simplified project shell with logo, title, subtitle, tabs, and the Snapmolt tracker
- a task-first Snapmolt mirror that filters updater noise from the primary panel
- a live `/api/watch` snapshot endpoint
- a Telegram updater with draft-style teleprompter support for private chats
- PM2 processes for the web app and Telegram loop
- custom watcher branding with versioned logo and favicon assets

## Environment

Create `.env.local` from `.env.example` and set:

- `WATCH_PASSWORD`
- `WATCH_TELEGRAM_BOT_TOKEN`
- `WATCH_TELEGRAM_CHAT_ID`
- `WATCH_URL`
- `WATCH_TELEGRAM_INTERVAL_MS`

Notes:

- `WATCH_PASSWORD` is required in the environment
- the app no longer relies on a hardcoded password fallback in repo code

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

- `POST /api/watch-telegram` triggers a Telegram sync
- in private chats the bot uses Telegram draft streaming to keep a single teleprompter-style draft updated
- the teleprompter text is built from filtered Snapmolt activity, latest error, and a short recent-activity list
- if draft streaming is unavailable, the bot falls back to the standard tracked-message flow
- `POST /api/watch-telegram/init` forces a fresh tracking cycle
- local state is stored in `.watch-telegram-state.json`
- if `WATCH_TELEGRAM_CHAT_ID` is empty, the bot uses the latest chat that messaged it

## Key Files

- `src/app/watch/page.tsx` for the main watcher UI
- `src/app/docs/page.tsx` for the built-in product and integration documentation
- `src/lib/watch-data.ts` for runtime data collection
- `src/lib/watch-telegram.ts` for Telegram formatting and sync
- `scripts/watch-telegram-loop.mjs` for the periodic Telegram updater
- `src/components/watch-shell-header.tsx` for the shared Watch and Docs tab header
- `ecosystem.config.cjs` for PM2 process definitions
- `public/watch-logo-v4.svg` and `public/watch-favicon-v4.svg` for the current branding
