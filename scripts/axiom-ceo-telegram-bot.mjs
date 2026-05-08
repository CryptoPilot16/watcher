#!/usr/bin/env node
// Long-poll Telegram bot that pairs a Telegram chat with the AXIOM CEO.
//
// Inbound: each DM is forwarded to /api/team-office/instruct with sessionKey
//          'axiom:axiom-ceo' (the same path the AXIOM Office UI uses), so the
//          operator gets a single coherent CEO conversation across web + chat.
// Outbound: the CEO's reply is posted back to the chat.
// Pairing:  by default only WATCH_AXIOM_CEO_OPERATOR_ID is allowed. If unset,
//           the first user to /start the bot is auto-paired and persisted.
//
// State file (JSON):
//   { offset: <last-update-id>, pairedChatId: <id>, pairedUserId: <id> }

import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

const TOKEN = process.env.WATCH_AXIOM_CEO_BOT_TOKEN || '';
const WATCH_URL = process.env.WATCH_URL || 'http://127.0.0.1:3012';
const WATCH_AUTH = (process.env.WATCH_API_KEY || process.env.WATCH_PASSWORD || '').trim();
const STATE_FILE = process.env.WATCH_AXIOM_CEO_STATE_FILE || '/var/lib/watcher/axiom-ceo-bot-state.json';
const MISSION_DIR = process.env.WATCH_AXIOM_MISSION_DIR || '/var/lib/watcher/axiom-missions';
const AXIOM_PROJECT_DIR = process.env.WATCH_AXIOM_PROJECT_DIR || '/opt/axiom';
const OPERATOR_ID = (process.env.WATCH_AXIOM_CEO_OPERATOR_ID || '').trim();
const POLL_TIMEOUT_S = Number(process.env.WATCH_AXIOM_CEO_POLL_TIMEOUT_S || 50);
// Set WATCH_AXIOM_CEO_WHISPER_PYTHON to the python venv that has faster-whisper installed.
// Voice-message transcription is disabled when this is unset.
const WHISPER_PYTHON = process.env.WATCH_AXIOM_CEO_WHISPER_PYTHON || '';
const WHISPER_SIDECAR = process.env.WATCH_AXIOM_CEO_WHISPER_SIDECAR || join(import.meta.dirname || '.', 'axiom-ceo-whisper-sidecar.py');
const WHISPER_TIMEOUT_MS = Number(process.env.WATCH_AXIOM_CEO_WHISPER_TIMEOUT_MS || 60_000);
const CODEX_BIN = process.env.WATCH_AXIOM_CODEX_BIN || 'codex';
const CODEX_MODEL = process.env.WATCH_AXIOM_CODEX_MISSION_MODEL || 'gpt-5.5';
const MISSION_TIMEOUT_MS = Number(process.env.WATCH_AXIOM_MISSION_TIMEOUT_MS || 1800_000); // 30 min
const TYPING_INTERVAL_MS = 4_000;
const TG_MAX = 4096;
const SESSION_KEY = 'axiom:axiom-ceo';
const AGENT_ID = 'claude-code';
const GROUP_ID = 'axiom';

if (!TOKEN) {
  process.stderr.write('[axiom-ceo-bot] missing WATCH_AXIOM_CEO_BOT_TOKEN\n');
  process.exit(1);
}

async function readState() {
  try {
    return JSON.parse(await fs.readFile(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

async function writeState(state) {
  await fs.mkdir(dirname(STATE_FILE), { recursive: true });
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

async function tg(method, body) {
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok || !json.ok) {
    const desc = json && json.description ? json.description : `HTTP ${r.status}`;
    throw new Error(`tg.${method} failed: ${desc}`);
  }
  return json.result;
}

async function sendChunked(chatId, text, replyTo) {
  const safe = String(text || '').trim() || '(empty reply)';
  let first = true;
  for (let i = 0; i < safe.length; i += TG_MAX) {
    const slice = safe.slice(i, i + TG_MAX);
    const body = {
      chat_id: chatId,
      text: slice,
      disable_web_page_preview: true,
    };
    if (first && replyTo) body.reply_to_message_id = replyTo;
    await tg('sendMessage', body);
    first = false;
  }
}

// Wraps fetch with retry-on-connection-error. Watcher-web sometimes restarts
// (e.g. user-driven `pm2 restart`) mid-call; node's fetch throws a TypeError
// "fetch failed" with a UND_ERR_SOCKET / ECONNREFUSED cause. We sleep and retry
// for up to ~12s so a single restart does not surface as "bot error: fetch
// failed" to the operator. Server-side errors (4xx/5xx) are NOT retried — only
// transport-level failures.
async function fetchWithRetry(url, init, { maxRetries = 4, baseDelayMs = 500 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fetch(url, init);
    } catch (err) {
      lastErr = err;
      const cause = err?.cause?.code || '';
      const transient = /ECONNREFUSED|ECONNRESET|UND_ERR_SOCKET|EAI_AGAIN|ETIMEDOUT|fetch failed/i.test(
        `${cause} ${err?.message || ''}`,
      );
      if (!transient || attempt === maxRetries) throw err;
      const delay = baseDelayMs * Math.pow(2, attempt);
      process.stderr.write(`[axiom-ceo-bot] fetch retry ${attempt + 1}/${maxRetries} after ${delay}ms (${err.message || cause})\n`);
      await new Promise((res) => setTimeout(res, delay));
    }
  }
  throw lastErr;
}

async function callCeo(message) {
  const url = new URL('/api/team-office/instruct', WATCH_URL).toString();
  const headers = { 'Content-Type': 'application/json' };
  if (WATCH_AUTH) headers.Authorization = `Bearer ${WATCH_AUTH}`;
  const r = await fetchWithRetry(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      agentId: AGENT_ID,
      sessionKey: SESSION_KEY,
      groupId: GROUP_ID,
      message,
    }),
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) {
    const detail = json && (json.detail || json.error) ? (json.detail || json.error) : `HTTP ${r.status}`;
    return { ok: false, reply: `(CEO call failed: ${String(detail).slice(0, 1500)})` };
  }
  return {
    ok: true,
    reply: String(json.reply || '(empty reply)'),
    engine: json.engine,
    model: json.model,
    durationMs: json.durationMs,
    inputTokens: json.inputTokens,
    outputTokens: json.outputTokens,
    cacheReadTokens: json.cacheReadTokens,
    costUsd: json.costUsd,
  };
}

// Departments must mirror NEXT_PUBLIC_AXIOM_DEPARTMENTS in the API. We avoid
// importing the route by re-deriving from the env, falling back to the same
// generic-startup default the API uses.
const DEFAULT_DEPARTMENTS = ['Platform', 'Frontend', 'Backend', 'Data', 'Infra', 'Security', 'ML', 'Mobile', 'Growth', 'Research'];
const _envDepartments = (process.env.NEXT_PUBLIC_AXIOM_DEPARTMENTS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
const AXIOM_DEPARTMENTS = _envDepartments.length === 10 ? _envDepartments : DEFAULT_DEPARTMENTS;
const managerLabel = (n) => `m${n} (${AXIOM_DEPARTMENTS[n - 1] || 'unknown'})`;

async function callManager(team, message) {
  const url = new URL('/api/team-office/instruct', WATCH_URL).toString();
  const headers = { 'Content-Type': 'application/json' };
  if (WATCH_AUTH) headers.Authorization = `Bearer ${WATCH_AUTH}`;
  const r = await fetchWithRetry(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      agentId: AGENT_ID,
      sessionKey: `axiom:axiom-mgr-${team}`,
      groupId: GROUP_ID,
      message,
    }),
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) {
    const detail = json && (json.detail || json.error) ? (json.detail || json.error) : `HTTP ${r.status}`;
    return { ok: false, team, reply: String(detail).slice(0, 1500), durationMs: 0 };
  }
  return {
    ok: true,
    team,
    reply: String(json.reply || '(empty reply)'),
    engine: json.engine,
    durationMs: json.durationMs,
  };
}

