'use client';

import dynamic from 'next/dynamic';
import { useEffect, useState } from 'react';
import { WatchShellHeader } from '@/components/watch-shell-header';
import {
  getPrimarySnapmoltText,
  getLatestSnapmoltError,
  getStructuredSnapmoltActivity,
  getActivityBreakdown,
  type ActivityTag,
  type ActivityItem,
} from '@/lib/snapmolt-mirror';
import {
  computeHealth,
  parseMeta,
  parseRuns,
  parseFlows,
  parseCron,
  parseSession,
  parseFaultState,
  providerHealth,
  sessionIdleLabel,
  type HealthLevel,
  type OpenClawMeta,
  type RunRecord,
  type FlowRecord,
  type CronRecord,
  type SessionTurn,
  type SystemHealth,
  type FaultState,
} from '@/lib/openclaw-health';
import {
  parseTeamTopology,
  sortTeamTopics,
  topicDisplayLabel,
  type TeamTopic,
  type TeamTopology,
} from '@/lib/watch-team';

// ── types ────────────────────────────────────────────────────────────────────

type WatchData = {
  ok: boolean;
  now: string;
  status: string;
  summary: string;
  sections: Record<string, string>;
};

type SectionTab = 'status' | 'office' | 'team' | 'runs' | 'flows' | 'snapmolt' | 'logs' | 'processes';

const sectionTabs: { id: SectionTab; label: string; hint: string }[] = [
  { id: 'status',    label: 'status',    hint: 'mission control' },
  { id: 'office',    label: 'office',    hint: '3d operator floor' },
  { id: 'team',      label: 'team',      hint: 'lanes & roster' },
  { id: 'runs',      label: 'runs',      hint: 'openclaw activity' },
  { id: 'flows',     label: 'flows',     hint: 'multi-step goals' },
  { id: 'snapmolt',  label: 'snapmolt',  hint: 'voice & agent feed' },
  { id: 'logs',      label: 'logs',      hint: 'raw output streams' },
  { id: 'processes', label: 'processes', hint: 'pm2 status' },
];

const TeamOfficePanel = dynamic(
  () => import('@/components/team-office/team-office-panel').then((mod) => mod.TeamOfficePanel),
  {
    ssr: false,
    loading: () => (
      <div className="h-[72dvh] min-h-[520px] animate-pulse rounded-xl border border-[var(--watch-panel-border)] bg-[rgba(255,255,255,0.03)] sm:h-[560px]" />
    ),
  },
);

// ── shared primitives ────────────────────────────────────────────────────────

const HEALTH_STYLE: Record<HealthLevel, { color: string; bg: string; border: string }> = {
  ok:    { color: '#4ade80', bg: 'rgba(74,222,128,0.10)',  border: 'rgba(74,222,128,0.28)'  },
  warn:  { color: '#fbbf24', bg: 'rgba(251,191,36,0.10)',  border: 'rgba(251,191,36,0.28)'  },
  error: { color: '#f87171', bg: 'rgba(248,113,113,0.10)', border: 'rgba(248,113,113,0.28)' },
};

function HealthBadge({ level, label }: { level: HealthLevel; label?: string }) {
  const s = HEALTH_STYLE[level];
  const text = label ?? level.toUpperCase();
  return (
    <span
      className="inline-block rounded-sm px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.2em] leading-none"
      style={{ color: s.color, background: s.bg, border: `1px solid ${s.border}` }}
    >
      {text}
    </span>
  );
}

function RunStatusBadge({ status }: { status: string }) {
  const map: Record<string, HealthLevel> = {
    succeeded: 'ok', failed: 'error', running: 'warn', pending: 'warn',
  };
  const level = map[status] ?? 'warn';
  return <HealthBadge level={level} label={status} />;
}

const TAG_META: Record<ActivityTag, { label: string; color: string; bg: string }> = {
  voice:  { label: 'voice',  color: '#67e8f9', bg: 'rgba(103,232,249,0.10)' },
  http:   { label: 'http',   color: '#818cf8', bg: 'rgba(129,140,248,0.10)' },
  event:  { label: 'event',  color: '#c084fc', bg: 'rgba(192,132,252,0.10)' },
  error:  { label: 'error',  color: '#f09070', bg: 'rgba(240,144,112,0.10)' },
  system: { label: 'system', color: '#86efac', bg: 'rgba(134,239,172,0.10)' },
  task:   { label: 'task',   color: '#fcd34d', bg: 'rgba(252,211,77,0.10)'  },
  log:    { label: 'log',    color: 'rgba(242,232,186,0.5)', bg: 'rgba(242,232,186,0.05)' },
};

function TagBadge({ tag }: { tag: ActivityTag }) {
  const meta = TAG_META[tag];
  return (
    <span
      className="inline-block shrink-0 rounded-sm px-1.5 py-0.5 text-[10px] uppercase tracking-[0.15em] font-medium leading-none"
      style={{ color: meta.color, background: meta.bg, border: `1px solid ${meta.color}22` }}
    >
      {meta.label}
    </span>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] uppercase tracking-[0.28em] text-[var(--watch-text-muted)]">
      ▌ {children}
    </div>
  );
}

