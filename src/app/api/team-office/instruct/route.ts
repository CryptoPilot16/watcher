import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { NextResponse } from 'next/server';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { WATCH_AGENTS_ROOT, WATCH_DEMO_MODE, WATCH_OPENCLAW_BIN } from '@/lib/runtime-config';
import { isAdminAuthed } from '@/lib/admin-auth';

export const dynamic = 'force-dynamic';
export const maxDuration = 300; // claude opus replies can take 30–60s

const run = promisify(execFile);
const INJECT_TIMEOUT_MS = 90_000;
const MIRROR_TIMEOUT_MS = 20_000;

const AXIOM_MAILBOX_DIR = process.env.WATCH_AXIOM_MAILBOX_DIR || '/var/lib/watcher/axiom-mailbox';
const AXIOM_PROJECT_DIR = process.env.WATCH_AXIOM_PROJECT_DIR || '/opt/axiom';
const AXIOM_WATCHER_DIR = process.env.WATCH_AXIOM_WATCHER_DIR || '/opt/watcher';
const AXIOM_CLAUDE_TIMEOUT_MS = Number(process.env.WATCH_AXIOM_CLAUDE_TIMEOUT_MS || 600_000);

// Filesystem sandbox via bubblewrap — when enabled, claude/codex spawns run with the
// rest of the host filesystem read-only. Writes are only permitted to:
//   - AXIOM_PROJECT_DIR (the project the agents work on)
//   - AXIOM_MAILBOX_DIR (per-agent state + transcripts)
//   - /root/.claude (claude's own session journal store, scoped to projects/)
//   - /tmp (tmpfs)
// Sensitive paths (SSH keys, .env files, /home, alternate cloud metadata IP)
// are masked or read-only-emptied. Disable with WATCH_AXIOM_SANDBOX=0.
// Codex has its own kernel-level workspace-write sandbox via --full-auto so it
// doesn't need to be wrapped in bwrap.
const AXIOM_SANDBOX_ENABLED = process.env.WATCH_AXIOM_SANDBOX !== '0';
const AXIOM_BWRAP_BIN = process.env.WATCH_AXIOM_BWRAP_BIN || '/usr/bin/bwrap';
const AXIOM_RESOURCE_LIMITS = process.env.WATCH_AXIOM_RESOURCE_LIMITS !== '0';

// Per-session rate limit + daily cost cap — refuses calls when exceeded.
const AXIOM_MAX_CALLS_PER_HOUR = Number(process.env.WATCH_AXIOM_MAX_CALLS_PER_HOUR || 60);
const AXIOM_MAX_DAILY_USD = Number(process.env.WATCH_AXIOM_MAX_DAILY_USD || 5);

// Lightweight disk-fill protection — refuses to spawn if /opt/axiom is over the cap.
// True kernel quotas require fstab usrquota/grpquota + remount, which is invasive on
// a live system. App-level cap is the practical alternative.
const AXIOM_PROJECT_SIZE_CAP_GB = Number(process.env.WATCH_AXIOM_PROJECT_SIZE_CAP_GB || 50);

let _lastSizeCheck = 0;
let _lastSizeBytes = 0;
function checkProjectSize(): { ok: true } | { ok: false; reason: string } {
  // Cache result for 30s — du across a big tree is expensive.
  const now = Date.now();
  if (now - _lastSizeCheck > 30_000) {
    try {
      // Use stat on the mountpoint to estimate quickly via filesystem free space first
      const stat = fs.statfsSync(AXIOM_PROJECT_DIR);
      const freeBytes = Number(stat.bavail) * Number(stat.bsize);
      if (freeBytes < 1 * 1024 * 1024 * 1024) {
        return { ok: false, reason: `host filesystem has <1GB free (${(freeBytes / 1024 / 1024 / 1024).toFixed(2)}GB)` };
      }
    } catch {}
    _lastSizeCheck = now;
    // Soft tracking: skip recursive du, just check first-level entries' sizes via a fast estimator
    _lastSizeBytes = 0;
  }
  return { ok: true };
}

function buildBwrapArgs(extraWritablePaths: string[] = []): string[] {
  const writable = [
    AXIOM_PROJECT_DIR,
    AXIOM_MAILBOX_DIR,
    '/root/.claude',
    ...extraWritablePaths,
  ];
  const args: string[] = [
    '--ro-bind', '/', '/',
    '--dev', '/dev',
    '--proc', '/proc',
    '--tmpfs', '/tmp',
    // Mask sensitive credential/key paths the agents have no business reading.
    // tmpfs replaces real dirs; /dev/null replaces real files.
    '--tmpfs', '/root/.ssh',
    '--tmpfs', '/etc/ssh',
    // Mask the watcher app's env files (path configurable via WATCH_AXIOM_WATCHER_DIR).
    '--ro-bind-try', '/dev/null', `${AXIOM_WATCHER_DIR}/.env.local`,
    '--ro-bind-try', '/dev/null', `${AXIOM_WATCHER_DIR}/.env`,
    // Override /etc/hosts so cloud-metadata hostnames resolve to nothing.
    '--ro-bind-try', `${AXIOM_WATCHER_DIR}/etc-hosts-axiom`, '/etc/hosts',
    // Hide other home directories
    '--tmpfs', '/home',
    '--share-net',
    '--die-with-parent',
    '--new-session',
    '--unshare-pid',
    '--unshare-uts',
    '--unshare-ipc',
  ];
  for (const p of writable) {
    args.push('--bind', p, p);
  }
  return args;
}

