import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
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

const OPENCLAW_DB   = '/root/.openclaw/tasks/runs.sqlite';
const OPENCLAW_DIR  = '/root/.openclaw';
const WATCH_STATE_FILE = path.join(process.cwd(), '.watch-state.json');

function readWatchState(): { clearedRunFaultAt: number | null } {
  try {
    const raw = fs.readFileSync(WATCH_STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      clearedRunFaultAt:
        typeof parsed?.clearedRunFaultAt === 'number' && Number.isFinite(parsed.clearedRunFaultAt)
          ? parsed.clearedRunFaultAt
          : null,
    };
  } catch {
    return { clearedRunFaultAt: null };
  }
}

function writeWatchState(state: { clearedRunFaultAt: number | null }) {
  fs.writeFileSync(WATCH_STATE_FILE, JSON.stringify(state, null, 2));
}

export function clearRunFaults() {
  const nextState = { clearedRunFaultAt: Date.now() };
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
  return run(`sqlite3 -json ${OPENCLAW_DB} "${sql}" 2>/dev/null || echo '[]'`);
}

// ── live session ────────────────────────────────────────────────────────────
function getOpenClawSession(): string {
  const SESS_DIR = `${OPENCLAW_DIR}/agents/main/sessions`;

  // Find the most recently modified active session file
  const sessionFile = run(
    `ls -1t ${SESS_DIR}/*.jsonl 2>/dev/null | grep -v '\\.reset\\|\\.deleted\\|\\.bak\\|\\.lock' | head -1`,
  );
  if (!sessionFile || sessionFile.startsWith('ERROR')) return '[]';

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
  const FLOWS_DB = `${OPENCLAW_DIR}/flows/registry.sqlite`;
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
  return run(`sqlite3 -json ${FLOWS_DB} "${sql}" 2>/dev/null || echo '[]'`);
}

// ── cron runs ───────────────────────────────────────────────────────────────
function getOpenClawCron(): string {
  const raw = run(
    `files=$(ls -1t ${OPENCLAW_DIR}/cron/runs/*.jsonl 2>/dev/null | head -3); ` +
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
  const configRaw     = run(`cat ${OPENCLAW_DIR}/openclaw.json 2>/dev/null`);
  const authStateRaw  = run(`cat ${OPENCLAW_DIR}/agents/main/agent/auth-state.json 2>/dev/null`);
  const sessionsRaw   = run(`cat ${OPENCLAW_DIR}/agents/main/sessions/sessions.json 2>/dev/null`);
  const healthRaw     = run(`cat ${OPENCLAW_DIR}/logs/config-health.json 2>/dev/null`);

  const config    = parseSafe(configRaw)    || {};
  const authState = parseSafe(authStateRaw) || {};
  const sessData  = parseSafe(sessionsRaw)  || {};
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
  const sessions = Object.entries(sessData)
    .filter(([k]) => !['version'].includes(k))
    .map(([key, v]: [string, any]) => ({
      key,
      status:    v?.status    ?? 'unknown',
      updatedAt: v?.updatedAt ?? null,
      model:     v?.model     ?? null,
      channel:   v?.channel   ?? null,
    }));

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
      pm2:           run('pm2 list'),
      updateResult:  run('cat /root/.openclaw/tasks/update-command.result 2>/dev/null || true'),
      snapmoltOut:   readMergedLog('/root/.pm2/logs/snapmolt-out*.log', 120, 160),
      snapmoltErr:   readMergedLog('/root/.pm2/logs/snapmolt-error*.log', 80, 120),
      echoesOut:     run('tail -n 40 /root/.pm2/logs/echoes-backend-out.log'),
      echoesErr:     run('tail -n 40 /root/.pm2/logs/echoes-backend-error.log'),
    },
  };
}