function LogPanel({ label, hint, content }: { label: string; hint: string; content: string }) {
  return (
    <div className="flex flex-col overflow-hidden rounded border border-[var(--watch-panel-border)] bg-[rgba(0,0,0,0.2)]">
      <div className="flex items-baseline gap-2 border-b border-[var(--watch-panel-border)] px-3 py-2">
        <span className="text-[10px] uppercase tracking-[0.25em] text-[var(--watch-accent-strong)]">{label}</span>
        <span className="text-[10px] text-[var(--watch-text-muted)]">— {hint}</span>
      </div>
      <pre className="max-h-[38vh] overflow-auto p-3 text-[11px] leading-[1.7] text-[var(--watch-text-code)] sm:max-h-[44vh]">
        {content || '(empty)'}
      </pre>
    </div>
  );
}

// ── mission control banner ───────────────────────────────────────────────────

function MissionBanner({ health, meta, now, sessionRunning, canClearStaleFaults, clearingRunFaults, onClearRunFaults }: {
  health: SystemHealth;
  meta: OpenClawMeta;
  now: string;
  sessionRunning: boolean;
  canClearStaleFaults: boolean;
  clearingRunFaults: boolean;
  onClearRunFaults: () => void;
}) {
  const s = HEALTH_STYLE[health.level];
  const modelShort = meta.model.replace('openai-codex/', '').replace('anthropic/', '');

  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded border px-4 py-3"
      style={{ background: s.bg, borderColor: s.border }}
    >
      {/* Status pill */}
      <div className="flex items-center gap-2">
        <span
          className="inline-block h-2 w-2 rounded-full"
          style={{ background: s.color, boxShadow: `0 0 8px ${s.color}99` }}
        />
        <span className="text-sm font-semibold tracking-[0.18em] uppercase" style={{ color: s.color }}>
          {health.label}
        </span>
      </div>

      <span className="hidden h-3 w-px bg-[var(--watch-panel-border)] sm:block" />

      {/* Version + model */}
      <span className="text-[11px] text-[var(--watch-text-bright)]">v{meta.version}</span>
      <span className="text-[var(--watch-panel-border)]">·</span>
      <span className="text-[11px] text-[var(--watch-text-bright)]">{modelShort}</span>
      {meta.thinking && meta.thinking !== '?' && (
        <>
          <span className="text-[var(--watch-panel-border)]">·</span>
          <span className="text-[11px] text-[var(--watch-text-muted)]">thinking: {meta.thinking}</span>
        </>
      )}

      {/* Session running indicator */}
      {sessionRunning && health.issues.length === 0 && (
        <>
          <span className="hidden h-3 w-px bg-[var(--watch-panel-border)] sm:block" />
          <span className="flex items-center gap-1.5 text-[11px]" style={{ color: '#4ade80' }}>
            <span className="inline-block h-1.5 w-1.5 rounded-full animate-pulse" style={{ background: '#4ade80' }} />
            in session
          </span>
        </>
      )}

      {/* Issues inline (first one) */}
      {health.issues.length > 0 && (
        <>
          <span className="hidden h-3 w-px bg-[var(--watch-panel-border)] sm:block" />
          <span className="text-[11px]" style={{ color: health.issues[0].level === 'error' ? '#f87171' : '#fbbf24' }}>
            ⚠ {health.issues[0].message}
            {health.issues.length > 1 ? ` (+${health.issues.length - 1} more)` : ''}
          </span>
          {canClearStaleFaults && (
            <button
              type="button"
              onClick={onClearRunFaults}
              disabled={clearingRunFaults}
              className="rounded-sm border px-2 py-1 text-[10px] uppercase tracking-[0.18em] transition-opacity disabled:cursor-not-allowed disabled:opacity-50"
              style={{ borderColor: 'rgba(242,232,186,0.22)', color: 'var(--watch-text-bright)', background: 'rgba(255,255,255,0.03)' }}
            >
              {clearingRunFaults ? 'clearing…' : 'clear stale faults'}
            </button>
          )}
        </>
      )}

      {/* Refresh indicator */}
      <div className="ml-auto flex items-center gap-1.5">
        <span className="text-[10px] tabular-nums text-[var(--watch-text-muted)]">
          {now ? now.replace('T', ' ').slice(0, 19) + ' UTC' : '…'}
        </span>
        <span className="text-[10px] text-[var(--watch-text-muted)]">↻ 5s</span>
      </div>
    </div>
  );
}

// ── LIVE SESSION FEED ────────────────────────────────────────────────────────

const TURN_STYLE = {
  user:  { label: 'you',   color: '#67e8f9', bg: 'rgba(103,232,249,0.08)' },
  reply: { label: 'agent', color: '#ecd58d', bg: 'rgba(236,213,141,0.06)' },
  tool:  { label: 'tool',  color: '#c084fc', bg: 'rgba(192,132,252,0.07)' },
};