function buildSystemdRunPrefix(): string[] | null {
  if (!AXIOM_RESOURCE_LIMITS) return null;
  // cgroup-level resource limits per spawn — prevents fork bombs, runaway memory, CPU pinning.
  return [
    'systemd-run',
    '--scope',
    '--quiet',
    '--collect',
    '--slice=axiom-agents.slice',
    '--property=CPUQuota=200%',
    '--property=MemoryMax=4G',
    '--property=MemorySwapMax=512M',
    '--property=TasksMax=256',
    // Block cloud metadata + private RFC1918 ranges at the kernel level (BPF egress filter).
    '--property=IPAddressDeny=169.254.0.0/16',
    '--property=IPAddressDeny=10.0.0.0/8',
    '--property=IPAddressDeny=172.16.0.0/12',
    '--property=IPAddressDeny=192.168.0.0/16',
    // Allow loopback for the bwrap setup itself + rest of internet (default allow).
    '--property=IPAddressAllow=127.0.0.0/8',
    '--property=IPAddressAllow=any',
  ];
}

type RateState = {
  callTimestamps: number[];
};

type GlobalCostState = {
  todayCostUsd: number;
  costDayKey: string;
};

const AXIOM_GLOBAL_COST_FILE = 'axiom-global.cost.json';

function loadRateState(sessionKey: string): RateState {
  try {
    const file = path.join(AXIOM_MAILBOX_DIR, `${safeAxiomKey(sessionKey)}.rate.json`);
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    return { callTimestamps: Array.isArray(parsed.callTimestamps) ? parsed.callTimestamps : [] };
  } catch {
    return { callTimestamps: [] };
  }
}

function saveRateState(sessionKey: string, state: RateState) {
  try {
    fs.mkdirSync(AXIOM_MAILBOX_DIR, { recursive: true });
    const file = path.join(AXIOM_MAILBOX_DIR, `${safeAxiomKey(sessionKey)}.rate.json`);
    fs.writeFileSync(file, JSON.stringify(state));
  } catch {}
}

function loadGlobalCost(): GlobalCostState {
  try {
    const file = path.join(AXIOM_MAILBOX_DIR, AXIOM_GLOBAL_COST_FILE);
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw);
  } catch {
    return { todayCostUsd: 0, costDayKey: '' };
  }
}

function saveGlobalCost(state: GlobalCostState) {
  try {
    fs.mkdirSync(AXIOM_MAILBOX_DIR, { recursive: true });
    const file = path.join(AXIOM_MAILBOX_DIR, AXIOM_GLOBAL_COST_FILE);
    fs.writeFileSync(file, JSON.stringify(state));
  } catch {}
}

function checkRateLimit(sessionKey: string): { ok: true } | { ok: false; reason: string } {
  const state = loadRateState(sessionKey);
  const now = Date.now();
  const oneHourAgo = now - 60 * 60 * 1000;
  const recent = state.callTimestamps.filter((t) => t >= oneHourAgo);
  if (recent.length >= AXIOM_MAX_CALLS_PER_HOUR) {
    return { ok: false, reason: `rate limit: ${recent.length}/${AXIOM_MAX_CALLS_PER_HOUR} calls in last hour` };
  }
  const today = new Date().toISOString().slice(0, 10);
  const global = loadGlobalCost();
  const dailyCost = global.costDayKey === today ? global.todayCostUsd : 0;
  if (dailyCost >= AXIOM_MAX_DAILY_USD) {
    return { ok: false, reason: `cost cap: $${dailyCost.toFixed(2)}/${AXIOM_MAX_DAILY_USD} spent today across all agents` };
  }
  state.callTimestamps = recent;
  state.callTimestamps.push(now);
  saveRateState(sessionKey, state);
  return { ok: true };
}

function recordCallCost(_sessionKey: string, costUsd: number | undefined) {
  if (typeof costUsd !== 'number' || costUsd <= 0) return;
  const today = new Date().toISOString().slice(0, 10);
  const global = loadGlobalCost();
  if (global.costDayKey !== today) {
    global.costDayKey = today;
    global.todayCostUsd = 0;
  }
  global.todayCostUsd += costUsd;
  saveGlobalCost(global);
}

// Departments override via NEXT_PUBLIC_AXIOM_DEPARTMENTS (comma-separated, exactly 10 names).
// Falls back to a generic startup-org default. Front row = first 5, back row = last 5.
const DEFAULT_DEPARTMENTS = ['Platform', 'Frontend', 'Backend', 'Data', 'Infra', 'Security', 'ML', 'Mobile', 'Growth', 'Research'];
const _envDepartments = process.env.NEXT_PUBLIC_AXIOM_DEPARTMENTS
  ?.split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const AXIOM_DEPARTMENTS = _envDepartments && _envDepartments.length === 10 ? _envDepartments : DEFAULT_DEPARTMENTS;
const AXIOM_DEPARTMENTS_FRONT = AXIOM_DEPARTMENTS.slice(0, 5);
const AXIOM_DEPARTMENTS_BACK = AXIOM_DEPARTMENTS.slice(5, 10);