// Fan out to selected managers in parallel and collect their replies. Posts a
// per-manager status line to the operator chat as each finishes so the operator
// can see the floor moving.
async function delegateToManagers(managers, brief, chatId) {
  await tg('sendMessage', {
    chat_id: chatId,
    text: `🛰️ delegating to ${managers.length} manager${managers.length === 1 ? '' : 's'}: ${managers.map(managerLabel).join(', ')}\n\nbrief: ${brief.slice(0, 280)}${brief.length > 280 ? '…' : ''}`,
  });
  const startedAt = Date.now();
  const tasks = managers.map(async (team) => {
    const dept = AXIOM_DEPARTMENTS[team - 1] || 'unknown';
    const taggedBrief = [
      `[CEO DELEGATION — you are the ${dept} manager (m${team}, team ${team}).]`,
      `Read /opt/axiom/departments/D${team}_GOAL.md before acting.`,
      ``,
      brief,
      ``,
      `When done, reply with: (1) what you did concretely (files touched, commands run), (2) what's still blocked or needs another team, (3) a short signed status line "m${team} ${dept}: <one-line summary>".`,
    ].join('\n');
    const t0 = Date.now();
    const res = await callManager(team, taggedBrief);
    const dur = ((Date.now() - t0) / 1000).toFixed(0);
    const head = res.ok
      ? `✅ ${managerLabel(team)} reported (${dur}s)`
      : `❌ ${managerLabel(team)} failed (${dur}s)`;
    const preview = String(res.reply || '').replace(/\s+/g, ' ').slice(0, 240);
    try {
      await tg('sendMessage', { chat_id: chatId, text: `${head}\n${preview}${preview.length >= 240 ? '…' : ''}` });
    } catch {}
    return { ...res, dept };
  });
  const results = await Promise.all(tasks);
  const totalSec = ((Date.now() - startedAt) / 1000).toFixed(0);
  return { results, totalSec };
}

// Build the SYSTEM message that re-invokes the CEO with manager outputs.
function buildManagerReportPayload(results) {
  const lines = ['MANAGER REPORTS — incoming from the floor. Re-assess and either DELEGATE follow-ups or finalize a tight rollup to the operator.', ''];
  for (const r of results) {
    const head = `--- ${managerLabel(r.team)} ${r.ok ? 'OK' : 'ERROR'} ${r.durationMs ? `(${(r.durationMs / 1000).toFixed(0)}s)` : ''} ---`;
    const body = String(r.reply || '').slice(0, 4000);
    lines.push(head, body, '');
  }
  return lines.join('\n');
}

const MAX_DELEGATION_ROUNDS = 5;

async function downloadTelegramFile(fileId, suffix) {
  // Step 1: ask Telegram for the file_path (valid for ~1h).
  const meta = await tg('getFile', { file_id: fileId });
  if (!meta?.file_path) throw new Error('getFile returned no file_path');
  const url = `https://api.telegram.org/file/bot${TOKEN}/${meta.file_path}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`download HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  const path = join(tmpdir(), `axiom-ceo-${randomUUID()}${suffix || '.ogg'}`);
  await fs.writeFile(path, buf);
  return { path, size: buf.length, durationS: meta.file_size, telegramPath: meta.file_path };
}

// ── faster-whisper sidecar ─────────────────────────────────────────────────
// Long-running faster-whisper (CTranslate2) Python process. The model stays
// loaded so subsequent transcriptions are fast: spawn one Python sidecar at
// boot, feed it filenames over stdin, get JSON transcripts on stdout. First
// request pays the model-load cost (~3-5s for small.en); subsequent requests
// on a 5s clip are <1s.

const whisperState = {
  proc: null,
  buffer: '',
  pending: new Map(),
  ready: null,
  starting: null,
};

function spawnWhisperSidecar() {
  if (whisperState.proc) return;
  process.stdout.write(`[axiom-ceo-bot] starting whisper sidecar (${WHISPER_PYTHON} ${WHISPER_SIDECAR})\n`);
  const proc = spawn(WHISPER_PYTHON, [WHISPER_SIDECAR], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env },
  });
  whisperState.proc = proc;
  whisperState.buffer = '';
  whisperState.ready = new Promise((resolve, reject) => {
    whisperState.starting = { resolve, reject };
  });

  proc.stdout.on('data', (chunk) => {
    whisperState.buffer += chunk.toString('utf8');
    let idx;
    while ((idx = whisperState.buffer.indexOf('\n')) >= 0) {
      const line = whisperState.buffer.slice(0, idx).trim();
      whisperState.buffer = whisperState.buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id === 'boot') {
        if (msg.ok) {
          process.stdout.write(`[axiom-ceo-bot] whisper sidecar ready — model=${msg.model} loadMs=${msg.loadMs}\n`);
          whisperState.starting?.resolve();
        } else {
          process.stderr.write(`[axiom-ceo-bot] whisper sidecar boot failed: ${msg.error}\n`);
          whisperState.starting?.reject(new Error(msg.error));
        }
        whisperState.starting = null;
        continue;
      }
      const pending = whisperState.pending.get(msg.id);
      if (!pending) continue;
      whisperState.pending.delete(msg.id);
      if (msg.ok) pending.resolve({ text: String(msg.text || ''), durationMs: msg.durationMs });
      else pending.reject(new Error(msg.error || 'transcription failed'));
    }
  });
  proc.stderr.on('data', (chunk) => {
    process.stderr.write(`[whisper-sidecar] ${chunk.toString('utf8')}`);
  });
  proc.on('exit', (code, signal) => {
    process.stderr.write(`[axiom-ceo-bot] whisper sidecar exited code=${code} signal=${signal}\n`);
    for (const pending of whisperState.pending.values()) pending.reject(new Error('whisper sidecar exited'));
    whisperState.pending.clear();
    whisperState.proc = null;
    whisperState.ready = null;
    if (whisperState.starting) {
      whisperState.starting.reject(new Error(`sidecar exited before ready (code=${code})`));
      whisperState.starting = null;
    }
  });
}

