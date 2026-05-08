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
import { createHash } from 'node:crypto';

const stat = promisify(statCb);

const PROJECT_DIR = process.env.WATCH_AXIOM_PROJECT_DIR || '/opt/axiom';
const EVENT_LOG = process.env.WATCH_AXIOM_PROJECT_EVENT_LOG || '/var/lib/watcher/axiom-project-events.jsonl';
const SNAPSHOT_DIR = process.env.WATCH_AXIOM_PROJECT_SNAPSHOT_DIR || '/var/lib/watcher/axiom-project-snapshots';
const MAX_SNAPSHOT_BYTES = Number(process.env.WATCH_AXIOM_PROJECT_SNAPSHOT_MAX || 256 * 1024);
const MAX_EVENT_LOG_BYTES = Number(process.env.WATCH_AXIOM_PROJECT_EVENT_LOG_MAX || 10 * 1024 * 1024);
const TRUNCATE_KEEP_BYTES = Number(process.env.WATCH_AXIOM_PROJECT_EVENT_LOG_KEEP || 4 * 1024 * 1024);
const DEBOUNCE_MS = 200;

// Paths inside the project that we never report on — too noisy or too big.
const IGNORED_PARTS = new Set([
  'node_modules', '.git', '.next', 'dist', 'build', '.turbo', '.cache',
  'coverage', '.nyc_output', '.parcel-cache', '.vite', '.svelte-kit',
]);
const IGNORED_FILES = /\.(log|swp|swo|tmp|lock)$/i;

// Path → owning team mapper. Each team's manager + 4 coders work in distinct
// path namespaces (the autopilot prompts steer them there). Most files match
// the first rule that fits; ambiguous files get team=null and render
// unattributed. Order matters — more specific patterns first.
const ATTRIBUTION_RULES = [
  { team: 1, dept: 'Foundation',   re: /^(services\/p0[125]-|contracts\/protos\/axiom\/core\/v1\/audit|services\/kms\/)/ },
  { team: 2, dept: 'Governance',   re: /^(services\/p06-rules\/|contracts\/cedar\/(?!sms\/)|contracts\/rules\/jurisdiction\/|tools\/validate-rule-pack)/ },
  { team: 3, dept: 'Reliability',  re: /^(services\/p09-|observability\/|contracts\/reliability\/|tools\/validate-(otel|dr-drill))/ },
  { team: 4, dept: 'Substrate',    re: /^(services\/p03-data\/|connectors\/(airports|fleet|units|time)\/|contracts\/protos\/axiom\/substrate\/|contracts\/asyncapi\/axiom\.substrate|contracts\/entities\/substrate\/)/ },
  { team: 5, dept: 'Flight Ops',   re: /^(contracts\/entities\/flight_ops|contracts\/protos\/axiom\/dispatch\/|contracts\/asyncapi\/dispatch-|contracts\/workflows\/dispatch_)/ },
  { team: 6, dept: 'Crew',         re: /^(contracts\/asyncapi\/crew\/|contracts\/entities\/crew\/|contracts\/rules\/(cba|crew))/ },
  { team: 7, dept: 'Engineering',  re: /^(contracts\/entities\/tech\/|contracts\/asyncapi\/axiom\.tech|tools\/validate-tech-)/ },
  { team: 8, dept: 'Safety',       re: /^(contracts\/asyncapi\/axiom\.(sms|avsec)|contracts\/cedar\/sms\/|contracts\/entities\/m1[78]_|tools\/validate-(sms|avsec)|contracts\/doc\/arinc)/ },
  { team: 9, dept: 'Commercial',   re: /^(contracts\/entities\/commercial\/|contracts\/asyncapi\/commercial\/|contracts\/rules\/commercial)/ },
  { team: 10, dept: 'ATC / IQ',    re: /^(contracts\/entities\/(iq\/|atc_)|contracts\/asyncapi\/axiom_atc|contracts\/protos\/axiom\/atc|tools\/validate-atc|contracts\/entities\/m80_)/ },
  { team: 0, dept: 'CEO / shared', re: /^(README\.md|CEO_MEMORY\.md|AXIOM_(MASTERPLAN|TECHSTACK|DEPARTMENTS)\.md|departments\/D\d+_GOAL\.md|package(-lock)?\.json|tsconfig\.json|reports\/)/ },
];

function attributePath(relPath) {
  if (!relPath) return null;
  for (const rule of ATTRIBUTION_RULES) {
    if (rule.re.test(relPath)) return { team: rule.team, dept: rule.dept };
  }
  return null;
}

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

// ── snapshot capture for diff view ─────────────────────────────────────────
// On each event we keep two files per watched path:
//   <hash>/state.txt  — content right AFTER the most recent event
//   <hash>/before.txt — content right BEFORE the most recent event
// At event time we move state.txt → before.txt, then save the live file as
// the new state.txt. The diff endpoint reads both and returns them; the UI
// renders a unified diff. before.txt may not exist for the first-ever event
// on a path — UI handles that gracefully.

function snapshotDirFor(relPath) {
  const hash = createHash('sha1').update(relPath).digest('hex');
  return join(SNAPSHOT_DIR, hash);
}

async function captureSnapshot(relPath, kind) {
  if (kind === 'deleted') {
    // Move state.txt → before.txt so the operator can still see "what got deleted".
    const dir = snapshotDirFor(relPath);
    try {
      await fs.rename(join(dir, 'state.txt'), join(dir, 'before.txt'));
    } catch {}
    try {
      await fs.unlink(join(dir, 'state.txt'));
    } catch {}
    return;
  }

  const abs = join(PROJECT_DIR, relPath);
  let buf;
  try {
    const s = await stat(abs);
    if (s.size === 0 || s.size > MAX_SNAPSHOT_BYTES) return;
    buf = await fs.readFile(abs);
    let nul = 0;
    for (let i = 0; i < Math.min(buf.length, 1024); i++) if (buf[i] === 0) nul++;
    if (nul > 4) return;
  } catch {
    return;
  }

  const dir = snapshotDirFor(relPath);
  await fs.mkdir(dir, { recursive: true });
  const stateFile = join(dir, 'state.txt');
  const beforeFile = join(dir, 'before.txt');

  try {
    await fs.rename(stateFile, beforeFile);
  } catch {
    // No prior state.txt — this is the first snapshot we've taken for this path.
  }
  await fs.writeFile(stateFile, buf);
}

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
    attributedTo: attributePath(relPath),
  };
  await fs.appendFile(EVENT_LOG, JSON.stringify(entry) + '\n').catch((err) => {
    process.stderr.write(`[axiom-project-watcher] append error: ${err.message}\n`);
  });
  await captureSnapshot(relPath, kind).catch((err) => {
    process.stderr.write(`[axiom-project-watcher] snapshot error for ${relPath}: ${err.message}\n`);
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
