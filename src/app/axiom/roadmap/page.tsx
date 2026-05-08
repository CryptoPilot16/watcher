'use client';

import { useEffect, useMemo, useState } from 'react';
import { AdminShellHeader } from '@/components/admin-shell-header';

type Item = {
  id: string;
  label: string;
  team: number;
  evidence: string[];
  built: boolean;
  matchedPath: string | null;
  size: number;
};

type ByTeam = { team: number; dept: string; built: number; total: number };

type Phase = {
  num: number;
  name: string;
  months: string;
  deliverable: string;
  cost: string;
  rationale: string;
};

type Resp = {
  ok: true;
  generatedAt: string;
  overall: { built: number; total: number; percent: number };
  byTeam: ByTeam[];
  items: Item[];
  phases?: Phase[];
  currentPhase?: number;
};

const DEPT_COLOR: Record<number, string> = {
  0: '#a78bfa', 1: '#7ee787', 2: '#f7c763', 3: '#58d9ff', 4: '#ff9d6a',
  5: '#ffd166', 6: '#f08585', 7: '#9ddafb', 8: '#f97676', 9: '#c084fc', 10: '#34d399',
};

const POLL_MS = 10_000;

export default function RoadmapPage() {
  const [data, setData] = useState<Resp | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const r = await fetch('/api/axiom/roadmap', { cache: 'no-store' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json();
        if (!cancelled) { setData(j); setError(null); }
      } catch (err: any) {
        if (!cancelled) setError(err?.message || String(err));
      }
    };
    poll();
    const id = setInterval(poll, POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  const itemsByTeam = useMemo(() => {
    const out = new Map<number, Item[]>();
    if (!data) return out;
    for (const it of data.items) {
      if (!out.has(it.team)) out.set(it.team, []);
      out.get(it.team)!.push(it);
    }
    return out;
  }, [data]);

  return (
    <main className="min-h-screen bg-[var(--watch-bg)] p-3 sm:p-5">
      <div className="mx-auto flex max-w-[1400px] flex-col gap-3">
        <AdminShellHeader activeTab="roadmap" />

        <div className="rounded-xl border border-[var(--watch-panel-border)] bg-[rgba(0,0,0,0.18)] px-4 py-3">
          <div className="flex items-center justify-between gap-2 text-[10px] uppercase tracking-[0.24em] text-[var(--watch-text-muted)]">
            <span>▌ AXIOM Phase 0 — roadmap</span>
            <span>{data?.generatedAt ? new Date(data.generatedAt).toLocaleTimeString() : ''}</span>
          </div>
          {data ? (
            <div className="mt-2">
              <div className="flex items-baseline gap-3">
                <span className="text-2xl font-semibold text-[var(--watch-text-bright)]">{data.overall.percent}%</span>
                <span className="text-sm text-[var(--watch-text-muted)]">{data.overall.built} of {data.overall.total} Phase-0 deliverables on disk</span>
              </div>
              <div className="mt-2 h-2 w-full overflow-hidden rounded bg-black/40">
                <div
                  className="h-full bg-emerald-400 transition-all"
                  style={{ width: `${data.overall.percent}%` }}
                />
              </div>
            </div>
          ) : error ? (
            <div className="mt-2 text-xs text-red-300">roadmap error: {error}</div>
          ) : (
            <div className="mt-2 text-xs text-[var(--watch-text-muted)]">loading…</div>
          )}
        </div>

        {/* Multi-phase platform timeline — Phase 0 in detail below; future
            phases show high-level scope from AXIOM_MASTERPLAN.md §15.1 so the
            operator sees the trajectory until full platform. */}
        {data?.phases ? (
          <div className="rounded-xl border border-[var(--watch-panel-border)] bg-[rgba(0,0,0,0.18)] px-4 py-3">
            <div className="text-[10px] uppercase tracking-[0.24em] text-[var(--watch-text-muted)]">▌ 6-phase platform plan (Phase 0 → 5)</div>
            <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {data.phases.map((p) => {
                const isCurrent = p.num === (data.currentPhase ?? 0);
                const isFuture = p.num > (data.currentPhase ?? 0);
                const isDone = p.num < (data.currentPhase ?? 0);
                const accent = isCurrent ? '#7ee787' : isDone ? '#94a3b8' : '#5b6478';
                return (
                  <div
                    key={p.num}
                    className="rounded-lg border p-2 transition-all"
                    style={{
                      borderColor: isCurrent ? accent : `${accent}55`,
                      borderWidth: isCurrent ? 2 : 1,
                      background: isCurrent ? `${accent}14` : 'transparent',
                      opacity: isFuture ? 0.7 : 1,
                    }}
                  >
                    <div className="flex items-baseline gap-2">
                      <span
                        className="rounded px-1.5 py-px text-[10px] font-mono uppercase tracking-wide"
                        style={{ color: accent, border: `1px solid ${accent}88`, background: `${accent}1a` }}
                      >
                        Phase {p.num} · {p.name}
                      </span>
                      <span className="text-[10px] text-[var(--watch-text-muted)]">{p.months} mo</span>
                      <span className="ml-auto text-[10px] text-[var(--watch-text-muted)]">{p.cost}</span>
                    </div>
                    {isCurrent ? (
                      <div className="mt-1 flex items-center gap-2 text-[10px]">
                        <span className="text-emerald-400">▲ in progress · {data.overall.percent}%</span>
                      </div>
                    ) : isDone ? (
                      <div className="mt-1 text-[10px] text-emerald-400">✓ complete</div>
                    ) : (
                      <div className="mt-1 text-[10px] text-[var(--watch-text-muted)]">— upcoming</div>
                    )}
                    <div className="mt-1 text-[11px] leading-snug text-[var(--watch-text)]">{p.deliverable}</div>
                    <div className="mt-1 text-[10px] italic text-[var(--watch-text-muted)]">{p.rationale}</div>
                  </div>
                );
              })}
            </div>
            <div className="mt-2 text-[10px] text-[var(--watch-text-muted)]">
              Total platform: $20–36M over 4 years (planning ±35%). Per AXIOM_MASTERPLAN.md §15.1.
            </div>
          </div>
        ) : null}

        {data ? (
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {data.byTeam.map((t) => {
              const color = DEPT_COLOR[t.team] || '#cbd5e1';
              const pct = t.total ? Math.round((t.built / t.total) * 100) : 0;
              const items = itemsByTeam.get(t.team) || [];
              return (
                <div
                  key={t.team}
                  className="rounded-lg border bg-[var(--watch-card)] p-3"
                  style={{ borderColor: `${color}55`, boxShadow: `0 0 0 1px ${color}15 inset` }}
                >
                  <div className="flex items-baseline justify-between gap-2 border-b pb-2" style={{ borderColor: `${color}33` }}>
                    <div className="flex items-center gap-2">
                      <span
                        className="rounded px-1.5 py-px text-[10px] font-mono uppercase tracking-wide"
                        style={{ color, border: `1px solid ${color}66`, background: `${color}14` }}
                      >
                        {t.team === 0 ? 'CEO' : `m${t.team}`} {t.dept}
                      </span>
                      <span className="text-xs text-[var(--watch-text-muted)]">{t.built}/{t.total}</span>
                    </div>
                    <span className="text-sm font-semibold" style={{ color }}>{pct}%</span>
                  </div>

                  <div className="mt-1 h-1.5 w-full overflow-hidden rounded bg-black/40">
                    <div className="h-full transition-all" style={{ width: `${pct}%`, background: color }} />
                  </div>

                  <ul className="mt-2 space-y-1 text-[11px]">
                    {items.map((it) => (
                      <li key={it.id} className="flex items-baseline gap-2">
                        <span className={`shrink-0 font-mono ${it.built ? 'text-emerald-400' : 'text-zinc-500'}`}>
                          {it.built ? '✓' : '○'}
                        </span>
                        <span className={it.built ? 'text-[var(--watch-text-bright)]' : 'text-[var(--watch-text-muted)]'}>
                          {it.label}
                        </span>
                        {it.built && it.matchedPath ? (
                          <span className="ml-auto truncate font-mono text-[9px] text-[var(--watch-text-muted)]" title={it.matchedPath}>
                            {it.matchedPath}
                          </span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        ) : null}

        <div className="rounded-xl border border-[var(--watch-panel-border)] bg-[rgba(0,0,0,0.12)] px-4 py-3 text-[10px] text-[var(--watch-text-muted)]">
          ⓘ Each item ✓ when an evidence path is on disk in <code>/opt/axiom</code>. Refreshes every 10s. Edit the manifest in <code>src/app/api/axiom/roadmap/route.ts</code> to add/remove deliverables.
        </div>
      </div>
    </main>
  );
}
