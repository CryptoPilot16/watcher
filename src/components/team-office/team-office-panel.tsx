'use client';

import { sortTeamTopics, type TeamTopology } from '@/lib/watch-team';
import { TeamOfficeCanvas } from './team-office-canvas';

export function TeamOfficePanel({ topology }: { topology: TeamTopology }) {
  const topics = sortTeamTopics(topology.topics);
  const active = topics.filter((topic) => topic.live.status === 'running' || topic.live.status === 'recent');

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-[10px] uppercase tracking-[0.28em] text-[var(--watch-text-muted)]">▌ 3d team office</div>
          <div className="mt-1 text-sm text-[var(--watch-text-bright)]">Live topic desks, command hub, and activity beacons.</div>
        </div>
        <div className="flex flex-wrap gap-2 text-[10px] uppercase tracking-[0.16em] text-[var(--watch-text-muted)]">
          <span className="rounded border border-[var(--watch-panel-border)] bg-[rgba(255,255,255,0.03)] px-2 py-1">running {topology.summary.running}</span>
          <span className="rounded border border-[var(--watch-panel-border)] bg-[rgba(255,255,255,0.03)] px-2 py-1">recent {topology.summary.recent}</span>
          <span className="rounded border border-[var(--watch-panel-border)] bg-[rgba(255,255,255,0.03)] px-2 py-1">idle {topology.summary.idle}</span>
        </div>
      </div>

      <div className="relative">
        <TeamOfficeCanvas topics={topics} />

        <div className="pointer-events-none absolute left-3 right-3 top-3 flex flex-wrap gap-2">
          {active.slice(0, 4).map((topic) => (
            <div
              key={topic.topicId}
              className="rounded-md border px-2 py-1 text-[10px] uppercase tracking-[0.14em] text-[var(--watch-text-bright)] backdrop-blur-sm"
              style={{
                borderColor: topic.live.status === 'running' ? 'rgba(103,232,249,0.45)' : 'rgba(251,191,36,0.35)',
                background: topic.live.status === 'running' ? 'rgba(103,232,249,0.12)' : 'rgba(251,191,36,0.10)',
              }}
            >
              {topic.configured.label}
            </div>
          ))}
        </div>

        <div className="absolute bottom-3 left-3 right-3 hidden gap-2 sm:grid sm:grid-cols-3 lg:grid-cols-4">
          {topics.slice(0, 4).map((topic) => (
            <div key={topic.topicId} className="rounded-lg border border-[var(--watch-panel-border)] bg-[rgba(0,0,0,0.42)] px-3 py-2 backdrop-blur-sm">
              <div className="truncate text-[10px] uppercase tracking-[0.18em] text-[var(--watch-text-muted)]">{topic.configured.label}</div>
              <div className="mt-1 truncate text-[11px] text-[var(--watch-text-bright)]">{topic.currentTask.snippet || topic.live.freshnessLabel}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