function LiveSessionFeed({ turns, sessionRunning }: { turns: SessionTurn[]; sessionRunning: boolean }) {
  if (turns.length === 0) {
    return (
      <div className="px-3 py-4 text-xs text-[var(--watch-text-muted)]">
        No session activity yet.
      </div>
    );
  }

  const ordered = [...turns].reverse();

  return (
    <div className="flex flex-col divide-y divide-[var(--watch-panel-border)]">
      {ordered.map((turn, i) => {
        const style = TURN_STYLE[turn.kind] ?? TURN_STYLE.reply;
        const time = turn.ts ? turn.ts.slice(11, 19) : '';
        const isLast = i === 0; // first in reversed list = most recent

        return (
          <div
            key={i}
            className="flex items-start gap-3 px-3 py-2.5"
            style={{ background: isLast && sessionRunning ? style.bg : undefined }}
          >
            {/* Kind badge */}
            <span
              className="mt-0.5 shrink-0 rounded-sm px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.15em] leading-none"
              style={{ color: style.color, background: style.bg, border: `1px solid ${style.color}22` }}
            >
              {style.label}
            </span>
            {/* Content */}
            <div className="min-w-0 flex-1">
              {turn.kind === 'tool' ? (
                <div>
                  <span className="text-[11px] font-medium" style={{ color: style.color }}>
                    {turn.name}
                  </span>
                  {turn.detail && (
                    <pre className="mt-0.5 whitespace-pre-wrap break-words text-[10px] leading-5 text-[var(--watch-text-muted)]">
                      {turn.detail}
                    </pre>
                  )}
                </div>
              ) : (
                <pre className="whitespace-pre-wrap break-words text-xs leading-6 text-[var(--watch-text-bright)]">
                  {turn.text}
                </pre>
              )}
            </div>
            {/* Timestamp */}
            <span className="shrink-0 tabular-nums text-[10px] text-[var(--watch-text-muted)]">{time}</span>
          </div>
        );
      })}
      {sessionRunning && (
        <div className="flex items-center gap-2 px-3 py-2">
          <span className="inline-block h-1.5 w-1.5 rounded-full animate-pulse" style={{ background: '#4ade80' }} />
          <span className="text-[10px] text-[var(--watch-text-muted)]">agent is working…</span>
        </div>
      )}
    </div>
  );
}

// ── STATUS TAB ───────────────────────────────────────────────────────────────

