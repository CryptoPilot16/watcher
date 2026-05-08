'use client';

import { useEffect, useMemo, useState } from 'react';
import { AdminShellHeader } from '@/components/admin-shell-header';

type AgentState = {
  sessionKey: string;
  topicId: string;
  status: 'running' | 'recent' | 'idle' | 'error';
  startedAt?: string;
  completedAt?: string;
  task?: string | null;
  progress?: number | null;
  engine?: 'claude' | 'codex';
  durationMs?: number;
  errorMessage?: string;
};

type StateResponse = {
  ok: boolean;
  generatedAt: string;
  states: Record<string, AgentState>;
  summary: { running: number; recent: number; error: number };
};

type ProjectEvent = {
  ts: string;
  kind: string;
  path: string;
  size: number | null;
  attributedTo?: { team: number; dept: string } | null;
};

const DEPARTMENTS = ['Foundation', 'Governance', 'Reliability', 'Substrate', 'Flight Ops', 'Crew', 'Engineering', 'Safety', 'Commercial', 'ATC / IQ'];

const DEPT_COLOR: Record<number, string> = {
  0: '#a78bfa', 1: '#7ee787', 2: '#f7c763', 3: '#58d9ff', 4: '#ff9d6a',
  5: '#ffd166', 6: '#f08585', 7: '#9ddafb', 8: '#f97676', 9: '#c084fc', 10: '#34d399',
};

const POLL_MS = 2000;

function statusIcon(s?: string) {
  if (s === 'running') return '🟢';
  if (s === 'recent') return '🟡';
  if (s === 'error') return '🔴';
  return '⚪';
}

function fmtAgo(iso?: string) {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 1000) return 'just now';
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  return `${Math.round(ms / 3_600_000)}h ago`;
}

// Strip the autopilot's `[AXIOM AUTOPILOT — ...]` and `[CEO DELEGATION — ...]`
// scaffolding so the operator sees the actual brief content, not the wrapper.
function cleanTask(task?: string | null) {
  if (!task) return '';
  let t = String(task).replace(/\[(AXIOM AUTOPILOT|CEO DELEGATION)[^\]]*\]\s*/g, '');
  t = t.replace(/^You are[^.]*\.\s*/, '');
  t = t.replace(/Read these in this order:[\s\S]*?(?=\n\n|$)/, '');
  return t.replace(/\s+/g, ' ').trim();
}

