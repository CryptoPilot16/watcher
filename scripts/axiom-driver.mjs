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
// Default: back-to-back cycles (10s breather between cycles to avoid pinning
// the Anthropic API on retries and to let the budget snapshot file settle).
// The real throttle is the daily budget cap — autopilot pauses at 90%.
const INTERVAL_MS = Number(process.env.WATCH_AXIOM_DRIVER_INTERVAL_MS || 10 * 1000);
const MIN_INTERVAL_MS = 5 * 1000;
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

function buildManagerBrief(team) {
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
    `Then do EXACTLY ONE concrete unfinished Phase 0 step for your department. Pick STRATEGIC scoping work — schemas, contracts, validators, specs, gating logic — and leave the implementation grunt-work for your 4 coders to pick up in the same cycle. Ship real artifacts on disk.`,
    ``,
    `When done, reply with: (1) what you built/wrote in 1-3 lines, (2) exact file paths created or modified, (3) what is now the next blocker for your D${team} goal so the next round can pick up.`,
    ``,
    `Reply ends with a signed status: "m${team} ${dept}: <one-line summary>"`,
  ].join('\n');
}

function buildCoderBrief(team, coderIndex) {
  const dept = DEPARTMENTS[team - 1] || 'unknown';
  // c4 is the team's QA/reviewer — audits what the rest of the team just
  // shipped, runs tests, finds gaps, fixes bugs, adds missing coverage.
  // c1-c3 are forward-builders.
  if (coderIndex === 4) {
    return [
      `[AXIOM AUTOPILOT — round driven by the operator's autopilot.]`,
      `You are coder c4 on the ${dept} team (m${team}, team ${team}). YOU ARE THE TEAM'S QA / REVIEWER, not a forward-builder.`,
      ``,
      `Your job is to harden what your teammates (manager m${team} + coders c1, c2, c3) just shipped. Do NOT write new contracts or new features — that's their lane. You are the audit + test + fix lane.`,
      ``,
      `Workflow each round:`,
      `1. Look at recent file changes in your team's path namespace under ${PROJECT_DIR}/. Use Glob/find with mtime to see what was modified in the last hour.`,
      `2. Read those files critically. For each, ask:`,
      `   - Does it actually work (run validators, run tests, parse the schema, lint the proto)?`,
      `   - Is there missing test coverage (failure cases, edge cases, fixtures for invalid input)?`,
      `   - Are the references and imports consistent (does the AsyncAPI ref a schema that exists? do Cedar policies match the schema?)?`,
      `   - Does the file's own claim (e.g. "validates X") actually hold?`,
      `3. Pick the SINGLE most impactful gap or bug and FIX IT. That might be:`,
      `   - Adding a fail-case fixture + a validator that proves the validator catches it`,
      `   - Wiring a CI check (npm test / cargo test) that exercises a contract`,
      `   - Patching a typo / wrong type / missing field that breaks a schema reference`,
      `   - Writing a regression test for a bug you found`,
      `4. If everything passes and there are no gaps, THEN write a new property-based test or fuzz fixture that pushes the existing artifacts harder.`,
      ``,
      `Bias toward DELETING bad code, FIXING wrong code, and ADDING failing-then-passing tests. You are the bullshit detector for your team.`,
      ``,
      `When done, reply with: (1) what you audited (file paths), (2) what you fixed or added (exact paths), (3) one issue you noticed but didn't fix this round (so the next round can pick it up).`,
      ``,
      `Reply ends with a signed status: "c4/m${team} ${dept} (QA): <one-line summary>"`,
    ].join('\n');
  }
  // Forward-builders (c1, c2, c3)
  return [
    `[AXIOM AUTOPILOT — round driven by the operator's autopilot.]`,
    `You are coder c${coderIndex} on the ${dept} team (m${team}, team ${team}).`,
    ``,
    `Read these in this order:`,
    `1. ${PROJECT_DIR}/departments/D${team}_GOAL.md — your team's binding goal`,
    `2. ${PROJECT_DIR}/AXIOM_MASTERPLAN.md and ${PROJECT_DIR}/AXIOM_TECHSTACK.md`,
    `3. Anything your team has already shipped under ${PROJECT_DIR}/ — focus especially on whatever your manager scaffolded most recently (look at file mtimes)`,
    ``,
    `Then do ONE concrete IMPLEMENTATION step in your team's domain. You are the hands, not the brain — write code, tests, fixtures, ETL, migration, integration glue, fakes, validators that exercise your manager's contracts. Don't redo what the manager just did; build ON TOP of it.`,
    ``,
    `Pick something OTHER coders on your team are unlikely to also pick this round (different file, different feature, different layer). Your role hint: c${coderIndex}=${coderIndex === 1 ? 'tests' : coderIndex === 2 ? 'integration glue' : 'fixtures/seeds'}. (c4 is your team's QA reviewer — they will audit your work next round, so write code that's actually correct.)`,
    ``,
    `When done, reply with: (1) what you built/wrote in 1-2 lines, (2) exact file paths created or modified.`,
    ``,
    `Reply ends with a signed status: "c${coderIndex}/m${team} ${dept}: <one-line summary>"`,
  ].join('\n');
}