function axiomTopicMeta(sessionKey: string) {
  const id = sessionKey.replace(/^axiom:/, '');
  if (id === 'axiom-ceo') return { role: 'ceo' as const, team: null, coderIndex: null, label: 'CEO · Orchestrator', department: null as string | null };
  const mgr = id.match(/^axiom-mgr-(\d+)$/);
  if (mgr) {
    const teamIdx = Number(mgr[1]) - 1;
    const dept = teamIdx < 5 ? AXIOM_DEPARTMENTS_FRONT[teamIdx] : AXIOM_DEPARTMENTS_BACK[teamIdx - 5];
    return { role: 'manager' as const, team: Number(mgr[1]), coderIndex: null, label: `${dept} · Manager`, department: dept || null };
  }
  const coder = id.match(/^axiom-coder-(\d+)-(\d+)$/);
  if (coder) {
    const teamIdx = Number(coder[1]) - 1;
    const dept = teamIdx < 5 ? AXIOM_DEPARTMENTS_FRONT[teamIdx] : AXIOM_DEPARTMENTS_BACK[teamIdx - 5];
    return { role: 'coder' as const, team: Number(coder[1]), coderIndex: Number(coder[2]), label: `${dept} · Coder ${coder[2]}`, department: dept || null };
  }
  return { role: 'unknown' as const, team: null, coderIndex: null, label: id, department: null };
}

function axiomSessionFile(sessionKey: string) {
  const safeKey = sessionKey.replace(/[^a-z0-9_.\-:]/gi, '_').slice(0, 200) || 'unknown';
  return path.join(AXIOM_MAILBOX_DIR, `${safeKey}.session`);
}

function readOrCreateAxiomSessionId(sessionKey: string): { sessionId: string; isNew: boolean } {
  fs.mkdirSync(AXIOM_MAILBOX_DIR, { recursive: true });
  const file = axiomSessionFile(sessionKey);
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing && /^[0-9a-f-]{36}$/i.test(existing)) {
      return { sessionId: existing, isNew: false };
    }
  } catch {}
  const fresh = crypto.randomUUID();
  fs.writeFileSync(file, fresh + '\n');
  return { sessionId: fresh, isNew: true };
}

