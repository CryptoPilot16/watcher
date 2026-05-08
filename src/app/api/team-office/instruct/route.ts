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

// runDetached spawns a child with stdin closed, mirroring execFile's
// promisified resolve/reject contract but routing via spawn so we can control
// stdio. Necessary because claude -p / codex exec wait up to 3s on an unclosed
// stdin pipe (the default for execFile), then warn and exit 1 with empty
// stdout — surfacing as "(empty reply)" to the operator. With stdin set to
// 'ignore', the CLI reads the prompt from -p / argv immediately.
type RunDetachedOpts = {
  timeout?: number;
  maxBuffer?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};
function runDetached(file: string, args: string[], opts: RunDetachedOpts = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const maxBuffer = opts.maxBuffer ?? 16 * 1024 * 1024;
    // stdin is a pipe we close immediately. Two reasons:
    //   1) `'ignore'` (which redirects to /dev/null) makes claude hang for some
    //      reason — even though its own warning suggests "< /dev/null" works.
    //   2) An open-but-unclosed pipe (the default for the lower-level spawn)
    //      makes claude wait 3s on stdin then exit with empty stdout.
    // Closing the pipe from the parent side mimics what execFile does and
    // gives claude an immediate EOF on stdin, so it proceeds with -p prompt.
    const child = spawn(file, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    try { child.stdin?.end(); } catch {}
    let stdout = '';
    let stderr = '';
    let killedForBuffer = false;
    let killedForTimeout = false;
    let timer: NodeJS.Timeout | null = null;
    if (opts.timeout && opts.timeout > 0) {
      timer = setTimeout(() => { killedForTimeout = true; try { child.kill('SIGTERM'); } catch {} }, opts.timeout);
    }
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      if (stdout.length > maxBuffer) { killedForBuffer = true; try { child.kill('SIGTERM'); } catch {} }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
      if (stderr.length > maxBuffer) { killedForBuffer = true; try { child.kill('SIGTERM'); } catch {} }
    });
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const reason = killedForTimeout ? `timeout` : killedForBuffer ? `buffer-overflow` : `exit ${code}${signal ? ` signal ${signal}` : ''}`;
        const err: any = new Error(`Command failed (${reason}): ${file} ${args.slice(0, 4).join(' ')}…`);
        err.code = code;
        err.signal = signal;
        err.stdout = stdout;
        err.stderr = stderr;
        err.timedOut = killedForTimeout;
        reject(err);
      }
    });
  });
}
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
const AXIOM_MAX_DAILY_USD = Number(process.env.WATCH_AXIOM_MAX_DAILY_USD || 10);

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
  ];
  // Mask the watcher app's env files. Only bind over targets that exist on the
  // host — bwrap cannot create a missing target file under the read-only root,
  // and `--ro-bind-try` only handles a missing SOURCE, not a missing TARGET.
  const envTargets = [`${AXIOM_WATCHER_DIR}/.env.local`, `${AXIOM_WATCHER_DIR}/.env`];
  for (const target of envTargets) {
    if (fs.existsSync(target)) args.push('--ro-bind', '/dev/null', target);
  }
  // Override /etc/hosts so cloud-metadata hostnames resolve to nothing.
  args.push('--ro-bind-try', `${AXIOM_WATCHER_DIR}/etc-hosts-axiom`, '/etc/hosts');
  args.push(
    // Hide other home directories
    '--tmpfs', '/home',
    '--share-net',
    '--die-with-parent',
    '--new-session',
    '--unshare-pid',
    '--unshare-uts',
    '--unshare-ipc',
  );
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
    // Block cloud metadata + private ranges at the kernel level (BPF egress filter).
    // IPv4: AWS/GCP/Azure metadata (169.254.169.254) + RFC1918 private LAN.
    '--property=IPAddressDeny=169.254.0.0/16',
    '--property=IPAddressDeny=10.0.0.0/8',
    '--property=IPAddressDeny=172.16.0.0/12',
    '--property=IPAddressDeny=192.168.0.0/16',
    // IPv6: link-local (fe80::/10) covers IPv6 metadata variants;
    // unique-local (fc00::/7) covers IPv6 internal networks.
    '--property=IPAddressDeny=fe80::/10',
    '--property=IPAddressDeny=fc00::/7',
    // Allow loopback for the bwrap setup itself + rest of internet (default allow).
    '--property=IPAddressAllow=127.0.0.0/8',
    '--property=IPAddressAllow=::1/128',
    '--property=IPAddressAllow=any',
  ];
}

