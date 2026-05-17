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
const MAX_DAILY_USD_CEILING = 100;
const DEFAULT_DAILY_USD = Math.min(Number(process.env.WATCH_AXIOM_MAX_DAILY_USD || 10), MAX_DAILY_USD_CEILING);
// Pause threshold: by default we run all the way to 100% (only stop when the
// cap is fully consumed), and warn — but keep running — at WARN_PCT.
const CAP_HEADROOM_PCT = Number(process.env.WATCH_AXIOM_DRIVER_CAP_HEADROOM_PCT || 100);
const CAP_WARN_PCT = Number(process.env.WATCH_AXIOM_DRIVER_CAP_WARN_PCT || 90);
const TG_TOKEN = (process.env.WATCH_AXIOM_CEO_BOT_TOKEN || '').trim();
const TG_CHAT_ID = (process.env.WATCH_AXIOM_CEO_OPERATOR_ID || '').trim();
const PROJECT_DIR = process.env.WATCH_AXIOM_PROJECT_DIR || '/opt/axiom';

// ── CEO orchestrator ────────────────────────────────────────────────
// Driver consults the CEO every N cycles to decide which managers run
// with what brief, instead of dispatching strictly from the roadmap
// manifest. This makes the CEO the actual conductor (previously CEO
// was chat-only via Telegram, autopilot dispatched managers blindly).
// Uses a SEPARATE sessionKey from the operator-facing CEO chat — if we
// share the chat session, prior operator instructions ("stop", "pause",
// philosophical chat) bleed into autopilot decisions. CEO_MEMORY.md is
// loaded into both sessions so the persistent brain stays consistent.
// Fail-safe: if CEO doesn't reply within CEO_TIMEOUT_MS or doesn't emit
// a DELEGATE tag, driver falls back to the manifest-derived brief.
const CEO_SESSION_KEY = process.env.WATCH_AXIOM_DRIVER_CEO_SESSION || 'axiom:axiom-ceo-autopilot';
const CEO_SCOPE_SESSION_KEY = process.env.WATCH_AXIOM_DRIVER_CEO_SCOPE_SESSION || 'axiom:axiom-ceo-scoping';
const CEO_TIMEOUT_MS = Math.max(15_000, Number(process.env.WATCH_AXIOM_DRIVER_CEO_TIMEOUT_MS || 90_000));
const CEO_EVERY = Math.max(1, Number(process.env.WATCH_AXIOM_DRIVER_CEO_EVERY || 3));
const CEO_DELEGATE_RE = /<<\s*DELEGATE\s*:\s*([^:]+?)\s*::\s*([\s\S]*?)\s*>>/;
const CEO_DELEGATE_ALL_RE = /<<\s*DELEGATE-ALL\s*:\s*([\s\S]*?)\s*>>/;
const CEO_MIN_BRIEF_CHARS = 30;

// Overlay: CEO-allocated cross-team deliverables written to a sidecar JSON
// file. The roadmap API merges these into milestones at GET time, so when
// CEO assigns m1 a buf-lint validator at /opt/axiom/tools/x.js the team's
// total goes 0→1 and its coders dispatch instead of being skipped as idle.
const OVERLAY_FILE = process.env.WATCH_AXIOM_ROADMAP_OVERLAY || '/var/lib/watcher/axiom-roadmap-overlay.json';
const AUTOPILOT_LOG_FILE = process.env.WATCH_AXIOM_AUTOPILOT_LOG || '/opt/axiom/CEO_AUTOPILOT_LOG.md';

// Coders run codex /goal (2–15 min) fire-and-forget; their state files
// stay "running" for the duration. The manager-side TTL (5 min) is too
// short — a long codex coder gets reaped and re-dispatched mid-flight.
// Separate TTL so the watchdog reaps zombies without killing live coders.
const CODER_RUNNING_ZOMBIE_TTL_MS = Math.max(5 * 60_000, Number(process.env.WATCH_AXIOM_CODER_TTL_MS || 20 * 60_000));

const MASTERPLAN_FILE = `${PROJECT_DIR}/AXIOM_MASTERPLAN.md`;

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
  if (override && typeof override.dailyUsdOverride === 'number' && Number.isFinite(override.dailyUsdOverride) && override.dailyUsdOverride >= 0) {
    return Math.min(Math.max(0, override.dailyUsdOverride), MAX_DAILY_USD_CEILING);
  }
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