function StatusSection({ data, health, meta, runs, cron, turns, sessionRunning }: {
  data: WatchData | null;
  health: SystemHealth;
  meta: OpenClawMeta;
  runs: RunRecord[];
  cron: CronRecord[];
  turns: SessionTurn[];
  sessionRunning: boolean;
}) {
  const modelShort = meta.model.replace('openai-codex/', '').replace('anthropic/', '');

  return (
    <div className="flex flex-col gap-5">

      {/* Live session feed — primary surface when active */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <SectionLabel>live session</SectionLabel>
          {sessionRunning && (
            <span className="flex items-center gap-1 text-[10px]" style={{ color: '#4ade80' }}>
              <span className="inline-block h-1.5 w-1.5 rounded-full animate-pulse" style={{ background: '#4ade80' }} />
              running
            </span>
          )}
        </div>
        <div className="overflow-hidden rounded border border-[var(--watch-panel-border)] bg-[rgba(0,0,0,0.18)]">
          <div className="max-h-[84vh] sm:max-h-[62vh] overflow-y-auto">
            <LiveSessionFeed turns={turns} sessionRunning={sessionRunning} />
          </div>
        </div>
      </div>


      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {/* Version & model */}
        <div className="flex flex-col gap-2 rounded border border-[var(--watch-panel-border)] bg-[rgba(0,0,0,0.18)] p-4">
          <div className="text-[10px] uppercase tracking-[0.25em] text-[var(--watch-text-muted)]">agent</div>
          <div className="text-sm font-semibold text-[var(--watch-text-bright)]">{modelShort}</div>
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-[var(--watch-text-muted)]">
            <span>v{meta.version}</span>
            {meta.thinking !== '?' && <span>thinking: {meta.thinking}</span>}
            {meta.heartbeat !== '?' && <span>heartbeat: {meta.heartbeat}</span>}
          </div>
        </div>

        {/* Auth providers */}
        <div className="flex flex-col gap-2 rounded border border-[var(--watch-panel-border)] bg-[rgba(0,0,0,0.18)] p-4">
          <div className="text-[10px] uppercase tracking-[0.25em] text-[var(--watch-text-muted)]">auth</div>
          {meta.authProviders.length === 0 ? (
            <div className="text-[11px] text-[var(--watch-text-muted)]">—</div>
          ) : (
            meta.authProviders.map((p) => {
              const lvl = providerHealth(p);
              const ps  = HEALTH_STYLE[lvl];
              const name = p.id.replace(':default', '');
              return (
                <div key={p.id} className="flex items-center justify-between gap-2">
                  <span className="text-[11px] text-[var(--watch-text-bright)] truncate">{name}</span>
                  <HealthBadge level={lvl} label={lvl === 'ok' ? 'ok' : lvl === 'warn' ? 'cooldown' : 'error'} />
                </div>
              );
            })
          )}
        </div>

        {/* Session */}
        <div className="flex flex-col gap-2 rounded border border-[var(--watch-panel-border)] bg-[rgba(0,0,0,0.18)] p-4">
          <div className="text-[10px] uppercase tracking-[0.25em] text-[var(--watch-text-muted)]">session</div>
          {meta.sessions.length === 0 ? (
            <div className="text-[11px] text-[var(--watch-text-muted)]">no sessions</div>
          ) : (
            <div className="max-h-40 space-y-1 overflow-auto pr-1">
              {meta.sessions
                .filter(s => s.key.includes('main:main'))
                .concat(meta.sessions.filter(s => !s.key.includes('main:main')))
                .map((sess) => {
                  const idleMs = sess.updatedAt ? Date.now() - sess.updatedAt : null;
                  const isStale = idleMs !== null && idleMs > 8 * 3_600_000;
                  const isIdle  = idleMs !== null && idleMs > 2 * 3_600_000;
                  const sessLevel: HealthLevel = isStale ? 'error' : isIdle ? 'warn' : 'ok';
                  const shortKey = sess.key.replace('agent:main:', '');
                  return (
                    <div key={sess.key} className="flex items-center justify-between gap-2">
                      <span className="text-[11px] truncate text-[var(--watch-text-bright)]">{shortKey}</span>
                      <span className="shrink-0 text-[10px] tabular-nums" style={{ color: HEALTH_STYLE[sessLevel].color }}>
                        {sessionIdleLabel(sess.updatedAt)}
                      </span>
                    </div>
                  );
                })}
            </div>
          )}
        </div>
      </div>

      {/* Recent runs summary */}
      <div className="flex flex-col gap-2">
        <SectionLabel>recent runs</SectionLabel>
        <div className="overflow-hidden rounded border border-[var(--watch-panel-border)]">
          {runs.slice(0, 6).length === 0 ? (
            <div className="px-3 py-3 text-xs text-[var(--watch-text-muted)]">no runs yet</div>
          ) : (
            runs.slice(0, 6).map((r) => (
              <div
                key={r.task_id}
                className="flex items-start gap-3 border-b border-[var(--watch-panel-border)] px-3 py-2.5 last:border-b-0"
              >
                <RunStatusBadge status={r.status} />
                <span className="min-w-0 flex-1 text-[11px] leading-5 text-[var(--watch-text-bright)] break-words">
                  {r.task}
                </span>
                <span className="shrink-0 tabular-nums text-[10px] text-[var(--watch-text-muted)]">
                  {r.ts?.slice(11, 16)}
                </span>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Cron status */}
      {cron.length > 0 && (
        <div className="flex flex-col gap-2">
          <SectionLabel>scheduled jobs</SectionLabel>
          <div className="overflow-hidden rounded border border-[var(--watch-panel-border)]">
            {cron.map((job) => {
              const jobLevel: HealthLevel =
                job.status === 'succeeded' ? 'ok' :
                job.status === 'skipped' ? 'warn' : 'error';
              return (
                <div
                  key={job.jobId}
                  className="flex items-start gap-3 border-b border-[var(--watch-panel-border)] px-3 py-2.5 last:border-b-0"
                >
                  <HealthBadge level={jobLevel} label={job.status} />
                  <span className="min-w-0 flex-1 text-[11px] leading-5 text-[var(--watch-text-bright)] break-words">
                    {job.summary || job.jobId}
                  </span>
                  {job.error && (
                    <span className="shrink-0 text-[10px] text-[#fbbf24]">{job.error}</span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Update result */}
      {data?.sections.updateResult && (
        <div className="flex flex-col gap-2">
          <SectionLabel>last update</SectionLabel>
          <div className="overflow-hidden rounded border border-[var(--watch-panel-border)] bg-[rgba(0,0,0,0.18)]">
            <pre className="max-h-[20vh] overflow-auto p-3 text-[11px] leading-[1.7] text-[var(--watch-text-code)]">
              {data.sections.updateResult}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}

// ── RUNS TAB ─────────────────────────────────────────────────────────────────

function RunsSection({ runs }: { runs: RunRecord[] }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-baseline gap-2">
        <SectionLabel>openclaw task runs</SectionLabel>
        <span className="text-[10px] text-[var(--watch-text-muted)]">— all agent tasks · most recent first</span>
      </div>
      <div className="overflow-hidden rounded border border-[var(--watch-panel-border)]">
        {runs.length === 0 ? (
          <div className="px-4 py-6 text-xs text-[var(--watch-text-muted)]">No runs recorded yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr className="border-b border-[var(--watch-panel-border)]">
                  {['time', 'status', 'label', 'task'].map((h) => (
                    <th key={h} className="px-3 py-2 text-left text-[10px] uppercase tracking-[0.2em] text-[var(--watch-text-muted)] font-normal whitespace-nowrap">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr key={run.task_id} className="border-b border-[var(--watch-panel-border)] last:border-b-0 hover:bg-white/[0.02] transition-colors">
                    <td className="px-3 py-2.5 tabular-nums text-[var(--watch-text-muted)] whitespace-nowrap align-top">
                      {run.ts?.slice(0, 16).replace('T', ' ') ?? '—'}
                    </td>
                    <td className="px-3 py-2.5 align-top whitespace-nowrap">
                      <RunStatusBadge status={run.status} />
                    </td>
                    <td className="px-3 py-2.5 text-[var(--watch-text-muted)] whitespace-nowrap align-top max-w-[120px] truncate">
                      {run.label || <span className="opacity-30">—</span>}
                    </td>
                    <td className="px-3 py-2.5 text-[var(--watch-text-bright)] align-top break-words max-w-[480px]">
                      {run.task}
                      {run.error && (
                        <div className="mt-1 text-[10px] text-[#f87171]">✕ {run.error}</div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {runs.length > 0 && (
        <div className="text-[10px] text-[var(--watch-text-muted)]">
          {runs.length} runs shown · refreshes every 5s
        </div>
      )}
    </div>
  );
}

// ── FLOWS TAB ────────────────────────────────────────────────────────────────

function FlowsSection({ flows }: { flows: FlowRecord[] }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-baseline gap-2">
        <SectionLabel>multi-step flows</SectionLabel>
        <span className="text-[10px] text-[var(--watch-text-muted)]">— orchestrated multi-turn sessions</span>
      </div>
      <div className="overflow-hidden rounded border border-[var(--watch-panel-border)]">
        {flows.length === 0 ? (
          <div className="px-4 py-6 text-xs text-[var(--watch-text-muted)]">No flows recorded yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr className="border-b border-[var(--watch-panel-border)]">
                  {['started', 'ended', 'status', 'goal', 'step / blocked'].map((h) => (
                    <th key={h} className="px-3 py-2 text-left text-[10px] uppercase tracking-[0.2em] text-[var(--watch-text-muted)] font-normal whitespace-nowrap">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {flows.map((f) => {
                  const lvl: HealthLevel = f.status === 'succeeded' ? 'ok' : f.status === 'failed' ? 'error' : 'warn';
                  return (
                    <tr key={f.flow_id} className="border-b border-[var(--watch-panel-border)] last:border-b-0 hover:bg-white/[0.02] transition-colors">
                      <td className="px-3 py-2.5 tabular-nums text-[var(--watch-text-muted)] whitespace-nowrap align-top">
                        {f.ts?.slice(0, 16).replace('T', ' ') ?? '—'}
                      </td>
                      <td className="px-3 py-2.5 tabular-nums text-[var(--watch-text-muted)] whitespace-nowrap align-top">
                        {f.ended_at?.slice(0, 16).replace('T', ' ') ?? '—'}
                      </td>
                      <td className="px-3 py-2.5 align-top whitespace-nowrap">
                        <HealthBadge level={lvl} label={f.status} />
                      </td>
                      <td className="px-3 py-2.5 text-[var(--watch-text-bright)] align-top break-words max-w-[400px]">
                        {f.goal}
                      </td>
                      <td className="px-3 py-2.5 align-top max-w-[200px]">
                        {f.blocked_summary ? (
                          <span className="text-[10px] text-[#fbbf24]">⊘ {f.blocked_summary}</span>
                        ) : f.current_step ? (
                          <span className="text-[10px] text-[var(--watch-text-muted)]">{f.current_step}</span>
                        ) : (
                          <span className="text-[10px] opacity-30">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ── SNAPMOLT TAB ─────────────────────────────────────────────────────────────

function SnapmoltSection({ data }: { data: WatchData | null }) {
  const primaryTask = data
    ? getPrimarySnapmoltText(data.sections.snapmoltOut, data.sections.snapmoltErr)
    : 'loading…';
  const latestError = data ? getLatestSnapmoltError(data.sections.snapmoltErr) : null;
  const activity: ActivityItem[] = data
    ? getStructuredSnapmoltActivity(data.sections.snapmoltOut, 12) : [];
  const breakdown = getActivityBreakdown(activity);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <SectionLabel>current task</SectionLabel>
        <div className="rounded border border-[var(--watch-panel-border-strong)] bg-[rgba(0,0,0,0.28)] p-4">
          <pre className="whitespace-pre-wrap text-sm leading-7 text-[var(--watch-text-bright)]">
            {primaryTask}
          </pre>
        </div>
      </div>

      {latestError && (
        <div className="flex items-start gap-2 rounded border border-[#f09070]/20 bg-[rgba(240,144,112,0.07)] px-3 py-2.5">
          <TagBadge tag="error" />
          <pre className="whitespace-pre-wrap text-xs leading-6 text-[var(--watch-danger)]">
            {latestError}
          </pre>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[1fr_200px]">
        <div className="flex flex-col gap-1.5">
          <SectionLabel>activity feed</SectionLabel>
          <div className="flex flex-col rounded border border-[var(--watch-panel-border)] overflow-hidden">
            {activity.length === 0 ? (
              <div className="px-3 py-4 text-xs text-[var(--watch-text-muted)]">
                {data ? 'No recent activity' : 'Loading…'}
              </div>
            ) : activity.map((item, i) => (
              <div key={i} className="flex items-start gap-3 border-b border-[var(--watch-panel-border)] px-3 py-2.5 last:border-b-0 hover:bg-white/[0.02] transition-colors">
                <TagBadge tag={item.tag} />
                <span className="min-w-0 flex-1 text-xs leading-6 text-[var(--watch-text-bright)] break-words">
                  {item.text}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <SectionLabel>breakdown</SectionLabel>
          <div className="flex flex-col rounded border border-[var(--watch-panel-border)] overflow-hidden">
            {breakdown.length === 0 ? (
              <div className="px-3 py-4 text-xs text-[var(--watch-text-muted)]">—</div>
            ) : breakdown.map(({ tag, count }) => {
              const meta = TAG_META[tag];
              const maxCount = breakdown[0].count;
              const barWidth = Math.max(8, Math.round((count / maxCount) * 100));
              return (
                <div key={tag} className="flex items-center gap-2.5 border-b border-[var(--watch-panel-border)] px-3 py-2 last:border-b-0">
                  <span className="w-[44px] shrink-0 text-[10px] uppercase tracking-[0.15em]" style={{ color: meta.color }}>
                    {meta.label}
                  </span>
                  <div className="flex flex-1 items-center">
                    <div className="h-1 rounded-sm" style={{ width: `${barWidth}%`, background: meta.color, opacity: 0.6 }} />
                  </div>
                  <span className="text-[10px] tabular-nums text-[var(--watch-text-muted)]">×{count}</span>
                </div>
              );
            })}
            {activity.length > 0 && (
              <div className="px-3 py-2 text-[10px] text-[var(--watch-text-muted)]">
                {activity.length} events tracked
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── TEAM TAB ─────────────────────────────────────────────────────────────────

function OfficeSection({ topology }: { topology: TeamTopology }) {
  return <TeamOfficePanel topology={topology} />;
}

function TeamSection({ topology }: { topology: TeamTopology }) {
  const topics = sortTeamTopics(topology.topics);
  const activeTasks = [...topics]
    .filter((topic) => topic.currentTask.snippet)
    .sort((a, b) => {
      const statusOrder = (a.live.status === 'running' ? -1 : 0) - (b.live.status === 'running' ? -1 : 0);
      if (statusOrder !== 0) return statusOrder;
      return (b.currentTask.updatedAt || '').localeCompare(a.currentTask.updatedAt || '');
    });

  const statusLevel = (status: TeamTopic['live']['status']): HealthLevel => {
    if (status === 'running') return 'ok';
    if (status === 'recent') return 'warn';
    if (status === 'missing') return 'error';
    return 'ok';
  };

  const sourceLabel = (topic: TeamTopic) => {
    if (topic.currentTask.source === 'none') return topic.live.freshnessLabel;
    return `${topic.currentTask.source} · ${topic.live.freshnessLabel}`;
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex gap-2 overflow-x-auto pb-1 sm:grid sm:grid-cols-2 sm:gap-3 sm:overflow-visible sm:pb-0 xl:grid-cols-5">
        {[
          { label: 'topics', value: topology.summary.totalTopics },
          { label: 'running', value: topology.summary.running },
          { label: 'recent', value: topology.summary.recent },
          { label: 'idle', value: topology.summary.idle },
          { label: 'missing', value: topology.summary.missingSession },
        ].map((item) => (
          <div
            key={item.label}
            className="min-w-[92px] rounded border border-[var(--watch-panel-border)] bg-[rgba(0,0,0,0.18)] px-3 py-2.5 sm:min-w-0 sm:px-4 sm:py-3"
          >
            <div className="text-[10px] uppercase tracking-[0.22em] text-[var(--watch-text-muted)]">{item.label}</div>
            <div className="mt-1.5 text-xl font-semibold text-[var(--watch-text-bright)] sm:mt-2 sm:text-2xl">{item.value}</div>
          </div>
        ))}
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.5fr_1fr]">
        <div className="flex flex-col gap-2">
          <SectionLabel>topic lanes</SectionLabel>
          <div className="grid gap-3 md:grid-cols-2">
            {topics.map((topic) => (
              <div key={topic.topicId} className="rounded border border-[var(--watch-panel-border)] bg-[rgba(0,0,0,0.18)] p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold text-[var(--watch-text-bright)]">{topicDisplayLabel(topic)}</div>
                    <div className="mt-1 text-[10px] uppercase tracking-[0.18em] text-[var(--watch-text-muted)]">
                      {topic.telegram.currentTopicName || `topic ${topic.topicId}`} · {topic.configured.role.replace(/_/g, ' ')}
                    </div>
                  </div>
                  <HealthBadge level={statusLevel(topic.live.status)} label={topic.live.status} />
                </div>

                <div className="mt-3 flex flex-wrap gap-1.5">
                  {topic.configured.capabilities.map((capability) => (
                    <span
                      key={capability}
                      className="rounded-sm border border-[var(--watch-panel-border)] bg-[rgba(255,255,255,0.03)] px-1.5 py-0.5 text-[10px] uppercase tracking-[0.14em] text-[var(--watch-text-muted)]"
                    >
                      {capability}
                    </span>
                  ))}
                </div>

                <div className="mt-3 rounded border border-[var(--watch-panel-border)] bg-[rgba(255,255,255,0.02)] px-3 py-2.5">
                  <div className="text-[10px] uppercase tracking-[0.16em] text-[var(--watch-text-muted)]">current task</div>
                  <div className="mt-1 text-xs leading-6 text-[var(--watch-text-bright)]">
                    {topic.currentTask.snippet || 'Idle, waiting for work.'}
                  </div>
                  <div className="mt-2 text-[10px] uppercase tracking-[0.14em] text-[var(--watch-text-muted)]">{sourceLabel(topic)}</div>
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[10px] text-[var(--watch-text-muted)]">
                  {[
                    ['agent', topic.configured.agent || 'main'],
                    ['runtime', topic.configured.runtime || 'main'],
                    ['updated', topic.live.freshnessLabel],
                    ['last tool', topic.recent.lastToolName || '—'],
                  ].map(([label, value]) => (
                    <span
                      key={label}
                      className="inline-flex max-w-full items-center gap-1 rounded-sm border border-[var(--watch-panel-border)] bg-[rgba(255,255,255,0.02)] px-2 py-1"
                    >
                      <span className="shrink-0 uppercase tracking-[0.14em]">{label}</span>
                      <span className="max-w-[34vw] truncate text-[11px] text-[var(--watch-text-bright)] sm:max-w-none">{value}</span>
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <SectionLabel>task board</SectionLabel>
          <div className="overflow-hidden rounded border border-[var(--watch-panel-border)] bg-[rgba(0,0,0,0.18)]">
            {activeTasks.length === 0 ? (
              <div className="px-4 py-6 text-xs text-[var(--watch-text-muted)]">No live task snippets yet.</div>
            ) : (
              activeTasks.map((topic) => (
                <div key={topic.topicId} className="border-b border-[var(--watch-panel-border)] px-4 py-3 last:border-b-0">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--watch-accent-strong)]">{topicDisplayLabel(topic)}</div>
                    <span className="text-[10px] uppercase tracking-[0.14em] text-[var(--watch-text-muted)]">{topic.currentTask.confidence}</span>
                  </div>
                  <div className="mt-2 text-xs leading-6 text-[var(--watch-text-bright)]">{topic.currentTask.snippet}</div>
                  <div className="mt-2 text-[10px] uppercase tracking-[0.14em] text-[var(--watch-text-muted)]">{sourceLabel(topic)}</div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── LOGS TAB ─────────────────────────────────────────────────────────────────

function LogsSection({ data }: { data: WatchData | null }) {
  const streams = [
    { key: 'snapmoltOut', label: 'snapmolt stdout', hint: 'agent output log' },
    { key: 'snapmoltErr', label: 'snapmolt stderr', hint: 'agent error log' },
    { key: 'echoesOut',   label: 'echoes stdout',   hint: 'backend output' },
    { key: 'echoesErr',   label: 'echoes stderr',   hint: 'backend errors' },
  ];
  return (
    <div className="grid gap-3 md:grid-cols-2">
      {streams.map(({ key, label, hint }) => (
        <LogPanel key={key} label={label} hint={hint} content={data?.sections[key] || ''} />
      ))}
    </div>
  );
}

// ── PROCESSES TAB ─────────────────────────────────────────────────────────────

function ProcessesSection({ data }: { data: WatchData | null }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-baseline gap-2">
        <SectionLabel>pm2 process manager</SectionLabel>
        <span className="text-[10px] text-[var(--watch-text-muted)]">
          — name · mode · status · restarts · cpu · mem · uptime
        </span>
      </div>
      <div className="overflow-hidden rounded border border-[var(--watch-panel-border)] bg-[rgba(0,0,0,0.2)]">
        <pre className="overflow-auto p-3 text-[11px] leading-[1.7] text-[var(--watch-text-code)]">
          {data?.sections.pm2 || 'Loading PM2 data…'}
        </pre>
      </div>
    </div>
  );
}

function SectionTabsBar({ activeSection, onChange }: { activeSection: SectionTab; onChange: (tab: SectionTab) => void }) {
  function renderTab(tab: { id: SectionTab; label: string; hint: string }, compact: boolean) {
    const isActive = tab.id === activeSection;

    if (compact) {
      return (
        <button
          key={tab.id}
          type="button"
          onClick={() => onChange(tab.id)}
          className={`rounded border px-2.5 py-1.5 text-left transition-colors ${
            isActive
              ? 'border-[var(--watch-accent)]/50 bg-[rgba(212,186,104,0.12)] text-[var(--watch-text)]'
              : 'border-[var(--watch-panel-border)] bg-[rgba(255,255,255,0.02)] text-[var(--watch-text-muted)] hover:text-[var(--watch-text)]'
          }`}
        >
          <div className="text-[10px] uppercase tracking-[0.16em]">{tab.label}</div>
        </button>
      );
    }

    return (
      <button
        key={tab.id}
        type="button"
        onClick={() => onChange(tab.id)}
        className={`relative flex flex-col items-start gap-0.5 px-4 py-3 text-left transition-colors whitespace-nowrap sm:flex-row sm:items-center sm:gap-2 ${
          isActive ? 'text-[var(--watch-text)]' : 'text-[var(--watch-text-muted)] hover:text-[var(--watch-text)]/70'
        }`}
      >
        <span className="text-xs tracking-[0.15em] uppercase">{tab.label}</span>
        <span className="hidden text-[10px] text-[var(--watch-text-muted)] sm:inline">{tab.hint}</span>
        {isActive && <span className="absolute bottom-0 left-0 right-0 h-px bg-[var(--watch-accent)]" />}
      </button>
    );
  }

  return (
    <div className="border-b border-[var(--watch-panel-border)]">
      <div className="flex gap-1.5 overflow-x-auto px-2 py-2 sm:hidden">
        {sectionTabs.map((tab) => renderTab(tab, true))}
      </div>
      <div className="hidden items-stretch overflow-x-auto sm:flex">
        {sectionTabs.map((tab) => renderTab(tab, false))}
      </div>
    </div>
  );
}

// ── PAGE ─────────────────────────────────────────────────────────────────────

export default function WatchPage() {
  const [data, setData]           = useState<WatchData | null>(null);
  const [error, setError]         = useState<string | null>(null);
  const [activeSection, setActiveSection] = useState<SectionTab>('office');
  const [clearingRunFaults, setClearingRunFaults] = useState(false);

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const res = await fetch('/api/watch', { cache: 'no-store', credentials: 'same-origin' });
        if (res.status === 401) { window.location.replace('/login?redirect=/watch'); return; }
        const json = (await res.json()) as WatchData;
        if (!active) return;
        setData(json);
        setError(null);
      } catch (err: any) {
        if (!active) return;
        setError(err?.message || 'failed to load watch data');
      }
    }
    load();
    const timer = window.setInterval(load, 5000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);

  const meta           = parseMeta(data?.sections.openclawMeta);
  const runs           = parseRuns(data?.sections.openclawRuns);
  const flows          = parseFlows(data?.sections.openclawFlows);
  const cron           = parseCron(data?.sections.openclawCron);
  const turns          = parseSession(data?.sections.openclawSession);
  const teamTopology   = parseTeamTopology(data?.sections.teamTopology);
  const faultState: FaultState = parseFaultState(data?.sections.watchFaultState);
  const health         = computeHealth(meta, runs, faultState);
  const sessionRunning = meta.sessions.some((s) => s.key === 'agent:main:main' && s.status === 'running');
  const canClearStaleFaults = health.issues.some((issue) => /consecutive runs failed|recent run failure|of last .* runs failed|Agent session idle for/i.test(issue.message));

  async function clearRunFaults() {
    try {
      setClearingRunFaults(true);
      const res = await fetch('/api/watch/faults/clear', {
        method: 'POST',
        credentials: 'same-origin',
      });
      if (!res.ok) throw new Error('failed to clear stale faults');
      const refresh = await fetch('/api/watch', { cache: 'no-store', credentials: 'same-origin' });
      if (!refresh.ok) throw new Error('failed to refresh watch data');
      const json = (await refresh.json()) as WatchData;
      setData(json);
      setError(null);
    } catch (err: any) {
      setError(err?.message || 'failed to clear stale faults');
    } finally {
      setClearingRunFaults(false);
    }
  }

  return (
    <main className="min-h-dvh px-3 py-3 sm:px-5 sm:py-5">
      <div className="mx-auto flex max-w-7xl flex-col gap-3">
        <WatchShellHeader activeTab="watch" />

        {error && (
          <div className="rounded border border-[var(--watch-danger)]/30 bg-[var(--watch-danger)]/10 px-3 py-2 text-xs text-[var(--watch-danger)]">
            {error}
          </div>
        )}

        {/* Mission control banner — always visible */}
        <MissionBanner
          health={health}
          meta={meta}
          now={data?.now ?? ''}
          sessionRunning={sessionRunning}
          canClearStaleFaults={canClearStaleFaults}
          clearingRunFaults={clearingRunFaults}
          onClearRunFaults={clearRunFaults}
        />

        {/* Main panel */}
        <div className="overflow-hidden rounded-lg border border-[var(--watch-panel-border-strong)] bg-[linear-gradient(135deg,rgba(24,20,14,0.97),rgba(16,13,9,0.97))] shadow-[0_8px_40px_rgba(0,0,0,0.28)]">
          <SectionTabsBar activeSection={activeSection} onChange={setActiveSection} />

          {/* Section content */}
          <div className={activeSection === 'office' ? 'p-1 sm:p-4' : 'p-4 sm:p-5'}>
            {!data ? (
              <div className="flex flex-col gap-3">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="h-16 animate-pulse rounded border border-[var(--watch-panel-border)] bg-[rgba(255,255,255,0.03)]" />
                ))}
              </div>
            ) : (
              <>
                {activeSection === 'status'    && <StatusSection    data={data} health={health} meta={meta} runs={runs} cron={cron} turns={turns} sessionRunning={sessionRunning} />}
                {activeSection === 'office'    && <OfficeSection    topology={teamTopology} />}
                {activeSection === 'team'      && <TeamSection      topology={teamTopology} />}
                {activeSection === 'runs'      && <RunsSection      runs={runs} />}
                {activeSection === 'flows'     && <FlowsSection     flows={flows} />}
                {activeSection === 'snapmolt'  && <SnapmoltSection  data={data} />}
                {activeSection === 'logs'      && <LogsSection      data={data} />}
                {activeSection === 'processes' && <ProcessesSection data={data} />}
              </>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}