type RateState = {
  callTimestamps: number[];
};

type GlobalCostState = {
  todayCostUsd: number;
  costDayKey: string;
  alertedAtPercent?: number;
};

type AllowanceOverride = {
  dailyUsdOverride?: number;
  updatedAt?: string;
  updatedBy?: string;
};

const AXIOM_GLOBAL_COST_FILE = 'axiom-global.cost.json';
const AXIOM_ALLOWANCE_FILE = 'axiom-allowance.json';
const AXIOM_ALERT_THRESHOLD_PERCENT = 90;

function loadAllowance(): AllowanceOverride {
  try {
    const file = path.join(AXIOM_MAILBOX_DIR, AXIOM_ALLOWANCE_FILE);
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function getEffectiveDailyCap(): number {
  const override = loadAllowance().dailyUsdOverride;
  if (typeof override === 'number' && override > 0) return override;
  return AXIOM_MAX_DAILY_USD;
}

async function sendTelegramAlert(text: string): Promise<void> {
  const token = process.env.WATCH_AXIOM_CEO_BOT_TOKEN;
  const chatId = process.env.WATCH_AXIOM_CEO_OPERATOR_ID;
  if (!token || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
    });
  } catch {
    // best-effort; don't let alert failures break agent calls
  }
}

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
  const cap = getEffectiveDailyCap();
  if (dailyCost >= cap) {
    return { ok: false, reason: `allowance cap: $${dailyCost.toFixed(2)}/${cap} spent today across all agents — extend via /budget on Telegram` };
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
    global.alertedAtPercent = undefined;
  }
  const previousCost = global.todayCostUsd;
  global.todayCostUsd += costUsd;
  saveGlobalCost(global);

  // Fire a Telegram alert when crossing the 90% threshold (once per day per threshold).
  const cap = getEffectiveDailyCap();
  const previousPercent = (previousCost / cap) * 100;
  const newPercent = (global.todayCostUsd / cap) * 100;
  const lastAlerted = global.alertedAtPercent ?? 0;
  if (newPercent >= AXIOM_ALERT_THRESHOLD_PERCENT && previousPercent < AXIOM_ALERT_THRESHOLD_PERCENT && lastAlerted < AXIOM_ALERT_THRESHOLD_PERCENT) {
    global.alertedAtPercent = AXIOM_ALERT_THRESHOLD_PERCENT;
    saveGlobalCost(global);
    const remaining = Math.max(0, cap - global.todayCostUsd);
    const msg = [
      '🚨 *AXIOM allowance — 90% reached*',
      '',
      `Used: *$${global.todayCostUsd.toFixed(2)}* / $${cap.toFixed(2)} (token-equiv)`,
      `Remaining: $${remaining.toFixed(2)}`,
      '',
      'Reply with one of:',
      '`/budget +5` — add $5 more',
      '`/budget set 20` — raise allowance to $20',
      '`/budget reset` — restore default',
      '',
      'Otherwise all 51 agents pause when the cap is hit (resets at UTC midnight). Membership-backed — no real billing.',
    ].join('\n');
    void sendTelegramAlert(msg);
  }
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
      `- You have Read/Glob/Grep over ${AXIOM_PROJECT_DIR}. Skim aggressively, quote sparingly.`,
      `- You also have WebFetch + WebSearch — use them when the operator asks about current events, external docs, market conditions, library APIs, or anything you genuinely don't know. Don't fabricate facts you can verify online. Cite the URL when you do.`,
      `- You may suggest README.md updates but DO NOT use Write/Edit on README.md directly — that's mission territory, route it via <<DISPATCH:>>.`,
      `- Reference managers by department when planning, e.g. "Platform manager owns X".`,
      ``,
      `PERSISTENT MEMORY — ${AXIOM_PROJECT_DIR}/CEO_MEMORY.md:`,
      `This is your brain that survives session resets and conversation compactions.`,
      `BEFORE responding to any non-trivial operator message, READ this file (use the Read tool). It tells you who the operator is, what the mission is, what's been decided, and what's open.`,
      `WHEN you learn something worth remembering — operator preferences ("call me X", "I prefer Y"), mission constraints, decisions made, recurring stakeholders, or open threads — APPEND or UPDATE the relevant section using the Write/Edit tool. Keep entries dated and terse (1-2 lines).`,
      `Sections to maintain (create on first use):`,
      `   ## Mission        — current overarching goal + phase`,
      `   ## Operator       — who you're talking to + how they like to work`,
      `   ## Decisions      — dated bullets of significant calls`,
      `   ## Open threads   — what's in flight; what's blocked; pending decisions`,
      `   ## Recent wins    — last 5-10 things the floor delivered`,
      `Keep the file under ~200 lines. When it grows, prune the oldest entries from "Recent wins" first, then collapse "Decisions" into a "Decisions (older)" section.`,
      `If the operator says "compact your context" or you receive a system-level COMPACT signal, append a one-paragraph recap of the last few turns to CEO_MEMORY.md (cover anything not already there) and reply with exactly "compacted" — your session will be reset after that turn.`,
      ``,
      `LONG-FORM REPORTS — ${AXIOM_PROJECT_DIR}/reports/:`,
      `When your reply would be a structured document — a roadmap, status report, design memo, multi-section plan, code listing, or anything that reads like a doc rather than chat — DO NOT dump the whole thing into the Telegram reply (it bloats the chat history and burns tokens on every subsequent turn).`,
      `Instead: write it as ${AXIOM_PROJECT_DIR}/reports/<slug>-<YYYY-MM-DD-HHmm>.md (use Write tool) where slug is a 2-4 word kebab-case name, then reply in chat with a 2-3 sentence summary plus this tag on its own line:`,
      `<<REPORT_FILE: reports/<slug>-<YYYY-MM-DD-HHmm>.md>>`,
      `The bot will send the file as a downloadable Telegram document with your summary as the caption, and the file will live in /axiom/project for browser viewing.`,
      `Use this whenever your reply would otherwise exceed ~800 chars or 8 sentences. Routine acknowledgements + short answers stay in chat as normal.`,
      ``,
      `WRITE TOOL CONSTRAINTS:`,
      `Your Write/Edit access is for CEO_MEMORY.md and reports/ ONLY. Never use Write/Edit on code files, configs, package.json, README.md, or anything outside those two targets — those go through <<DISPATCH:>> to codex /goal. Violating this defeats the whole architecture.`,
      ``,
      `MANAGER DELEGATION — your real lever for keeping the floor busy:`,
      `THE BOT IS RUNNING. Every reply you send is parsed by an AXIOM Telegram bot middleware that ALWAYS processes <<DELEGATE: ...>> and <<DELEGATE-ALL: ...>> tags. There is no scenario where "the bot might not be running" — if you're being invoked, the bot is invoking you. Never say things like "the tag is just text" or "the manager loop only works if the bot stack is running" — the stack IS running, and your job is to use it.`,
      `IMPORTANT: only emit a DELEGATE tag when you actually want managers to start work. If you are EXPLAINING the protocol or DESCRIBING the tag, do NOT include the literal "<<DELEGATE-ALL: ...>>" syntax in your prose — the bot will see it and fan out a useless empty-brief delegation. Talk about it descriptively instead ("I can fan out to all 10 managers via the delegation protocol when you say go").`,
      `You are the orchestrator. Your floor has 10 managers, indexed m1..m10:`,
      `   m1=${AXIOM_DEPARTMENTS_FRONT[0]}  m2=${AXIOM_DEPARTMENTS_FRONT[1]}  m3=${AXIOM_DEPARTMENTS_FRONT[2]}  m4=${AXIOM_DEPARTMENTS_FRONT[3]}  m5=${AXIOM_DEPARTMENTS_FRONT[4]}`,
      `   m6=${AXIOM_DEPARTMENTS_BACK[0]}  m7=${AXIOM_DEPARTMENTS_BACK[1]}  m8=${AXIOM_DEPARTMENTS_BACK[2]}  m9=${AXIOM_DEPARTMENTS_BACK[3]}  m10=${AXIOM_DEPARTMENTS_BACK[4]}`,
      `Each manager has a binding goal already written at ${AXIOM_PROJECT_DIR}/departments/D{N}_GOAL.md (D1..D10). Each manager runs autonomously when you delegate to them and replies with what they did + what they need.`,
      ``,
      `When the operator asks you to advance the project, build something across the floor, or "keep the managers busy" — do NOT use <<DISPATCH:>> (that's a single codex mission). Instead, fan out to the relevant managers using:`,
      `   <<DELEGATE: m1,m4,m7 :: brief that applies to each, ≤1500 chars total>>`,
      `or to hit every manager:`,
      `   <<DELEGATE-ALL: brief that applies to every department, ≤1500 chars>>`,
      `The brief is sent to each chosen manager with their department context appended. Each manager runs in parallel; their replies will be fed back to you in your NEXT turn as a SYSTEM message tagged "MANAGER REPORTS".`,
      ``,
      `DELEGATE LOOP (this is how orchestration works):`,
      `1. Operator gives you a goal.`,
      `2. You decide which managers to engage and emit a <<DELEGATE: ...>> tag with a chat preface (1-3 sentences telling the operator who you're tasking and why).`,
      `3. Bot fans out, waits for all manager replies, then re-invokes you with a "MANAGER REPORTS" SYSTEM message containing each manager's output.`,
      `4. You read the reports, decide what's next: re-delegate (with sharper / follow-up briefs), test something via Read/Glob/Grep, or finalize. If finalizing, reply WITHOUT a DELEGATE tag — that triggers the operator-facing summary.`,
      `5. The bot caps the delegation loop at 5 rounds to avoid runaway. After that, you must finalize.`,
      ``,
      `Example flow:`,
      `   Operator: "build the AXIOM auth flow."`,
      `   You: "Tasking Platform + Security to draft the auth contract; Frontend will wire UI once the contract lands. <<DELEGATE: m1,m6 :: Draft the AXIOM auth contract per departments/D{N}_GOAL.md. Platform owns identity + session model; Security owns threat model and key rotation. Output: a single shared contract markdown at contracts/auth-v1.md plus your team's checklist.>>"`,
      `   [bot dispatches; managers reply; you receive MANAGER REPORTS]`,
      `   You (next turn): "Auth contract is in. Pulling Frontend in to wire the UI. <<DELEGATE: m2 :: Read contracts/auth-v1.md and ship the login + session-refresh UI. Match the spec exactly; tests required.>>"`,
      `   [...]`,
      `   You (final turn): "Auth flow is live. Platform shipped contract, Security signed off, Frontend has UI + tests passing. Files: contracts/auth-v1.md, web/login/*.tsx. Ready for review."`,
      ``,
      `KEEP MANAGERS BUSY — when operator says "go" / "get started" / "make progress" with no specific target, your default is: <<DELEGATE-ALL: Read your departments/D{N}_GOAL.md, pick the next concrete unfinished step, do it on disk in ${AXIOM_PROJECT_DIR}, and report back what you did + what's now the bottleneck.>> — that's the heartbeat that turns the floor on.`,
      `When you get a "MANAGER REPORTS" SYSTEM message, treat it like an inbox of signed status updates. Do NOT just summarise verbatim — re-assess: are there blockers? Conflicts between teams? Missing tests? Then either chain another DELEGATE for follow-ups or finalize a tight rollup to the operator (3-8 lines max + REPORT_FILE for the long version).`,
      ``,
      `Use <<DISPATCH:>> only for one-shot work that doesn't fit any manager's domain (e.g. infra tweaks outside the project, repo-wide migrations). Default to DELEGATE.`,
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
      `YOU HAVE FULL WRITE ACCESS to ${AXIOM_PROJECT_DIR}. Tools: Read, Glob, Grep, Write, Edit, Bash, WebFetch, WebSearch. Use WebFetch/WebSearch to look up library docs, API specs, or external references — don't guess when you can verify.`,
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