function buildManagerBrief(team, roadmapHint, currentPhase = 0) {
  const dept = DEPARTMENTS[team - 1] || 'unknown';
  const remainingItems = roadmapHint?.remaining || [];
  const phaseTag = `PHASE-${currentPhase}`;
  // Render each remaining item with its EXACT manifest path so codex has no
  // room to drift (e.g. axiom_comm_entities.v1.yaml when manifest wants
  // axiom_comm_entities.yaml). The path comes from item.evidence[0] in the
  // roadmap API and is what the API checks for file existence to mark built.
  function renderItem(it, i) {
    if (typeof it === 'string') return `  ${i + 1}. ${it}`; // legacy shape, shouldn't happen
    const path = it.path ? ` → ${PROJECT_DIR}/${it.path}` : '';
    return `  ${i + 1}. [${it.id}] ${it.label}${path}`;
  }
  // No-hardening rule: when REMAINING is empty for a team that has tracked
  // items in this phase, the only acceptable reply is "{phaseTag} SCOPE
  // COMPLETE" + empty <<CODERS>>.
  const remainingBlock = roadmapHint
    ? remainingItems.length > 0
      ? `REMAINING for D${team} in ${phaseTag} (${roadmapHint.built}/${roadmapHint.total} done) — your ONLY allowed work this cycle:\n${remainingItems.slice(0, 8).map(renderItem).join('\n')}`
      : `Tracked roadmap is COMPLETE for D${team} in ${phaseTag} (${roadmapHint.built}/${roadmapHint.total}). Reply EXACTLY: "${phaseTag} SCOPE COMPLETE" and emit empty <<CODERS>><<END>>. Do NOT allocate hardening, regression, or any other work — that is forbidden busywork. Other teams have real work; idle managers must declare and exit so cost goes to teams that need it.`
    : '';
  return [
    `[AUTOPILOT — m${team} ${dept}]`,
    remainingBlock,
    `RULE 1 (PATH DISCIPLINE — CRITICAL): Ship files at the EXACT path shown after the "→" arrow above. No version suffixes (.v1, .v0). No relocations to "more idiomatic" locations. No variant filenames. The roadmap API runs fs.stat() on that literal path; if your file lands anywhere else, you shipped nothing the roadmap can count, the cycle was wasted, and the operator pays for it. If a path looks wrong to you, REPLY explaining the conflict — do NOT silently rename.`,
    `RULE 2 (NO ELABORATION): Coder tasks must be DIFFERENT FILES from each other and from your own ship this cycle. Forbidden pattern: "c1: validate X. c2: check X. c3: verify X" where X is the same file. That ships nothing new. If you can't think of 3 distinct artifacts to advance, emit empty <<CODERS>> instead of busywork.`,
    `RULE 3 (PARALLEL DECOMPOSITION): Allocate ALL 3 coders to advance THREE DIFFERENT remaining items where possible — each coder gets a distinct [id] and its exact /opt/axiom path from REMAINING. If REMAINING has fewer than 3 items, decompose your single primary item into 3 sibling files: c1=tests/fixtures path, c2=implementation/glue path, c3=regression test or validator path. All three paths must differ.`,
    `Reply ≤500 chars + <<CODERS>>...<<END>> block.`,
    `Format:`,
    `m${team} ${dept}: <≤200ch — which [id] you advanced + EXACT path you shipped>`,
    `<<CODERS>>`,
    `c1: [id] ship ${PROJECT_DIR}/<exact path — a different file from c2/c3 and your ship>`,
    `c2: [id] ship ${PROJECT_DIR}/<exact path — different again>`,
    `c3: [id] ship ${PROJECT_DIR}/<exact path — different again>`,
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
  const block = blockMatch ? blockMatch[1] : reply;
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
      `PATH DISCIPLINE (CRITICAL): the task contains a file path. Write to that EXACT path. No version suffixes (.v1, .v0). No relocations. The roadmap API runs fs.stat() on that literal path — if you ship anywhere else, you shipped nothing the roadmap can count. If the path looks wrong, reply with the conflict instead of silently renaming.`,
      `Do EXACTLY this task. Reference D${team}_GOAL.md if needed. Reply ≤200 chars: what you built + EXACT file path. End with "c${coderIndex}/m${team} ${dept}: <summary>". Report blocker if impossible.`,
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

// Treat a "running" state as actually running only if it started within
// the agent's TTL. Anything older is a zombie (parent watcher-web restart
// killed the subprocess but the state file was never updated). The driver
// would otherwise skip these forever and the team would idle. Decaying
// here also writes back to disk so the API stays truthful.
//
// Managers: 5 min TTL (claude reply; if not back in 5 min, dead).
// Coders:   20 min TTL (codex /goal can legitimately run 2-15 min).
const RUNNING_ZOMBIE_TTL_MS = 5 * 60 * 1000;
async function isAgentRunning(sessionKey) {
  const safe = sessionKey.replace(/[^a-z0-9_.\-:]/gi, '_').slice(0, 200) || 'unknown';
  const f = join(MAILBOX_DIR, `${safe}.state.json`);
  const s = await readJson(f);
  if (s?.status !== 'running') return false;
  const startedAt = s?.startedAt;
  if (startedAt) {
    const ttl = sessionKey.includes('coder') ? CODER_RUNNING_ZOMBIE_TTL_MS : RUNNING_ZOMBIE_TTL_MS;
    const elapsed = Date.now() - new Date(startedAt).getTime();
    if (elapsed > ttl) {
      // Reap: rewrite as idle so next cycle dispatches.
      try {
        await fs.writeFile(f, JSON.stringify({ ...s, status: 'idle', progress: null, task: null }, null, 2));
      } catch {}
      return false;
    }
  }
  return true;
}

async function callManager(team, roadmapHint, currentPhase = 0) {
  const r = await callAgent(`axiom:axiom-mgr-${team}`, buildManagerBrief(team, roadmapHint, currentPhase));
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
        .map((it) => ({
          id: it.id,
          label: it.label,
          path: Array.isArray(it.evidence) && it.evidence.length ? it.evidence[0] : '',
        }));
      map.set(team, { built: counts.built, total: counts.total, remaining });
    }
    const currentPhase = typeof j?.currentPhase === 'number' ? j.currentPhase : 0;
    let activeMilestone = null;
    if (Array.isArray(j?.milestones) && j.milestones.length) {
      activeMilestone = j.milestones.find((m) => m.status === 'in_progress')
        || j.milestones.find((m) => m.status === 'scoping')
        || j.milestones[0];
    }
    // Surface which items are built right now (for cycle-over-cycle diffs).
    const builtIds = new Set((j?.items || []).filter((it) => it.built).map((it) => it.id));
    return { hints: map, currentPhase, activeMilestone, builtIds, rawItems: j?.items || [], allMilestones: j?.allMilestones || {} };
  } catch {
    return null;
  }
}

function roadmapComplete(roadmapHints) {
  if (!roadmapHints || roadmapHints.size === 0) return false;
  return [...roadmapHints.values()].every((h) => {
    const built = Number(h?.built || 0);
    const total = Number(h?.total || 0);
    const remaining = Array.isArray(h?.remaining) ? h.remaining.length : 0;
    return remaining === 0 && built >= total;
  });
}

function countAllocations(allocations) {
  let count = 0;
  for (const alloc of allocations.values()) {
    for (const task of Object.values(alloc || {})) {
      if (task) count++;
    }
  }
  return count;
}

function managersDeclaredPhaseComplete(mgrResults, currentPhase = 0) {
  const managers = (mgrResults || []).filter((r) => r.role === 'manager');
  if (managers.length === 0) return false;
  const re = new RegExp(`PHASE-${currentPhase}\\s+SCOPE\\s+COMPLETE`, 'i');
  return managers.every((r) => r.ok && re.test(r.reply || ''));
}

async function callCoder(team, coderIndex, managerAssignedTask) {
  const r = await callAgent(`axiom:axiom-coder-${team}-${coderIndex}`, buildCoderBrief(team, coderIndex, managerAssignedTask));
  return { ...r, role: 'coder', team, coderIndex, managerAssignedTask };
}

// ── Masterplan slice (cached) ───────────────────────────────────────
// CEO needs to see the mission, not just per-team counters. We slice
// §15.1 (the six-phase build plan) on first call and cache it for the
// session. Cheap and infrequent.
let _masterplanSliceCache = null;
async function getMasterplanSlice() {
  if (_masterplanSliceCache !== null) return _masterplanSliceCache;
  try {
    const full = await fs.readFile(MASTERPLAN_FILE, 'utf8');
    const idx = full.indexOf('### 15.1');
    if (idx < 0) { _masterplanSliceCache = ''; return ''; }
    // Find next ### or ## after 15.1 — that's the end of the slice
    const tail = full.slice(idx);
    const endIdx = tail.search(/\n###\s+15\.2/);
    const slice = endIdx > 0 ? tail.slice(0, endIdx) : tail.slice(0, 2500);
    _masterplanSliceCache = slice.trim();
  } catch {
    _masterplanSliceCache = '';
  }
  return _masterplanSliceCache;
}

// ── Overlay reader/writer ───────────────────────────────────────────
async function readOverlay() {
  try {
    const txt = await fs.readFile(OVERLAY_FILE, 'utf8');
    const j = JSON.parse(txt);
    if (j && Array.isArray(j.entries)) {
      if (!Array.isArray(j.milestones)) j.milestones = [];
      return j;
    }
  } catch {}
  return { entries: [], milestones: [] };
}

async function writeOverlay(overlay) {
  overlay.generatedAt = new Date().toISOString();
  try { await fs.writeFile(OVERLAY_FILE, JSON.stringify(overlay, null, 2), 'utf8'); } catch {}
}

// Parse CEO's per-team allocation lines from DELEGATE-ALL brief. Format:
//   m1: [P2-M3-buf-lint] DCS proto buf-lint → /opt/axiom/tools/validate-x.js
// Returns array of { team, id, label, path } records. Strips PROJECT_DIR
// prefix from path to get the manifest-relative form.
function parseCeoAllocations(brief, activeMilestoneId) {
  const out = [];
  const seen = new Set();
  // Per-team lines start with "m{N}:" — split on those, ignore everything before m1
  const re = /m(\d+)\s*:\s*([\s\S]*?)(?=\s+m\d+\s*:|$)/g;
  let m;
  while ((m = re.exec(brief)) !== null) {
    const team = Number(m[1]);
    if (team < 1 || team > 10) continue;
    const body = m[2].trim();
    // Skip scope-complete declarations
    if (/SCOPE\s+COMPLETE/i.test(body)) continue;
    // Extract [id] and → path
    const idMatch = body.match(/\[([A-Za-z0-9_\-]+)\]/);
    if (!idMatch) continue;
    const id = idMatch[1];
    if (seen.has(id)) continue;
    // Label = body without [id] and after the arrow
    const arrowIdx = body.indexOf('→');
    if (arrowIdx < 0) continue;
    const labelRaw = body.slice(0, arrowIdx).replace(/\[[^\]]+\]/, '').trim();
    let pathRaw = body.slice(arrowIdx + 1).trim().split(/\s+(?=m\d+\s*:)/)[0].split('|')[0].trim();
    // Strip trailing sentence punctuation that CEO often appends (".", ",", ";")
    pathRaw = pathRaw.replace(/[.,;:]+$/, '').trim();
    // Strip /opt/axiom/ prefix → manifest-relative
    const rel = pathRaw.startsWith(`${PROJECT_DIR}/`) ? pathRaw.slice(PROJECT_DIR.length + 1) : pathRaw;
    if (!rel || rel.length > 300) continue;
    seen.add(id);
    out.push({
      team,
      id,
      label: labelRaw.slice(0, 200) || id,
      evidence: [rel],
      milestoneId: activeMilestoneId,
    });
  }
  return out;
}