async function transcribeWithWhisper(audioPath) {
  if (!whisperState.proc) spawnWhisperSidecar();
  if (whisperState.ready) await whisperState.ready;
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      whisperState.pending.delete(id);
      reject(new Error(`whisper timeout after ${WHISPER_TIMEOUT_MS}ms`));
    }, WHISPER_TIMEOUT_MS);
    whisperState.pending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v.text || '(transcription was empty)'); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    whisperState.proc.stdin.write(JSON.stringify({ id, path: audioPath }) + '\n');
  });
}

function pickMediaSource(msg) {
  if (msg.voice) return { fileId: msg.voice.file_id, suffix: '.ogg', kind: 'voice', durationS: msg.voice.duration };
  if (msg.audio) return { fileId: msg.audio.file_id, suffix: '.' + (msg.audio.mime_type?.split('/').pop() || 'mp3'), kind: 'audio', durationS: msg.audio.duration };
  if (msg.video_note) return { fileId: msg.video_note.file_id, suffix: '.mp4', kind: 'video_note', durationS: msg.video_note.duration };
  return null;
}

async function transcribeMessageMedia(chatId, msg) {
  const source = pickMediaSource(msg);
  if (!source) return null;
  const dl = await downloadTelegramFile(source.fileId, source.suffix);
  try {
    const transcript = await transcribeWithWhisper(dl.path);
    return { transcript, kind: source.kind, durationS: source.durationS };
  } finally {
    await fs.unlink(dl.path).catch(() => {});
  }
}

// ── Mission dispatch (Claude → Codex /goal handoff) ───────────────────────
// Claude Sonnet replies fast. When Ace decides a request is an autonomous
// mission rather than chat, it ends its reply with `<<DISPATCH: brief>>`.
// We strip the tag, spawn `codex exec --enable goals` in the background with
// the brief, and DM the operator when codex returns.

const DISPATCH_RE = /<<\s*DISPATCH\s*:\s*([\s\S]*?)\s*>>/;
const REPORT_RE = /<<\s*REPORT_FILE\s*:\s*([^\s>][^>]*?)\s*>>/;
const DELEGATE_RE = /<<\s*DELEGATE\s*:\s*([^:]+?)\s*::\s*([\s\S]*?)\s*>>/;
const DELEGATE_ALL_RE = /<<\s*DELEGATE-ALL\s*:\s*([\s\S]*?)\s*>>/;

function parseDispatch(reply) {
  if (!reply) return { cleaned: '', brief: null };
  const match = DISPATCH_RE.exec(reply);
  if (!match) return { cleaned: reply.trim(), brief: null };
  const brief = match[1].trim().replace(/\s+/g, ' ').slice(0, 1500);
  const cleaned = reply.replace(DISPATCH_RE, '').trim();
  return { cleaned, brief };
}

// Minimum brief length for a real delegation. Below this we treat the tag as
// referential text (e.g. Ace explaining the protocol) rather than an
// invocation. Short briefs would also produce useless manager work.
const MIN_DELEGATION_BRIEF_CHARS = 30;

// <<DELEGATE: m1,m4 :: brief>>  →  { managers: [1,4], brief }
// <<DELEGATE-ALL: brief>>       →  { managers: [1..10], brief }
function parseDelegate(reply) {
  if (!reply) return { cleaned: '', delegation: null };
  const allMatch = DELEGATE_ALL_RE.exec(reply);
  if (allMatch) {
    const brief = allMatch[1].trim().replace(/\s+/g, ' ').slice(0, 1500);
    if (brief.length < MIN_DELEGATION_BRIEF_CHARS) {
      // Empty / placeholder / referential tag — leave it inline so Ace's text
      // stays intact and no fan-out happens. Operator will see the raw tag
      // and can prompt Ace for an actual brief.
      return { cleaned: reply.trim(), delegation: null };
    }
    const cleaned = reply.replace(DELEGATE_ALL_RE, '').trim();
    return { cleaned, delegation: { managers: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], brief } };
  }
  const match = DELEGATE_RE.exec(reply);
  if (!match) return { cleaned: reply.trim(), delegation: null };
  const ids = match[1]
    .split(/[,\s]+/)
    .map((tok) => tok.trim().match(/^m(\d+)$/i))
    .filter(Boolean)
    .map((m) => Number(m[1]))
    .filter((n) => n >= 1 && n <= 10);
  const unique = Array.from(new Set(ids)).sort((a, b) => a - b);
  if (!unique.length) return { cleaned: reply.replace(DELEGATE_RE, '').trim(), delegation: null };
  const brief = match[2].trim().replace(/\s+/g, ' ').slice(0, 1500);
  if (brief.length < MIN_DELEGATION_BRIEF_CHARS) {
    return { cleaned: reply.trim(), delegation: null };
  }
  const cleaned = reply.replace(DELEGATE_RE, '').trim();
  return { cleaned, delegation: { managers: unique, brief } };
}

// Parse <<REPORT_FILE: relative/path.md>> — Ace writes long-form output to a
// file and just summarises in chat. The bot strips the tag and sends the file
// as a Telegram document with the summary as the caption. Path must resolve
// inside AXIOM_PROJECT_DIR (no traversal).
function parseReportFile(reply) {
  if (!reply) return { cleaned: '', reportPath: null };
  const match = REPORT_RE.exec(reply);
  if (!match) return { cleaned: reply.trim(), reportPath: null };
  let raw = match[1].trim();
  // Allow either "reports/foo.md" or absolute path inside the project dir.
  if (raw.startsWith('/')) raw = raw.replace(new RegExp(`^${AXIOM_PROJECT_DIR}/?`), '');
  if (raw.includes('..') || raw.includes('\0')) {
    return { cleaned: reply.replace(REPORT_RE, '').trim(), reportPath: null };
  }
  const cleaned = reply.replace(REPORT_RE, '').trim();
  return { cleaned, reportPath: raw };
}

