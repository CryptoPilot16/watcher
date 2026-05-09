import fs from 'fs';
import path from 'path';
import { NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { isAdminAuthed } from '@/lib/admin-auth';
import { getWatchApiKey } from '@/lib/auth';

export const dynamic = 'force-dynamic';

const AXIOM_MAILBOX_DIR = process.env.WATCH_AXIOM_MAILBOX_DIR || '/var/lib/watcher/axiom-mailbox';
const AXIOM_GLOBAL_COST_FILE = 'axiom-global.cost.json';
const AXIOM_ALLOWANCE_FILE = 'axiom-allowance.json';
const AXIOM_KILL_SWITCH_FILE = process.env.WATCH_AXIOM_KILL_SWITCH_FILE || '/var/lib/watcher/axiom-kill-switch.json';
const AXIOM_PAUSE_FILE = process.env.WATCH_AXIOM_DRIVER_PAUSE_FILE || '/var/lib/watcher/axiom-autopilot.paused';
const AXIOM_MAX_DAILY_USD_CEILING = 50;
const AXIOM_MAX_DAILY_USD_DEFAULT = Math.min(Number(process.env.WATCH_AXIOM_MAX_DAILY_USD || 10), AXIOM_MAX_DAILY_USD_CEILING);
const run = promisify(execFile);
const AXIOM_MAX_CALLS_PER_HOUR = Number(process.env.WATCH_AXIOM_MAX_CALLS_PER_HOUR || 60);

type AllowanceOverride = {
  dailyUsdOverride?: number;
  maxDailyUsd?: number;
  updatedAt?: string;
  updatedBy?: string;
};

type KillSwitchState = {
  enabled?: boolean;
  alertsEnabled?: boolean;
  reason?: string;
  updatedAt?: string;
  updatedBy?: string;
};

function loadAllowance(): AllowanceOverride {
  try {
    const file = path.join(AXIOM_MAILBOX_DIR, AXIOM_ALLOWANCE_FILE);
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function loadKillSwitch(): KillSwitchState {
  try {
    return JSON.parse(fs.readFileSync(AXIOM_KILL_SWITCH_FILE, 'utf8'));
  } catch {
    return { enabled: false, alertsEnabled: true };
  }
}

function authOk(request: Request) {
  const auth = request.headers.get('authorization') || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (bearer && bearer === getWatchApiKey()) return Promise.resolve(true);
  return isAdminAuthed(request as any);
}

function effectiveCapFromAllowance(allowance: AllowanceOverride): number {
  const override = allowance.dailyUsdOverride;
  if (typeof override === 'number' && Number.isFinite(override) && override >= 0) {
    return Math.min(Math.max(0, override), AXIOM_MAX_DAILY_USD_CEILING);
  }
  return AXIOM_MAX_DAILY_USD_DEFAULT;
}

function writeAllowance(cap: number, updatedBy: string) {
  fs.mkdirSync(AXIOM_MAILBOX_DIR, { recursive: true });
  fs.writeFileSync(path.join(AXIOM_MAILBOX_DIR, AXIOM_ALLOWANCE_FILE), JSON.stringify({
    dailyUsdOverride: Math.min(Math.max(0, cap), AXIOM_MAX_DAILY_USD_CEILING),
    maxDailyUsd: AXIOM_MAX_DAILY_USD_CEILING,
    updatedAt: new Date().toISOString(),
    updatedBy,
  }, null, 2));
}

function writeKillSwitch(state: KillSwitchState) {
  fs.mkdirSync(path.dirname(AXIOM_KILL_SWITCH_FILE), { recursive: true });
  fs.writeFileSync(AXIOM_KILL_SWITCH_FILE, JSON.stringify({
    enabled: Boolean(state.enabled),
    alertsEnabled: state.alertsEnabled !== false,
    reason: state.reason || null,
    updatedAt: new Date().toISOString(),
    updatedBy: state.updatedBy || 'settings-ui',
  }, null, 2));
}

function pauseAutopilot(reason: string) {
  fs.mkdirSync(path.dirname(AXIOM_PAUSE_FILE), { recursive: true });
  fs.writeFileSync(AXIOM_PAUSE_FILE, `${reason}\n`);
}

function resumeAutopilot() {
  try { fs.unlinkSync(AXIOM_PAUSE_FILE); } catch {}
}

function resetGlobalCostCounter() {
  fs.mkdirSync(AXIOM_MAILBOX_DIR, { recursive: true });
  fs.writeFileSync(path.join(AXIOM_MAILBOX_DIR, AXIOM_GLOBAL_COST_FILE), JSON.stringify({
    todayCostUsd: 0,
    costDayKey: new Date().toISOString().slice(0, 10),
  }, null, 2));
}

function resetAgentRateCounters() {
  let count = 0;
  let files: string[] = [];
  try { files = fs.readdirSync(AXIOM_MAILBOX_DIR).filter((n) => n.endsWith('.rate.json')); } catch { return count; }
  for (const fname of files) {
    try {
      fs.writeFileSync(path.join(AXIOM_MAILBOX_DIR, fname), JSON.stringify({ callTimestamps: [] }, null, 2));
      count++;
    } catch {}
  }
  return count;
}

async function stopAxiomDriver() {
  let stopped = false;
  try {
    await run('pm2', ['stop', 'clawnux-axiom-driver'], { timeout: 15_000 });
    await run('pm2', ['save', '--force'], { timeout: 15_000 });
    stopped = true;
  } catch {}
  return stopped;
}

async function startAxiomDriver() {
  let started = false;
  try {
    await run('pm2', ['start', 'clawnux-axiom-driver'], { timeout: 15_000 });
    await run('pm2', ['save', '--force'], { timeout: 15_000 });
    started = true;
  } catch {}
  return started;
}

function markAgentsKilled(reason: string) {
  let count = 0;
  let files: string[] = [];
  try {
    files = fs.readdirSync(AXIOM_MAILBOX_DIR).filter((n) => n.startsWith('axiom:') && n.endsWith('.state.json'));
  } catch {
    return count;
  }
  for (const fname of files) {
    try {
      const file = path.join(AXIOM_MAILBOX_DIR, fname);
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      fs.writeFileSync(file, JSON.stringify({ ...parsed, status: 'idle', killedAt: new Date().toISOString(), killReason: reason, progress: null, task: null }, null, 2));
      count++;
    } catch {}
  }
  return count;
}

type ActionType = 'image' | 'pdf' | 'document' | 'voice' | 'code' | 'text';

type ActionStat = {
  type: ActionType;
  count: number;
  totalCostUsd: number;
  avgCostUsd: number;
  totalDurationMs: number;
  avgDurationMs: number;
};

type AgentUsage = {
  topicId: string;
  callsLastHour: number;
};

type JsonlEntry = {
  ts: string;
  sessionKey?: string;
  agentId?: string;
  message?: string;
  reply?: string;
  costUsd?: number;
  engine?: string;
  durationMs?: number;
};

function classifyAction(entry: JsonlEntry): ActionType {
  const msg = entry.message || '';
  // Voice messages are Whisper-transcribed locally, so they reach the LLM as plain text.
  // We only label as 'voice' if the bot explicitly tagged the transcript.
  if (/\[voice\]/i.test(msg) || /🎙️ ?transcript/i.test(msg) || /\[transcribed/i.test(msg)) return 'voice';
  if (/\[attached image:/i.test(msg) || /\[image\]/i.test(msg)) return 'image';
  // [attached file: ... mime=application/pdf ...] — PDF specifically
  if (/\[attached file:[^\]]*application\/pdf/i.test(msg) || /\[attached file:[^\]]*\.pdf\b/i.test(msg)) return 'pdf';
  if (/\[attached file:/i.test(msg)) return 'document';
  if (entry.engine === 'codex') return 'code';
  return 'text';
}

function loadGlobalCost(): { todayCostUsd: number; costDayKey: string; alertedAtPercent?: number } {
  try {
    const file = path.join(AXIOM_MAILBOX_DIR, AXIOM_GLOBAL_COST_FILE);
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { todayCostUsd: 0, costDayKey: '' };
  }
}

function loadAgentRates(): AgentUsage[] {
  let files: string[] = [];
  try {
    files = fs.readdirSync(AXIOM_MAILBOX_DIR).filter((n) => n.endsWith('.rate.json'));
  } catch {
    return [];
  }
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  const usage: AgentUsage[] = [];
  for (const fname of files) {
    try {
      const raw = fs.readFileSync(path.join(AXIOM_MAILBOX_DIR, fname), 'utf8');
      const parsed = JSON.parse(raw) as { callTimestamps?: number[] };
      const recent = (parsed.callTimestamps || []).filter((t) => t >= oneHourAgo);
      if (recent.length === 0) continue;
      const topicId = fname.replace(/^axiom:/, '').replace(/\.rate\.json$/, '');
      usage.push({ topicId, callsLastHour: recent.length });
    } catch {
      // skip
    }
  }
  usage.sort((a, b) => b.callsLastHour - a.callsLastHour);
  return usage;
}

function readJsonl(file: string, sinceTs: number): JsonlEntry[] {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const out: JsonlEntry[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as JsonlEntry;
        if (!parsed.ts) continue;
        if (new Date(parsed.ts).getTime() < sinceTs) continue;
        out.push(parsed);
      } catch {
        // skip malformed line
      }
    }
    return out;
  } catch {
    return [];
  }
}

function aggregateActions(): { actions: ActionStat[]; entriesWithCost: number; oldestEntryTs: string | null } {
  let files: string[] = [];
  try {
    files = fs.readdirSync(AXIOM_MAILBOX_DIR).filter((n) => n.endsWith('.jsonl'));
  } catch {
    return { actions: [], entriesWithCost: 0, oldestEntryTs: null };
  }
  const sinceTs = Date.now() - 7 * 24 * 60 * 60 * 1000; // last 7 days
  const buckets = new Map<ActionType, { count: number; cost: number; duration: number }>();
  let entriesWithCost = 0;
  let oldestTs: number | null = null;
  for (const fname of files) {
    const entries = readJsonl(path.join(AXIOM_MAILBOX_DIR, fname), sinceTs);
    for (const e of entries) {
      if (typeof e.costUsd !== 'number' || e.costUsd <= 0) continue;
      entriesWithCost++;
      const ts = new Date(e.ts).getTime();
      if (oldestTs === null || ts < oldestTs) oldestTs = ts;
      const type = classifyAction(e);
      const bucket = buckets.get(type) || { count: 0, cost: 0, duration: 0 };
      bucket.count++;
      bucket.cost += e.costUsd;
      bucket.duration += typeof e.durationMs === 'number' ? e.durationMs : 0;
      buckets.set(type, bucket);
    }
  }
  const actions: ActionStat[] = [];
  for (const type of ['image', 'pdf', 'document', 'voice', 'code', 'text'] as const) {
    const b = buckets.get(type);
    if (!b) continue;
    actions.push({
      type,
      count: b.count,
      totalCostUsd: b.cost,
      avgCostUsd: b.cost / b.count,
      totalDurationMs: b.duration,
      avgDurationMs: b.count > 0 ? b.duration / b.count : 0,
    });
  }
  actions.sort((a, b) => b.totalCostUsd - a.totalCostUsd);
  return {
    actions,
    entriesWithCost,
    oldestEntryTs: oldestTs ? new Date(oldestTs).toISOString() : null,
  };
}

export async function GET() {
  const today = new Date().toISOString().slice(0, 10);
  const global = loadGlobalCost();
  const spentToday = global.costDayKey === today ? global.todayCostUsd : 0;
  const allowance = loadAllowance();
  const killSwitch = loadKillSwitch();
  const effectiveCap = killSwitch.enabled ? 0 : effectiveCapFromAllowance(allowance);
  const agents = loadAgentRates();
  const { actions, entriesWithCost, oldestEntryTs } = aggregateActions();

  return NextResponse.json({
    ok: true,
    generatedAt: new Date().toISOString(),
    cap: {
      dailyUsd: effectiveCap,
      configuredUsd: effectiveCapFromAllowance(allowance),
      defaultUsd: AXIOM_MAX_DAILY_USD_DEFAULT,
      maxDailyUsd: AXIOM_MAX_DAILY_USD_CEILING,
      overrideActive: typeof allowance.dailyUsdOverride === 'number' && Number.isFinite(allowance.dailyUsdOverride),
      overrideUpdatedAt: allowance.updatedAt || null,
      overrideUpdatedBy: allowance.updatedBy || null,
      callsPerHourPerAgent: AXIOM_MAX_CALLS_PER_HOUR,
    },
    today: {
      spentUsd: spentToday,
      remainingUsd: Math.max(0, effectiveCap - spentToday),
      percentUsed: effectiveCap > 0 ? Math.min(100, (spentToday / effectiveCap) * 100) : (spentToday > 0 ? 100 : 0),
      dayKey: today,
      alertedAtPercent: global.alertedAtPercent || null,
    },
    agents,
    actions,
    actionWindow: {
      days: 7,
      entriesWithCost,
      oldestEntryTs,
    },
    killSwitch: {
      enabled: Boolean(killSwitch.enabled),
      alertsEnabled: killSwitch.alertsEnabled !== false,
      reason: killSwitch.reason || null,
      updatedAt: killSwitch.updatedAt || null,
      updatedBy: killSwitch.updatedBy || null,
    },
  });
}


export async function POST(request: Request) {
  if (!(await authOk(request))) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }
  const body = await request.json().catch(() => ({}));
  const action = String(body?.action || '');
  const updatedBy = String(body?.updatedBy || 'settings-ui');
  if (action === 'kill-all') {
    const reason = 'AXIOM emergency token kill switch enabled from settings UI';
    writeAllowance(0, updatedBy);
    writeKillSwitch({ enabled: true, alertsEnabled: false, reason, updatedBy });
    pauseAutopilot(reason);
    const killedAgents = markAgentsKilled(reason);
    const rateFilesReset = resetAgentRateCounters();
    const pm2Stopped = await stopAxiomDriver();
    return NextResponse.json({ ok: true, action, capUsd: 0, maxDailyUsd: AXIOM_MAX_DAILY_USD_CEILING, pm2Stopped, killedAgents, rateFilesReset });
  }
  if (action === 'reset-counter') {
    resetGlobalCostCounter();
    const rateFilesReset = resetAgentRateCounters();
    return NextResponse.json({ ok: true, action, spentUsd: 0, rateFilesReset });
  }
  if (action === 'resume-operations') {
    const requested = Number(body?.capUsd);
    const allowance = loadAllowance();
    const fallbackCap = effectiveCapFromAllowance(allowance) > 0 ? effectiveCapFromAllowance(allowance) : AXIOM_MAX_DAILY_USD_CEILING;
    const cap = Number.isFinite(requested) && requested > 0 ? requested : fallbackCap;
    if (cap <= 0 || cap > AXIOM_MAX_DAILY_USD_CEILING) {
      return NextResponse.json({ ok: false, error: `resume cap must be > $0 and <= $${AXIOM_MAX_DAILY_USD_CEILING}` }, { status: 400 });
    }
    writeAllowance(cap, updatedBy);
    writeKillSwitch({ enabled: false, alertsEnabled: true, reason: 'AXIOM operations resumed from settings UI', updatedBy });
    resetGlobalCostCounter();
    resetAgentRateCounters();
    resumeAutopilot();
    const pm2Started = await startAxiomDriver();
    return NextResponse.json({ ok: true, action, capUsd: cap, maxDailyUsd: AXIOM_MAX_DAILY_USD_CEILING, spentUsd: 0, pm2Started });
  }
  if (action === 'set-allowance') {
    const cap = Number(body?.capUsd);
    if (!Number.isFinite(cap) || cap < 0) {
      return NextResponse.json({ ok: false, error: 'capUsd must be >= 0' }, { status: 400 });
    }
    if (cap > AXIOM_MAX_DAILY_USD_CEILING) {
      return NextResponse.json({ ok: false, error: `max allowance is $${AXIOM_MAX_DAILY_USD_CEILING}/day` }, { status: 400 });
    }
    writeAllowance(cap, updatedBy);
    writeKillSwitch({ enabled: cap === 0, alertsEnabled: cap > 0, reason: cap === 0 ? 'AXIOM allowance set to zero from settings UI' : 'AXIOM allowance restored from settings UI', updatedBy });
    if (cap === 0) pauseAutopilot('AXIOM allowance set to zero from settings UI');
    return NextResponse.json({ ok: true, action, capUsd: cap, maxDailyUsd: AXIOM_MAX_DAILY_USD_CEILING });
  }
  return NextResponse.json({ ok: false, error: 'unknown action' }, { status: 400 });
}