export default function AxiomWorkPage() {
  const [data, setData] = useState<StateResponse | null>(null);
  const [events, setEvents] = useState<ProjectEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const [stateR, eventsR] = await Promise.all([
          fetch('/api/axiom/state', { cache: 'no-store' }),
          fetch('/api/axiom/project/events?limit=120', { cache: 'no-store' }),
        ]);
        if (cancelled) return;
        if (stateR.ok) setData(await stateR.json());
        if (eventsR.ok) {
          const j = await eventsR.json();
          setEvents(Array.isArray(j?.events) ? j.events : []);
        }
        setError(null);
      } catch (err: any) {
        if (!cancelled) setError(err?.message || String(err));
      }
    };
    poll();
    const id = setInterval(poll, POLL_MS);
    const tickId = setInterval(() => setTick((n) => n + 1), 1000);
    return () => { cancelled = true; clearInterval(id); clearInterval(tickId); };
  }, []);

  const teams = useMemo(() => {
    const states = data?.states || {};
    const out: Array<{
      team: number;
      dept: string;
      color: string;
      manager: AgentState | null;
      coders: Array<{ idx: number; state: AgentState | null }>;
      recentFiles: ProjectEvent[];
    }> = [];
    for (let n = 1; n <= 10; n++) {
      const dept = DEPARTMENTS[n - 1];
      const color = DEPT_COLOR[n] || '#cbd5e1';
      const manager = states[`axiom-mgr-${n}`] || null;
      const coders: Array<{ idx: number; state: AgentState | null }> = [];
      for (let c = 1; c <= 4; c++) coders.push({ idx: c, state: states[`axiom-coder-${n}-${c}`] || null });
      const recentFiles = events.filter((e) => e.attributedTo?.team === n).slice(0, 5);
      out.push({ team: n, dept, color, manager, coders, recentFiles });
    }
    return out;
  }, [data, events]);

  const ceo = data?.states?.['axiom-ceo'] || null;
  const summary = data?.summary || { running: 0, recent: 0, error: 0 };

  return (
    <div className="min-h-screen bg-[var(--watch-bg)] text-[var(--watch-text)]">
      <AdminShellHeader activeTab="work" />

      <div className="mx-auto max-w-[1600px] px-4 py-4">
        <div className="mb-4 flex items-baseline gap-4">
          <h1 className="text-lg font-semibold uppercase tracking-wide">Floor — live work</h1>
          <span className="text-xs text-[var(--watch-text-muted)]">
            🟢 {summary.running} running · 🟡 {summary.recent} recent · 🔴 {summary.error} error
          </span>
          {ceo ? (
            <span className="text-xs">
              CEO: {statusIcon(ceo.status)} {ceo.status}
              {ceo.task ? <span className="text-[var(--watch-text-muted)]"> — {cleanTask(ceo.task).slice(0, 80)}…</span> : null}
            </span>
          ) : null}
          {error ? <span className="text-xs text-red-400">{error}</span> : null}
        </div>

        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 xl:grid-cols-2 2xl:grid-cols-2">
          {teams.map(({ team, dept, color, manager, coders, recentFiles }) => {
            const mTask = cleanTask(manager?.task);
            const runningCount = coders.filter((c) => c.state?.status === 'running').length;
            const recentCount = coders.filter((c) => c.state?.status === 'recent').length;
            const errorCount = coders.filter((c) => c.state?.status === 'error').length;
            const idleCount = 4 - runningCount - recentCount - errorCount;
            return (
              <div
                key={team}
                className="rounded-lg border bg-[var(--watch-card)] p-3"
                style={{ borderColor: `${color}55`, boxShadow: `0 0 0 1px ${color}15 inset` }}
              >
                <div className="flex items-baseline justify-between gap-2 border-b pb-2" style={{ borderColor: `${color}33` }}>
                  <div className="flex items-center gap-2">
                    <span
                      className="rounded px-1.5 py-px text-[10px] font-mono uppercase tracking-wide"
                      style={{ color, border: `1px solid ${color}66`, background: `${color}14` }}
                    >
                      m{team} {dept}
                    </span>
                    <span className="text-xs">{statusIcon(manager?.status)} {manager?.status || 'idle'}</span>
                    {manager?.startedAt && manager?.status === 'running' ? (
                      <span className="text-[10px] text-[var(--watch-text-muted)]">{fmtAgo(manager.startedAt)}</span>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-1 text-[10px] font-mono">
                    <span className="text-emerald-400">{runningCount}🟢</span>
                    <span className="text-yellow-400">{recentCount}🟡</span>
                    <span className="text-red-400">{errorCount}🔴</span>
                    <span className="text-zinc-400">{idleCount}⚪</span>
                  </div>
                </div>

                {/* Manager current brief */}
                {mTask ? (
                  <div className="mt-2 text-[11px] leading-snug">
                    <span className="text-[var(--watch-text-muted)]">📋 mgr:</span>{' '}
                    <span>{mTask.slice(0, 220)}{mTask.length > 220 ? '…' : ''}</span>
                  </div>
                ) : (
                  <div className="mt-2 text-[10px] italic text-[var(--watch-text-muted)]">manager idle</div>
                )}

                {/* Coders */}
                <div className="mt-2 grid grid-cols-2 gap-1 text-[10px]">
                  {coders.map(({ idx, state }) => {
                    const role = idx === 4 ? 'QA' : idx === 1 ? 'tests' : idx === 2 ? 'glue' : 'fixtures';
                    const cTask = cleanTask(state?.task);
                    return (
                      <div key={idx} className="rounded bg-black/20 px-1.5 py-1" style={{ borderLeft: `2px solid ${color}55` }}>
                        <div className="flex items-baseline gap-1">
                          <span>{statusIcon(state?.status)}</span>
                          <span className="font-mono text-[10px]">c{idx}</span>
                          <span className="text-[9px] text-[var(--watch-text-muted)]">{role}</span>
                          {state?.startedAt && state?.status === 'running' ? (
                            <span className="ml-auto text-[9px] text-[var(--watch-text-muted)]">{fmtAgo(state.startedAt)}</span>
                          ) : null}
                        </div>
                        {cTask && state?.status === 'running' ? (
                          <div className="mt-0.5 truncate text-[9px] text-[var(--watch-text-muted)]">{cTask.slice(0, 80)}</div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>

                {/* Recent files attributed to this team */}
                {recentFiles.length > 0 ? (
                  <div className="mt-2 border-t pt-1 text-[10px]" style={{ borderColor: `${color}22` }}>
                    <div className="text-[9px] uppercase tracking-wide text-[var(--watch-text-muted)]">recent files</div>
                    {recentFiles.map((ev, i) => (
                      <div key={i} className="flex items-baseline gap-1.5 truncate font-mono">
                        <span className="text-[9px]" style={{ color: ev.kind === 'deleted' ? '#f08585' : ev.kind === 'modified' || ev.kind === 'change' ? '#f7c763' : '#7ee787' }}>
                          {ev.kind === 'deleted' ? '✕' : ev.kind === 'modified' || ev.kind === 'change' ? '✎' : '＋'}
                        </span>
                        <span className="truncate text-[10px]">{ev.path}</span>
                        <span className="ml-auto shrink-0 text-[9px] text-[var(--watch-text-muted)]">{fmtAgo(ev.ts)}</span>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
