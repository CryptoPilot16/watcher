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

async function callCeo(message) {
  const url = new URL('/api/team-office/instruct', WATCH_URL).toString();
  const headers = { 'Content-Type': 'application/json' };
  if (WATCH_AUTH) headers.Authorization = `Bearer ${WATCH_AUTH}`;
  const r = await fetch(url, {
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
  return { ok: true, reply: String(json.reply || '(empty reply)'), engine: json.engine, model: json.model, durationMs: json.durationMs };
}

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

function parseDispatch(reply) {
  if (!reply) return { cleaned: '', brief: null };
  const match = DISPATCH_RE.exec(reply);
  if (!match) return { cleaned: reply.trim(), brief: null };
  const brief = match[1].trim().replace(/\s+/g, ' ').slice(0, 1500);
  const cleaned = reply.replace(DISPATCH_RE, '').trim();
  return { cleaned, brief };
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
      'AXIOM CEO — Ace, the Builder.',
      '',
      newlyPaired ? `Paired with you (chat ${chatId}).` : 'Connected.',
      '',
      'Talk to me like a chief: ask anything for a fast Claude reply, or hand me a real task and I will dispatch it to codex /goal autonomous mode in the background. I will DM you when the mission lands.',
      'Commands:',
      '  /status   — show CEO + active missions',
      '  /missions — list recent missions',
      '  /who      — show pairing info',
      '  /reset    — start a fresh CEO session (rare, destroys context)',
    ];
    await tg('sendMessage', { chat_id: chatId, text: lines.join('\n') });
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

  const result = await withTyping(chatId, () => callCeo(text));
  const { cleaned, brief } = parseDispatch(result.reply || '');
  const engineTag = result.ok && result.engine
    ? `\n\n— ${result.engine}/${result.model || '?'}${typeof result.durationMs === 'number' ? ` · ${(result.durationMs / 1000).toFixed(1)}s` : ''}`
    : '';

  if (brief && result.ok) {
    let mission;
    try {
      mission = await dispatchMission(brief, chatId);
    } catch (err) {
      await sendChunked(chatId, `${cleaned || '(empty)'}\n\n❌ dispatch failed: ${err.message}` + engineTag, msg.message_id);
      return;
    }
    const dispatchNote = `\n\n🚀 codex /goal · mission ${mission.id} dispatched — I'll DM the result back.`;
    await sendChunked(chatId, (cleaned || 'On it.') + dispatchNote + engineTag, msg.message_id);
    return;
  }

  await sendChunked(chatId, (cleaned || '(empty)') + engineTag, msg.message_id);
}

async function bootstrap() {
  // Set bot identity (idempotent — Telegram silently no-ops on duplicates).
  try {
    await tg('setMyCommands', {
      commands: [
        { command: 'start',    description: 'Pair with the CEO' },
        { command: 'status',   description: 'Show CEO and floor status' },
        { command: 'missions', description: 'List recent codex missions' },
        { command: 'who',      description: 'Show pairing info' },
        { command: 'reset',    description: 'Start a fresh CEO session' },
      ],
    });
  } catch (err) {
    process.stderr.write(`[axiom-ceo-bot] setMyCommands warning: ${err.message}\n`);
  }
  try {
    await tg('setMyDescription', {
      description: 'Direct line to IAN, the CEO of the AXIOM Office — orchestrator of 51 AI agents on one operations floor.',
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
