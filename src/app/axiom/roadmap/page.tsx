'use client';

import { useEffect, useMemo, useState } from 'react';
import { AdminShellHeader } from '@/components/admin-shell-header';

type Deliverable = {
  id: string;
  label: string;
  team: number;
  evidence: string[];
  phase: number;
  milestoneId: string;
  built: boolean;
  matchedPath: string | null;
  size: number;
  qualityFailed: boolean | null;
  failedValidators: string[];
};

type MilestoneStatus = 'scoping' | 'in_progress' | 'closed';

type Milestone = {
  id: string;
  num: number;
  name: string;
  scope: string;
  owners: string;
  phase: number;
  status: MilestoneStatus;
  built: number;
  total: number;
  qualityHealthy: number;
  qualityBlocked: number;
  deliverables: Deliverable[];
};

type Phase = {
  num: number;
  name: string;
  months: string;
  deliverable: string;
  cost: string;
  rationale: string;
};

type PhaseSummary = {
  phase: number;
  name: string;
  milestonesTotal: number;
  milestonesClosed: number;
  milestonesScoping: number;
  milestonesInProgress: number;
  built: number;
  total: number;
  complete: boolean;
};

type Resp = {
  ok: true;
  generatedAt: string;
  currentPhase: number;
  phases: Phase[];
  phaseSummaries: PhaseSummary[];
  milestones: Milestone[];
  allMilestones: Record<string, Milestone[]>;
  validatorMatrix: { generatedAt: string; total: number; passed: number; failed: number; passRate: number } | null;
  departments: string[];
};

const DEPT_COLOR: Record<number, string> = {
  0: '#a78bfa', 1: '#7ee787', 2: '#f7c763', 3: '#58d9ff', 4: '#ff9d6a',
  5: '#ffd166', 6: '#f08585', 7: '#9ddafb', 8: '#f97676', 9: '#c084fc', 10: '#34d399',
};

const STATUS_COLOR: Record<MilestoneStatus, string> = {
  scoping: '#94a3b8',       // grey — placeholder
  in_progress: '#f7c763',   // amber — work in flight
  closed: '#7ee787',        // green — done
};

const STATUS_LABEL: Record<MilestoneStatus, string> = {
  scoping: 'scoping',
  in_progress: 'in progress',
  closed: 'closed',
};

const POLL_MS = 10_000;

const DEPARTMENTS = ['Foundation', 'Governance', 'Reliability', 'Substrate', 'Flight Ops', 'Crew', 'Engineering', 'Safety', 'Commercial', 'ATC / IQ'];

function deptName(team: number) {
  if (team === 0) return 'CEO / shared';
  return DEPARTMENTS[team - 1] ?? `m${team}`;
}

