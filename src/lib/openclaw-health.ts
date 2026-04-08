export type HealthLevel = 'ok' | 'warn' | 'error';

export type HealthIssue = {
  level: 'warn' | 'error';
  message: string;
};

export type SystemHealth = {
  level: HealthLevel;
  label: string;
  issues: HealthIssue[];
  color: string;
  bg: string;
  border: string;
};

export type OpenClawMeta = {
  version: string;
  model: string;
  thinking: string;
  heartbeat: string;
  maxFlows: number | null;
  maxSubagents: number | null;
  authProviders: AuthProvider[];
  sessions: AgentSession[];
  configHealthy: boolean;
};

export type AuthProvider = {
  id: string;
  errorCount: number;
  cooldownUntil: number | null;
  lastUsed: number | null;
  lastFailureAt: number | null;
  cooldownReason: string | null;
};

export type AgentSession = {
  key: string;
  status: string;
  updatedAt: number | null;
  model: string | null;
  channel: string | null;
};

export type RunRecord = {
  task_id: string;
  label: string;
  status: string;
  ts: string;
  task: string;
  terminal_outcome: string;
  terminal_summary: string;
  error: string;
  source_id: string;
};

export type FlowRecord = {
  flow_id: string;
  status: string;
  sync_mode: string;
  ts: string;
  updated_at: string;
  ended_at: string;
  goal: string;
  current_step: string;
  blocked_summary: string;
};

export type SessionTurn = {
  kind: 'user' | 'reply' | 'tool';
  ts: string;
  text?: string;
  name?: string;
  detail?: string;
};

export function parseSession(raw: string | undefined): SessionTurn[] {
  return parseJsonSafe<SessionTurn[]>(raw, []);
}

export type CronRecord = {
  ts: number;
  jobId: string;
  action: string;
  status: string;
  error: string | null;
  summary: string;
  durationMs: number;
  nextRunAtMs: number;
};

function parseJsonSafe<T>(raw: string | undefined, fallback: T): T {
  try { return JSON.parse(raw || '') as T; } catch { return fallback; }
}

export function parseMeta(raw: string | undefined): OpenClawMeta {
  return parseJsonSafe<OpenClawMeta>(raw, {
    version: '?', model: '?', thinking: '?', heartbeat: '?',
    maxFlows: null, maxSubagents: null,
    authProviders: [], sessions: [], configHealthy: true,
  });
}

export function parseRuns(raw: string | undefined): RunRecord[] {
  return parseJsonSafe<RunRecord[]>(raw, []);
}

export function parseFlows(raw: string | undefined): FlowRecord[] {
  return parseJsonSafe<FlowRecord[]>(raw, []);
}

export function parseCron(raw: string | undefined): CronRecord[] {
  return parseJsonSafe<CronRecord[]>(raw, []);
}

export function computeHealth(
  meta: OpenClawMeta,
  runs: RunRecord[],
): SystemHealth {
  const now = Date.now();
  const issues: HealthIssue[] = [];

  // ── config integrity ──────────────────────────────────────────────────────
  if (!meta.configHealthy) {
    issues.push({ level: 'error', message: 'Config file integrity check failed' });
  }

  // ── auth providers ────────────────────────────────────────────────────────
  const activeProviders = meta.authProviders;
  const inCooldown = activeProviders.filter(
    (p) => p.cooldownUntil && p.cooldownUntil > now,
  );
  const hardFailing = activeProviders.filter((p) => p.errorCount >= 3);
  const allFailing = activeProviders.length > 0 &&
    activeProviders.every((p) => p.errorCount > 0);

  if (allFailing) {
    issues.push({ level: 'error', message: 'All auth providers have errors — agent cannot call models' });
  } else if (hardFailing.length > 0) {
    for (const p of hardFailing) {
      issues.push({ level: 'error', message: `${p.id}: ${p.errorCount} auth errors` });
    }
  } else if (inCooldown.length > 0) {
    for (const p of inCooldown) {
      const mins = Math.max(1, Math.round(((p.cooldownUntil ?? 0) - now) / 60000));
      issues.push({ level: 'warn', message: `${p.id}: auth cooldown (~${mins}m remaining)` });
    }
  }

  // ── recent run failures ───────────────────────────────────────────────────
  const recent = runs.slice(0, 8);
  const failures = recent.filter((r) => r.status === 'failed');
  const allRecentFailed = recent.length >= 3 && recent.slice(0, 3).every((r) => r.status === 'failed');

  if (allRecentFailed) {
    issues.push({ level: 'error', message: `Last 3 consecutive runs failed — agent may be stuck` });
  } else if (failures.length >= 3) {
    issues.push({ level: 'warn', message: `${failures.length} of last ${recent.length} runs failed` });
  } else if (failures.length > 0) {
    issues.push({ level: 'warn', message: `${failures.length} recent run failure${failures.length > 1 ? 's' : ''}` });
  }

  // ── session staleness ─────────────────────────────────────────────────────
  const mainSession = meta.sessions.find((s) => s.key === 'agent:main:main');
  if (mainSession) {
    // 'running' means actively processing — never flag as stale
    if (mainSession.status !== 'running' && mainSession.updatedAt) {
      const idleMs = now - mainSession.updatedAt;
      const idleHours = idleMs / 3_600_000;
      if (idleHours >= 8) {
        issues.push({ level: 'error', message: `Agent session idle for ${Math.round(idleHours)}h — may need /reset` });
      } else if (idleHours >= 2) {
        issues.push({ level: 'warn', message: `Agent session idle for ${Math.round(idleHours)}h` });
      }
    }
  } else if (meta.sessions.length === 0) {
    issues.push({ level: 'warn', message: 'No active agent sessions found' });
  }

  // ── determine overall level ───────────────────────────────────────────────
  const hasError = issues.some((i) => i.level === 'error');
  const hasWarn  = issues.some((i) => i.level === 'warn');
  const level: HealthLevel = hasError ? 'error' : hasWarn ? 'warn' : 'ok';

  const labels: Record<HealthLevel, string> = {
    ok:    'NOMINAL',
    warn:  'DEGRADED',
    error: 'FAULT',
  };

  const styles: Record<HealthLevel, { color: string; bg: string; border: string }> = {
    ok:    { color: '#4ade80', bg: 'rgba(74,222,128,0.10)', border: 'rgba(74,222,128,0.30)' },
    warn:  { color: '#fbbf24', bg: 'rgba(251,191,36,0.10)', border: 'rgba(251,191,36,0.30)' },
    error: { color: '#f87171', bg: 'rgba(248,113,113,0.10)', border: 'rgba(248,113,113,0.30)' },
  };

  return { level, label: labels[level], issues, ...styles[level] };
}

export function providerHealth(p: AuthProvider): HealthLevel {
  const now = Date.now();
  if (p.errorCount >= 3) return 'error';
  if (p.cooldownUntil && p.cooldownUntil > now) return 'warn';
  if (p.errorCount > 0) return 'warn';
  return 'ok';
}

export function sessionIdleLabel(updatedAt: number | null): string {
  if (!updatedAt) return 'never';
  const ms = Date.now() - updatedAt;
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}