async function sendReportDocument(chatId, relPath, caption) {
  const abs = join(AXIOM_PROJECT_DIR, relPath);
  let stat;
  try {
    stat = await fs.stat(abs);
  } catch {
    await tg('sendMessage', { chat_id: chatId, text: `${caption}\n\n(report file not found: ${relPath})` });
    return false;
  }
  if (stat.size > 50 * 1024 * 1024) {
    await tg('sendMessage', { chat_id: chatId, text: `${caption}\n\n(report file too large to send: ${relPath} · ${stat.size} bytes)` });
    return false;
  }
  // Telegram bot API caption limit is 1024 chars. Truncate gracefully.
  const safeCaption = caption.length > 1000 ? caption.slice(0, 997) + '…' : caption;
  const buf = await fs.readFile(abs);
  const filename = relPath.split('/').pop() || 'report.md';
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('caption', safeCaption);
  form.append('document', new Blob([buf], { type: 'text/markdown' }), filename);
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendDocument`, { method: 'POST', body: form });
  const json = await r.json().catch(() => ({}));
  if (!r.ok || !json.ok) {
    const desc = json?.description || `HTTP ${r.status}`;
    process.stderr.write(`[axiom-ceo-bot] sendDocument failed: ${desc}\n`);
    await tg('sendMessage', { chat_id: chatId, text: `${caption}\n\n(could not attach ${filename}: ${desc})` });
    return false;
  }
  return true;
}

// ── Persistent context tracking + auto-compaction ──────────────────────────
// Conversation context grows every turn. We track the most recent input-token
// count from claude (which represents the resumed conversation length) and
// trigger a compaction prompt when it crosses a threshold. Ace responds by
// flushing a recap into CEO_MEMORY.md, then the bot deletes the session
// file so the next turn starts fresh — but Ace reads CEO_MEMORY.md first so
// the conversation feels continuous.

const CONTEXT_COMPACT_THRESHOLD = Number(process.env.WATCH_AXIOM_CEO_COMPACT_THRESHOLD || 40_000);
const CEO_SESSION_FILE = '/var/lib/watcher/axiom-mailbox/axiom:axiom-ceo.session';
const CEO_MEMORY_FILE = join(AXIOM_PROJECT_DIR, 'CEO_MEMORY.md');

let lastSeenInputTokens = 0;
let compactionInFlight = false;

async function resetCeoSession() {
  try { await fs.unlink(CEO_SESSION_FILE); } catch {}
  lastSeenInputTokens = 0;
}

async function performCompaction(chatId) {
  if (compactionInFlight) return;
  compactionInFlight = true;
  try {
    const directive = [
      'SYSTEM COMPACT SIGNAL: Your conversation context is getting large.',
      `Append a brief recap paragraph (3-6 lines) to ${CEO_MEMORY_FILE} covering anything significant from the last several turns that is not already recorded there. Update the relevant sections (Mission, Operator, Decisions, Open threads, Recent wins) as you go.`,
      'After saving, reply with exactly the single word: compacted',
      'Your session will be reset after this turn — but you will read CEO_MEMORY.md on the next turn so the conversation continues seamlessly.',
    ].join('\n\n');

    const result = await callCeo(directive);
    if (!result.ok) {
      await tg('sendMessage', { chat_id: chatId, text: `🧠 auto-compact failed: ${String(result.reply).slice(0, 200)}` });
      return;
    }
    await resetCeoSession();
    const lines = (result.reply || '').toLowerCase().split(/\s+/).slice(0, 6).join(' ');
    if (!lines.includes('compacted')) {
      await tg('sendMessage', {
        chat_id: chatId,
        text: `🧠 context compacted (Ace did not echo "compacted"; reset anyway). CEO_MEMORY.md updated.`,
      });
      return;
    }
    await tg('sendMessage', {
      chat_id: chatId,
      text: '🧠 context compacted to CEO_MEMORY.md and session reset. Continuing seamlessly.',
    });
  } finally {
    compactionInFlight = false;
  }
}

async function readMemoryFile() {
  try {
    return await fs.readFile(CEO_MEMORY_FILE, 'utf8');
  } catch {
    return null;
  }
}

const AXIOM_MAILBOX_DIR = process.env.WATCH_AXIOM_MAILBOX_DIR || '/var/lib/watcher/axiom-mailbox';
const AXIOM_GLOBAL_COST_FILE = join(AXIOM_MAILBOX_DIR, 'axiom-global.cost.json');
const AXIOM_ALLOWANCE_FILE = join(AXIOM_MAILBOX_DIR, 'axiom-allowance.json');
const AXIOM_DEFAULT_DAILY_USD = Number(process.env.WATCH_AXIOM_MAX_DAILY_USD || 10);

async function readJsonFile(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

async function readEffectiveAllowance() {
  const override = await readJsonFile(AXIOM_ALLOWANCE_FILE);
  if (override && typeof override.dailyUsdOverride === 'number' && override.dailyUsdOverride > 0) {
    return { cap: override.dailyUsdOverride, override };
  }
  return { cap: AXIOM_DEFAULT_DAILY_USD, override: null };
}

async function writeAllowanceOverride(cap, updatedBy) {
  await fs.mkdir(AXIOM_MAILBOX_DIR, { recursive: true });
  await fs.writeFile(
    AXIOM_ALLOWANCE_FILE,
    JSON.stringify({
      dailyUsdOverride: cap,
      updatedAt: new Date().toISOString(),
      updatedBy,
    }, null, 2),
  );
}

async function clearAllowanceOverride() {
  await fs.unlink(AXIOM_ALLOWANCE_FILE).catch(() => {});
}

async function clearGlobalAlertFlag() {
  // Re-arm the 90% alert so a fresh allowance can trigger another alert later.
  const cost = await readJsonFile(AXIOM_GLOBAL_COST_FILE);
  if (!cost) return;
  if (cost.alertedAtPercent != null) {
    delete cost.alertedAtPercent;
    await fs.writeFile(AXIOM_GLOBAL_COST_FILE, JSON.stringify(cost));
  }
}

async function handleBudgetCommand(chatId, userId, text) {
  const todayKey = new Date().toISOString().slice(0, 10);
  const cost = (await readJsonFile(AXIOM_GLOBAL_COST_FILE)) || { todayCostUsd: 0, costDayKey: '' };
  const spent = cost.costDayKey === todayKey ? Number(cost.todayCostUsd) || 0 : 0;
  const { cap, override } = await readEffectiveAllowance();

  // Strip the command word (handles `/budget`, `/budget@bot`, `/budget set 20`).
  const args = text.replace(/^\/budget(@\S+)?\s*/i, '').trim();
  const updatedBy = `telegram:${userId}`;

  // Status (no args).
  if (!args) {
    const pct = cap > 0 ? (spent / cap) * 100 : 0;
    const lines = [
      `💰 *AXIOM allowance — ${todayKey}*`,
      '',
      `Spent: *$${spent.toFixed(2)}* / $${cap.toFixed(2)} (${pct.toFixed(1)}%)`,
      `Remaining: $${Math.max(0, cap - spent).toFixed(2)}`,
      override
        ? `Override active: $${cap.toFixed(2)} (default $${AXIOM_DEFAULT_DAILY_USD}, set ${override.updatedAt || '?'})`
        : `Default cap: $${AXIOM_DEFAULT_DAILY_USD}`,
      '',
      'Commands:',
      '`/budget +5` — add $5 to today\'s cap',
      '`/budget set 20` — raise allowance to $20',
      '`/budget reset` — clear override',
      '',
      '_Membership-backed · figures are token-equivalent, not real billing._',
    ];
    await tg('sendMessage', { chat_id: chatId, text: lines.join('\n'), parse_mode: 'Markdown' });
    return;
  }

  // Reset.
  if (/^reset|clear|default$/i.test(args)) {
    await clearAllowanceOverride();
    await clearGlobalAlertFlag();
    await tg('sendMessage', {
      chat_id: chatId,
      text: `Allowance override cleared. Cap back to default *$${AXIOM_DEFAULT_DAILY_USD}*.`,
      parse_mode: 'Markdown',
    });
    return;
  }

  // Parse the new value.
  let newCap = null;
  const setMatch = args.match(/^set\s+\$?(\d+(?:\.\d+)?)$/i);
  const addMatch = args.match(/^\+\s*\$?(\d+(?:\.\d+)?)$/);
  const subMatch = args.match(/^-\s*\$?(\d+(?:\.\d+)?)$/);
  const numMatch = args.match(/^\$?(\d+(?:\.\d+)?)$/);
  if (setMatch) newCap = Number(setMatch[1]);
  else if (addMatch) newCap = cap + Number(addMatch[1]);
  else if (subMatch) newCap = cap - Number(subMatch[1]);
  else if (numMatch) newCap = Number(numMatch[1]);

  if (newCap == null || !isFinite(newCap)) {
    await tg('sendMessage', {
      chat_id: chatId,
      text: 'usage: `/budget`, `/budget +5`, `/budget set 20`, `/budget reset`',
      parse_mode: 'Markdown',
    });
    return;
  }
  if (newCap < 0.5) {
    await tg('sendMessage', { chat_id: chatId, text: 'minimum allowance is $0.50.' });
    return;
  }
  if (newCap > 500) {
    await tg('sendMessage', { chat_id: chatId, text: 'sanity-check: cap is limited to $500/day.' });
    return;
  }

  await writeAllowanceOverride(newCap, updatedBy);
  await clearGlobalAlertFlag();
  const pct = newCap > 0 ? (spent / newCap) * 100 : 0;
  await tg('sendMessage', {
    chat_id: chatId,
    text: [
      `✅ Allowance updated to *$${newCap.toFixed(2)}* (was $${cap.toFixed(2)}).`,
      `Spent today: $${spent.toFixed(2)} (${pct.toFixed(1)}%).`,
      'Agents resume immediately if they were paused.',
    ].join('\n'),
    parse_mode: 'Markdown',
  });
}

async function readMissionList() {
  try {
    const files = await fs.readdir(MISSION_DIR);
    const out = [];
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const raw = await fs.readFile(join(MISSION_DIR, f), 'utf8');
        out.push(JSON.parse(raw));
      } catch {}
    }
    out.sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''));
    return out;
  } catch {
    return [];
  }
}

async function writeMission(state) {
  await fs.mkdir(MISSION_DIR, { recursive: true });
  await fs.writeFile(join(MISSION_DIR, `${state.id}.json`), JSON.stringify(state, null, 2) + '\n', 'utf8');
}

async function dispatchMission(brief, chatId) {
  const id = `ax-${Math.random().toString(36).slice(2, 6)}${Math.random().toString(36).slice(2, 6)}`;
  const lastMessageFile = join(tmpdir(), `axiom-mission-${id}.txt`);
  const startedAt = new Date().toISOString();
  const state = { id, brief, status: 'running', startedAt, chatId, lastMessageFile };
  await writeMission(state);

  const args = [
    'exec',
    '--skip-git-repo-check',
    '--enable', 'goals',
    '-m', CODEX_MODEL,
    '--json',
    '-C', AXIOM_PROJECT_DIR,
    '--sandbox', 'workspace-write',
    '--output-last-message', lastMessageFile,
    `/goal ${brief}`,
  ];
  process.stdout.write(`[axiom-ceo-bot] dispatch ${id} → codex /goal\n`);

  const child = spawn(CODEX_BIN, args, {
    cwd: AXIOM_PROJECT_DIR,
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });
  let stdoutBuf = '';
  let stderrBuf = '';
  child.stdout.on('data', (d) => { stdoutBuf += d.toString('utf8'); if (stdoutBuf.length > 1_000_000) stdoutBuf = stdoutBuf.slice(-500_000); });
  child.stderr.on('data', (d) => { stderrBuf += d.toString('utf8'); if (stderrBuf.length > 200_000) stderrBuf = stderrBuf.slice(-100_000); });

  const killer = setTimeout(() => {
    process.stderr.write(`[axiom-ceo-bot] mission ${id} timed out, killing\n`);
    try { child.kill('SIGKILL'); } catch {}
  }, MISSION_TIMEOUT_MS);

  child.on('exit', async (code) => {
    clearTimeout(killer);
    let output = '';
    try { output = (await fs.readFile(lastMessageFile, 'utf8')).trim(); } catch {}
    if (!output) {
      // Fallback: scan stdout for last agent_message
      const lines = stdoutBuf.split('\n').map((l) => l.trim()).filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const parsed = JSON.parse(lines[i]);
          if (parsed?.item?.type === 'agent_message' && typeof parsed.item.text === 'string') {
            output = parsed.item.text;
            break;
          }
        } catch {}
      }
    }
    if (!output) output = stderrBuf.slice(-1500) || `(no output, exit code ${code})`;
    const endedAt = new Date().toISOString();
    const durationMs = Date.parse(endedAt) - Date.parse(startedAt);
    const final = { ...state, status: code === 0 ? 'done' : 'error', endedAt, durationMs, exitCode: code, output };
    await writeMission(final);
    try { await fs.unlink(lastMessageFile); } catch {}
    try {
      const header = code === 0
        ? `✅ mission ${id} · ${(durationMs / 1000).toFixed(0)}s`
        : `❌ mission ${id} failed · exit ${code}`;
      await sendChunked(chatId, `${header}\n\n${output}`);
    } catch (err) {
      process.stderr.write(`[axiom-ceo-bot] mission ${id} post-back failed: ${err.message}\n`);
    }
  });
  child.on('error', async (err) => {
    clearTimeout(killer);
    process.stderr.write(`[axiom-ceo-bot] mission ${id} spawn error: ${err.message}\n`);
    await writeMission({ ...state, status: 'error', endedAt: new Date().toISOString(), output: `spawn error: ${err.message}` });
    try { await tg('sendMessage', { chat_id: chatId, text: `❌ mission ${id} could not start: ${err.message}` }); } catch {}
  });

  return { id, startedAt };
}

async function withTyping(chatId, fn) {
  let cancelled = false;
  const beat = async () => {
    while (!cancelled) {
      try { await tg('sendChatAction', { chat_id: chatId, action: 'typing' }); } catch {}
      await new Promise((res) => setTimeout(res, TYPING_INTERVAL_MS));
    }
  };
  const beater = beat();
  try {
    return await fn();
  } finally {
    cancelled = true;
    await beater.catch(() => {});
  }
}

function isOperator(state, userId, chatId) {
  if (OPERATOR_ID && String(userId) === OPERATOR_ID) return true;
  if (state.pairedUserId && String(userId) === String(state.pairedUserId)) return true;
  if (state.pairedChatId && String(chatId) === String(state.pairedChatId)) return true;
  return false;
}

async function maybeAutoPair(state, userId, chatId) {
  // If neither an env operator nor a stored pair, claim the first incoming user.
  if (OPERATOR_ID) return false;
  if (state.pairedUserId) return false;
  state.pairedUserId = String(userId);
  state.pairedChatId = String(chatId);
  await writeState(state);
  return true;
}

async function handleMessage(state, msg) {
  const chatId = msg.chat?.id;
  const userId = msg.from?.id;
  const hasMedia = Boolean(msg.voice || msg.audio || msg.video_note);
  let text = String(msg.text || msg.caption || '').trim();
  if (!chatId || !userId || (!text && !hasMedia)) return;
  process.stdout.write(`[axiom-ceo-bot] msg from=${userId} chat=${chatId} ${hasMedia ? 'media' : 'text'} ${text ? text.slice(0, 80) : ''}\n`);

  if (msg.chat?.type !== 'private') {
    // Bot is paired 1:1 with the operator. Politely no-op in groups.
    return;
  }

  const newlyPaired = await maybeAutoPair(state, userId, chatId);
  if (!isOperator(state, userId, chatId)) {
    await tg('sendMessage', {
      chat_id: chatId,
      text: 'This bot is paired with another operator. Access denied.',
    });
    return;
  }

  let voicePreface = '';
  if (hasMedia) {
    try {
      const transcribed = await withTyping(chatId, () => transcribeMessageMedia(chatId, msg));
      if (transcribed) {
        const dur = typeof transcribed.durationS === 'number' ? ` ${transcribed.durationS}s` : '';
        voicePreface = `🎙️ transcript (${transcribed.kind}${dur}): ${transcribed.transcript}`;
        await tg('sendMessage', { chat_id: chatId, text: voicePreface, reply_to_message_id: msg.message_id });
        text = text ? `${transcribed.transcript}\n\n[caption]: ${text}` : transcribed.transcript;
      }
    } catch (err) {
      await tg('sendMessage', {
        chat_id: chatId,
        text: `transcription failed: ${String(err.message).slice(0, 400)}`,
        reply_to_message_id: msg.message_id,
      });
      return;
    }
    if (!text) return;
  }

  if (text === '/start' || text === '/help') {
    const lines = [
      '*AXIOM CEO — Ace, the Builder*',
      '',
      newlyPaired ? `Paired with you (chat ${chatId}).` : 'Connected.',
      '',
      'Talk to me like a chief: ask anything for a fast Claude reply, or hand me a real task and I will dispatch it to codex /goal autonomous mode in the background. I will DM you when the mission lands.',
      '',
      '*Status*',
      '`/status`    — CEO state + floor running/recent/error counts',
      '`/floor`     — per-manager (m1..m10) status snapshot',
      '`/autopilot` — autopilot status / on / off',
      '`/who`       — show pairing info',
      '`/missions`  — list recent codex missions',
      '',
      '*Allowance*',
      '`/budget`         — show today\'s spend, cap, remaining, override status',
      '`/budget +5`      — add $5 to today\'s cap',
      '`/budget set 20`  — raise allowance to $20',
      '`/budget reset`   — clear override, restore default',
      '_(I DM a 🚨 alert automatically when usage crosses 90%)_',
      '',
      '*Memory*',
      '`/memory`  — show what I remember (CEO\\_MEMORY.md)',
      '`/compact` — flush context to memory + reset session now',
      '`/forget`  — clear my memory file',
      '',
      '*Session*',
      '`/reset` — start a fresh CEO session (rare, destroys context)',
      '',
      '*Help*',
      '`/help` — show this list',
    ];
    await tg('sendMessage', { chat_id: chatId, text: lines.join('\n'), parse_mode: 'Markdown' });
    return;
  }

  if (text === '/memory') {
    const mem = await readMemoryFile();
    if (!mem) {
      await tg('sendMessage', { chat_id: chatId, text: 'CEO_MEMORY.md does not exist yet.' });
    } else {
      await sendChunked(chatId, `🧠 CEO_MEMORY.md\n\n${mem}`);
    }
    return;
  }

  if (text === '/compact') {
    await tg('sendMessage', { chat_id: chatId, text: '🧠 compacting now…' });
    await performCompaction(chatId);
    return;
  }

  if (text === '/forget') {
    try {
      await fs.writeFile(CEO_MEMORY_FILE, '# CEO Memory — Ace, the Builder\n\n_(cleared)_\n');
      await tg('sendMessage', { chat_id: chatId, text: '🧠 memory cleared. CEO_MEMORY.md reset to a blank state.' });
    } catch (err) {
      await tg('sendMessage', { chat_id: chatId, text: `forget error: ${err.message}` });
    }
    return;
  }

  if (text === '/who') {
    await tg('sendMessage', {
      chat_id: chatId,
      text: `paired user: ${state.pairedUserId || OPERATOR_ID || '(none)'}\npaired chat: ${state.pairedChatId || chatId}`,
    });
    return;
  }

  if (text === '/status') {
    try {
      const r = await fetch(new URL('/api/axiom/state', WATCH_URL).toString(), { cache: 'no-store' });
      const j = await r.json().catch(() => ({}));
      const ceo = j?.states?.['axiom-ceo'];
      const summary = j?.summary || {};
      const lines = [
        `floor: ${summary.running || 0} running · ${summary.recent || 0} recent · ${summary.error || 0} error`,
        ceo ? `ceo: ${ceo.status}${ceo.task ? ` — ${ceo.task}` : ''}` : 'ceo: idle',
      ];
      await tg('sendMessage', { chat_id: chatId, text: lines.join('\n') });
    } catch (err) {
      await tg('sendMessage', { chat_id: chatId, text: `status error: ${err.message}` });
    }
    return;
  }

  if (text === '/autopilot' || text.startsWith('/autopilot ')) {
    const PAUSE_FILE = process.env.WATCH_AXIOM_DRIVER_PAUSE_FILE || '/var/lib/watcher/axiom-autopilot.paused';
    const STATE_FILE = process.env.WATCH_AXIOM_DRIVER_STATE_FILE || '/var/lib/watcher/axiom-driver.state.json';
    const arg = text.replace(/^\/autopilot\s*/i, '').trim().toLowerCase();
    try {
      if (arg === 'on' || arg === 'start' || arg === 'resume') {
        try { await fs.unlink(PAUSE_FILE); } catch {}
        await tg('sendMessage', { chat_id: chatId, text: '🤖 autopilot ON — driver will start the next cycle within 30s.' });
        return;
      }
      if (arg === 'off' || arg === 'stop' || arg === 'pause') {
        await fs.writeFile(PAUSE_FILE, new Date().toISOString() + '\n', 'utf8');
        await tg('sendMessage', { chat_id: chatId, text: '🤖 autopilot OFF — current cycle finishes, then driver will idle until you say `/autopilot on`.', parse_mode: 'Markdown' });
        return;
      }
      // Default: show status
      let state = null;
      try { state = JSON.parse(await fs.readFile(STATE_FILE, 'utf8')); } catch {}
      let paused = false;
      try { await fs.access(PAUSE_FILE); paused = true; } catch {}
      const lines = [
        `🤖 *AXIOM autopilot*`,
        '',
        paused ? '*Status*: paused' : (state?.status ? `*Status*: ${state.status}` : '*Status*: unknown (driver may not be running)'),
        state?.interval ? `*Interval*: every ${Math.round(state.interval / 60000)} min` : '',
        state?.cycleNum != null ? `*Cycles run*: ${state.cycleNum}` : '',
        state?.lastCycleAt ? `*Last cycle*: ${state.lastCycleAt}` : '',
        state?.lastCycle ? `*Last result*: ${state.lastCycle.completed}/${state.lastCycle.dispatched} ok${state.lastCycle.failed ? `, ${state.lastCycle.failed} failed` : ''}` : '',
        '',
        'Commands:',
        '`/autopilot on`  — start the loop',
        '`/autopilot off` — pause the loop',
      ].filter(Boolean);
      await tg('sendMessage', { chat_id: chatId, text: lines.join('\n'), parse_mode: 'Markdown' });
    } catch (err) {
      await tg('sendMessage', { chat_id: chatId, text: `autopilot error: ${err.message}` });
    }
    return;
  }

  if (text === '/floor') {
    try {
      const r = await fetch(new URL('/api/axiom/state', WATCH_URL).toString(), { cache: 'no-store' });
      const j = await r.json().catch(() => ({}));
      const states = j?.states || {};
      const lines = ['*AXIOM floor — managers*', ''];
      for (let n = 1; n <= 10; n++) {
        const dept = AXIOM_DEPARTMENTS[n - 1] || 'unknown';
        const s = states[`axiom-mgr-${n}`];
        if (!s) {
          lines.push(`m${n} ${dept}: idle`);
          continue;
        }
        const icon = s.status === 'running' ? '🟢' : s.status === 'error' ? '🔴' : s.status === 'recent' ? '🟡' : '⚪';
        const task = s.task ? ` — ${String(s.task).slice(0, 60)}` : '';
        const dur = s.durationMs ? ` (${(s.durationMs / 1000).toFixed(0)}s)` : '';
        lines.push(`${icon} m${n} ${dept}: ${s.status}${dur}${task}`);
      }
      await tg('sendMessage', { chat_id: chatId, text: lines.join('\n'), parse_mode: 'Markdown' });
    } catch (err) {
      await tg('sendMessage', { chat_id: chatId, text: `floor error: ${err.message}` });
    }
    return;
  }

  if (text === '/reset') {
    try {
      await fs.unlink('/var/lib/watcher/axiom-mailbox/axiom:axiom-ceo.session').catch(() => {});
      await fs.unlink('/var/lib/watcher/axiom-mailbox/axiom:axiom-ceo.codex.session').catch(() => {});
      await tg('sendMessage', { chat_id: chatId, text: 'CEO session cleared. Next message starts fresh.' });
    } catch (err) {
      await tg('sendMessage', { chat_id: chatId, text: `reset error: ${err.message}` });
    }
    return;
  }

  if (text === '/budget' || text.startsWith('/budget ') || text.startsWith('/budget@')) {
    try {
      await handleBudgetCommand(chatId, userId, text);
    } catch (err) {
      await tg('sendMessage', { chat_id: chatId, text: `budget error: ${err.message}` });
    }
    return;
  }

  if (text === '/missions') {
    const missions = await readMissionList();
    if (!missions.length) {
      await tg('sendMessage', { chat_id: chatId, text: 'no missions yet.' });
      return;
    }
    const lines = ['recent missions:'];
    for (const m of missions.slice(0, 8)) {
      const dur = m.durationMs ? ` · ${(m.durationMs / 1000).toFixed(0)}s` : '';
      const briefShort = (m.brief || '').slice(0, 80);
      lines.push(`${m.id} · ${m.status}${dur} — ${briefShort}`);
    }
    await tg('sendMessage', { chat_id: chatId, text: lines.join('\n') });
    return;
  }

  // Operator turn enters the orchestration loop. Each round either:
  //   - finalises (no DELEGATE/DISPATCH/REPORT_FILE tag)            → reply to operator
  //   - delegates to managers                                       → fan out, feed reports back, loop
  //   - dispatches one codex /goal mission                          → background, ack to operator
  //   - emits a report file                                         → attach to operator chat
  // Cap at MAX_DELEGATION_ROUNDS to prevent runaway.
  let nextInput = text;
  let lastResult = null;
  for (let round = 0; round < MAX_DELEGATION_ROUNDS + 1; round++) {
    const result = await withTyping(chatId, () => callCeo(nextInput));
    lastResult = result;

    if (typeof result.inputTokens === 'number') {
      lastSeenInputTokens = result.inputTokens;
      process.stdout.write(`[axiom-ceo-bot] tokens in=${result.inputTokens} out=${result.outputTokens || '?'} cost=$${(result.costUsd || 0).toFixed(4)}\n`);
    }

    const delegateParse = parseDelegate(result.reply || '');
    const dispatchParse = parseDispatch(delegateParse.cleaned);
    const reportParse = parseReportFile(dispatchParse.cleaned);
    const cleaned = reportParse.cleaned;

    const engineTag = result.ok && result.engine
      ? `\n\n— ${result.engine}/${result.model || '?'}${typeof result.durationMs === 'number' ? ` · ${(result.durationMs / 1000).toFixed(1)}s` : ''}${
          typeof result.inputTokens === 'number' ? ` · ${result.inputTokens} tok` : ''
        }`
      : '';

    // Round-trip: CEO chose to delegate. Post the chat preface (so operator
    // sees the plan), fan out, then loop back into the CEO with the reports.
    if (delegateParse.delegation && result.ok && round < MAX_DELEGATION_ROUNDS) {
      const preface = (cleaned || `On it — round ${round + 1}.`) + engineTag;
      await sendChunked(chatId, preface, round === 0 ? msg.message_id : undefined);
      const { results } = await delegateToManagers(
        delegateParse.delegation.managers,
        delegateParse.delegation.brief,
        chatId,
      );
      nextInput = buildManagerReportPayload(results);
      continue; // re-invoke CEO with reports
    }

    // CEO emitted a delegation but we've already hit the cap — force-finalise.
    if (delegateParse.delegation && round >= MAX_DELEGATION_ROUNDS) {
      await sendChunked(
        chatId,
        `${cleaned || '(empty)'}\n\n⚠️ delegation cap (${MAX_DELEGATION_ROUNDS}) reached — finalised here. Send a new directive to keep going.${engineTag}`,
        round === 0 ? msg.message_id : undefined,
      );
      break;
    }

    // Single codex /goal handoff (legacy path — for one-shot work outside any manager's domain).
    if (dispatchParse.brief && result.ok) {
      let mission;
      try {
        mission = await dispatchMission(dispatchParse.brief, chatId);
      } catch (err) {
        await sendChunked(chatId, `${cleaned || '(empty)'}\n\n❌ dispatch failed: ${err.message}` + engineTag, round === 0 ? msg.message_id : undefined);
        break;
      }
      const dispatchNote = `\n\n🚀 codex /goal · mission ${mission.id} dispatched — I'll DM the result back.`;
      await sendChunked(chatId, (cleaned || 'On it.') + dispatchNote + engineTag, round === 0 ? msg.message_id : undefined);
      break;
    }

    if (reportParse.reportPath && result.ok) {
      const caption = (cleaned || '(see attached)') + engineTag;
      await sendReportDocument(chatId, reportParse.reportPath, caption);
      break;
    }

    // Final operator-facing reply.
    await sendChunked(chatId, (cleaned || '(empty)') + engineTag, round === 0 ? msg.message_id : undefined);
    break;
  }

  if (
    lastResult &&
    !compactionInFlight &&
    typeof lastResult.inputTokens === 'number' &&
    lastResult.inputTokens >= CONTEXT_COMPACT_THRESHOLD
  ) {
    process.stdout.write(`[axiom-ceo-bot] context ${lastResult.inputTokens} >= ${CONTEXT_COMPACT_THRESHOLD}, auto-compacting\n`);
    performCompaction(chatId).catch((err) => {
      process.stderr.write(`[axiom-ceo-bot] auto-compact: ${err.message}\n`);
    });
  }
}

