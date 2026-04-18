'use client';

import { useEffect, useMemo, useState } from 'react';
import { topicDisplayLabel, type TeamTopic } from '@/lib/watch-team';

function expectedMode(topic: TeamTopic) {
  if (topic.live.status === 'running' || topic.live.status === 'recent') return 'desk-watch';
  if (topic.live.status === 'missing') return 'offline';
  return 'standby';
}

function expectedTarget(topic: TeamTopic) {
  if (topic.live.status === 'running' || topic.live.status === 'recent') return 'own desk seat';
  if (topic.live.status === 'missing') return 'offline';
  return 'standby zone';
}

export function OfficePreviewDebug({ topics }: { topics: TeamTopic[] }) {
  const runningIds = useMemo(() => topics.filter((topic) => topic.live.status === 'running').map((topic) => topic.topicId), [topics]);
  const [startedAt, setStartedAt] = useState<Record<string, number>>({});
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const base = Date.now();
    setStartedAt((current) => {
      const next = { ...current };
      for (const topicId of runningIds) {
        if (!next[topicId]) next[topicId] = base;
      }
      return next;
    });
  }, [runningIds]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 200);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <div className="rounded-xl border border-[rgba(236,213,141,0.18)] bg-[rgba(12,10,7,0.78)] p-4 text-[var(--watch-text-bright)] backdrop-blur-sm">
      <div className="text-[10px] uppercase tracking-[0.2em] text-[var(--watch-text-muted)]">debug motion panel</div>
      <div className="mt-2 text-xs text-[var(--watch-text-muted)]">DOM-side check for expected avatar mode and progress movement.</div>
      <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
        {topics.map((topic) => {
          const elapsedMs = startedAt[topic.topicId] ? Math.max(0, now - startedAt[topic.topicId]) : 0;
          const progress = topic.live.status === 'running'
            ? 1 - Math.exp(-(elapsedMs / 1000) / 10)
            : topic.live.status === 'recent'
              ? 1
              : 0;
          const progressPct = Math.max(0, Math.min(100, Math.round(progress * 100)));
          const showBar = topic.live.status === 'running' || topic.live.status === 'recent';
          return (
            <div key={topic.topicId} className="rounded-lg border border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.03)] p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="truncate text-sm">{topicDisplayLabel(topic)}</div>
                <div className="text-[10px] uppercase tracking-[0.16em] text-[var(--watch-text-muted)]">{topic.live.status}</div>
              </div>
              <div className="mt-2 text-[11px] text-[var(--watch-text-muted)]">mode {expectedMode(topic)}</div>
              <div className="text-[11px] text-[var(--watch-text-muted)]">target {expectedTarget(topic)}</div>
              <div className="mt-2 text-[11px] text-[var(--watch-text-muted)]">bar {showBar ? 'visible' : 'hidden'} · {progressPct}%</div>
              <div className="mt-2 h-2 overflow-hidden rounded bg-[rgba(255,255,255,0.08)]">
                <div
                  className={`h-full rounded ${topic.live.status === 'running' ? 'animate-pulse bg-emerald-400' : topic.live.status === 'recent' ? 'bg-amber-300' : 'bg-transparent'}`}
                  style={{ width: `${progressPct}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
