#!/usr/bin/env node
// AXIOM autopilot — periodically pings each manager (m1..m10) to advance their
// department goal by one concrete step. Runs forever. Skips a manager if it's
// already running. Hard-stops the cycle if today's spend is >= cap. Honours a
// pause flag file so the operator can halt from Telegram without restarting.
//
// Cadence: every WATCH_AXIOM_DRIVER_INTERVAL_MS (default 15 min). Each cycle
// fans out to all available managers in parallel and awaits all replies.
//
// State file: /var/lib/watcher/axiom-driver.state.json — tracks cycle count,
// last-cycle-at, current status (running/paused/cap-reached/idle).
//
// Pause file: /var/lib/watcher/axiom-autopilot.paused — touch to pause; rm to
// resume. The bot's /autopilot command does this for you.

import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const WATCH_URL = process.env.WATCH_URL || 'http://127.0.0.1:3012';
const WATCH_AUTH = (process.env.WATCH_API_KEY || process.env.WATCH_PASSWORD || '').trim();
const INTERVAL_MS = Number(process.env.WATCH_AXIOM_DRIVER_INTERVAL_MS || 15 * 60 * 1000);
const MIN_INTERVAL_MS = 60 * 1000;
const MAILBOX_DIR = process.env.WATCH_AXIOM_MAILBOX_DIR || '/var/lib/watcher/axiom-mailbox';
const PAUSE_FILE = process.env.WATCH_AXIOM_DRIVER_PAUSE_FILE || '/var/lib/watcher/axiom-autopilot.paused';
const STATE_FILE = process.env.WATCH_AXIOM_DRIVER_STATE_FILE || '/var/lib/watcher/axiom-driver.state.json';
const COST_FILE = join(MAILBOX_DIR, 'axiom-global.cost.json');
const ALLOWANCE_FILE = join(MAILBOX_DIR, 'axiom-allowance.json');
const DEFAULT_DAILY_USD = Number(process.env.WATCH_AXIOM_MAX_DAILY_USD || 10);
const CAP_HEADROOM_PCT = Number(process.env.WATCH_AXIOM_DRIVER_CAP_HEADROOM_PCT || 90);
const TG_TOKEN = (process.env.WATCH_AXIOM_CEO_BOT_TOKEN || '').trim();
const TG_CHAT_ID = (process.env.WATCH_AXIOM_CEO_OPERATOR_ID || '').trim();
const PROJECT_DIR = process.env.WATCH_AXIOM_PROJECT_DIR || '/opt/axiom';

const DEFAULT_DEPARTMENTS = ['Foundation', 'Governance', 'Reliability', 'Substrate', 'Flight Ops', 'Crew', 'Engineering', 'Safety', 'Commercial', 'ATC / IQ'];
const _envDepts = (process.env.NEXT_PUBLIC_AXIOM_DEPARTMENTS || '').split(',').map((s) => s.trim()).filter(Boolean);
const DEPARTMENTS = _envDepts.length === 10 ? _envDepts : DEFAULT_DEPARTMENTS;

const interval = Math.max(MIN_INTERVAL_MS, INTERVAL_MS);

async function readJson(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return null; }
}

async function writeState(state) {
  try { await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2) + '\n', 'utf8'); } catch {}
}

async function readEffectiveCap() {
  const override = await readJson(ALLOWANCE_FILE);
  if (override && typeof override.dailyUsdOverride === 'number' && override.dailyUsdOverride > 0) return override.dailyUsdOverride;
  return DEFAULT_DAILY_USD;
}

async function readSpendToday() {
  const c = await readJson(COST_FILE);
  if (!c) return 0;
  const today = new Date().toISOString().slice(0, 10);
  if (c.costDayKey === today) return Number(c.todayCostUsd) || 0;
  return 0;
}

async function isManagerRunning(team) {
  const f = join(MAILBOX_DIR, `axiom:axiom-mgr-${team}.state.json`);
  const s = await readJson(f);
  return s?.status === 'running';
}

async function tg(method, body) {
  if (!TG_TOKEN || !TG_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT_ID, ...body }),
    });
  } catch (err) {
    process.stderr.write(`[axiom-driver] tg.${method} failed: ${err.message}\n`);
  }
}

function buildBrief(team) {
  const dept = DEPARTMENTS[team - 1] || 'unknown';
  return [
    `[AXIOM AUTOPILOT — round driven by the operator's autopilot, not a CEO chat turn.]`,
    `You are the ${dept} manager (m${team}, team ${team}).`,
    ``,
    `Read these in this order:`,
    `1. ${PROJECT_DIR}/departments/D${team}_GOAL.md — your binding goal`,
    `2. ${PROJECT_DIR}/AXIOM_MASTERPLAN.md and ${PROJECT_DIR}/AXIOM_TECHSTACK.md — full Phase 0 spec`,
    `3. Anything you've already shipped under ${PROJECT_DIR}/ for your domain`,
    ``,
    `Then do EXACTLY ONE concrete unfinished Phase 0 step for your department. Pick the one that unblocks the most downstream teams. Ship real artifacts on disk — schema, code, contract, test, ETL, whatever your domain demands. No plans, no markdown reports unless the artifact itself is a spec.`,
    ``,
    `When done, reply with: (1) what you built/wrote in 1-3 lines, (2) exact file paths created or modified, (3) what is now the next blocker for your D${team} goal so the next round can pick up.`,
    ``,
    `Reply ends with a signed status: "m${team} ${dept}: <one-line summary>"`,
  ].join('\n');
}