async function bootstrap() {
  // Set bot identity (idempotent — Telegram silently no-ops on duplicates).
  try {
    await tg('setMyCommands', {
      commands: [
        { command: 'start',    description: 'Pair with the CEO' },
        { command: 'help',     description: 'Show all commands' },
        { command: 'status',   description: 'Show CEO and floor status' },
        { command: 'floor',    description: 'Per-manager (m1..m10) status' },
        { command: 'autopilot',description: 'Autopilot status / on / off' },
        { command: 'budget',   description: 'View / change daily allowance' },
        { command: 'missions', description: 'List recent codex missions' },
        { command: 'memory',   description: 'Show CEO_MEMORY.md' },
        { command: 'compact',  description: 'Flush context to memory + reset session' },
        { command: 'forget',   description: 'Clear CEO memory file' },
        { command: 'who',      description: 'Show pairing info' },
        { command: 'reset',    description: 'Start a fresh CEO session' },
      ],
    });
  } catch (err) {
    process.stderr.write(`[axiom-ceo-bot] setMyCommands warning: ${err.message}\n`);
  }
  try {
    await tg('setMyDescription', {
      description: 'Direct line to the CEO of the AXIOM Office — orchestrator of 51 AI agents on one operations floor.',
    });
  } catch {}
  try {
    await tg('setMyShortDescription', {
      short_description: 'CEO of the AXIOM Office. Reports, plans, dispatches.',
    });
  } catch {}
}