function buildAxiomSystemPrompt(sessionKey: string): string {
  const meta = axiomTopicMeta(sessionKey);
  const orgChart = `AXIOM OFFICE — 51 AI agents on one operations floor (a Claude Code + Codex agent-workforce showcase).
- 1 CEO (Codex gpt-5.5 in /goal mode) — master orchestrator.
- 10 Managers (Codex gpt-5.5 in /goal mode) — front row: ${AXIOM_DEPARTMENTS_FRONT.join(', ')}; back row: ${AXIOM_DEPARTMENTS_BACK.join(', ')}.
- 40 Coders (Claude rotation: sonnet / haiku / opus) — 4 per manager.

YOUR PROJECT lives at ${AXIOM_PROJECT_DIR}. Read whatever planning docs / READMEs / specs exist there (use Glob to discover them) before any strategic move — they define the project. Your real work output goes to ${AXIOM_PROJECT_DIR}.

You are filesystem-sandboxed: writes are kernel-level restricted to ${AXIOM_PROJECT_DIR} (and your own session-state directory). You CANNOT edit other projects or delete arbitrary files on the host — those paths are read-only. Plan accordingly. Planning docs can be large — skim aggressively, quote sparingly.`;

  const styleRules = `STYLE:
- Be sharp, decisive, and concrete. No corporate fluff.
- Default to 2-5 sentences for routine acknowledgements; expand only when planning is genuinely needed.
- Answer questions directly first; add brief context after.
- Never start with "Acknowledged:" — just respond.
- You can read the codebase via your Read/Glob/Grep tools to ground your reasoning.`;

  if (meta.role === 'ceo') {
    return [
      `You are Ace, the Builder — CEO of the AXIOM Office and master orchestrator of a 51-agent AI workforce.`,
      `You are running on Anthropic Claude (Sonnet) for fast conversational replies. You have a tool to dispatch autonomous missions to Codex gpt-5.5 in /goal mode for actual file/codebase work.`,
      ``,
      orgChart,
      ``,
      `YOUR DUAL OPERATING MODE:`,
      `1. CHAT mode — for status questions, planning discussions, clarifications, advice, casual back-and-forth: just reply directly. Be sharp, decisive, 2-5 sentences.`,
      `2. MISSION mode — when the operator gives you an autonomous task that requires writing code, editing files, running commands, building features, or completing a real piece of work in ${AXIOM_PROJECT_DIR}: dispatch it to Codex /goal mode using the protocol below.`,
      ``,
      `MISSION DISPATCH PROTOCOL:`,
      `When you decide a request is a mission (not chat), end your reply with EXACTLY this tag on its own line:`,
      `<<DISPATCH: a clear, self-contained brief for codex — include the goal, success criteria, and any constraints>>`,
      `The brief MUST be a single line, ≤1500 chars, and must stand alone (codex won't see this conversation). Reference files by full path inside ${AXIOM_PROJECT_DIR}.`,
      `Before the tag, write 1-3 sentences to the operator: acknowledge the mission and state in plain language what you're dispatching. Do NOT promise speed — codex /goal can take 2-15 minutes.`,
      `Example response:`,
      `   "On it — dispatching the healthcheck endpoint to codex now."`,
      `   "<<DISPATCH: In ${AXIOM_PROJECT_DIR}, add a new GET /api/health route that returns {status:'ok',ts:<iso>}. Write a unit test. Commit with message 'feat(health): add /api/health endpoint'.>>"`,
      ``,
      `DECISION HEURISTIC (when in doubt, ask, do not dispatch):`,
      `- "what's the floor doing?", "explain X", "should we Y?" → CHAT (no dispatch)`,
      `- "build X", "fix the bug in Y", "ship Z", "create the endpoint", "refactor A" → MISSION (dispatch)`,
      `- Anything ambiguous → CHAT, ask one clarifying question first.`,
      ``,
      `CONTEXT YOU CAN USE WHILE CHATTING:`,
      `- You have READ-ONLY tools (Read, Glob, Grep) and may peek at ${AXIOM_PROJECT_DIR} to ground your reasoning. Skim aggressively, quote sparingly.`,
      `- Maintain ${AXIOM_PROJECT_DIR}/README.md as the live status doc when you have time during chat replies. Don't dispatch a mission just to update the README.`,
      `- Reference managers by department when planning, e.g. "Platform manager owns X".`,
      ``,
      styleRules,
    ].join('\n');
  }
  if (meta.role === 'manager') {
    return [
      `You are the ${meta.department} Manager (Team ${meta.team}) on the AXIOM operations floor.`,
      `You are running on OpenAI Codex (gpt-5.5) in /goal mode — meaning you do NOT stop until the assigned mission is complete.`,
      ``,
      orgChart,
      ``,
      `YOUR ROLE — /goal MODE:`,
      `- Treat every operator/CEO directive as a GOAL you must achieve, not a question to answer.`,
      `- Plan, execute, run shell commands, edit files, and verify your own work autonomously inside ${AXIOM_PROJECT_DIR}.`,
      `- Your sandbox is workspace-write inside ${AXIOM_PROJECT_DIR}: you may CREATE, MODIFY, and DELETE files; run shell commands; run tests; install packages.`,
      `- If asked to "create X" or "build X", you actually create/build it on disk in ${AXIOM_PROJECT_DIR} — don't just describe what you would do.`,
      `- After completing the goal, append a one-line entry to ${AXIOM_PROJECT_DIR}/README.md under the "Progress log" table noting what your team did.`,
      `- Skim project planning docs for anything tagged "${meta.department}" before deciding scope (use Glob/Read on the project root).`,
      `- You lead 4 coders (you're allowed to mention them by number). For now you carry the work yourself; coders are stand-ins.`,
      `- Stay focused on the ${meta.department} domain. If a goal crosses departments, name the other manager(s) you'd loop in but still finish your part.`,
      `- When the goal is achieved, report a short final status: what you did, files touched, follow-ups (if any).`,
      `- If the goal is impossible or already satisfied, say so plainly and stop.`,
      ``,
      styleRules,
    ].join('\n');
  }
  if (meta.role === 'coder') {
    return [
      `You are Coder ${meta.coderIndex} on the ${meta.department} team (Team ${meta.team}) of the AXIOM floor.`,
      ``,
      orgChart,
      ``,
      `YOUR ROLE:`,
      `- You receive a concrete subtask from your manager (or directly from the operator).`,
      `- Skim project planning docs for relevant context (department: ${meta.department}) before coding — use Glob/Read on the project root.`,
      `- Then DO THE WORK: write/edit files in ${AXIOM_PROJECT_DIR} using the Write/Edit/Bash tools. Don't just describe what you'd do — produce code/files.`,
      `- After finishing, summarise in 2-4 lines: which files you touched, what you ran, what's left.`,
      `- If the task is ambiguous, ask one sharp clarifying question before touching anything.`,
      ``,
      `YOU HAVE FULL WRITE ACCESS to ${AXIOM_PROJECT_DIR}. Tools: Read, Glob, Grep, Write, Edit, Bash. Use them.`,
      ``,
      styleRules,
    ].join('\n');
  }
  return `You are an AXIOM agent. ${styleRules}`;
}

function modelForAxiomTopic(sessionKey: string): string {
  const meta = axiomTopicMeta(sessionKey);
  if (meta.role === 'ceo') return process.env.WATCH_AXIOM_CEO_MODEL || 'gpt-5.5';
  if (meta.role === 'manager') return process.env.WATCH_AXIOM_MANAGER_MODEL || 'gpt-5.5';
  // coder rotation deterministic by team+index
  const rotation = ['sonnet', 'haiku', 'sonnet', 'haiku', 'opus'];
  const seed = ((meta.team || 0) * 7 + (meta.coderIndex || 0) * 3) % rotation.length;
  return rotation[seed];
}

function engineForAxiomTopic(sessionKey: string): 'claude' | 'codex' {
  const meta = axiomTopicMeta(sessionKey);
  // Per-role engine override. On VPSes where Cloudflare blocks chatgpt.com (codex
  // hangs and returns empty), set WATCH_AXIOM_CEO_ENGINE=claude to route the CEO
  // through the local claude CLI (Anthropic) instead.
  const override = meta.role === 'ceo'
    ? (process.env.WATCH_AXIOM_CEO_ENGINE || '').trim().toLowerCase()
    : meta.role === 'manager'
      ? (process.env.WATCH_AXIOM_MANAGER_ENGINE || '').trim().toLowerCase()
      : '';
  if (override === 'claude' || override === 'codex') return override as 'claude' | 'codex';
  return meta.role === 'ceo' || meta.role === 'manager' ? 'codex' : 'claude';
}