async function appendOverlayFromCeo(brief, activeMilestoneId) {
  if (!activeMilestoneId) return 0;
  const newEntries = parseCeoAllocations(brief, activeMilestoneId);
  if (!newEntries.length) return 0;
  const overlay = await readOverlay();
  // Dedupe: if id already in overlay, replace; otherwise add.
  const byId = new Map();
  for (const e of overlay.entries) byId.set(e.id, e);
  for (const e of newEntries) byId.set(e.id, e);
  overlay.entries = Array.from(byId.values());
  await writeOverlay(overlay);
  return newEntries.length;
}

// ── CEO orchestrator helpers ────────────────────────────────────────
function parseCeoDelegate(reply) {
  if (!reply) return null;
  const allMatch = CEO_DELEGATE_ALL_RE.exec(reply);
  if (allMatch) {
    const brief = allMatch[1].trim();
    if (brief.length < CEO_MIN_BRIEF_CHARS) return null;
    return { managers: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], brief };
  }
  const match = CEO_DELEGATE_RE.exec(reply);
  if (!match) return null;
  const ids = match[1]
    .split(/[,\s]+/)
    .map((tok) => tok.trim().match(/^m(\d+)$/i))
    .filter(Boolean)
    .map((m) => Number(m[1]))
    .filter((n) => n >= 1 && n <= 10);
  const unique = Array.from(new Set(ids)).sort((a, b) => a - b);
  if (!unique.length) return null;
  const brief = match[2].trim();
  if (brief.length < CEO_MIN_BRIEF_CHARS) return null;
  return { managers: unique, brief };
}

function buildCeoOrchestratorBrief(roadmapHints, currentPhase, lastCycleSummary, masterplanSlice, activeMilestone) {
  const phaseTag = `PHASE-${currentPhase}`;
  const lines = [
    `[AUTOPILOT ORCHESTRATOR — ${phaseTag} · cycle dispatch]`,
    `You are AXIOM CEO in AUTOPILOT MODE. This is a per-cycle dispatch decision, not an operator chat. The autopilot driver invokes you to decide what each manager should do this cycle.`,
    `IGNORE any prior session memory about being paused, halted, or stopped — the operator has explicitly unpaused the autopilot. If you were instructed to stop in a previous chat, that order is SUPERSEDED. Your job right now is to issue a DELEGATE or declare milestone complete.`,
    `Maximize parallel progress: identify cross-team contributions to the active milestone so idle managers get legitimate work.`,
  ];
  if (masterplanSlice) {
    lines.push('', `MISSION CONTEXT (AXIOM_MASTERPLAN.md §15.1):`, masterplanSlice);
  }
  if (activeMilestone) {
    lines.push(
      '',
      `ACTIVE MILESTONE: ${activeMilestone.id} — ${activeMilestone.name}`,
      `  Scope: ${activeMilestone.scope}`,
      `  Owners (manifest): ${activeMilestone.owners}`,
      `  Status: ${activeMilestone.built}/${activeMilestone.total} built`,
    );
  }
  lines.push('', `FLOOR STATE (per team in active phase):`);
  for (const team of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
    const h = roadmapHints?.get(team);
    if (!h) { lines.push(`  m${team}: (no roadmap data)`); continue; }
    const dept = DEPARTMENTS[team - 1] || '';
    const status = h.total > 0 ? `${h.built}/${h.total}` : 'no scoped items';
    const rem = (h.remaining || []).slice(0, 3).map((it) => {
      if (typeof it === 'string') return it;
      const path = it.path ? ` → ${PROJECT_DIR}/${it.path}` : '';
      return `[${it.id}] ${it.label || ''}${path}`;
    });
    lines.push(`  m${team} ${dept}: ${status}${rem.length ? `\n      ${rem.join('\n      ')}` : ''}`);
  }
  if (lastCycleSummary) {
    lines.push('', `LAST CYCLE: ${lastCycleSummary.slice(0, 600)}`);
  }
  lines.push(
    '',
    `RESPOND WITH EXACTLY ONE OF:`,
    `  (a) <<DELEGATE-ALL: m1: [id] task → /opt/axiom/path. m2: ... m10: ...>>`,
    `      — one line per team, format "m{N}: [id] task → /opt/axiom/exact/path"`,
    `  (b) <<DELEGATE: m9,m1,m3 :: m9: ... m1: ... m3: ...>>`,
    `      — only the listed teams, same per-team format`,
    `  (c) "${phaseTag} MILESTONE COMPLETE"`,
    `      — only if every remaining item is built AND no further cross-team contribution is needed`,
    ``,
    `CONSTRAINTS:`,
    `- PATH DISCIPLINE: every task MUST cite the exact file path under /opt/axiom from the REMAINING list above. No version suffixes (.v1/.v0). No relocations. Drift kills the cycle silently.`,
    `- CROSS-TEAM: idle teams (status "no scoped items") can be assigned legitimate contributions to the active milestone — e.g. m1 ships proto buf-lint for D9's NDC proto, m3 ships SLO catalog for AXIOM-COMM, m4 ships substrate publish gate. Cite the EXACT new file path you want the team to ship at; do NOT invent placeholder work.`,
    `- SCOPE COMPLETE: if a team has tracked items all built (e.g. m2: 1/1), tell it to reply "${phaseTag} SCOPE COMPLETE" so it counts toward auto-pause.`,
    `- Each manager will allocate 3 coders from your brief. Include enough granularity that each manager can derive 3 parallel coder tasks at exact paths.`,
    `- Reply ≤2000 chars. Just the DELEGATE tag or the completion phrase. NO preamble, NO chat.`,
  );
  return lines.join('\n');
}