async function loop() {
  const state = await readState();
  let offset = Number(state.offset || 0);

  process.stdout.write(`[axiom-ceo-bot] online — paired=${state.pairedUserId || OPERATOR_ID || '(awaiting pair)'} watch=${WATCH_URL}\n`);

  while (true) {
    let updates = [];
    try {
      updates = await tg('getUpdates', {
        offset: offset + 1,
        timeout: POLL_TIMEOUT_S,
        allowed_updates: ['message'],
      });
    } catch (err) {
      process.stderr.write(`[axiom-ceo-bot] getUpdates: ${err.message}\n`);
      await new Promise((res) => setTimeout(res, 5_000));
      continue;
    }

    for (const update of updates) {
      offset = Math.max(offset, update.update_id);
      try {
        if (update.message) await handleMessage(state, update.message);
      } catch (err) {
        process.stderr.write(`[axiom-ceo-bot] handle: ${err.message}\n`);
        try {
          if (update.message?.chat?.id) {
            await tg('sendMessage', {
              chat_id: update.message.chat.id,
              text: `bot error: ${String(err.message).slice(0, 400)}`,
            });
          }
        } catch {}
      }
    }

    if (updates.length) {
      state.offset = offset;
      await writeState(state).catch((err) => {
        process.stderr.write(`[axiom-ceo-bot] state write: ${err.message}\n`);
      });
    }
  }
}

await bootstrap();
// Warm the whisper sidecar so the first voice message is fast.
try { spawnWhisperSidecar(); } catch (err) { process.stderr.write(`[axiom-ceo-bot] whisper warmup: ${err.message}\n`); }
await loop();