export default function RoadmapPage() {
  const [data, setData] = useState<Resp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedPhase, setSelectedPhase] = useState<number | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

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

  const activePhase = selectedPhase ?? data?.currentPhase ?? 0;
  const activePhaseMeta = data?.phases?.find((p) => p.num === activePhase) ?? null;
  const activePhaseName = activePhaseMeta?.name ?? '';

  const phaseMilestones: Milestone[] = useMemo(() => {
    if (!data) return [];
    return data.allMilestones?.[String(activePhase)] ?? data.milestones;
  }, [data, activePhase]);

  const activeSummary = data?.phaseSummaries.find((s) => s.phase === activePhase) ?? null;

  function toggle(mid: string) {
    setExpanded((prev) => ({ ...prev, [mid]: !prev[mid] }));
  }

  return (
    <main className="min-h-screen bg-[var(--watch-bg)] p-3 sm:p-5">
      <div className="mx-auto flex max-w-[1400px] flex-col gap-3">
        <AdminShellHeader activeTab="roadmap" />

        {/* Header card: phase + milestone counters (no aggregate % — counts are honest, percents lie). */}
        <div className="rounded-xl border border-[var(--watch-panel-border)] bg-[rgba(0,0,0,0.18)] px-4 py-3">
          <div className="flex items-center justify-between gap-2 text-[10px] uppercase tracking-[0.24em] text-[var(--watch-text-muted)]">
            <span>▌ AXIOM Phase {activePhase}{activePhaseName ? ` · ${activePhaseName}` : ''} — roadmap</span>
            <span>{data?.generatedAt ? new Date(data.generatedAt).toLocaleTimeString() : ''}</span>
          </div>

          {data ? (
            <>
              {/* Phase tabs */}
              <div className="mt-2 flex flex-wrap gap-1.5">
                {data.phaseSummaries.map((t) => {
                  const isActive = t.phase === activePhase;
                  const isCurrent = t.phase === data.currentPhase;
                  const tone = t.complete ? '#7ee787' : t.milestonesTotal === 0 ? '#5b6478' : '#f7c763';
                  const label = t.milestonesTotal === 0
                    ? 'scope not started'
                    : `${t.milestonesClosed}/${t.milestonesTotal} M closed`;
                  return (
                    <button
                      key={t.phase}
                      type="button"
                      onClick={() => setSelectedPhase(t.phase)}
                      className="rounded px-2 py-0.5 text-[10px] font-mono uppercase tracking-wide transition-colors"
                      style={{
                        color: isActive ? tone : 'var(--watch-text-muted)',
                        border: `1px solid ${isActive ? `${tone}88` : 'var(--watch-panel-border)'}`,
                        background: isActive ? `${tone}14` : 'transparent',
                      }}
                      title={isCurrent ? 'current phase' : t.complete ? 'closed' : 'past/future'}
                    >
                      Phase {t.phase} · {label}{isCurrent ? ' ◀' : t.complete ? ' ✓' : ''}
                    </button>
                  );
                })}
              </div>

              {/* Honest summary for the selected phase */}
              {activeSummary ? (
                <div className="mt-3">
                  {activeSummary.milestonesTotal === 0 ? (
                    <div className="text-sm text-[var(--watch-text-muted)]">
                      <span className="font-semibold text-[var(--watch-text)]">Phase {activePhase} scope not started.</span> Milestones not yet scoped in the roadmap manifest.
                    </div>
                  ) : (
                    <div className="flex flex-wrap items-baseline gap-3">
                      <span className="text-lg font-semibold text-[var(--watch-text-bright)]">
                        {activeSummary.milestonesClosed} of {activeSummary.milestonesTotal} milestones closed
                      </span>
                      {activeSummary.milestonesInProgress > 0 ? (
                        <span className="text-[11px] uppercase tracking-[0.18em]" style={{ color: STATUS_COLOR.in_progress }}>
                          · {activeSummary.milestonesInProgress} in progress
                        </span>
                      ) : null}
                      {activeSummary.milestonesScoping > 0 ? (
                        <span className="text-[11px] uppercase tracking-[0.18em]" style={{ color: STATUS_COLOR.scoping }}>
                          · {activeSummary.milestonesScoping} scoping
                        </span>
                      ) : null}
                      <span className="text-[11px] text-[var(--watch-text-muted)]">
                        · {activeSummary.built}/{activeSummary.total} deliverables built across scoped milestones
                      </span>
                    </div>
                  )}
                  {/* Milestone strip: one pill per milestone, colour = status. */}
                  {phaseMilestones.length > 0 ? (
                    <div className="mt-2 flex flex-wrap items-center gap-1">
                      {phaseMilestones.map((m) => {
                        const c = STATUS_COLOR[m.status];
                        return (
                          <button
                            key={m.id}
                            type="button"
                            onClick={() => toggle(m.id)}
                            className="rounded px-1.5 py-0.5 text-[10px] font-mono uppercase tracking-wide transition-colors"
                            style={{ color: c, border: `1px solid ${c}66`, background: `${c}14` }}
                            title={`${m.name} — ${STATUS_LABEL[m.status]}${m.total ? ` (${m.built}/${m.total})` : ''}`}
                          >
                            M{m.num} {m.total ? `${m.built}/${m.total}` : '·'} {m.status === 'closed' ? '✓' : m.status === 'in_progress' ? '▲' : '○'}
                          </button>
                        );
                      })}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : error ? (
            <div className="mt-2 text-xs text-red-300">roadmap error: {error}</div>
          ) : (
            <div className="mt-2 text-xs text-[var(--watch-text-muted)]">loading…</div>
          )}
        </div>

        {/* 6-phase platform plan — same as before but with milestone fractions instead of %. */}
        {data?.phases ? (
          <div className="rounded-xl border border-[var(--watch-panel-border)] bg-[rgba(0,0,0,0.18)] px-4 py-3">
            <div className="text-[10px] uppercase tracking-[0.24em] text-[var(--watch-text-muted)]">▌ 6-phase platform plan (Phase 0 → 5)</div>
            <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {data.phases.map((p) => {
                const summary = data.phaseSummaries.find((s) => s.phase === p.num);
                const isCurrent = p.num === data.currentPhase;
                const isDone = summary?.complete ?? false;
                const isFuture = !isCurrent && !isDone;
                const accent = isCurrent ? '#7ee787' : isDone ? '#94a3b8' : '#5b6478';
                return (
                  <button
                    key={p.num}
                    type="button"
                    onClick={() => setSelectedPhase(p.num)}
                    className="rounded-lg border p-2 text-left transition-all"
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
                    {summary ? (
                      summary.milestonesTotal === 0 ? (
                        <div className="mt-1 text-[10px] text-[var(--watch-text-muted)]">— scope not started</div>
                      ) : isDone ? (
                        <div className="mt-1 text-[10px] text-emerald-400">✓ closed · {summary.milestonesClosed}/{summary.milestonesTotal} M</div>
                      ) : isCurrent ? (
                        <div className="mt-1 text-[10px] text-emerald-400">▲ in progress · {summary.milestonesClosed}/{summary.milestonesTotal} M closed</div>
                      ) : (
                        <div className="mt-1 text-[10px] text-[var(--watch-text-muted)]">— upcoming</div>
                      )
                    ) : null}
                    <div className="mt-1 text-[11px] leading-snug text-[var(--watch-text)]">{p.deliverable}</div>
                    <div className="mt-1 text-[10px] italic text-[var(--watch-text-muted)]">{p.rationale}</div>
                  </button>
                );
              })}
            </div>
            <div className="mt-2 text-[10px] text-[var(--watch-text-muted)]">
              Total platform: $7–10M / €6.5–9.2M gross over ~36 months (planning ±35%, AI-floor delivery; ~€4.5–6.5M net of SIFIDE II credit). Per AXIOM_MASTERPLAN.md §15.1.
            </div>
          </div>
        ) : null}

        {/* Milestone cards for the active phase */}
        {data && phaseMilestones.length === 0 ? (
          <div className="rounded-xl border border-dashed border-[var(--watch-panel-border)] bg-[rgba(0,0,0,0.12)] px-4 py-6 text-center text-[12px] text-[var(--watch-text-muted)]">
            No milestones scoped for Phase {activePhase} yet. Add them in <code className="font-mono">src/app/api/axiom/roadmap/route.ts</code> as <code className="font-mono">PHASE{activePhase}_MILESTONES</code> entries.
          </div>
        ) : null}

        {phaseMilestones.map((m) => {
          const c = STATUS_COLOR[m.status];
          const isOpen = expanded[m.id] ?? (m.status === 'in_progress');
          // Group deliverables by team for the inner list
          const byTeam = new Map<number, Deliverable[]>();
          for (const d of m.deliverables) {
            if (!byTeam.has(d.team)) byTeam.set(d.team, []);
            byTeam.get(d.team)!.push(d);
          }
          const teams = Array.from(byTeam.entries()).sort((a, b) => a[0] - b[0]);
          return (
            <div
              key={m.id}
              className="rounded-xl border bg-[var(--watch-card)]"
              style={{ borderColor: `${c}55`, boxShadow: `0 0 0 1px ${c}15 inset` }}
            >
              <button
                type="button"
                onClick={() => toggle(m.id)}
                className="flex w-full items-center justify-between gap-3 border-b px-4 py-2 text-left"
                style={{ borderColor: `${c}33` }}
              >
                <div className="flex flex-wrap items-baseline gap-2">
                  <span
                    className="rounded px-1.5 py-px text-[10px] font-mono uppercase tracking-wide"
                    style={{ color: c, border: `1px solid ${c}66`, background: `${c}14` }}
                  >
                    M{m.num} · {STATUS_LABEL[m.status]}
                  </span>
                  <span className="text-sm font-semibold text-[var(--watch-text-bright)]">{m.name}</span>
                  {m.total > 0 ? (
                    <span className="text-[11px] text-[var(--watch-text-muted)]">{m.built}/{m.total} built</span>
                  ) : (
                    <span className="text-[11px] text-[var(--watch-text-muted)]">no deliverables scoped yet</span>
                  )}
                  {m.qualityBlocked > 0 ? (
                    <span className="text-[11px] text-red-400">{m.qualityBlocked} validator-blocked</span>
                  ) : null}
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-[11px] text-[var(--watch-text-muted)]">owners: {m.owners}</span>
                  <span className="text-[10px] text-[var(--watch-text-muted)]">{isOpen ? '▼' : '▶'}</span>
                </div>
              </button>

              <div className="px-4 py-2 text-[11px] text-[var(--watch-text-muted)]">
                <span className="font-semibold text-[var(--watch-text)]">scope:</span> {m.scope}
              </div>

              {isOpen ? (
                m.deliverables.length === 0 ? (
                  <div className="px-4 pb-3 text-[11px] italic text-[var(--watch-text-muted)]">
                    This milestone is a scoping placeholder — no deliverables enumerated yet. The phase cannot be marked complete while any milestone is still in scoping.
                  </div>
                ) : (
                  <div className="grid grid-cols-1 gap-3 px-3 pb-3 lg:grid-cols-2">
                    {teams.map(([team, items]) => {
                      const dc = DEPT_COLOR[team] || '#cbd5e1';
                      const built = items.filter((i) => i.built).length;
                      return (
                        <div key={team} className="rounded-lg border bg-[rgba(0,0,0,0.18)] p-2" style={{ borderColor: `${dc}33` }}>
                          <div className="flex items-baseline justify-between gap-2 pb-1.5">
                            <span
                              className="rounded px-1.5 py-px text-[10px] font-mono uppercase tracking-wide"
                              style={{ color: dc, border: `1px solid ${dc}66`, background: `${dc}14` }}
                            >
                              {team === 0 ? 'CEO' : `m${team}`} {deptName(team)}
                            </span>
                            <span className="text-xs text-[var(--watch-text-muted)]">{built}/{items.length}</span>
                          </div>
                          <ul className="space-y-1 text-[11px]">
                            {items.map((it) => (
                              <li key={it.id} className="flex items-baseline gap-2">
                                <span
                                  className={`shrink-0 font-mono ${it.built ? (it.qualityFailed ? 'text-red-400' : 'text-emerald-400') : 'text-zinc-500'}`}
                                  title={it.qualityFailed ? `validator failed: ${it.failedValidators.join(', ')}` : it.built ? 'on disk' : 'missing'}
                                >
                                  {it.built ? (it.qualityFailed ? '!' : '✓') : '○'}
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
                )
              ) : null}
            </div>
          );
        })}

        <div className="rounded-xl border border-[var(--watch-panel-border)] bg-[rgba(0,0,0,0.12)] px-4 py-3 text-[10px] text-[var(--watch-text-muted)]">
          ⓘ Items show ✓ when an evidence path is on disk in <code>/opt/axiom</code>, <span className="text-red-400">!</span> when a tagged validator fails, ○ when missing. A milestone is <span style={{ color: STATUS_COLOR.closed }}>closed</span> only when every deliverable is ✓; a phase is closed only when every milestone is closed and no milestone is in <span style={{ color: STATUS_COLOR.scoping }}>scoping</span>. Edit milestones in <code>src/app/api/axiom/roadmap/route.ts</code>. Polls every 10s.
          {data?.validatorMatrix ? (
            <span className="ml-2">· validator matrix: {data.validatorMatrix.passed}/{data.validatorMatrix.total} pass ({data.validatorMatrix.passRate}%)</span>
          ) : null}
        </div>
      </div>
    </main>
  );
}
