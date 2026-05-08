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

function buildManagerBrief(team, roadmapHint) {
  const dept = DEPARTMENTS[team - 1] || 'unknown';
  // Compressed brief — same instructions, fewer tokens. The full system
  // prompt is appended separately and already covers role context.
  const remainingLine = roadmapHint
    ? roadmapHint.remaining.length > 0
      ? `Remaining (${roadmapHint.built}/${roadmapHint.total}): ${roadmapHint.remaining.slice(0, 6).join(' · ')}`
      : `Tracked roadmap is COMPLETE. If D${team}_GOAL.md scope is also done, declare "PHASE-0 SCOPE COMPLETE" and emit empty <<CODERS>> block. No makework.`
    : '';
  return [
    `[AUTOPILOT — m${team} ${dept}]`,
    remainingLine,
    `Do ONE concrete Phase-0 step for D${team} (schema/contract/validator/spec). Ship to disk. No makework.`,
    `Reply ≤400 chars + <<CODERS>>...<<END>> block. Allocate ONLY coders with real work. Hints: c1=tests c2=glue c3=QA-reviewer. Skip a c-line if useless. Empty block = team rests.`,
    `Format:`,
    `m${team} ${dept}: <≤200ch summary>`,
    `<<CODERS>>`,
    `c1: <only if useful>`,
    `c2: <only if useful>`,
    `c3: <only if useful — what to audit/fix>`,
    `<<END>>`,
  ].filter(Boolean).join('\n');
}

// Parse a manager's reply for a <<CODERS>> ... <<END>> block. Returns
// { 1, 2, 3 } with whatever briefs the manager assigned, or null per-coder
// if the line was missing. Teams have 3 coders: c1=tests, c2=glue, c3=QA.
function parseCoderAllocations(reply) {
  const out = { 1: null, 2: null, 3: null };
  if (!reply) return out;
  const blockMatch = reply.match(/<<\s*CODERS\s*>>([\s\S]*?)<<\s*END\s*>>/i);
  const block = blockMatch ? blockMatch[1] : reply; // fall back to full reply if no block
  const lines = block.split('\n').map((l) => l.trim());
  for (const line of lines) {
    const m = line.match(/^c([1-4])\s*[:\-]\s*(.+)$/i);
    if (m) {
      let idx = Number(m[1]);
      // Backwards-compat: managers trained on the old 4-coder layout may
      // still emit a c4 line — fold it into c3 (the QA slot it became).
      if (idx === 4) idx = 3;
      if (idx < 1 || idx > 3) continue;
      const task = m[2].trim().slice(0, 600);
      if (task && task.length >= 10) out[idx] = task;
    }
  }
  return out;
}