async function callManager(team) {
  const url = new URL('/api/team-office/instruct', WATCH_URL).toString();
  const headers = { 'Content-Type': 'application/json' };
  if (WATCH_AUTH) headers.Authorization = `Bearer ${WATCH_AUTH}`;
  const body = JSON.stringify({
    agentId: 'claude-code',
    sessionKey: `axiom:axiom-mgr-${team}`,
    groupId: 'axiom',
    message: buildBrief(team),
  });
  const t0 = Date.now();
  try {
    const r = await fetch(url, { method: 'POST', headers, body });
    const j = await r.json().catch(() => ({}));
    const dur = Math.round((Date.now() - t0) / 1000);
    const reply = String(j?.reply || '');
    const ok = r.ok && reply && !reply.startsWith('(empty');
    return { team, ok, dur, reply: reply.slice(0, 200), engine: j?.engine };
  } catch (err) {
    return { team, ok: false, dur: Math.round((Date.now() - t0) / 1000), reply: `(fetch failed: ${err.message})` };
  }
}

async function runCycle(cycleNum) {
  const startedAt = new Date().toISOString();
  const targets = [];
  for (let n = 1; n <= 10; n++) {
    if (await isManagerRunning(n)) {
      process.stdout.write(`[axiom-driver] cycle=${cycleNum} skip m${n} (already running)\n`);
      continue;
    }
    targets.push(n);
  }
  if (!targets.length) {
    return { startedAt, cycleNum, dispatched: 0, completed: 0, skipped: 10 };
  }
  process.stdout.write(`[axiom-driver] cycle=${cycleNum} dispatching m${targets.join(',m')} (${targets.length} managers)\n`);
  const results = await Promise.all(targets.map(callManager));
  const ok = results.filter((r) => r.ok).length;
  const fail = results.length - ok;
  process.stdout.write(`[axiom-driver] cycle=${cycleNum} done: ${ok} ok, ${fail} failed in ${Math.round((Date.now() - Date.parse(startedAt)) / 1000)}s\n`);
  return { startedAt, cycleNum, dispatched: targets.length, completed: ok, failed: fail, skipped: 10 - targets.length, results };
}

async function summarizeCycle(cycle) {
  const lines = [`🤖 *Autopilot cycle ${cycle.cycleNum}* — ${cycle.completed}/${cycle.dispatched} ok${cycle.failed ? `, ${cycle.failed} failed` : ''}${cycle.skipped ? `, ${cycle.skipped} skipped` : ''}`];
  for (const r of cycle.results || []) {
    const dept = DEPARTMENTS[r.team - 1] || '';
    const icon = r.ok ? '✅' : '❌';
    lines.push(`${icon} m${r.team} ${dept} (${r.dur}s) — ${r.reply.replace(/\s+/g, ' ').slice(0, 110)}`);
  }
  await tg('sendMessage', { text: lines.join('\n').slice(0, 4000), parse_mode: 'Markdown' });
}

async function loop() {
  let cycleNum = 0;
  process.stdout.write(`[axiom-driver] online — interval=${Math.round(interval / 1000)}s pause-file=${PAUSE_FILE}\n`);
  await writeState({ status: 'idle', startedAt: new Date().toISOString(), interval, lastCycleAt: null, cycleNum });

  // Initial wait so we don't hammer immediately on restart.
  await new Promise((r) => setTimeout(r, Math.min(30_000, interval)));

  while (true) {
    if (existsSync(PAUSE_FILE)) {
      await writeState({ status: 'paused', pausedAt: new Date().toISOString(), interval, cycleNum });
      await new Promise((r) => setTimeout(r, 30_000));
      continue;
    }
    const cap = await readEffectiveCap();
    const spend = await readSpendToday();
    const budgetPct = cap > 0 ? (spend / cap) * 100 : 100;
    if (budgetPct >= CAP_HEADROOM_PCT) {
      process.stdout.write(`[axiom-driver] cap-reached: $${spend.toFixed(2)}/$${cap.toFixed(2)} (${budgetPct.toFixed(0)}%) — sleeping\n`);
      await writeState({ status: 'cap-reached', spend, cap, budgetPct, interval, cycleNum, lastCycleAt: new Date().toISOString() });
      await new Promise((r) => setTimeout(r, 5 * 60 * 1000));
      continue;
    }

    cycleNum += 1;
    await writeState({ status: 'running', cycleNum, interval, startedAt: new Date().toISOString() });
    let cycle;
    try {
      cycle = await runCycle(cycleNum);
    } catch (err) {
      process.stderr.write(`[axiom-driver] cycle ${cycleNum} threw: ${err.message}\n`);
      await tg('sendMessage', { text: `🤖 autopilot cycle ${cycleNum} errored: ${String(err.message).slice(0, 300)}` });
      await new Promise((r) => setTimeout(r, interval));
      continue;
    }
    await writeState({ status: 'idle', cycleNum, interval, lastCycleAt: cycle.startedAt, lastCycle: cycle });
    summarizeCycle(cycle).catch((err) => process.stderr.write(`[axiom-driver] summarize: ${err.message}\n`));
    await new Promise((r) => setTimeout(r, interval));
  }
}

loop().catch((err) => {
  process.stderr.write(`[axiom-driver] fatal: ${err.stack || err.message}\n`);
  process.exit(1);
});
