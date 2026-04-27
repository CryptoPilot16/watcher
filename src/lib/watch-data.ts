import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { buildDemoWatchSnapshot } from '@/lib/demo-data';
import {
  WATCH_DEMO_MODE,
  WATCH_ECHOES_PROCESS,
  WATCH_FLOWS_DB,
  WATCH_OPENCLAW_DIR,
  WATCH_PM2_BIN,
  WATCH_RUNS_DB,
  WATCH_SNAPMOLT_PROCESS,
  WATCH_UPDATE_RESULT_PATH,
  pm2LogFile,
  pm2LogGlob,
} from '@/lib/runtime-config';
import { getTeamTopology } from '@/lib/team-topology-server';

export type WatchSnapshot = {
  ok: true;
  now: string;
  status: string;
  summary: string;
  sections: Record<string, string>;
};

function run(command: string) {
  try {
    return execSync(command, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error: any) {
    const out = String(error?.stdout || error?.stderr || error?.message || 'command failed').trim();
    return `ERROR: ${out}`;
  }
}

function readMergedLog(glob: string, perFileLines: number, totalLines: number) {
  const command = `files=$(ls -1t ${glob} 2>/dev/null | head -n 2); if [ -z "$files" ]; then exit 0; fi; for file in $files; do tail -n ${perFileLines} "$file" 2>/dev/null; done | tail -n ${totalLines}`;
  return run(`/bin/bash -lc '${command}'`);
}

function parseSafe(raw: string): any {
  try { return JSON.parse(raw); } catch { return null; }
}

const WATCH_STATE_FILE = path.join(process.cwd(), '.state', 'watch-state.json');

type SessionIndexEntry = {
  sessionFile?: string;
  updatedAt?: number;
  status?: string;
  acp?: {
    state?: string;
    lastActivityAt?: number;
  };
};

function listAgentIds(): string[] {
  const agentsDir = path.join(WATCH_OPENCLAW_DIR, 'agents');
  try {
    return fs.readdirSync(agentsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return ['main'];
  }
}

function listSessionCandidates() {
  return listAgentIds().flatMap((agentId) => {
    const sessionsFile = path.join(WATCH_OPENCLAW_DIR, 'agents', agentId, 'sessions', 'sessions.json');
    const parsed = parseSafe(run(`cat ${sessionsFile} 2>/dev/null`)) || {};

    return Object.entries(parsed as Record<string, SessionIndexEntry>)
      .filter(([key]) => key !== 'version')
      .map(([key, value]) => {
        const explicitFile = typeof value?.sessionFile === 'string' ? value.sessionFile : null;
        const updatedAt =
          typeof value?.updatedAt === 'number'
            ? value.updatedAt
            : typeof value?.acp?.lastActivityAt === 'number'
              ? value.acp.lastActivityAt
              : 0;
        const status = String(value?.acp?.state || value?.status || '').toLowerCase();
        const exists = explicitFile ? fs.existsSync(explicitFile) : false;

        return {
          key,
          sessionFile: exists ? explicitFile : null,
          updatedAt,
          isTopicSession: key.includes(':topic:'),
          isDirectSession: key.includes(':direct:'),
          isSlashSession: key.includes(':slash:'),
          isMainSession: key.endsWith(':main'),
          isRunning: status === 'running' || status === 'busy',
        };
      });
  });
}

function findLatestTeamTopicSessionFile(): string | null {
  const topology = parseSafe(getTeamTopology());
  const topics = Array.isArray(topology?.topics) ? topology.topics : [];

  const dispatcherTopic = topics.find(
    (topic: any) =>
      topic?.configured?.role === 'dispatcher' &&
      typeof topic?.sessionFile === 'string' &&
      fs.existsSync(topic.sessionFile),
  );
  if (dispatcherTopic?.sessionFile) return dispatcherTopic.sessionFile;

  const rankedTopics = topics
    .filter((topic: any) => typeof topic?.sessionFile === 'string' && fs.existsSync(topic.sessionFile))
    .sort((a: any, b: any) => {
      const aRunning = a?.live?.status === 'running' ? 1 : 0;
      const bRunning = b?.live?.status === 'running' ? 1 : 0;
      if (aRunning !== bRunning) return bRunning - aRunning;
      return (Number(b?.live?.updatedAt) || 0) - (Number(a?.live?.updatedAt) || 0);
    });

  return rankedTopics[0]?.sessionFile || null;
}

function findLatestSessionFile(): string | null {
  const latestTeamTopicSession = findLatestTeamTopicSessionFile();
  if (latestTeamTopicSession) return latestTeamTopicSession;

  const ranked = listSessionCandidates()
    .filter((candidate) => candidate.sessionFile)
    .sort((a, b) => {
      const aScore =
        (a.isRunning ? 10_000_000_000_000 : 0) +
        (a.isTopicSession ? 1_000_000_000_000 : 0) +
        (a.isDirectSession ? 900_000_000_000 : 0) +
        (a.isSlashSession ? 100_000_000_000 : 0) +
        (!a.isMainSession ? 10_000_000_000 : 0) +
        (a.updatedAt || 0);
      const bScore =
        (b.isRunning ? 10_000_000_000_000 : 0) +
        (b.isTopicSession ? 1_000_000_000_000 : 0) +
        (b.isDirectSession ? 900_000_000_000 : 0) +
        (b.isSlashSession ? 100_000_000_000 : 0) +
        (!b.isMainSession ? 10_000_000_000 : 0) +
        (b.updatedAt || 0);
      return bScore - aScore;
    });

  if (ranked[0]?.sessionFile) return ranked[0].sessionFile;

  const fallback = run(
    `find ${WATCH_OPENCLAW_DIR}/agents -path '*/sessions/*.jsonl' -not -name '*.reset*' -not -name '*.deleted*' -not -name '*.bak*' -not -name '*.lock*' -printf '%T@ %p\\n' 2>/dev/null | sort -nr | head -1 | cut -d' ' -f2-`,
  );
  if (fallback && !fallback.startsWith('ERROR')) return fallback.trim();
  return null;
}

function readWatchState(): { clearedRunFaultAt: number | null; clearedSessionIdleAt: number | null } {
  try {
    const raw = fs.readFileSync(WATCH_STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      clearedRunFaultAt:
        typeof parsed?.clearedRunFaultAt === 'number' && Number.isFinite(parsed.clearedRunFaultAt)
          ? parsed.clearedRunFaultAt
          : null,
      clearedSessionIdleAt:
        typeof parsed?.clearedSessionIdleAt === 'number' && Number.isFinite(parsed.clearedSessionIdleAt)
          ? parsed.clearedSessionIdleAt
          : null,
    };
  } catch {
    return { clearedRunFaultAt: null, clearedSessionIdleAt: null };
  }
}

function writeWatchState(state: { clearedRunFaultAt: number | null; clearedSessionIdleAt: number | null }) {
  fs.mkdirSync(path.dirname(WATCH_STATE_FILE), { recursive: true });
  fs.writeFileSync(WATCH_STATE_FILE, JSON.stringify(state, null, 2));
}

export function clearStaleFaults() {
  const now = Date.now();
  const nextState = {
    clearedRunFaultAt: now,
    clearedSessionIdleAt: now,
  };
  writeWatchState(nextState);
  return nextState;
}

// ── task runs ──────────────────────────────────────────────────────────────
function getOpenClawRuns(): string {
  const sql = [
    'SELECT task_id, label, status,',
    "datetime(created_at/1000,'unixepoch') as ts,",
    'substr(task,1,240) as task,',
    'terminal_outcome, source_id,',
    "substr(terminal_summary,1,200) as terminal_summary,",
    "substr(error,1,200) as error",
    'FROM task_runs',
    "WHERE task NOT LIKE '%Reply with exactly%'",
    'ORDER BY created_at DESC LIMIT 30',
  ].join(' ');
  return run(`sqlite3 -json ${WATCH_RUNS_DB} "${sql}" 2>/dev/null || echo '[]'`);
}

// ── live session ────────────────────────────────────────────────────────────
function getOpenClawSession(): string {
  const sessionFile = findLatestSessionFile();
  if (!sessionFile) return '[]';

  // tail -n 100 reads complete lines (some lines are 2-6KB each)
  const raw = run(`tail -n 100 "${sessionFile.trim()}" 2>/dev/null`);
  if (!raw) return '[]';

  const turns: object[] = [];

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const obj = parseSafe(line);
    if (!obj) continue;

    const { type, message: msg = {}, timestamp: ts = '' } = obj;

    if (type === 'message') {
      const { role, content } = msg;

      if (role === 'user') {
        // Content is always a list with a single text part
        const rawText: string =
          Array.isArray(content)
            ? content.map((c: any) => c.text ?? c.content ?? '').join(' ')
            : typeof content === 'string'
              ? content
              : String(content ?? '');

        // Strip OpenClaw Telegram metadata preamble — actual message follows last ``` block
        let text = rawText;
        if (rawText.includes('Conversation info (untrusted metadata)')) {
          const idx = rawText.lastIndexOf('```\n\n');
          if (idx >= 0) {
            text = rawText.slice(idx + 5).trim();
          } else {
            // skip system-injected messages with no real user content
            continue;
          }
        }

        // Skip pure system/probe messages
        if (!text || text.startsWith('Reply with exactly') || text.startsWith('You are running a boot')) continue;

        turns.push({ kind: 'user', ts, text: text.slice(0, 300) });

      } else if (role === 'assistant') {
        const parts: any[] = Array.isArray(content) ? content : [];
        for (const part of parts) {
          if (part.type === 'text' && part.text) {
            const text = String(part.text)
              .replace(/\[\[reply_to_current\]\]\s*/g, '')
              .trim();
            if (text) turns.push({ kind: 'reply', ts, text: text.slice(0, 300) });
          } else if (part.type === 'toolCall') {
            const args = part.arguments ?? {};
            const detail =
              args.command ?? args.path ?? args.query ?? JSON.stringify(args).slice(0, 120);
            turns.push({ kind: 'tool', ts, name: part.name, detail: String(detail).slice(0, 200) });
          }
        }
      }
    }
  }

  return JSON.stringify(turns.slice(-25));
}

// ── flows ───────────────────────────────────────────────────────────────────
function getOpenClawFlows(): string {
  const sql = [
    'SELECT flow_id, status, sync_mode,',
    "datetime(created_at/1000,'unixepoch') as ts,",
    "datetime(updated_at/1000,'unixepoch') as updated_at,",
    "datetime(ended_at/1000,'unixepoch') as ended_at,",
    'substr(goal,1,200) as goal,',
    'current_step, substr(blocked_summary,1,200) as blocked_summary',
    'FROM flow_runs',
    'ORDER BY created_at DESC LIMIT 25',
  ].join(' ');
  return run(`sqlite3 -json ${WATCH_FLOWS_DB} "${sql}" 2>/dev/null || echo '[]'`);
}

// ── cron runs ───────────────────────────────────────────────────────────────
function getOpenClawCron(): string {
  const raw = run(
    `files=$(ls -1t ${WATCH_OPENCLAW_DIR}/cron/runs/*.jsonl 2>/dev/null | head -3); ` +
    `[ -z "$files" ] && echo '[]' && exit 0; ` +
    `for f in $files; do tail -n 10 "$f"; done`
  );
  if (!raw || raw === '[]') return '[]';

  const lines = raw.split('\n').filter(Boolean);
  const items: any[] = [];
  for (const line of lines) {
    const obj = parseSafe(line);
    if (obj) items.push(obj);
  }
  // most recent first, dedup by jobId keeping latest
  const seen = new Set<string>();
  const deduped = items
    .reverse()
    .filter((x) => { if (seen.has(x.jobId)) return false; seen.add(x.jobId); return true; });
  return JSON.stringify(deduped);
}

// ── agent meta (version, model, auth, sessions) ─────────────────────────────
function getOpenClawMeta(): string {
  const configRaw     = run(`cat ${WATCH_OPENCLAW_DIR}/openclaw.json 2>/dev/null`);
  const authStateRaw  = run(`cat ${WATCH_OPENCLAW_DIR}/agents/main/agent/auth-state.json 2>/dev/null`);
  const healthRaw     = run(`cat ${WATCH_OPENCLAW_DIR}/logs/config-health.json 2>/dev/null`);

  const config    = parseSafe(configRaw)    || {};
  const authState = parseSafe(authStateRaw) || {};
  const sessionDataByAgent = listAgentIds().map((agentId) => {
    const raw = run(`cat ${WATCH_OPENCLAW_DIR}/agents/${agentId}/sessions/sessions.json 2>/dev/null`);
    const parsed = parseSafe(raw) || {};
    return { agentId, parsed };
  });
  const health    = parseSafe(healthRaw)    || {};

  // version + model
  const version    = config?.meta?.lastTouchedVersion || '?';
  const agentEntry = (config?.agents?.list || []).find((a: any) => a.default) || (config?.agents?.list || [])[0] || {};
  const model      = agentEntry?.model || config?.agents?.defaults?.model?.primary || '?';
  const thinking   = agentEntry?.thinkingDefault || config?.agents?.defaults?.thinkingDefault || '?';
  const heartbeat  = config?.agents?.defaults?.heartbeat?.every || '?';
  const maxFlows   = config?.agents?.defaults?.maxConcurrent?.flows ?? config?.agents?.defaults?.maxConcurrentFlows ?? null;
  const maxSubagents = config?.agents?.defaults?.subagents?.maxConcurrent ?? config?.agents?.defaults?.maxConcurrentSubagents ?? null;

  // auth providers
  const usage = authState?.usageStats || {};
  const authProviders = Object.entries(usage).map(([id, v]: [string, any]) => ({
    id,
    errorCount:    v?.errorCount   ?? 0,
    cooldownUntil: v?.cooldownUntil ?? null,
    lastUsed:      v?.lastUsed      ?? null,
    lastFailureAt: v?.lastFailureAt ?? null,
    cooldownReason:v?.cooldownReason ?? null,
  }));

  // sessions
  const sessions = sessionDataByAgent
    .flatMap(({ parsed }) => Object.entries(parsed as Record<string, any>))
    .filter(([k]) => k !== 'version')
    .map(([key, v]: [string, any]) => ({
      key,
      status:    v?.status    ?? (v?.updatedAt ? 'active' : 'unknown'),
      updatedAt: v?.updatedAt ?? null,
      model:     v?.model     ?? null,
      channel:   v?.channel   ?? null,
    }))
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));

  const configHealthy = (health as any)?.ok !== false && !String(configRaw).startsWith('ERROR');

  return JSON.stringify({
    version,
    model,
    thinking,
    heartbeat,
    maxFlows,
    maxSubagents,
    authProviders,
    sessions,
    configHealthy,
  });
}

