'use client';

import { sortTeamTopics, topicDisplayLabel, type TeamTopology } from '@/lib/watch-team';
import { TeamOfficeCanvas } from './team-office-canvas';

function statusTone(status: 'running' | 'recent' | 'idle' | 'missing') {
  switch (status) {
    case 'running':
      return {
        border: 'rgba(103,232,249,0.4)',
        background: 'rgba(103,232,249,0.12)',
        color: '#67e8f9',
      };
    case 'recent':
      return {
        border: 'rgba(251,191,36,0.36)',
        background: 'rgba(251,191,36,0.1)',
        color: '#fbbf24',
      };
    case 'idle':
      return {
        border: 'rgba(143,122,83,0.34)',
        background: 'rgba(143,122,83,0.1)',
        color: '#b69d6d',
      };
    case 'missing':
      return {
        border: 'rgba(248,113,113,0.34)',
        background: 'rgba(248,113,113,0.1)',
        color: '#f87171',
      };
  }
}

export function TeamOfficePanel({ topology }: { topology: TeamTopology }) {
  const topics = sortTeamTopics(topology.topics);
  const active = topics.filter((topic) => topic.live.status === 'running' || topic.live.status === 'recent');
  const featured = topics.slice(0, 6);

  return (
    <div className="flex flex-col gap-3 sm:gap-4">
      <div className="hidden flex-wrap items-start justify-between gap-3 px-1 sm:flex sm:px-0">
        <div>
          <div className="text-[10px] uppercase tracking-[0.28em] text-[var(--watch-text-muted)]">▌ office view</div>
          <div className="mt-1 text-base text-[var(--watch-text-bright)] sm:text-lg">Open office floor with one forward PILOT desk, a front job row, and a back standby row.</div>
          <div className="mt-2 hidden max-w-3xl text-xs leading-6 text-[var(--watch-text-muted)] sm:block sm:text-[13px]">
            Anyone attached to a job stays in front of PILOT, active lanes glow there, unassigned lanes wait in the back row, and recent deliveries queue nearest the desk.
          </div>
        </div>
        <div className="flex flex-wrap gap-2 text-[10px] uppercase tracking-[0.16em] text-[var(--watch-text-muted)]">
          <span className="rounded border border-[var(--watch-panel-border)] bg-[rgba(255,255,255,0.03)] px-2 py-1">running {topology.summary.running}</span>
          <span className="rounded border border-[var(--watch-panel-border)] bg-[rgba(255,255,255,0.03)] px-2 py-1">recent {topology.summary.recent}</span>
          <span className="rounded border border-[var(--watch-panel-border)] bg-[rgba(255,255,255,0.03)] px-2 py-1">idle {topology.summary.idle}</span>
          <span className="rounded border border-[var(--watch-panel-border)] bg-[rgba(255,255,255,0.03)] px-2 py-1">topics {topology.summary.totalTopics}</span>
        </div>
      </div>

      <div className="relative">
        <TeamOfficeCanvas topics={topics} />

        <div className="pointer-events-none absolute left-3 right-3 top-3 hidden flex-wrap gap-2 sm:flex">
          {active.slice(0, 5).map((topic) => (
            <div
              key={topic.topicId}
              className="rounded-md border px-2.5 py-1 text-[10px] uppercase tracking-[0.14em] text-[var(--watch-text-bright)] backdrop-blur-sm"
              style={{
                borderColor: topic.live.status === 'running' ? 'rgba(103,232,249,0.45)' : 'rgba(251,191,36,0.35)',
                background: topic.live.status === 'running' ? 'rgba(103,232,249,0.12)' : 'rgba(251,191,36,0.10)',
              }}
            >
              {topicDisplayLabel(topic)}
            </div>
          ))}
        </div>
      </div>

      <div className="flex items-center justify-between gap-2 rounded-lg border border-[var(--watch-panel-border)] bg-[rgba(0,0,0,0.2)] px-3 py-2 text-[10px] uppercase tracking-[0.16em] text-[var(--watch-text-muted)] sm:hidden">
        <span>running {topology.summary.running}</span>
        <span>recent {topology.summary.recent}</span>
        <span>tap workers or desks</span>
      </div>

      <div className="hidden gap-3 xl:grid xl:grid-cols-[1.1fr_1.4fr]">
        <div className="rounded-xl border border-[var(--watch-panel-border)] bg-[rgba(0,0,0,0.22)] p-4">
          <div className="text-[10px] uppercase tracking-[0.24em] text-[var(--watch-text-muted)]">scene legend</div>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {([
              { status: 'running', title: 'running', desc: 'worker actively executing in front of the PILOT desk with green diamond' },
              { status: 'recent', title: 'handoff', desc: 'worker presenting output nearest the PILOT desk' },
              { status: 'idle', title: 'idle', desc: 'job-linked workers wait in front of PILOT, unassigned lanes wait in the back row' },
              { status: 'missing', title: 'offline', desc: 'red marker, no active worker body' },
            ] as const).map((item) => {
              const tone = statusTone(item.status);
              return (
                <div
                  key={item.status}
                  className="rounded-lg border px-3 py-3"
                  style={{ borderColor: tone.border, background: tone.background }}
                >
                  <div className="text-[11px] uppercase tracking-[0.18em]" style={{ color: tone.color }}>{item.title}</div>
                  <div className="mt-1 text-xs leading-5 text-[var(--watch-text-bright)]">{item.desc}</div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="rounded-xl border border-[var(--watch-panel-border)] bg-[rgba(0,0,0,0.22)] p-4">
          <div className="text-[10px] uppercase tracking-[0.24em] text-[var(--watch-text-muted)]">live floor</div>
          <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {featured.map((topic) => {
              const tone = statusTone(topic.live.status);
              return (
                <div key={topic.topicId} className="rounded-lg border px-3 py-3" style={{ borderColor: tone.border, background: 'rgba(255,255,255,0.02)' }}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-[11px] uppercase tracking-[0.18em] text-[var(--watch-text-bright)]">{topicDisplayLabel(topic)}</div>
                      <div className="mt-1 text-[10px] uppercase tracking-[0.14em] text-[var(--watch-text-muted)]">{topic.currentTask.source === 'none' ? 'waiting' : topic.currentTask.source}</div>
                    </div>
                    <span className="rounded-sm px-1.5 py-0.5 text-[10px] uppercase tracking-[0.14em]" style={{ color: tone.color, background: tone.background }}>
                      {topic.live.status}
                    </span>
                  </div>
                  <div className="mt-2 text-xs leading-5 text-[var(--watch-text-bright)]">
                    {topic.currentTask.snippet || topic.recent.lastAssistantText || topic.live.freshnessLabel}
                  </div>
                  <div className="mt-2 flex items-center justify-between gap-2 text-[10px] uppercase tracking-[0.14em] text-[var(--watch-text-muted)]">
                    <span>{topic.live.freshnessLabel}</span>
                    <span style={{ color: confidenceColor(topic.currentTask.confidence) }}>{topic.currentTask.confidence} confidence</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

function confidenceColor(confidence: 'high' | 'medium' | 'low') {
  switch (confidence) {
    case 'high':
      return '#67e8f9';
    case 'medium':
      return '#fbbf24';
    default:
      return '#8f7a53';
  }
}