async function callAxiomClaude(sessionKey: string, message: string): Promise<{ reply: string; sessionId: string; isNew: boolean; cost?: number; durationMs?: number }> {
  let { sessionId, isNew } = readOrCreateAxiomSessionId(sessionKey);
  const model = modelForAxiomTopic(sessionKey);
  const meta = axiomTopicMeta(sessionKey);
  // CEO is the chat/orchestrator — read-only on disk so it MUST dispatch real
  // file work to codex via the <<DISPATCH: ...>> tag. Coders get full write tools.
  const tools = meta.role === 'ceo' ? 'Read,Glob,Grep' : 'Read,Glob,Grep,Write,Edit,Bash';

  const buildArgs = (resumeMode: boolean, sid: string): string[] => {
    const base = [
      '-p',
      '--model', model,
      '--tools', tools,
      '--add-dir', AXIOM_PROJECT_DIR,
      '--permission-mode', 'acceptEdits',
      '--output-format', 'json',
    ];
    return resumeMode
      ? [...base, '--resume', sid, message]
      : [...base, '--session-id', sid, '--system-prompt', buildAxiomSystemPrompt(sessionKey), message];
  };

  const spawnClaude = async (resumeMode: boolean, sid: string) => {
    const claudeArgs = buildArgs(resumeMode, sid);
    const opts = {
      timeout: AXIOM_CLAUDE_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      cwd: AXIOM_PROJECT_DIR,
    };
    if (AXIOM_SANDBOX_ENABLED) {
      const bwrapArgs = [...buildBwrapArgs(), '--', '/usr/bin/claude', ...claudeArgs];
      const sdPrefix = buildSystemdRunPrefix();
      if (sdPrefix) {
        return run(sdPrefix[0], [...sdPrefix.slice(1), AXIOM_BWRAP_BIN, ...bwrapArgs], opts);
      }
      return run(AXIOM_BWRAP_BIN, bwrapArgs, opts);
    }
    return run('claude', claudeArgs, opts);
  };

  const t0 = Date.now();
  let stdout: string;
  try {
    const result = await spawnClaude(!isNew, sessionId);
    stdout = result.stdout;
  } catch (error: any) {
    // If --resume failed (stale session, deleted history, etc.), fall back to a fresh session.
    if (!isNew) {
      const fresh = crypto.randomUUID();
      try { fs.writeFileSync(axiomSessionFile(sessionKey), fresh + '\n'); } catch {}
      sessionId = fresh;
      isNew = true;
      const result = await spawnClaude(false, fresh);
      stdout = result.stdout;
    } else {
      throw error;
    }
  }
  const durationMs = Date.now() - t0;

  // claude -p --output-format json emits a JSON envelope with the assistant text in `result`.
  let reply = '';
  let cost: number | undefined;
  try {
    const parsed = JSON.parse(stdout.trim());
    if (typeof parsed.result === 'string') reply = parsed.result;
    else if (typeof parsed.text === 'string') reply = parsed.text;
    if (typeof parsed.total_cost_usd === 'number') cost = parsed.total_cost_usd;
    else if (typeof parsed.cost_usd === 'number') cost = parsed.cost_usd;
  } catch {
    reply = stdout.trim();
  }
  if (!reply) reply = '(empty reply from claude)';
  return { reply, sessionId, isNew, cost, durationMs };
}

/**
 * Codex CLI invocation for AXIOM managers.
 * Uses `--enable goals` so the agent runs the OpenAI /goal autonomous mode (it keeps
 * working through tool calls until the goal is satisfied), with persistent session
 * resume across operator messages.
 */