function buildCoderBrief(team, coderIndex, managerAssignedTask) {
  const dept = DEPARTMENTS[team - 1] || 'unknown';
  // Coders only run with an explicit manager-allocated task. The operator's
  // rule: no allocation = no dispatch. runCycle enforces that contract; this
  // function should never be called without a task. The fallback role-
  // default brief below is retained ONLY as a last-resort safety net.
  if (managerAssignedTask) {
    return [
      `[AUTOPILOT — c${coderIndex}/m${team} ${dept}]`,
      `Manager allocated: ${managerAssignedTask}`,
      `Do EXACTLY this task. Reference D${team}_GOAL.md if needed. Reply ≤200 chars: what you built + file paths. End with "c${coderIndex}/m${team} ${dept}: <summary>". Report blocker if impossible.`,
    ].join('\n');
  }
  // SAFETY NET — runCycle won't dispatch a coder without a manager
  // allocation, so this branch shouldn't be reached. If something does
  // dispatch without a task, we fall back to the role-default brief
  // rather than crashing.
  if (coderIndex === 3) {
    return [
      `[AXIOM AUTOPILOT — round driven by the operator's autopilot.]`,
      `You are coder c3 on the ${dept} team (m${team}, team ${team}). YOU ARE THE TEAM'S QA / REVIEWER, not a forward-builder.`,
      ``,
      `Your job is to harden what your teammates (manager m${team} + coders c1, c2) just shipped. Do NOT write new contracts or new features — that's their lane. You are the audit + test + fix lane.`,
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
      `Reply ends with a signed status: "c3/m${team} ${dept} (QA): <one-line summary>"`,
    ].join('\n');
  }
  // Forward-builders (c1, c2)
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
    `Your role hint: c${coderIndex}=${coderIndex === 1 ? 'tests/fixtures' : 'integration glue'}. (c3 is your team's QA reviewer — they will audit your work next round, so write code that's actually correct.)`,
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

// Treat a "running" state as actually running only if it started within the
// last 5 minutes. Anything older is a zombie (parent watcher-web restart
// killed the subprocess but the state file was never updated). The driver
// would otherwise skip these forever and the team would idle. Decaying here
// also writes back to disk so the API stays truthful.
const RUNNING_ZOMBIE_TTL_MS = 5 * 60 * 1000;
async function isAgentRunning(sessionKey) {
  const safe = sessionKey.replace(/[^a-z0-9_.\-:]/gi, '_').slice(0, 200) || 'unknown';
  const f = join(MAILBOX_DIR, `${safe}.state.json`);
  const s = await readJson(f);
  if (s?.status !== 'running') return false;
  const startedAt = s?.startedAt;
  if (startedAt) {
    const elapsed = Date.now() - new Date(startedAt).getTime();
    if (elapsed > RUNNING_ZOMBIE_TTL_MS) {
      // Reap: rewrite as idle so next cycle dispatches.
      try {
        await fs.writeFile(f, JSON.stringify({ ...s, status: 'idle', progress: null, task: null }, null, 2));
      } catch {}
      return false;
    }
  }
  return true;
}

async function callManager(team, roadmapHint) {
  const r = await callAgent(`axiom:axiom-mgr-${team}`, buildManagerBrief(team, roadmapHint));
  return { ...r, role: 'manager', team, coderIndex: null };
}

// Pull roadmap once per cycle. Returns Map<team, {built,total,remaining[]}>
// or null on failure. The driver passes per-team summaries into each
// manager's brief so they know what's left vs what's shipped — without
// this they spin generating makework after their tracked items are done.
async function fetchRoadmapHints() {
  try {
    const url = new URL('/api/axiom/roadmap', WATCH_URL).toString();
    const headers = WATCH_AUTH ? { Authorization: `Bearer ${WATCH_AUTH}` } : {};
    const r = await fetch(url, { headers });
    if (!r.ok) return null;
    const j = await r.json();
    const map = new Map();
    const byTeamCounts = new Map((j?.byTeam || []).map((t) => [t.team, t]));
    for (const team of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
      const counts = byTeamCounts.get(team) || { built: 0, total: 0 };
      const remaining = (j?.items || [])
        .filter((it) => it.team === team && !it.built)
        .map((it) => it.label);
      map.set(team, { built: counts.built, total: counts.total, remaining });
    }
    return map;
  } catch {
    return null;
  }
}

async function callCoder(team, coderIndex, managerAssignedTask) {
  const r = await callAgent(`axiom:axiom-coder-${team}-${coderIndex}`, buildCoderBrief(team, coderIndex, managerAssignedTask));
  return { ...r, role: 'coder', team, coderIndex, managerAssignedTask };
}

// Last round's coder allocations, kept in memory so coders can run in
// parallel with the next round's managers. Without this, the floor shows
// "managers running, coders idle" for ~half each cycle. Now: round N
// dispatches managers (planning round N+1) AND coders (executing
// round N-1's allocations) concurrently — five-agent teams are always
// active together.
let lastRoundAllocations = new Map(); // team → { 1: task, 2: task, 3: task, 4: task }

// Two-phase cycle: managers run first and allocate one task per coder via a
// <<CODERS>>...<<END>> block in their reply. Driver parses each manager's
// reply for those allocations, then dispatches the 4 coders for that team
// with the manager-assigned task. If a manager skips the allocation block,
// the coder falls back to its role-default brief.
async function runCycle(cycleNum) {
  const startedAt = new Date().toISOString();
  const STAGGER_MS = 150;

  // ── Phase 0: pull roadmap once so managers know what's still pending ─
  const roadmapHints = await fetchRoadmapHints();
  if (roadmapHints) {
    const summary = [...roadmapHints.entries()]
      .map(([t, h]) => `m${t}=${h.built}/${h.total}`)
      .join(' ');
    process.stdout.write(`[axiom-driver] cycle=${cycleNum} roadmap: ${summary}\n`);
  }

  // ── Phase 1 + 2 in PARALLEL ──────────────────────────────────────
  // Managers dispatch and plan ROUND N+1's allocations, coders dispatch
  // and execute ROUND N-1's allocations from `lastRoundAllocations`. Both
  // run concurrently so the five-agent team is always active together
  // instead of alternating "managers up, coders down" each cycle.
  const mgrTasks = [];
  let mgrSkipped = 0;
  let stagger = 0;
  for (let n = 1; n <= 10; n++) {
    if (await isAgentRunning(`axiom:axiom-mgr-${n}`)) {
      process.stdout.write(`[axiom-driver] cycle=${cycleNum} skip m${n} (already running)\n`);
      mgrSkipped++;
      continue;
    }
    const hint = roadmapHints ? roadmapHints.get(n) : null;
    const delay = stagger; stagger += STAGGER_MS;
    mgrTasks.push(new Promise((r) => setTimeout(() => r(callManager(n, hint)), delay)));
  }

  // Coders use last round's allocations. On the first cycle (no prior
  // allocations), coders skip and the floor warms up after the first
  // manager round.
  const codTasks = [];
  let codSkippedRunning = 0;
  let codSkippedNoAlloc = 0;
  for (let n = 1; n <= 10; n++) {
    const teamAlloc = lastRoundAllocations.get(n) || { 1: null, 2: null, 3: null };
    for (let c = 1; c <= 3; c++) {
      if (await isAgentRunning(`axiom:axiom-coder-${n}-${c}`)) {
        process.stdout.write(`[axiom-driver] cycle=${cycleNum} skip c${c}/m${n} (already running)\n`);
        codSkippedRunning++;
        continue;
      }
      const assignedTask = teamAlloc[c];
      // Manager must explicitly allocate — no allocation, no dispatch.
      if (!assignedTask) {
        codSkippedNoAlloc++;
        continue;
      }
      const delay = stagger; stagger += STAGGER_MS;
      codTasks.push(new Promise((r) => setTimeout(() => r(callCoder(n, c, assignedTask)), delay)));
    }
  }
  process.stdout.write(`[axiom-driver] cycle=${cycleNum} dispatching ${mgrTasks.length} managers + ${codTasks.length} coders concurrently (${codSkippedNoAlloc} coders had no allocation from last round)\n`);

  // Run both phases concurrently.
  const [mgrResults, codResults] = await Promise.all([
    Promise.all(mgrTasks),
    Promise.all(codTasks),
  ]);
  const mgrOk = mgrResults.filter((r) => r.ok).length;
  const codOk = codResults.filter((r) => r.ok).length;

  // Update lastRoundAllocations from this round's manager replies — these
  // become the briefs that the NEXT cycle's coders will execute.
  const newAllocations = new Map();
  for (const m of mgrResults) {
    if (m.team) newAllocations.set(m.team, parseCoderAllocations(m.reply || ''));
  }
  // Preserve teams whose manager didn't run this cycle (already-running
  // skipped) — they keep the previous allocation.
  for (const [team, alloc] of lastRoundAllocations) {
    if (!newAllocations.has(team)) newAllocations.set(team, alloc);
  }
  lastRoundAllocations = newAllocations;
  const codSkipped = codSkippedRunning + codSkippedNoAlloc;

  const allResults = [...mgrResults, ...codResults];
  const dispatched = allResults.length;
  const ok = mgrOk + codOk;
  const fail = dispatched - ok;
  const allocCount = codResults.filter((r) => r.managerAssignedTask).length;
  process.stdout.write(`[axiom-driver] cycle=${cycleNum} done: ${ok}/${dispatched} ok (${mgrOk} mgr + ${codOk} cod, ${allocCount}/${codResults.length} coders had manager-assigned tasks), ${fail} failed in ${Math.round((Date.now() - Date.parse(startedAt)) / 1000)}s\n`);
  return { startedAt, cycleNum, dispatched, completed: ok, failed: fail, skipped: mgrSkipped + codSkipped, results: allResults, allocCount };
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