async function callCeoOrchestrator(message) {
  const url = new URL('/api/team-office/instruct', WATCH_URL).toString();
  const headers = { 'Content-Type': 'application/json' };
  if (WATCH_AUTH) headers.Authorization = `Bearer ${WATCH_AUTH}`;
  const body = JSON.stringify({ agentId: 'claude-code', sessionKey: CEO_SESSION_KEY, groupId: 'axiom', message });
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CEO_TIMEOUT_MS);
  try {
    const r = await fetch(url, { method: 'POST', headers, body, signal: ctrl.signal });
    const j = await r.json().catch(() => ({}));
    const dur = Math.round((Date.now() - t0) / 1000);
    // Full reply (not truncated to 200 like callAgent — orchestrator output is the entire brief).
    const reply = String(j?.reply || '');
    const ok = r.ok && reply && !reply.startsWith('(empty');
    return { ok, dur, reply, engine: j?.engine };
  } catch (err) {
    return { ok: false, dur: Math.round((Date.now() - t0) / 1000), reply: `(fetch failed: ${err.message})` };
  } finally {
    clearTimeout(timer);
  }
}

// ── Auto-scope: ask CEO to draft deliverables for an empty milestone ──
function buildCeoScopingBrief(milestone, currentPhase, masterplanSlice) {
  return [
    `[AUTOPILOT SCOPING — Phase ${currentPhase} · Milestone ${milestone.id}]`,
    `You are AXIOM CEO. This is autopilot scoping, not chat. The current milestone has NO deliverables enumerated and the autopilot needs work to dispatch.`,
    ``,
    masterplanSlice ? `MISSION CONTEXT:\n${masterplanSlice}\n` : '',
    `MILESTONE TO SCOPE: ${milestone.id} — ${milestone.name}`,
    `  Stated scope: ${milestone.scope}`,
    `  Manifest owners: ${milestone.owners}`,
    ``,
    `YOUR JOB: emit a DELEGATE-ALL with 10-14 cross-team deliverables that together close this milestone AND produce real user-facing utility. Spread ownership across at least 3 teams to maximize parallelism.`,
    ``,
    `INTEGRATION MANDATE — every milestone MUST include ALL FOUR of these deliverables. Skipping any of them is failure:`,
    `  1. An axiom-web API route at /opt/axiom/web/app/api/<feature>/route.ts that does REAL CRUD via /opt/axiom/web/lib/data/<feature>-live.ts → /opt/axiom/web/lib/db (SQLite). NOT hardcoded sample arrays. NOT mock data. Follow the template at /opt/axiom/web/app/api/dispatch/release/route.ts which uses createRelease() + auditLog().`,
    `  2. An axiom-web UI page at /opt/axiom/web/app/<feature>/page.tsx that calls the API + uses Next.js server actions for POST/PATCH/DELETE. Forms must be wired to write to the DB. Follow the template at /opt/axiom/web/app/dispatch/console/page.tsx — every button there persists.`,
    `  3. A data module at /opt/axiom/web/lib/data/<feature>-live.ts that holds the DB queries, schema if needed, and helpers. Follow /opt/axiom/web/lib/data/dispatch-live.ts.`,
    `  4. An end-to-end smoke test at /opt/axiom/tests/smoke/${milestone.id}-e2e.test.js that POSTs to /api/<feature>, GETs back, asserts the row exists. The autopilot quality suite runs all smoke tests after each milestone close.`,
    `Without these four, the milestone is "paper". With them, the operator at axiom.clawnux.com/app/<feature> clicks a real button that writes to the real DB and shows up on reload.`,
    ``,
    `Reference implementation to study before scoping: /opt/axiom/web/lib/db/index.ts (DB), /opt/axiom/web/lib/data/dispatch-live.ts (domain helpers), /opt/axiom/web/app/dispatch/console/page.tsx (live UI), /opt/axiom/web/app/api/dispatch/release/route.ts (API). These prove the pattern works end-to-end — copy it.`,
    ``,
    `PATHS — CRITICAL. ALL paths must be under /opt/axiom only. The axiom coders are bwrap-sandboxed to /opt/axiom; they cannot write anywhere else. Use paths like /opt/axiom/web/app/<feature>/page.tsx — NEVER /opt/watcher/... (the watcher app is a separate sandbox, untouchable from here).`,
    ``,
    `OUTPUT FORMAT — same per-team line shape as cycle dispatch:`,
    `<<DELEGATE-ALL: m1: [${milestone.id}-foo] short label → /opt/axiom/exact/path.ext. m2: [${milestone.id}-bar] label → /opt/axiom/web/app/api/<feature>/route.ts. ...>>`,
    ``,
    `RULES:`,
    `- Each [id] starts with "${milestone.id}-" (e.g. ${milestone.id}-svc-skel, ${milestone.id}-api-route, ${milestone.id}-ui-page, ${milestone.id}-e2e).`,
    `- Each path is NEW (not already on disk) and under /opt/axiom/.`,
    `- 10-14 entries total. Mix: contracts/schemas + service skeleton + /opt/axiom/web/app/api/<feature>/route.ts + /opt/axiom/web/app/<feature>/page.tsx + /opt/axiom/tests/smoke/<id>-e2e.test.js.`,
    `- Reply with ONLY the DELEGATE-ALL tag. No preamble.`,
  ].filter(Boolean).join('\n');
}

// ── Auto-create milestone: phase has 0 milestones, CEO drafts one ──
function buildCeoCreateMilestoneBrief(currentPhase, milestoneNum, masterplanSlice) {
  const phaseNames = ['Foundation', 'Operate', 'Sell & Serve', 'Run Business', 'Harden & Extend', 'Productise'];
  const phaseName = phaseNames[currentPhase] || `Phase ${currentPhase}`;
  return [
    `[AUTOPILOT CREATE-MILESTONE — Phase ${currentPhase} · M${milestoneNum}]`,
    `You are AXIOM CEO. This phase has NO milestones defined yet. Your job: design the first milestone for this phase from scratch.`,
    ``,
    masterplanSlice ? `MISSION CONTEXT:\n${masterplanSlice}\n` : '',
    `TARGET PHASE: ${currentPhase} — ${phaseName}`,
    `Per AXIOM_MASTERPLAN.md §15.1 above, this phase is the next logical block of work. You design its M${milestoneNum}.`,
    ``,
    `OUTPUT — TWO tagged blocks in a single reply:`,
    ``,
    `(1) Milestone metadata block (one line):`,
    `<<MILESTONE: id=P${currentPhase}-M${milestoneNum} | num=${milestoneNum} | name=<Short milestone name> | scope=<One-sentence scope statement> | owners=<dept letters like D5+D9>>>`,
    ``,
    `(2) Deliverables via DELEGATE-ALL (10-14 entries, same as cycle dispatch):`,
    `<<DELEGATE-ALL: m1: [P${currentPhase}-M${milestoneNum}-foo] label → /opt/axiom/path. m2: [P${currentPhase}-M${milestoneNum}-bar] label → /opt/watcher/src/app/api/axiom/x/route.ts. ...>>`,
    ``,
    `INTEGRATION MANDATE — the milestone MUST produce real user-facing utility, not just scaffolding:`,
    `  a) Backend contracts/services under /opt/axiom/ (schemas, protos, validators).`,
    `  b) An axiom-web API route at /opt/axiom/web/app/api/<feature>/route.ts (live endpoint at https://axiom.clawnux.com/app/api/<feature>).`,
    `  c) An axiom-web UI page at /opt/axiom/web/app/<feature>/page.tsx (operator-facing at https://axiom.clawnux.com/app/<feature>).`,
    `  d) An end-to-end smoke test at /opt/axiom/tests/smoke/P${currentPhase}-M${milestoneNum}-e2e.test.js (proves it works end-to-end).`,
    `Without (b)(c)(d) the milestone is "paper" — contracts nobody uses. With them, the operator gets a real feature surfaced in the axiom shell at axiom.clawnux.com/app.`,
    ``,
    `PATHS — CRITICAL. ALL paths must be under /opt/axiom only. Coders are bwrap-sandboxed to /opt/axiom — they cannot write anywhere else. Use /opt/axiom/web/app/... for axiom-web integration (NEVER /opt/watcher/...).`,
    ``,
    `RULES:`,
    `- Pick the FIRST natural milestone for this phase from the masterplan's deliverable list above.`,
    `- Spread across teams to maximize parallelism. m2 owns axiom-web routes/pages by default (Governance/UI).`,
    `- Reply with ONLY the two tagged blocks. No preamble, no explanation.`,
  ].filter(Boolean).join('\n');
}