async function callAgent(sessionKey, message) {
  const url = new URL('/api/team-office/instruct', WATCH_URL).toString();
  const headers = { 'Content-Type': 'application/json' };
  if (WATCH_AUTH) headers.Authorization = `Bearer ${WATCH_AUTH}`;
  const body = JSON.stringify({ agentId: 'claude-code', sessionKey, groupId: 'axiom', message });
  const t0 = Date.now();
  try {
    const r = await fetch(url, { method: 'POST', headers, body });
    const j = await r.json().catch(() => ({}));
    const dur = Math.round((Date.now() - t0) / 1000);
    const reply = String(j?.reply || '');
    const ok = r.ok && reply && !reply.startsWith('(empty');
    return { ok, dur, reply: reply.slice(0, 200), engine: j?.engine };
  } catch (err) {
    return { ok: false, dur: Math.round((Date.now() - t0) / 1000), reply: `(fetch failed: ${err.message})` };
  }
}

async function isAgentRunning(sessionKey) {
  const safe = sessionKey.replace(/[^a-z0-9_.\-:]/gi, '_').slice(0, 200) || 'unknown';
  const f = join(MAILBOX_DIR, `${safe}.state.json`);
  const s = await readJson(f);
  return s?.status === 'running';
}

async function callManager(team) {
  const r = await callAgent(`axiom:axiom-mgr-${team}`, buildManagerBrief(team));
  return { ...r, role: 'manager', team, coderIndex: null };
}

async function callCoder(team, coderIndex) {
  const r = await callAgent(`axiom:axiom-coder-${team}-${coderIndex}`, buildCoderBrief(team, coderIndex));
  return { ...r, role: 'coder', team, coderIndex };
}