async function callAxiomClaude(sessionKey: string, message: string): Promise<{ reply: string; sessionId: string; isNew: boolean; cost?: number; durationMs?: number; inputTokens?: number; outputTokens?: number; cacheReadTokens?: number }> {
  let { sessionId, isNew } = readOrCreateAxiomSessionId(sessionKey);
  const model = modelForAxiomTopic(sessionKey);
  const meta = axiomTopicMeta(sessionKey);
  // CEO is the chat/orchestrator — file work MUST dispatch to codex via the
  // <<DISPATCH: ...>> tag. The narrow Write/Edit grant for the CEO is for its
  // own bookkeeping only: persistent memory at CEO_MEMORY.md and long-form
  // reports under reports/. The system prompt enforces "no code work, ever" —
  // Ace either chats, dispatches, or writes one of those two file targets.
  // WebFetch + WebSearch are enabled for online research; the systemd-run
  // cgroup blocks RFC1918 + cloud-metadata egress.
  const tools = meta.role === 'ceo'
    ? 'Read,Glob,Grep,Write,Edit,WebFetch,WebSearch'
    : 'Read,Glob,Grep,Write,Edit,Bash,WebFetch,WebSearch';

  const buildArgs = (resumeMode: boolean, sid: string): string[] => {
    // --tools exposes the toolset to the model; --allowedTools auto-permits
    // calls so WebFetch/WebSearch don't trip the interactive permission gate
    // (which would otherwise reply "tool call was denied" in headless -p mode).
    const allowed = meta.role === 'ceo'
      ? 'WebFetch WebSearch Write Edit'
      : 'WebFetch WebSearch Bash Edit Write';
    const base = [
      '-p',
      '--model', model,
      '--tools', tools,
      '--allowedTools', allowed,
      '--add-dir', AXIOM_PROJECT_DIR,
      '--permission-mode', 'acceptEdits',
      '--output-format', 'json',
    ];
    // The system prompt MUST be passed on every invocation. Claude --resume
    // rehydrates the message history from disk but the original --system-prompt
    // is not persisted in the session jsonl — without re-sending it on resume,
    // the CEO replies as generic Claude with no AXIOM identity / DELEGATE
    // protocol / department knowledge. Use --append-system-prompt so it stacks
    // additively if claude ever re-introduces a default system prompt path.
    const systemPrompt = buildAxiomSystemPrompt(sessionKey);
    return resumeMode
      ? [...base, '--resume', sid, '--append-system-prompt', systemPrompt, message]
      : [...base, '--session-id', sid, '--system-prompt', systemPrompt, message];
  };

  const spawnClaude = async (resumeMode: boolean, sid: string) => {
    const claudeArgs = buildArgs(resumeMode, sid);
    // Strip parent-process Claude Code identity vars. If watcher-web was launched
    // from a VSCode/Claude-Code shell (PM2 inherits the launching shell's env),
    // CLAUDECODE=1 / CLAUDE_CODE_SESSION_ID / CLAUDE_CODE_EXECPATH leak into the
    // spawned `claude -p` subprocess. The CLI then thinks it's nested inside an
    // existing Claude Code session and exits silently with empty stdout —
    // surfacing as "(empty reply from claude)" to the operator. Scrub them.
    const childEnv = { ...process.env };
    for (const key of Object.keys(childEnv)) {
      if (key === 'CLAUDECODE' || key.startsWith('CLAUDE_CODE_') || key === 'AI_AGENT' || key === 'CLAUDE_AGENT_SDK_VERSION') {
        delete childEnv[key];
      }
    }
    const opts = {
      timeout: AXIOM_CLAUDE_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      cwd: AXIOM_PROJECT_DIR,
      env: childEnv,
    };
    const sdPrefix = buildSystemdRunPrefix();
    if (AXIOM_SANDBOX_ENABLED) {
      const bwrapArgs = [...buildBwrapArgs(), '--', '/usr/bin/claude', ...claudeArgs];
      if (sdPrefix) {
        return runDetached(sdPrefix[0], [...sdPrefix.slice(1), AXIOM_BWRAP_BIN, ...bwrapArgs], opts);
      }
      return runDetached(AXIOM_BWRAP_BIN, bwrapArgs, opts);
    }
    // Sandbox off (no bwrap): still wrap in systemd-run so the IP filter +
    // resource limits stay active. Without this, an agent with internet access
    // could hit cloud metadata or RFC1918 ranges unrestricted.
    if (sdPrefix) {
      return runDetached(sdPrefix[0], [...sdPrefix.slice(1), '/usr/bin/claude', ...claudeArgs], opts);
    }
    return runDetached('claude', claudeArgs, opts);
  };

  const t0 = Date.now();
  let stdout: string;
  const startFreshSession = () => {
    const fresh = crypto.randomUUID();
    try { fs.writeFileSync(axiomSessionFile(sessionKey), fresh + '\n'); } catch {}
    sessionId = fresh;
    isNew = true;
  };
  try {
    const result = await spawnClaude(!isNew, sessionId);
    stdout = result.stdout;
  } catch (error: any) {
    // If --resume failed (stale session, deleted history, etc.), fall back to a fresh session.
    if (!isNew) {
      startFreshSession();
      const result = await spawnClaude(false, sessionId);
      stdout = result.stdout;
    } else {
      throw error;
    }
  }
  // Some CLI hiccups exit 0 but emit empty stdout — most commonly when --resume
  // points at a UUID with no session jsonl on disk (orphan after a restart that
  // killed the spawn before the session was written). Retry with a fresh
  // session. We retry even when isNew was true, because a fresh-session call
  // can also drop empty if a concurrent watcher-web restart killed the spawn.
  if (!stdout.trim()) {
    startFreshSession();
    const result = await spawnClaude(false, sessionId);
    stdout = result.stdout;
  }
  const durationMs = Date.now() - t0;

  // claude -p --output-format json emits a JSON envelope with the assistant text in `result`.
  let reply = '';
  let cost: number | undefined;
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let cacheReadTokens: number | undefined;
  try {
    const parsed = JSON.parse(stdout.trim());
    if (typeof parsed.result === 'string') reply = parsed.result;
    else if (typeof parsed.text === 'string') reply = parsed.text;
    if (typeof parsed.total_cost_usd === 'number') cost = parsed.total_cost_usd;
    else if (typeof parsed.cost_usd === 'number') cost = parsed.cost_usd;
    const usage = parsed.usage || parsed.total_usage || null;
    if (usage && typeof usage === 'object') {
      if (typeof usage.input_tokens === 'number') inputTokens = usage.input_tokens;
      if (typeof usage.output_tokens === 'number') outputTokens = usage.output_tokens;
      if (typeof usage.cache_read_input_tokens === 'number') cacheReadTokens = usage.cache_read_input_tokens;
    }
  } catch {
    reply = stdout.trim();
  }
  if (!reply) reply = '(empty reply from claude)';
  return { reply, sessionId, isNew, cost, durationMs, inputTokens, outputTokens, cacheReadTokens };
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
      return runDetached(sdPrefix[0], [...sdPrefix.slice(1), '/usr/bin/codex', ...codexArgs], opts);
    }
    return runDetached('codex', codexArgs, opts);
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
  // Codex emits token usage in the `turn.completed` JSONL event. Pull it so we
  // can estimate cost — codex doesn't expose total_cost_usd directly the way
  // the claude CLI does, but we know the gpt-5.5 rates and can multiply.
  let inputTokens: number | undefined;
  let cachedInputTokens: number | undefined;
  let outputTokens: number | undefined;
  let reasoningOutputTokens: number | undefined;
  const stdoutLines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = stdoutLines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(stdoutLines[i]);
      if (parsed?.type === 'turn.completed' && parsed?.usage) {
        inputTokens = parsed.usage.input_tokens;
        cachedInputTokens = parsed.usage.cached_input_tokens;
        outputTokens = parsed.usage.output_tokens;
        reasoningOutputTokens = parsed.usage.reasoning_output_tokens;
        break;
      }
    } catch {}
  }
  if (!reply) {
    // Fallback: scan stdout JSONL for last agent_message
    for (let i = stdoutLines.length - 1; i >= 0; i--) {
      try {
        const parsed = JSON.parse(stdoutLines[i]);
        if (parsed?.item?.type === 'agent_message' && typeof parsed.item.text === 'string') {
          reply = parsed.item.text;
          break;
        }
      } catch {}
    }
  }
  if (!reply) reply = '(empty reply from codex)';

  // Estimate cost from token usage. gpt-5.5 rates (approximate; configurable
  // via WATCH_AXIOM_CODEX_*_RATE env vars if pricing changes). Cached input
  // is ~10× cheaper than fresh input. Reasoning tokens billed at output rate.
  const ratePerMInput = Number(process.env.WATCH_AXIOM_CODEX_INPUT_RATE_PER_M || 1.25);   // $/M input tokens
  const ratePerMCached = Number(process.env.WATCH_AXIOM_CODEX_CACHED_RATE_PER_M || 0.125); // $/M cached input
  const ratePerMOutput = Number(process.env.WATCH_AXIOM_CODEX_OUTPUT_RATE_PER_M || 10);    // $/M output tokens
  let cost: number | undefined;
  if (typeof outputTokens === 'number') {
    const freshIn = Math.max(0, (inputTokens || 0) - (cachedInputTokens || 0));
    const cached = cachedInputTokens || 0;
    const out = (outputTokens || 0) + (reasoningOutputTokens || 0);
    cost = (freshIn * ratePerMInput + cached * ratePerMCached + out * ratePerMOutput) / 1_000_000;
  }

  // Persist the session id on first run so subsequent messages resume the same conversation.
  if (actuallyNew && resolvedSessionId) {
    try { fs.writeFileSync(codexSessionFile, resolvedSessionId + '\n'); } catch {}
  }

  return { reply, sessionId: resolvedSessionId, isNew: actuallyNew, durationMs, cost, inputTokens, outputTokens, cacheReadTokens: cachedInputTokens };
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

function recordAxiomMessage(
  sessionKey: string,
  agentId: string,
  groupId: string,
  message: string,
  reply: string,
  meta?: { costUsd?: number; engine?: string; durationMs?: number },
) {
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
      ...(meta?.costUsd != null ? { costUsd: meta.costUsd } : {}),
      ...(meta?.engine ? { engine: meta.engine } : {}),
      ...(meta?.durationMs != null ? { durationMs: meta.durationMs } : {}),
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
      const inputTokens = (rest as { inputTokens?: number }).inputTokens;
      const outputTokens = (rest as { outputTokens?: number }).outputTokens;
      const cacheReadTokens = (rest as { cacheReadTokens?: number }).cacheReadTokens;
      recordCallCost(sessionKey, cost);
      const file = recordAxiomMessage(sessionKey, agentId, groupId, message, reply, {
        costUsd: cost,
        engine,
        durationMs,
      });
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
        inputTokens,
        outputTokens,
        cacheReadTokens,
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