const MILESTONE_TAG_RE = /<<\s*MILESTONE\s*:\s*([\s\S]+?)>>/;

function parseCeoMilestoneTag(reply, currentPhase) {
  const m = MILESTONE_TAG_RE.exec(reply);
  if (!m) return null;
  const fields = {};
  for (const part of m[1].split('|')) {
    const [k, ...v] = part.split('=');
    if (!k || v.length === 0) continue;
    fields[k.trim()] = v.join('=').trim();
  }
  const id = fields.id || '';
  const num = Number(fields.num || 0);
  if (!id || !num || !fields.name || !fields.scope) return null;
  return {
    id,
    num,
    name: fields.name,
    scope: fields.scope,
    owners: fields.owners || 'all',
    phase: currentPhase,
  };
}

async function autoCreateMilestoneForEmptyPhase(currentPhase) {
  const masterplanSlice = await getMasterplanSlice();
  const brief = buildCeoCreateMilestoneBrief(currentPhase, 1, masterplanSlice);
  process.stdout.write(`[axiom-driver] phase ${currentPhase} has 0 milestones — asking CEO to create M1\n`);
  const res = await callCeoScoping(brief);
  if (!res.ok) {
    process.stdout.write(`[axiom-driver] create-milestone CEO call failed in ${res.dur}s: ${res.reply.slice(0, 200)}\n`);
    return false;
  }
  const milestone = parseCeoMilestoneTag(res.reply, currentPhase);
  const delegation = parseCeoDelegate(res.reply);
  if (!milestone || !delegation) {
    process.stdout.write(`[axiom-driver] create-milestone: CEO reply missing MILESTONE tag (${!!milestone}) or DELEGATE (${!!delegation}). preview: ${res.reply.slice(0, 300)}\n`);
    return false;
  }
  // Persist milestone metadata + deliverables to overlay
  const overlay = await readOverlay();
  // Dedupe by id
  overlay.milestones = (overlay.milestones || []).filter((m) => m.id !== milestone.id);
  overlay.milestones.push(milestone);
  const added = parseCeoAllocations(delegation.brief, milestone.id);
  const byId = new Map();
  for (const e of overlay.entries) byId.set(e.id, e);
  for (const e of added) byId.set(e.id, e);
  overlay.entries = Array.from(byId.values());
  await writeOverlay(overlay);
  process.stdout.write(`[axiom-driver] create-milestone: created ${milestone.id} (${milestone.name}) with ${added.length} deliverables in ${res.dur}s\n`);
  return true;
}

async function callCeoScoping(message) {
  const url = new URL('/api/team-office/instruct', WATCH_URL).toString();
  const headers = { 'Content-Type': 'application/json' };
  if (WATCH_AUTH) headers.Authorization = `Bearer ${WATCH_AUTH}`;
  const body = JSON.stringify({ agentId: 'claude-code', sessionKey: CEO_SCOPE_SESSION_KEY, groupId: 'axiom', message });
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CEO_TIMEOUT_MS * 2); // scoping can take longer than cycle dispatch
  try {
    const r = await fetch(url, { method: 'POST', headers, body, signal: ctrl.signal });
    const j = await r.json().catch(() => ({}));
    const dur = Math.round((Date.now() - t0) / 1000);
    const reply = String(j?.reply || '');
    const ok = r.ok && reply && !reply.startsWith('(empty');
    return { ok, dur, reply };
  } catch (err) {
    return { ok: false, dur: Math.round((Date.now() - t0) / 1000), reply: `(fetch failed: ${err.message})` };
  } finally {
    clearTimeout(timer);
  }
}

// Track milestone-close transitions so we can autolog them on first detection.
let lastSeenMilestoneStatus = new Map(); // milestoneId → status

async function appendAutopilotLog(line) {
  try {
    const header = `\n## ${new Date().toISOString()}\n${line}\n`;
    await fs.appendFile(AUTOPILOT_LOG_FILE, header, 'utf8');
  } catch {}
}

async function detectMilestoneCloseTransitions(allMilestones) {
  // allMilestones: { phase0: [...], phase1: [...], phase2: [...], ... }
  let anyClose = false;
  for (const phaseKey of Object.keys(allMilestones || {})) {
    for (const m of (allMilestones[phaseKey] || [])) {
      const prev = lastSeenMilestoneStatus.get(m.id);
      if (prev && prev !== 'closed' && m.status === 'closed') {
        const line = `Milestone ${m.id} (${m.name}) just closed. ${m.built}/${m.total} deliverables built. Owners: ${m.owners}.`;
        process.stdout.write(`[axiom-driver] milestone close: ${m.id}\n`);
        await appendAutopilotLog(line);
        anyClose = true;
      }
      lastSeenMilestoneStatus.set(m.id, m.status);
    }
  }
  if (anyClose) {
    // Refresh the validator + smoke-test matrix so the dashboard's quality
    // signal reflects what was actually shipped this cycle. Fire-and-forget;
    // takes ~30s for 100+ validators so we don't block cycle cadence on it.
    const child = (await import('node:child_process')).spawn('bash', [`${PROJECT_DIR}/tools/run-quality-suite.sh`], {
      cwd: PROJECT_DIR,
      stdio: 'ignore',
      detached: true,
    });
    child.unref();
    process.stdout.write(`[axiom-driver] quality-suite triggered (fire-and-forget) after milestone close\n`);
  }
}

async function autoScopeMilestone(milestone, currentPhase) {
  const masterplanSlice = await getMasterplanSlice();
  const brief = buildCeoScopingBrief(milestone, currentPhase, masterplanSlice);
  process.stdout.write(`[axiom-driver] auto-scoping milestone ${milestone.id} via CEO\n`);
  const res = await callCeoScoping(brief);
  if (!res.ok) {
    process.stdout.write(`[axiom-driver] auto-scope failed for ${milestone.id} in ${res.dur}s: ${res.reply.slice(0, 160)}\n`);
    return 0;
  }
  const delegation = parseCeoDelegate(res.reply);
  if (!delegation) {
    process.stdout.write(`[axiom-driver] auto-scope ${milestone.id}: CEO reply lacked DELEGATE in ${res.dur}s: ${res.reply.slice(0, 160)}\n`);
    return 0;
  }
  const added = await appendOverlayFromCeo(delegation.brief, milestone.id);
  process.stdout.write(`[axiom-driver] auto-scope ${milestone.id}: persisted ${added} deliverables to overlay in ${res.dur}s\n`);
  return added;
}

