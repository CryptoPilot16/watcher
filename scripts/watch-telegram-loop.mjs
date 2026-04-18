const WATCH_URL = process.env.WATCH_URL || 'http://127.0.0.1:3012';
const WATCH_API_KEY = process.env.WATCH_API_KEY || process.env.WATCH_PASSWORD || '';
const INTERVAL_MS = Number(process.env.WATCH_TELEGRAM_INTERVAL_MS || 60_000);

async function tick() {
  const url = new URL('/api/watch-telegram', WATCH_URL);

  const res = await fetch(url.toString(), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${WATCH_API_KEY}`,
    },
  });
  const json = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(json?.error || `watch telegram sync failed (${res.status})`);
  }

  process.stdout.write(`[watch-telegram-loop] ${new Date().toISOString()} ${json.action}\n`);
}

async function main() {
  if (!WATCH_API_KEY) {
    throw new Error('Missing WATCH_API_KEY or WATCH_PASSWORD');
  }

  await tick();
  setInterval(() => {
    tick().catch((error) => {
      process.stderr.write(`[watch-telegram-loop] ${new Date().toISOString()} ${error.message}\n`);
    });
  }, INTERVAL_MS);
}

main().catch((error) => {
  process.stderr.write(`[watch-telegram-loop] startup failed: ${error.message}\n`);
  process.exit(1);
});