async function runCycle(cycleNum) {
  const startedAt = new Date().toISOString();
  const tasks = [];
  let skipped = 0;
  // Stagger dispatches by ~150ms each so progress bars visibly diverge in the
  // 3D office (without staggering, all 50 agents start in the same instant
  // and their progress fractions stay clustered, making the bars look
  // identical). Net effect on cycle wall-time is negligible (~7.5s spread
  // across 50 agents vs ~5 min slowest).
  const STAGGER_MS = 150;
  let stagger = 0;
  const enqueue = (call) => {
    const delay = stagger;
    stagger += STAGGER_MS;
    tasks.push(new Promise((r) => setTimeout(() => r(call()), delay)));
  };
  // Interleave managers and their coders so each cubicle lights up roughly
  // together rather than all 10 managers first then all 40 coders.
  for (let n = 1; n <= 10; n++) {
    if (await isAgentRunning(`axiom:axiom-mgr-${n}`)) {
      process.stdout.write(`[axiom-driver] cycle=${cycleNum} skip m${n} (already running)\n`);
      skipped++;
    } else {
      enqueue(() => callManager(n));
    }
    for (let c = 1; c <= 4; c++) {
      if (await isAgentRunning(`axiom:axiom-coder-${n}-${c}`)) {
        process.stdout.write(`[axiom-driver] cycle=${cycleNum} skip c${c}/m${n} (already running)\n`);
        skipped++;
        continue;
      }
      enqueue(() => callCoder(n, c));
    }
  }
  if (!tasks.length) {
    return { startedAt, cycleNum, dispatched: 0, completed: 0, skipped };
  }
  const dispatched = tasks.length;
  process.stdout.write(`[axiom-driver] cycle=${cycleNum} dispatching ${dispatched} agents (${dispatched - (40 - skipped)} managers + ${dispatched - (10 - Math.min(10, skipped))} coders, approx)\n`);
  const results = await Promise.all(tasks);
  const ok = results.filter((r) => r.ok).length;
  const fail = results.length - ok;
  const mgrOk = results.filter((r) => r.role === 'manager' && r.ok).length;
  const codOk = results.filter((r) => r.role === 'coder' && r.ok).length;
  process.stdout.write(`[axiom-driver] cycle=${cycleNum} done: ${ok}/${dispatched} ok (${mgrOk} mgr, ${codOk} cod), ${fail} failed in ${Math.round((Date.now() - Date.parse(startedAt)) / 1000)}s\n`);
  return { startedAt, cycleNum, dispatched, completed: ok, failed: fail, skipped, results };
}

async function summarizeCycle(cycle) {
  const lines = [`🤖 *Autopilot cycle ${cycle.cycleNum}* — ${cycle.completed}/${cycle.dispatched} ok${cycle.failed ? `, ${cycle.failed} failed` : ''}${cycle.skipped ? `, ${cycle.skipped} skipped` : ''}`];
  // Managers first, then coders, both grouped by team for readability.
  const mgrs = (cycle.results || []).filter((r) => r.role === 'manager').sort((a, b) => a.team - b.team);
  const cods = (cycle.results || []).filter((r) => r.role === 'coder').sort((a, b) => a.team - b.team || a.coderIndex - b.coderIndex);
  if (mgrs.length) {
    lines.push('', '*Managers*');
    for (const r of mgrs) {
      const dept = DEPARTMENTS[r.team - 1] || '';
      lines.push(`${r.ok ? '✅' : '❌'} m${r.team} ${dept} (${r.dur}s) — ${r.reply.replace(/\s+/g, ' ').slice(0, 90)}`);
    }
  }
  if (cods.length) {
    lines.push('', `*Coders* (${cods.filter((c) => c.ok).length}/${cods.length} ok)`);
    // For coders, condense to one line per team showing how many delivered.
    const byTeam = new Map();
    for (const r of cods) {
      if (!byTeam.has(r.team)) byTeam.set(r.team, []);
      byTeam.get(r.team).push(r);
    }
    for (const [team, list] of [...byTeam.entries()].sort((a, b) => a[0] - b[0])) {
      const dept = DEPARTMENTS[team - 1] || '';
      const okCount = list.filter((r) => r.ok).length;
      lines.push(`m${team} ${dept}: ${okCount}/${list.length} coders shipped`);
    }
  }
  await tg('sendMessage', { text: lines.join('\n').slice(0, 4000), parse_mode: 'Markdown' });
}

async function loop() {
  let cycleNum = 0;
  process.stdout.write(`[axiom-driver] online — interval=${Math.round(interval / 1000)}s pause-file=${PAUSE_FILE}\n`);
  await writeState({ status: 'idle', startedAt: new Date().toISOString(), interval, lastCycleAt: null, cycleNum });

  // Tiny initial wait so the first cycle doesn't fire mid-startup if pm2 is
  // restarting the watcher web at the same moment.
  await new Promise((r) => setTimeout(r, 5_000));

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