export function getWatchSnapshot(): WatchSnapshot {
  if (WATCH_DEMO_MODE) {
    return buildDemoWatchSnapshot() as WatchSnapshot;
  }

  return {
    ok: true,
    now: new Date().toISOString(),
    status: 'working',
    summary: 'Live ops watcher',
    sections: {
      openclawMeta:    getOpenClawMeta(),
      openclawSession: getOpenClawSession(),
      openclawRuns:    getOpenClawRuns(),
      openclawFlows:   getOpenClawFlows(),
      openclawCron:    getOpenClawCron(),
      teamTopology:    getTeamTopology(),
      watchFaultState: JSON.stringify(readWatchState()),
      pm2:           run(`${WATCH_PM2_BIN} list`),
      pm2Json:       run(`${WATCH_PM2_BIN} jlist`),
      updateResult:  run(`cat ${WATCH_UPDATE_RESULT_PATH} 2>/dev/null || true`),
      snapmoltOut:   readMergedLog(pm2LogGlob(WATCH_SNAPMOLT_PROCESS, 'out'), 120, 160),
      snapmoltErr:   readMergedLog(pm2LogGlob(WATCH_SNAPMOLT_PROCESS, 'error'), 80, 120),
      echoesOut:     run(`tail -n 40 ${pm2LogFile(WATCH_ECHOES_PROCESS, 'out')}`),
      echoesErr:     run(`tail -n 40 ${pm2LogFile(WATCH_ECHOES_PROCESS, 'error')}`),
    },
  };
}
