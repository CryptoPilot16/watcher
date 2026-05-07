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
import { dirname } from 'node:path';

const TOKEN = process.env.WATCH_AXIOM_CEO_BOT_TOKEN || '';
const WATCH_URL = process.env.WATCH_URL || 'http://127.0.0.1:3012';
const STATE_FILE = process.env.WATCH_AXIOM_CEO_STATE_FILE || '/var/lib/watcher/axiom-ceo-bot-state.json';
const OPERATOR_ID = (process.env.WATCH_AXIOM_CEO_OPERATOR_ID || '').trim();
const POLL_TIMEOUT_S = Number(process.env.WATCH_AXIOM_CEO_POLL_TIMEOUT_S || 50);
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
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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
  const text = String(msg.text || '').trim();
  if (!chatId || !userId || !text) return;

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

  if (text === '/start' || text === '/help') {
    const lines = [
      'AXIOM CEO — IAN, the Builder.',
      '',
      newlyPaired ? `Paired with you (chat ${chatId}).` : 'Connected.',
      '',
      'Send me anything and I will execute it as the CEO of the AXIOM operations floor.',
      'Commands:',
      '  /status — show recent CEO mailbox',
      '  /who    — show pairing info',
      '  /reset  — start a fresh CEO session (rare, destroys context)',
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

  const result = await withTyping(chatId, () => callCeo(text));
  const tag = result.ok && result.engine
    ? `\n\n— ${result.engine}/${result.model || '?'}${typeof result.durationMs === 'number' ? ` · ${(result.durationMs / 1000).toFixed(1)}s` : ''}`
    : '';
  await sendChunked(chatId, (result.reply || '(empty)') + tag, msg.message_id);
}

async function bootstrap() {
  // Set bot identity (idempotent — Telegram silently no-ops on duplicates).
  try {
    await tg('setMyCommands', {
      commands: [
        { command: 'start',  description: 'Pair with the CEO' },
        { command: 'status', description: 'Show CEO and floor status' },
        { command: 'who',    description: 'Show pairing info' },
        { command: 'reset',  description: 'Start a fresh CEO session' },
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
await loop();
