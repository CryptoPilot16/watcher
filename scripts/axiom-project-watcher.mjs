#!/usr/bin/env node
// Watches /opt/axiom (or whatever WATCH_AXIOM_PROJECT_DIR points at) and appends
// each filesystem event as a JSONL line to /var/lib/watcher/axiom-project-events.jsonl.
//
// The watcher app's /api/axiom/project/events endpoint tails this file to drive
// the live "what are the agents creating?" feed in /axiom/project.

import { promises as fs, watch as fsWatch } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { stat as statCb } from 'node:fs';
import { promisify } from 'node:util';

const stat = promisify(statCb);

const PROJECT_DIR = process.env.WATCH_AXIOM_PROJECT_DIR || '/opt/axiom';
const EVENT_LOG = process.env.WATCH_AXIOM_PROJECT_EVENT_LOG || '/var/lib/watcher/axiom-project-events.jsonl';
const MAX_EVENT_LOG_BYTES = Number(process.env.WATCH_AXIOM_PROJECT_EVENT_LOG_MAX || 10 * 1024 * 1024);
const TRUNCATE_KEEP_BYTES = Number(process.env.WATCH_AXIOM_PROJECT_EVENT_LOG_KEEP || 4 * 1024 * 1024);
const DEBOUNCE_MS = 200;

// Paths inside the project that we never report on — too noisy or too big.
const IGNORED_PARTS = new Set([
  'node_modules', '.git', '.next', 'dist', 'build', '.turbo', '.cache',
  'coverage', '.nyc_output', '.parcel-cache', '.vite', '.svelte-kit',
]);
const IGNORED_FILES = /\.(log|swp|swo|tmp|lock)$/i;

function isIgnored(relPath) {
  if (!relPath) return false;
  for (const part of relPath.split('/')) {
    if (IGNORED_PARTS.has(part)) return true;
    if (part.startsWith('.') && part.length > 1 && part !== '.env.example') {
      // hide .DS_Store, .vscode, .idea, etc.
      if (part === '.gitignore' || part === '.env.example') continue;
      return true;
    }
  }
  return IGNORED_FILES.test(relPath);
}

async function ensureLog() {
  await fs.mkdir(dirname(EVENT_LOG), { recursive: true });
  try { await fs.access(EVENT_LOG); }
  catch { await fs.writeFile(EVENT_LOG, ''); }
}

async function maybeTruncate() {
  try {
    const s = await stat(EVENT_LOG);
    if (s.size <= MAX_EVENT_LOG_BYTES) return;
    const fh = await fs.open(EVENT_LOG, 'r');
    const buf = Buffer.alloc(TRUNCATE_KEEP_BYTES);
    const start = Math.max(0, s.size - TRUNCATE_KEEP_BYTES);
    await fh.read(buf, 0, TRUNCATE_KEEP_BYTES, start);
    await fh.close();
    // Drop the partial line at the start so we don't have a half-event.
    let tail = buf.toString('utf8');
    const nl = tail.indexOf('\n');
    if (nl >= 0) tail = tail.slice(nl + 1);
    await fs.writeFile(EVENT_LOG, tail);
    process.stdout.write(`[axiom-project-watcher] truncated event log: ${s.size} → ${tail.length} bytes\n`);
  } catch (err) {
    process.stderr.write(`[axiom-project-watcher] truncate error: ${err.message}\n`);
  }
}

const recent = new Map();

async function handle(eventName, relPath) {
  if (!relPath) return;
  if (isIgnored(relPath)) return;
  const key = `${eventName}:${relPath}`;
  const now = Date.now();
  const last = recent.get(key);
  if (last && now - last < DEBOUNCE_MS) return;
  recent.set(key, now);
  if (recent.size > 5_000) {
    // Cheap eviction — drop the oldest half.
    const entries = [...recent.entries()].sort((a, b) => a[1] - b[1]);
    for (let i = 0; i < entries.length / 2; i++) recent.delete(entries[i][0]);
  }

  const abs = join(PROJECT_DIR, relPath);
  let kind = 'change';
  let size = null;
  try {
    const s = await stat(abs);
    if (s.isDirectory()) return; // skip directory events themselves; we care about files
    size = s.size;
    kind = eventName === 'rename' ? 'created-or-renamed' : 'modified';
  } catch {
    kind = 'deleted';
  }

  const entry = {
    ts: new Date().toISOString(),
    kind,
    path: relPath,
    size,
  };
  await fs.appendFile(EVENT_LOG, JSON.stringify(entry) + '\n').catch((err) => {
    process.stderr.write(`[axiom-project-watcher] append error: ${err.message}\n`);
  });
}

async function main() {
  await ensureLog();
  process.stdout.write(`[axiom-project-watcher] watching ${PROJECT_DIR} → ${EVENT_LOG}\n`);

  let watcher;
  try {
    watcher = fsWatch(PROJECT_DIR, { recursive: true, persistent: true });
  } catch (err) {
    process.stderr.write(`[axiom-project-watcher] fs.watch failed: ${err.message}\n`);
    process.exit(1);
  }

  watcher.on('change', (eventType, filename) => {
    if (!filename) return;
    const rel = String(filename).replace(/\\/g, '/');
    handle(eventType, rel).catch(() => {});
  });
  watcher.on('error', (err) => {
    process.stderr.write(`[axiom-project-watcher] watcher error: ${err.message}\n`);
  });

  // Boot marker so the UI shows the watcher is alive.
  await fs.appendFile(EVENT_LOG, JSON.stringify({
    ts: new Date().toISOString(),
    kind: 'watcher-online',
    path: '',
    size: null,
  }) + '\n').catch(() => {});

  setInterval(maybeTruncate, 5 * 60_000).unref();

  process.on('SIGTERM', () => {
    try { watcher.close(); } catch {}
    process.exit(0);
  });
}

main().catch((err) => {
  process.stderr.write(`[axiom-project-watcher] fatal: ${err.message}\n`);
  process.exit(1);
});