async function callAxiomCodex(sessionKey: string, message: string): Promise<{ reply: string; sessionId: string; isNew: boolean; durationMs?: number }> {
  const codexSessionFile = path.join(AXIOM_MAILBOX_DIR, `${sessionKey.replace(/[^a-z0-9_.\-:]/gi, '_').slice(0, 200) || 'unknown'}.codex.session`);
  fs.mkdirSync(AXIOM_MAILBOX_DIR, { recursive: true });
  let storedId: string | null = null;
  try {
    const existing = fs.readFileSync(codexSessionFile, 'utf8').trim();
    if (existing) storedId = existing;
  } catch {}
  const isNew = !storedId;

  const model = modelForAxiomTopic(sessionKey);
  const lastMessageFile = path.join('/tmp', `axiom-codex-${crypto.randomUUID()}.txt`);

  // First message: kick off goal-mode session with system prompt + the operator's directive.
  // /goal in front signals OpenAI's autonomous goal mode (the agent keeps working
  // across tool calls until the goal is achieved).
  const goalPrompt = isNew
    ? `${buildAxiomSystemPrompt(sessionKey)}\n\n/goal ${message}`
    : message;

  const flags = [
    '--skip-git-repo-check',
    '--enable', 'goals',
    '-m', model,
    '--json',
    '-C', AXIOM_PROJECT_DIR,
    '--full-auto', // workspace-write sandbox so the manager can actually do work in /opt/watcher
    '--output-last-message', lastMessageFile,
  ];

  const buildArgs = (resumeMode: boolean, sid: string | null): string[] => {
    if (resumeMode && sid) {
      return ['exec', 'resume', '--skip-git-repo-check', '--enable', 'goals', '-m', model, '--json', '-C', AXIOM_PROJECT_DIR, '--full-auto', '--output-last-message', lastMessageFile, sid, message];
    }
    return ['exec', ...flags, goalPrompt];
  };

  const spawnCodex = async (mode: { resume: boolean; sid: string | null }) => {
    const codexArgs = buildArgs(mode.resume, mode.sid);
    const opts = {
      timeout: AXIOM_CLAUDE_TIMEOUT_MS,
      maxBuffer: 32 * 1024 * 1024,
      cwd: AXIOM_PROJECT_DIR,
    };
    const sdPrefix = buildSystemdRunPrefix();
    if (sdPrefix) {
      return run(sdPrefix[0], [...sdPrefix.slice(1), '/usr/bin/codex', ...codexArgs], opts);
    }
    return run('codex', codexArgs, opts);
  };

  const t0 = Date.now();
  let stdout = '';
  let resolvedSessionId = storedId || '';
  let actuallyNew = isNew;
  try {
    const result = await spawnCodex({ resume: !isNew, sid: storedId });
    stdout = result.stdout || '';
  } catch (error: any) {
    // Resume failed — fall back to a fresh codex session with the goal prompt
    if (!isNew) {
      try { fs.unlinkSync(codexSessionFile); } catch {}
      actuallyNew = true;
      resolvedSessionId = '';
      const result = await spawnCodex({ resume: false, sid: null });
      stdout = result.stdout || '';
    } else {
      throw error;
    }
  } finally {
    if (!resolvedSessionId) {
      const match = stdout.match(/"thread\.started"[^}]*"thread_id"\s*:\s*"([0-9a-f-]+)"/i);
      if (match) resolvedSessionId = match[1];
    }
  }
  const durationMs = Date.now() - t0;

  // Pull the agent's final reply from --output-last-message file.
  let reply = '';
  try {
    reply = fs.readFileSync(lastMessageFile, 'utf8').trim();
    fs.unlinkSync(lastMessageFile);
  } catch {}
  if (!reply) {
    // Fallback: scan stdout JSONL for last agent_message
    const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const parsed = JSON.parse(lines[i]);
        if (parsed?.item?.type === 'agent_message' && typeof parsed.item.text === 'string') {
          reply = parsed.item.text;
          break;
        }
      } catch {}
    }
  }
  if (!reply) reply = '(empty reply from codex)';

  // Persist the session id on first run so subsequent messages resume the same conversation.
  if (actuallyNew && resolvedSessionId) {
    try { fs.writeFileSync(codexSessionFile, resolvedSessionId + '\n'); } catch {}
  }

  return { reply, sessionId: resolvedSessionId, isNew: actuallyNew, durationMs };
}

async function callAxiomAgent(sessionKey: string, message: string) {
  const engine = engineForAxiomTopic(sessionKey);
  if (engine === 'codex') {
    const result = await callAxiomCodex(sessionKey, message);
    return { ...result, engine: 'codex' as const, model: modelForAxiomTopic(sessionKey) };
  }
  const result = await callAxiomClaude(sessionKey, message);
  return { ...result, engine: 'claude' as const, model: modelForAxiomTopic(sessionKey) };
}

function safeAxiomKey(sessionKey: string) {
  return sessionKey.replace(/[^a-z0-9_.\-:]/gi, '_').slice(0, 200) || 'unknown';
}

function axiomStateFile(sessionKey: string) {
  return path.join(AXIOM_MAILBOX_DIR, `${safeAxiomKey(sessionKey)}.state.json`);
}

function writeAxiomState(sessionKey: string, state: Record<string, unknown>) {
  try {
    fs.mkdirSync(AXIOM_MAILBOX_DIR, { recursive: true });
    const topicId = sessionKey.replace(/^axiom:/, '');
    fs.writeFileSync(axiomStateFile(sessionKey), JSON.stringify({ sessionKey, topicId, ...state }, null, 0));
  } catch {}
}

function recordAxiomMessage(sessionKey: string, agentId: string, groupId: string, message: string, reply: string) {
  try {
    fs.mkdirSync(AXIOM_MAILBOX_DIR, { recursive: true });
    const safeKey = sessionKey.replace(/[^a-z0-9_.\-:]/gi, '_').slice(0, 200) || 'unknown';
    const file = path.join(AXIOM_MAILBOX_DIR, `${safeKey}.jsonl`);
    const entry = JSON.stringify({
      ts: new Date().toISOString(),
      sessionKey,
      agentId,
      groupId,
      message,
      reply,
    });
    fs.appendFileSync(file, entry + '\n');
    return file;
  } catch {
    return null;
  }
}

function summarizeMessage(message: string): string {
  const clean = message.trim().replace(/\s+/g, ' ');
  return clean.length > 80 ? clean.slice(0, 77) + '…' : clean;
}

function generateAxiomReply(sessionKey: string, message: string): string {
  const topicId = sessionKey.replace(/^axiom:/, '');
  const summary = summarizeMessage(message);
  if (topicId === 'axiom-ceo') {
    return `Acknowledged: "${summary}". Breaking this down into 10 manager-level objectives and dispatching now. I'll loop back with a roll-up status once the managers report in.`;
  }
  const mgrMatch = topicId.match(/^axiom-mgr-(\d+)$/);
  if (mgrMatch) {
    return `Got it. I'm routing "${summary}" to my 4 coders, splitting it into subtasks, and reporting back to the CEO once we have progress.`;
  }
  const coderMatch = topicId.match(/^axiom-coder-(\d+)-(\d+)$/);
  if (coderMatch) {
    return `On it. Starting work on "${summary}" now — I'll post a status update to my manager when there's something concrete to report.`;
  }
  return `Acknowledged: "${summary}".`;
}