async function consultCeoOrchestrator(roadmapHints, currentPhase, lastCycleSummary, activeMilestone) {
  const masterplanSlice = await getMasterplanSlice();
  const brief = buildCeoOrchestratorBrief(roadmapHints, currentPhase, lastCycleSummary, masterplanSlice, activeMilestone);
  process.stdout.write(`[axiom-driver] consulting CEO orchestrator (timeout=${Math.round(CEO_TIMEOUT_MS / 1000)}s)\n`);
  const res = await callCeoOrchestrator(brief);
  if (!res.ok) {
    process.stdout.write(`[axiom-driver] CEO call failed in ${res.dur}s — fallback to manifest brief. preview: ${res.reply.slice(0, 160)}\n`);
    return null;
  }
  if (new RegExp(`PHASE-${currentPhase}\\s+MILESTONE\\s+COMPLETE`, 'i').test(res.reply)) {
    process.stdout.write(`[axiom-driver] CEO declared MILESTONE COMPLETE in ${res.dur}s\n`);
    return { milestoneComplete: true, ceoDur: res.dur };
  }
  const delegation = parseCeoDelegate(res.reply);
  if (!delegation) {
    process.stdout.write(`[axiom-driver] CEO reply lacked DELEGATE in ${res.dur}s — fallback. preview: ${res.reply.slice(0, 160)}\n`);
    return null;
  }
  process.stdout.write(`[axiom-driver] CEO delegated to ${delegation.managers.length} mgrs in ${res.dur}s: ${delegation.managers.map((n) => 'm' + n).join(',')}\n`);

  // Persist CEO's cross-team allocations into the overlay manifest so the
  // roadmap API will include them next request — unlocks coder dispatch
  // for teams whose manifest items would otherwise be empty.
  if (activeMilestone?.id) {
    const added = await appendOverlayFromCeo(delegation.brief, activeMilestone.id);
    if (added > 0) {
      process.stdout.write(`[axiom-driver] overlay: persisted ${added} CEO-allocated deliverables to ${OVERLAY_FILE}\n`);
    }
  }
  return { delegation, ceoDur: res.dur };
}

// Wrap a CEO-issued brief in the same scaffolding (rules, format) that
// buildManagerBrief provides for manifest-driven dispatch. The manager
// scans the CEO brief for its own "m{N}:" line and acts on that.
//
// YOUR JOB AS MANAGER (the key thing): the CEO names ONE primary file.
// You ship that file, then DECOMPOSE the work into 3 DIFFERENT supporting
// artifacts for c1/c2/c3. They are sibling files at different paths —
// NOT three coders staring at the same file you just shipped (that's the
// elaboration anti-pattern from Phase-0 Lesson 2).
function buildManagerBriefFromCeo(team, ceoBrief, currentPhase = 0) {
  const dept = DEPARTMENTS[team - 1] || 'unknown';
  const phaseTag = `PHASE-${currentPhase}`;
  return [
    `[AUTOPILOT — m${team} ${dept} · CEO ORCHESTRATED · ${phaseTag}]`,
    `The CEO issued floor-wide allocations this cycle. Find YOUR line below (starts with "m${team}:") and execute that.`,
    ``,
    `CEO BRIEF:`,
    ceoBrief,
    ``,
    `YOUR ROLE — orchestrate your own coders. The CEO told you to ship ONE file. Your job: (a) ship that primary file yourself, and (b) decompose the work into THREE DIFFERENT supporting artifacts at three different file paths for c1, c2, c3.`,
    ``,
    `RULE 1 (PATH DISCIPLINE — CRITICAL): Ship the primary file at the EXACT path after the "→" in YOUR m${team} line. No version suffixes (.v1, .v0). No relocations.`,
    `RULE 2 (NO ELABORATION — CRITICAL): Coder tasks must be DIFFERENT FILES from your primary file. Forbidden: "c1: validate <my file>. c2: check <my file>. c3: verify <my file>." That ships nothing new and wastes 3 cycles of spend. If you literally can't think of 3 distinct sub-artifacts, emit empty <<CODERS>> instead — better than busywork.`,
    `RULE 3 (DECOMPOSITION PATTERN): For a primary contract file, the three coders typically ship:`,
    `   c1 = tests/fixtures (valid + invalid examples) at /opt/axiom/tests/fixtures/<area>/<name>_valid.json + _invalid.json`,
    `   c2 = the JS validator/glue at /opt/axiom/tools/validate-<name>.js OR the integration glue file`,
    `   c3 = the regression test or CI gate at /opt/axiom/tests/<name>.test.js OR a Cedar invariants YAML in /opt/axiom/contracts/validators/<area>/`,
    `   ADAPT to your domain — but coder paths MUST differ from your primary path and from each other.`,
    `RULE 4: If your CEO line says reply "${phaseTag} SCOPE COMPLETE", do exactly that with empty <<CODERS>><<END>>.`,
    ``,
    `Reply ≤500 chars + <<CODERS>>...<<END>> block.`,
    `Format:`,
    `m${team} ${dept}: <≤200ch — what you advanced + EXACT path of primary file>`,
    `<<CODERS>>`,
    `c1: <DIFFERENT file path under /opt/axiom — tests/fixtures>`,
    `c2: <DIFFERENT file path — implementation/glue>`,
    `c3: <DIFFERENT file path — regression test or CI gate>`,
    `<<END>>`,
  ].join('\n');
}

async function callManagerWithBrief(team, brief) {
  const r = await callAgent(`axiom:axiom-mgr-${team}`, brief);
  return { ...r, role: 'manager', team };
}

// Last round's coder allocations, kept in memory so coders can run in
// parallel with the next round's managers. Without this, the floor shows
// "managers running, coders idle" for ~half each cycle. Now: round N
// dispatches managers (planning round N+1) AND coders (executing
// round N-1's allocations) concurrently — five-agent teams are always
// active together.
let lastRoundAllocations = new Map(); // team → { 1: task, 2: task, 3: task, 4: task }

// Compact summary of the previous cycle, fed back to the CEO at the start
// of the next cycle so it can plan based on what just happened.
let lastCycleSummary = null;

// Track which deliverable IDs were built going into the previous cycle so
// we can diff and surface "newly built this cycle" to the CEO. Powers the
// quality-feedback signal in the orchestrator brief.
let prevBuiltSet = new Set();

