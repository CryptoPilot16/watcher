import fs from 'fs';
import path from 'path';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const AXIOM_MAILBOX_DIR = process.env.WATCH_AXIOM_MAILBOX_DIR || '/var/lib/watcher/axiom-mailbox';
const AXIOM_GLOBAL_COST_FILE = 'axiom-global.cost.json';
const AXIOM_ALLOWANCE_FILE = 'axiom-allowance.json';
const AXIOM_MAX_DAILY_USD_DEFAULT = Number(process.env.WATCH_AXIOM_MAX_DAILY_USD || 10);
const AXIOM_MAX_CALLS_PER_HOUR = Number(process.env.WATCH_AXIOM_MAX_CALLS_PER_HOUR || 60);

type AllowanceOverride = {
  dailyUsdOverride?: number;
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
  const effectiveCap = typeof allowance.dailyUsdOverride === 'number' && allowance.dailyUsdOverride > 0
    ? allowance.dailyUsdOverride
    : AXIOM_MAX_DAILY_USD_DEFAULT;
  const agents = loadAgentRates();
  const { actions, entriesWithCost, oldestEntryTs } = aggregateActions();

  return NextResponse.json({
    ok: true,
    generatedAt: new Date().toISOString(),
    cap: {
      dailyUsd: effectiveCap,
      defaultUsd: AXIOM_MAX_DAILY_USD_DEFAULT,
      overrideActive: typeof allowance.dailyUsdOverride === 'number' && allowance.dailyUsdOverride > 0,
      overrideUpdatedAt: allowance.updatedAt || null,
      overrideUpdatedBy: allowance.updatedBy || null,
      callsPerHourPerAgent: AXIOM_MAX_CALLS_PER_HOUR,
    },
    today: {
      spentUsd: spentToday,
      remainingUsd: Math.max(0, effectiveCap - spentToday),
      percentUsed: Math.min(100, (spentToday / effectiveCap) * 100),
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
  });
}