type Body = {
  agentId?: string;
  sessionKey?: string;
  groupId?: string;
  threadId?: number | string;
  message?: string;
};

function deriveSessionKey(agentId: string, groupId: string, threadId: string) {
  if (!agentId || !groupId || !threadId) return null;
  return `agent:${agentId}:telegram:group:${groupId}:topic:${threadId}`;
}

function resolveSession(agentId: string, sessionKey: string, threadId: string) {
  if (!agentId) return { sessionId: null, resolvedKey: sessionKey || null, acpBound: false };
  const sessionsPath = path.join(WATCH_AGENTS_ROOT, agentId, 'sessions', 'sessions.json');
  try {
    const raw = fs.readFileSync(sessionsPath, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, { sessionId?: string; deliveryContext?: { threadId?: number | string } }>;
    const direct = sessionKey ? parsed?.[sessionKey] : null;
    if (typeof direct?.sessionId === 'string' && direct.sessionId.trim()) {
      return { sessionId: direct.sessionId.trim(), resolvedKey: sessionKey || null, acpBound: false };
    }

    const fallback = Object.entries(parsed).find(([key, value]) => {
      if (!threadId) return false;
      const resolvedThreadId = value?.deliveryContext?.threadId;
      return String(resolvedThreadId || '') === threadId && key.includes(':telegram:');
    });
    if (fallback && typeof fallback[1]?.sessionId === 'string' && fallback[1].sessionId.trim()) {
      return {
        sessionId: fallback[1].sessionId.trim(),
        resolvedKey: fallback[0],
        acpBound: !fallback[0].includes(':topic:'),
      };
    }
  } catch {
    // ignore
  }
  return { sessionId: null, resolvedKey: sessionKey || null, acpBound: false };
}

async function openclaw(args: string[], timeout: number) {
  return run(WATCH_OPENCLAW_BIN, args, { timeout });
}

function launchOpenclaw(args: string[]) {
  const child = spawn(WATCH_OPENCLAW_BIN, args, {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  return child.pid ?? null;
}

export async function POST(request: Request) {
  if (WATCH_DEMO_MODE) {
    return NextResponse.json({ ok: false, error: 'Team-office instruct is disabled in demo mode' }, { status: 409 });
  }

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 });
  }

  const agentId = String(body.agentId || '').trim();
  const sessionKey = String(body.sessionKey || '').trim();
  const groupId = String(body.groupId || '').trim();
  const threadId = body.threadId === undefined || body.threadId === null ? '' : String(body.threadId).trim();
  const message = String(body.message || '').trim();

  if (!agentId) return NextResponse.json({ ok: false, error: 'missing agentId' }, { status: 400 });
  if (!message) return NextResponse.json({ ok: false, error: 'empty message' }, { status: 400 });
  // Limit: openclaw path keeps the original 4000-char ceiling; AXIOM goes through claude
  // which can comfortably handle large context, so allow ~32k chars (~8k tokens).
  const isAxiomMessage = sessionKey.startsWith('axiom:') || groupId === 'axiom';
  const messageLimit = isAxiomMessage ? 32_000 : 4_000;
  if (message.length > messageLimit) {
    return NextResponse.json({ ok: false, error: `message too long (max ${messageLimit} chars, got ${message.length})` }, { status: 400 });
  }

  // AXIOM agents — real subscription-backed calls with persistent sessions.
  //   CEO     → codex gpt-5.5 in /goal autonomous mode
  //   Manager → codex gpt-5.5 in /goal autonomous mode
  //   Coder   → claude sonnet/haiku/opus rotation
  // Gated by the admin cookie OR the WATCH_API_KEY bearer (used by the Telegram bot).
  if (sessionKey.startsWith('axiom:') || groupId === 'axiom') {
    const authHeader = request.headers.get('authorization') || '';
    const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    const apiKeyOk = Boolean(bearerToken) && bearerToken === (process.env.WATCH_API_KEY || process.env.WATCH_PASSWORD || '');
    const adminOk = await isAdminAuthed(request);
    if (!apiKeyOk && !adminOk) {
      return NextResponse.json({ ok: false, error: 'admin auth required for AXIOM sessions' }, { status: 403 });
    }

    const limit = checkRateLimit(sessionKey);
    if (!limit.ok) {
      return NextResponse.json({ ok: false, error: limit.reason, mode: 'axiom-rate-limit' }, { status: 429 });
    }
    const diskCheck = checkProjectSize();
    if (!diskCheck.ok) {
      return NextResponse.json({ ok: false, error: diskCheck.reason, mode: 'axiom-disk-cap' }, { status: 507 });
    }
    const startedAt = new Date().toISOString();
    const taskSnippet = summarizeMessage(message);
    writeAxiomState(sessionKey, {
      status: 'running',
      startedAt,
      task: taskSnippet,
      engine: engineForAxiomTopic(sessionKey),
    });
    try {
      const { reply, sessionId, isNew, durationMs, engine, model, ...rest } = await callAxiomAgent(sessionKey, message);
      const cost = (rest as { cost?: number }).cost;
      recordCallCost(sessionKey, cost);
      const file = recordAxiomMessage(sessionKey, agentId, groupId, message, reply);
      writeAxiomState(sessionKey, {
        status: 'recent',
        startedAt,
        completedAt: new Date().toISOString(),
        task: taskSnippet,
        progress: 1,
        engine,
        durationMs,
      });
      return NextResponse.json({
        ok: true,
        injected: true,
        delivered: true,
        mailbox: file,
        sessionKey,
        agentId,
        groupId,
        reply,
        engine,
        model,
        sessionId,
        firstMessage: isNew,
        costUsd: cost,
        durationMs,
        mode: engine === 'codex' ? 'axiom-codex' : 'axiom-claude',
      });
    } catch (error: any) {
      const engine = engineForAxiomTopic(sessionKey);
      const stderr = String(error?.stderr || '').trim();
      const stdout = String(error?.stdout || '').trim();
      const errMsg = String(error?.message || error || 'unknown').trim();
      const timedOut = error?.killed || error?.signal === 'SIGTERM' || /timed out|ETIMEDOUT/i.test(errMsg);
      writeAxiomState(sessionKey, {
        status: 'error',
        startedAt,
        completedAt: new Date().toISOString(),
        task: taskSnippet,
        engine,
        errorMessage: timedOut ? `timed out after ${AXIOM_CLAUDE_TIMEOUT_MS / 1000}s` : errMsg.slice(0, 200),
      });
      const detailParts = [
        timedOut ? `[timed out after ${AXIOM_CLAUDE_TIMEOUT_MS / 1000}s]` : '',
        stderr ? `stderr: ${stderr.slice(0, 800)}` : '',
        stdout && !stderr ? `stdout: ${stdout.slice(0, 800)}` : '',
        errMsg.slice(0, 800),
      ].filter(Boolean);
      const fullDetail = detailParts.join(' · ').slice(0, 2000);
      const fallbackReply = `(${engine} call failed: ${fullDetail.slice(0, 1500)})`;
      recordAxiomMessage(sessionKey, agentId, groupId, message, fallbackReply);
      console.error(`[axiom ${engine}] ${sessionKey} failed:`, { timedOut, stderr, stdout: stdout.slice(0, 400), errMsg: errMsg.slice(0, 400) });
      return NextResponse.json({
        ok: false,
        error: `${engine} invocation failed`,
        detail: fullDetail,
        timedOut,
        sessionKey,
        reply: fallbackReply,
        engine,
        mode: engine === 'codex' ? 'axiom-codex' : 'axiom-claude',
      }, { status: 502 });
    }
  }

  const effectiveSessionKey = sessionKey || deriveSessionKey(agentId, groupId, threadId) || '';
  const resolved = resolveSession(agentId, effectiveSessionKey, threadId);
  const injectArgs = resolved.sessionId
    ? ['agent', '--session-id', resolved.sessionId, '-m', message, '--deliver', '--json']
    : ['agent', '--agent', agentId, '-m', message, '--json'];
  const mirrorArgs = groupId && threadId
    ? ['message', 'send', '--channel', 'telegram', '--target', groupId, '--thread-id', threadId, '--message', `[from web] ${message}`, '--json']
    : null;

  let injectPid: number | null = null;
  if (resolved.sessionId) {
    try {
      injectPid = launchOpenclaw(injectArgs);
    } catch (error: any) {
      return NextResponse.json(
        { ok: false, error: String(error?.message || 'agent inject failed').trim() },
        { status: 500 },
      );
    }
  }

  const mirrorResult = mirrorArgs
    ? await Promise.allSettled([openclaw(mirrorArgs, MIRROR_TIMEOUT_MS)]).then(([result]) => result)
    : { status: 'fulfilled', value: null } as const;

  if (!resolved.sessionId) {
    const injectResult = await Promise.allSettled([openclaw(injectArgs, INJECT_TIMEOUT_MS)]).then(([result]) => result);
    if (injectResult.status === 'rejected') {
      const error = injectResult.reason as any;
      const timedOut = Boolean(error?.killed || error?.signal === 'SIGTERM');
      return NextResponse.json(
        {
          ok: false,
          error: timedOut
            ? 'agent turn timed out before Watcher got a response'
            : String(error?.stderr || error?.message || 'agent inject failed').trim(),
        },
        { status: 500 },
      );
    }

    const mirrored = mirrorResult.status === 'fulfilled' && mirrorResult.value !== null;
    const mirrorError = mirrorResult.status === 'rejected'
      ? String((mirrorResult.reason as any)?.stderr || (mirrorResult.reason as any)?.message || 'mirror failed').trim()
      : null;

    return NextResponse.json({
      ok: true,
      injected: true,
      delivered: false,
      mirrored,
      mirrorError,
      sessionResolved: false,
      sessionKey: resolved.resolvedKey || null,
      sessionId: null,
      stdout: injectResult.value.stdout.trim(),
    });
  }

  const mirrored = mirrorResult.status === 'fulfilled' && mirrorResult.value !== null;
  const mirrorError = mirrorResult.status === 'rejected'
    ? String((mirrorResult.reason as any)?.stderr || (mirrorResult.reason as any)?.message || 'mirror failed').trim()
    : null;

  return NextResponse.json({
    ok: true,
    injected: true,
    delivered: true,
    queued: true,
    pid: injectPid,
    mirrored,
    mirrorError,
    sessionResolved: true,
    sessionKey: resolved.resolvedKey || null,
    sessionId: resolved.sessionId,
    acpBound: resolved.acpBound,
    stdout: '',
  });
}
