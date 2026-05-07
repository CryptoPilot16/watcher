'use client';

import { useEffect, useState } from 'react';
import { AdminShellHeader } from '@/components/admin-shell-header';

type TaskEntry = {
  ts: string;
  sessionKey: string;
  agentId?: string;
  groupId?: string;
  message: string;
  reply?: string;
  role: 'ceo' | 'manager' | 'coder' | 'unknown';
  team: number | null;
  coderIndex: number | null;
  label: string;
};

type TasksResponse = {
  ok: boolean;
  generatedAt: string;
  total: number;
  entries: TaskEntry[];
  mailboxDir?: string;
};

function fmtTime(ts: string) {
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return ts;
  }
}

function roleColor(role: TaskEntry['role']) {
  if (role === 'ceo') return '#fbbf24';
  if (role === 'manager') return '#a78bfa';
  if (role === 'coder') return '#7dd3fc';
  return '#94a3b8';
}

export default function TasksPage() {
  const [data, setData] = useState<TasksResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | 'ceo' | 'manager' | 'coder'>('all');

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch('/api/axiom/tasks', { cache: 'no-store' });
        const json = (await res.json()) as TasksResponse;
        if (!cancelled) {
          setData(json);
          setError(null);
        }
      } catch (e: any) {
        if (!cancelled) setError(String(e?.message || e || 'failed to load'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    const id = setInterval(load, 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const entries = (data?.entries || []).filter((e) => (filter === 'all' ? true : e.role === filter));
  const ceoCount = (data?.entries || []).filter((e) => e.role === 'ceo').length;
  const managerCount = (data?.entries || []).filter((e) => e.role === 'manager').length;
  const coderCount = (data?.entries || []).filter((e) => e.role === 'coder').length;

  return (
    <main className="min-h-screen bg-[var(--watch-bg)] p-3 sm:p-5">
      <div className="mx-auto flex min-h-[calc(100vh-24px)] max-w-[1400px] flex-col gap-3">
        <AdminShellHeader activeTab="tasks" />

        <div className="rounded-xl border border-[var(--watch-panel-border)] bg-[rgba(0,0,0,0.18)] px-4 py-3">
          <div className="text-[10px] uppercase tracking-[0.24em] text-[var(--watch-text-muted)]">▌ tasks at hand</div>
          <div className="mt-2 text-sm text-[var(--watch-text-bright)] sm:text-base">
            Live feed of every directive sent to the AXIOM floor. Auto-refreshes every 5s.
          </div>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--watch-text-muted)]">
            <span><span className="text-[var(--watch-text-bright)]">{data?.total ?? 0}</span> total</span>
            <span><span style={{ color: roleColor('ceo') }}>{ceoCount}</span> CEO</span>
            <span><span style={{ color: roleColor('manager') }}>{managerCount}</span> manager</span>
            <span><span style={{ color: roleColor('coder') }}>{coderCount}</span> coder</span>
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {(['all', 'ceo', 'manager', 'coder'] as const).map((id) => (
              <button
                key={id}
                type="button"
                onClick={() => setFilter(id)}
                className={`rounded border px-2.5 py-1 text-[10px] uppercase tracking-[0.16em] transition-colors ${
                  filter === id
                    ? 'border-[var(--watch-panel-border-strong)] bg-[var(--watch-accent-soft)] text-[var(--watch-text)]'
                    : 'border-[var(--watch-panel-border)] text-[var(--watch-text-muted)] hover:border-[var(--watch-panel-border-strong)] hover:text-[var(--watch-text)]'
                }`}
              >
                {id}
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1 rounded-xl border border-[var(--watch-panel-border)] bg-[rgba(0,0,0,0.18)] p-3 sm:p-4">
          {loading && !data && (
            <div className="text-xs uppercase tracking-[0.18em] text-[var(--watch-text-muted)]">loading…</div>
          )}
          {error && (
            <div className="text-xs text-[#f87171]">error: {error}</div>
          )}
          {!loading && !error && entries.length === 0 && (
            <div className="text-xs uppercase tracking-[0.18em] text-[var(--watch-text-muted)]">
              no tasks yet — open the AXIOM tab, click an agent, and send a directive to start
            </div>
          )}
          {entries.length > 0 && (
            <div className="space-y-2">
              {entries.map((entry, i) => {
                const color = roleColor(entry.role);
                return (
                  <div
                    key={`${entry.sessionKey}-${entry.ts}-${i}`}
                    className="rounded-lg border border-white/5 bg-[rgba(255,255,255,0.02)] p-3"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2 text-[10px] uppercase tracking-[0.16em] text-white/55">
                      <div className="flex flex-wrap items-center gap-2">
                        <span
                          className="rounded px-1.5 py-0.5 font-semibold"
                          style={{ background: `${color}22`, color }}
                        >
                          {entry.role}
                        </span>
                        <span className="text-white/85">{entry.label}</span>
                        {entry.agentId && <span>· {entry.agentId}</span>}
                      </div>
                      <span>{fmtTime(entry.ts)}</span>
                    </div>
                    <div className="mt-2 grid gap-2 sm:grid-cols-2">
                      <div>
                        <div className="text-[9px] uppercase tracking-[0.18em] text-white/45">directive</div>
                        <div className="mt-1 whitespace-pre-wrap text-[12px] leading-5 text-white/90">{entry.message}</div>
                      </div>
                      {entry.reply && (
                        <div>
                          <div className="text-[9px] uppercase tracking-[0.18em] text-[rgb(125,211,252)]">reply</div>
                          <div className="mt-1 whitespace-pre-wrap text-[12px] leading-5 text-white/85">{entry.reply}</div>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