// Two-phase cycle: managers run first and allocate one task per coder via a
// <<CODERS>>...<<END>> block in their reply. Driver parses each manager's
// reply for those allocations, then dispatches the 4 coders for that team
// with the manager-assigned task. If a manager skips the allocation block,
// the coder falls back to its role-default brief.
async function runCycle(cycleNum) {
  const startedAt = new Date().toISOString();
  const STAGGER_MS = 150;

  // ── Phase 0: pull roadmap once so managers know what's still pending ─
  // fetchRoadmapHints now returns { hints, currentPhase } so the manager
  // brief and the auto-pause string can both tag themselves with the active
  // phase (was hardcoded PHASE-0).
  const roadmap = await fetchRoadmapHints();
  const roadmapHints = roadmap?.hints || null;
  const currentPhase = roadmap?.currentPhase ?? 0;
  const activeMilestone = roadmap?.activeMilestone || null;
  // Detect milestone-close transitions → write to autopilot log
  if (roadmap?.allMilestones) await detectMilestoneCloseTransitions(roadmap.allMilestones);
  if (roadmapHints) {
    const summary = [...roadmapHints.entries()]
      .map(([t, h]) => `m${t}=${h.built}/${h.total}`)
      .join(' ');
    const mLabel = activeMilestone ? ` · active=${activeMilestone.id} ${activeMilestone.status}` : '';
    process.stdout.write(`[axiom-driver] cycle=${cycleNum} phase=${currentPhase}${mLabel} roadmap: ${summary}\n`);
  }

  // ── AUTO-CREATE MILESTONE: if the current phase has 0 milestones at all,
  // ask CEO to design M1 from scratch (metadata + deliverables) so the
  // autopilot can advance into a new phase without operator intervention.
  // This is what unblocks the "Phase 3, no milestones, 0 dispatch" loop.
  const phaseHasNoMilestones = !activeMilestone && roadmapHints && [...roadmapHints.values()].every((h) => h.total === 0);
  if (phaseHasNoMilestones) {
    const created = await autoCreateMilestoneForEmptyPhase(currentPhase);
    if (created) {
      // Refresh state so the new milestone + deliverables are visible.
      const refreshed = await fetchRoadmapHints();
      if (refreshed?.hints) {
        for (const [t, h] of refreshed.hints.entries()) roadmapHints.set(t, h);
      }
      // refresh activeMilestone too
      if (refreshed?.activeMilestone) {
        // eslint-disable-next-line no-param-reassign
        Object.assign(activeMilestone || {}, refreshed.activeMilestone);
      }
    }
  }

  // ── AUTO-SCOPE: if the active milestone is "scoping" (no deliverables),
  // ask the CEO to draft its manifest BEFORE the orchestrator cycle. This
  // removes the operator-bottleneck between milestones — autopilot can
  // close one milestone, scope the next, and keep building.
  if (activeMilestone?.status === 'scoping') {
    await autoScopeMilestone(activeMilestone, currentPhase);
    // Refresh hints so the just-scoped deliverables are visible to the
    // orchestrator immediately on this same cycle.
    const refreshed = await fetchRoadmapHints();
    if (refreshed?.hints) {
      for (const [t, h] of refreshed.hints.entries()) roadmapHints.set(t, h);
    }
  }

  // ── CEO ORCHESTRATOR (every CEO_EVERY cycles) ───────────────────
  // Ask the CEO to nominate per-team allocations for this cycle. CEO sees
  // the full roadmap state + last cycle's summary and returns DELEGATE-ALL
  // or DELEGATE :: brief. If the call fails or the brief is malformed,
  // we fall back to the manifest-derived per-team brief.
  let ceoDelegation = null; // { managers: [1,3,9], brief: '...' } or null
  let ceoMilestoneComplete = false;
  if (roadmapHints && cycleNum % CEO_EVERY === 1) {
    const ceoOut = await consultCeoOrchestrator(roadmapHints, currentPhase, lastCycleSummary || null, activeMilestone);
    if (ceoOut?.milestoneComplete) {
      ceoMilestoneComplete = true;
    } else if (ceoOut?.delegation) {
      ceoDelegation = ceoOut.delegation;
    }
  }

  // ── Phase 1 + 2 in PARALLEL ──────────────────────────────────────
  // Managers dispatch and plan ROUND N+1's allocations, coders dispatch
  // and execute ROUND N-1's allocations from `lastRoundAllocations`. Both
  // run concurrently so the five-agent team is always active together
  // instead of alternating "managers up, coders down" each cycle.
  const mgrTasks = [];
  let mgrSkipped = 0;
  let mgrSkippedNoItems = 0;
  let mgrSkippedNotDelegated = 0;
  let stagger = 0;
  // When CEO has delegated, only managers in its list run. Other teams
  // are intentionally idle this cycle (CEO's decision, not the manifest's).
  const delegatedSet = ceoDelegation ? new Set(ceoDelegation.managers) : null;
  for (let n = 1; n <= 10; n++) {
    if (await isAgentRunning(`axiom:axiom-mgr-${n}`)) {
      process.stdout.write(`[axiom-driver] cycle=${cycleNum} skip m${n} (already running)\n`);
      mgrSkipped++;
      continue;
    }
    if (delegatedSet) {
      if (!delegatedSet.has(n)) { mgrSkippedNotDelegated++; continue; }
      // CEO told us to run this team — use the CEO brief. Skip-idle is overridden;
      // CEO may have legitimately allocated cross-team work for a team with
      // no roadmap-tracked items in this phase.
      const brief = buildManagerBriefFromCeo(n, ceoDelegation.brief, currentPhase);
      const delay = stagger; stagger += STAGGER_MS;
      mgrTasks.push(new Promise((r) => setTimeout(() => r(callManagerWithBrief(n, brief)), delay)));
      continue;
    }
    // No CEO this cycle — fall back to manifest-derived brief with skip-idle.
    const hint = roadmapHints ? roadmapHints.get(n) : null;
    // Skip teams with zero scoped items in the active phase. Dispatching them
    // burns a manager call only to get "no work" — the brief's no-hardening
    // rule means they'd just reply scope-complete or refuse. Save the spend.
    // Teams with items but remaining=0 (e.g. m2 with 1/1) still dispatch so
    // they can declare scope-complete and contribute to the auto-pause check.
    if (hint && hint.total === 0) {
      mgrSkippedNoItems++;
      continue;
    }
    const delay = stagger; stagger += STAGGER_MS;
    mgrTasks.push(new Promise((r) => setTimeout(() => r(callManager(n, hint, currentPhase)), delay)));
  }
  if (delegatedSet) {
    process.stdout.write(`[axiom-driver] cycle=${cycleNum} CEO-driven: ${mgrTasks.length} dispatched, ${mgrSkippedNotDelegated} skipped (not in CEO delegation)\n`);
  } else if (mgrSkippedNoItems > 0) {
    process.stdout.write(`[axiom-driver] cycle=${cycleNum} skipped ${mgrSkippedNoItems} mgrs with 0 items in phase=${currentPhase}\n`);
  }

  // Coders use last round's allocations. On the first cycle (no prior
  // allocations), coders skip and the floor warms up after the first
  // manager round.
  //
  // FIRE-AND-FORGET: coder dispatches are not awaited. A codex /goal session
  // can take 2–15 min; if the cycle blocked on the slowest coder, fast claude
  // coders that finished at 30s would sit idle for 14 min. Instead, we fire
  // each coder dispatch and immediately move on. Their results land in the
  // state files (writeAxiomState in the watcher API) and isAgentRunning skips
  // them on the next cycle until they finish. This keeps cycle cadence tied
  // to manager planning, not coder execution.
  let codDispatched = 0;
  let codSkippedRunning = 0;
  let codSkippedNoAlloc = 0;
  let codSkippedIdleTeam = 0;
  for (let n = 1; n <= 10; n++) {
    // Defense-in-depth: even if a misbehaving manager allocated coder tasks
    // for a team with 0 scoped items in the active phase, refuse to dispatch
    // them. The hardening-fallback bug had 60% of cycle-N coder slots going
    // to idle teams while m9 starved — this is the backstop in case the
    // brief change doesn't fully land.
    const teamHint = roadmapHints ? roadmapHints.get(n) : null;
    if (teamHint && teamHint.total === 0) {
      // Count any phantom allocations against codSkippedIdleTeam.
      const phantom = lastRoundAllocations.get(n) || { 1: null, 2: null, 3: null };
      codSkippedIdleTeam += [1, 2, 3].filter((c) => phantom[c]).length;
      continue;
    }
    const teamAlloc = lastRoundAllocations.get(n) || { 1: null, 2: null, 3: null };
    for (let c = 1; c <= 3; c++) {
      if (await isAgentRunning(`axiom:axiom-coder-${n}-${c}`)) {
        codSkippedRunning++;
        continue;
      }
      const assignedTask = teamAlloc[c];
      if (!assignedTask) {
        codSkippedNoAlloc++;
        continue;
      }
      const delay = stagger; stagger += STAGGER_MS;
      const team = n;
      const coderIndex = c;
      setTimeout(() => {
        callCoder(team, coderIndex, assignedTask)
          .then((r) => {
            const tag = r.ok ? 'ok' : 'fail';
            process.stdout.write(`[axiom-driver] c${coderIndex}/m${team} ${tag} in ${r.dur}s${r.ok ? '' : ` — ${(r.reply || '').replace(/\s+/g, ' ').slice(0, 120)}`}\n`);
          })
          .catch((err) => {
            process.stdout.write(`[axiom-driver] c${coderIndex}/m${team} threw: ${err?.message || err}\n`);
          });
      }, delay);
      codDispatched++;
    }
  }
  process.stdout.write(`[axiom-driver] cycle=${cycleNum} dispatching ${mgrTasks.length} managers (await) + ${codDispatched} coders (fire-and-forget) [${codSkippedRunning} skip:running, ${codSkippedNoAlloc} skip:no-alloc, ${codSkippedIdleTeam} skip:idle-team]\n`);

  // Cycle awaits ONLY managers — coders trickle in async via state files.
  const mgrResults = await Promise.all(mgrTasks);
  const codResults = []; // intentionally empty: coders are async this cycle
  const mgrOk = mgrResults.filter((r) => r.ok).length;
  const codOk = 0;

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
  const nextAllocCount = countAllocations(newAllocations);

  const allResults = [...mgrResults, ...codResults];
  const dispatched = mgrResults.length;
  const ok = mgrOk;
  const fail = dispatched - ok;
  // Auto-complete: only fire on the LAST phase. For earlier phases that
  // close, just keep looping — the API's currentPhase advances on its own
  // (first-incomplete logic), and the CEO will pick up the new phase next
  // cycle. Empty milestones in the new phase trigger auto-scope.
  const isFinalPhase = currentPhase >= 5;
  const manifestComplete = roadmapComplete(roadmapHints)
    && codDispatched === 0
    && codSkippedRunning === 0
    && nextAllocCount === 0
    && managersDeclaredPhaseComplete(mgrResults, currentPhase);
  const ceoComplete = ceoMilestoneComplete && codDispatched === 0 && codSkippedRunning === 0 && nextAllocCount === 0;
  // Only pause if this is the FINAL phase or operator has set explicit pause-on-phase-close.
  const pauseOnPhaseClose = process.env.WATCH_AXIOM_DRIVER_PAUSE_ON_PHASE_CLOSE === '1';
  const autoComplete = (isFinalPhase || pauseOnPhaseClose) && (manifestComplete || ceoComplete);
  if ((manifestComplete || ceoComplete) && !autoComplete) {
    process.stdout.write(`[axiom-driver] cycle=${cycleNum} phase ${currentPhase} closed — auto-advancing (set WATCH_AXIOM_DRIVER_PAUSE_ON_PHASE_CLOSE=1 to pause instead)\n`);
  }
  process.stdout.write(`[axiom-driver] cycle=${cycleNum} mgr-done: ${ok}/${dispatched} ok, ${fail} failed in ${Math.round((Date.now() - Date.parse(startedAt)) / 1000)}s (coders still running async)\n`);
  if (autoComplete) {
    const reason = ceoComplete ? 'CEO declared MILESTONE COMPLETE' : `managers declared PHASE-${currentPhase} SCOPE COMPLETE`;
    process.stdout.write(`[axiom-driver] cycle=${cycleNum} auto-complete: ${reason}, no coder allocations/running coders\n`);
  }

  // Quality feedback: diff built items vs the snapshot the cycle started
  // from. Tells the CEO concretely which deliverables flipped to ✓ this
  // cycle (the work that LANDED) vs which managers reported success but
  // didn't move the roadmap (= path-drift incidents).
  const currentBuilt = roadmap?.builtIds || new Set();
  const newlyBuilt = [];
  for (const id of currentBuilt) if (!prevBuiltSet.has(id)) newlyBuilt.push(id);
  prevBuiltSet = currentBuilt;

  const cycleBrief = (() => {
    const mgrLines = mgrResults.map((r) => `m${r.team}=${r.ok ? 'ok' : 'fail'}${r.dur ? `(${r.dur}s)` : ''}`).join(' ');
    const builtLine = newlyBuilt.length ? ` · newly built (${newlyBuilt.length}): ${newlyBuilt.slice(0, 8).join(', ')}` : ' · NO items flipped to built (path drift suspected)';
    return `c${cycleNum}: ${mgrLines || '(no managers)'} · coders dispatched=${codDispatched} skip:idle-team=${codSkippedIdleTeam}${ceoDelegation ? ' · CEO-led' : ''}${ceoMilestoneComplete ? ' · CEO-declared-complete' : ''}${builtLine}`;
  })();
  lastCycleSummary = cycleBrief;

  return { startedAt, cycleNum, currentPhase, dispatched, completed: ok, failed: fail, skipped: mgrSkipped + codSkipped, results: allResults, allocCount: codDispatched, nextAllocCount, codSkippedRunning, autoComplete, ceoLed: Boolean(ceoDelegation), ceoMilestoneComplete };
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
    if (budgetPct >= CAP_WARN_PCT) {
      process.stdout.write(`[axiom-driver] WARN: budget at $${spend.toFixed(2)}/$${cap.toFixed(2)} (${budgetPct.toFixed(0)}%) — continuing until ${CAP_HEADROOM_PCT}%\n`);
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
    if (cycle.autoComplete) {
      const completedAt = new Date().toISOString();
      const phaseTag = `PHASE-${cycle.currentPhase ?? 0}`;
      try {
        await fs.writeFile(PAUSE_FILE, `AXIOM autopilot auto-paused at ${completedAt}: roadmap complete, managers declared ${phaseTag} SCOPE COMPLETE, and no coder allocations/running coders.\n`, 'utf8');
      } catch {}
      await writeState({ status: 'completed', completedAt, cycleNum, interval, lastCycleAt: cycle.startedAt, lastCycle: cycle });
      summarizeCycle(cycle).catch((err) => process.stderr.write(`[axiom-driver] summarize: ${err.message}\n`));
      await tg('sendMessage', { text: `🤖 AXIOM autopilot complete — all managers declared ${phaseTag} SCOPE COMPLETE, no coder work remains, and the driver auto-paused at ${PAUSE_FILE}.` });
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
