'use client';

import dynamic from 'next/dynamic';
import { useEffect, useMemo, useState } from 'react';
import { WatchShellHeader } from '@/components/watch-shell-header';
import type { TeamTopic } from '@/lib/watch-team';

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

const TeamOfficeCanvas = dynamic(
  () => import('@/components/team-office/team-office-canvas').then((m) => m.TeamOfficeCanvas),
  { ssr: false, loading: () => <div className="flex h-full items-center justify-center text-xs uppercase tracking-[0.2em] text-[var(--watch-text-muted)]">loading axiom floor…</div> },
);

// Department names — front row (indices 0..4) and back row (indices 5..9).
// Override locally via NEXT_PUBLIC_AXIOM_DEPARTMENTS env var (comma-separated, exactly 10 names)
// to fit your own project. The 51-agent floor layout is project-agnostic.
const DEFAULT_DOMAINS = [
  'Platform',
  'Frontend',
  'Backend',
  'Data',
  'Infra',
  'Security',
  'ML',
  'Mobile',
  'Growth',
  'Research',
] as const;
const ENV_DOMAINS = process.env.NEXT_PUBLIC_AXIOM_DEPARTMENTS
  ?.split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const TEAM_DOMAINS: readonly string[] = ENV_DOMAINS && ENV_DOMAINS.length === 10
  ? ENV_DOMAINS
  : DEFAULT_DOMAINS;

const RUNNING_TASKS = [
  'wiring up a new endpoint',
  'refactoring a legacy module',
  'profiling a hot loop',
  'shipping a UI tweak',
  'investigating a flaky test',
  'tuning the cache layer',
  'drafting a migration plan',
  'reviewing a spec doc',
];

// Coder model rotation — picked per coder by hash so different agents handle
// different kinds of work (latency-sensitive vs heavy reasoning vs cheap edits).
const CODER_MODELS = [
  'sonnet-4.6',
  'haiku-4.5',
  'codex-5.5',
  'opus-4.7',
  'sonnet-4.6',
  'haiku-4.5',
] as const;

function makeTopic(
  topicId: string,
  label: string,
  role: 'ceo' | 'manager' | 'coder',
  status: 'running' | 'recent' | 'idle',
  taskSnippet: string | null,
  progress: number | null,
  model: string,
  capabilities: string[],
): TeamTopic {
  return {
    topicId,
    sessionKey: `axiom:${topicId}`,
    sessionFile: null,
    context: { usedTokens: null, maxTokens: null, percent: null },
    configured: {
      label,
      role,
      agent: role === 'ceo' ? 'claude-code' : role === 'manager' ? 'codex' : 'claude-code',
      runtime: model,
      capabilities,
    },
    telegram: {
      currentTopicName: null,
      lastSeenTopicName: null,
      groupLabel: 'AXIOM',
      threadId: null,
    },
    live: {
      status,
      sessionStatus: null,
      updatedAt: status === 'running' ? Date.now() : status === 'recent' ? Date.now() - 60_000 : null,
      idleMs: status === 'running' ? 0 : status === 'recent' ? 60_000 : null,
      freshnessLabel: status === 'running' ? 'live now' : status === 'recent' ? 'recently active' : 'standing by',
    },
    currentTask: {
      snippet: taskSnippet,
      source: status === 'running' ? 'tool' : status === 'recent' ? 'yield' : 'none',
      updatedAt: null,
      confidence: 'medium',
      progress,
      progressLabel: progress !== null ? `${Math.round(progress * 100)}%` : null,
    },
    recent: {
      lastUserText: null,
      lastAssistantText: null,
      lastToolName: null,
    },
  };
}

function buildAxiomTopics(): TeamTopic[] {
  const topics: TeamTopic[] = [];

  topics.push(
    makeTopic(
      'axiom-ceo',
      'CEO · Orchestrator',
      'ceo',
      'idle',
      null,
      null,
      'opus-4.7',
      ['delegate', 'orchestrate'],
    ),
  );

  TEAM_DOMAINS.forEach((domain, teamIdx) => {
    topics.push(
      makeTopic(
        `axiom-mgr-${teamIdx + 1}`,
        `${domain} · Manager`,
        'manager',
        'idle',
        null,
        null,
        'codex-5.5',
        ['/goal', 'subscription-login'],
      ),
    );

    for (let coderIdx = 0; coderIdx < 4; coderIdx++) {
      const globalIdx = teamIdx * 4 + coderIdx;
      const model = CODER_MODELS[globalIdx % CODER_MODELS.length];
      topics.push(
        makeTopic(
          `axiom-coder-${teamIdx + 1}-${coderIdx + 1}`,
          `${domain} · Coder ${coderIdx + 1}`,
          'coder',
          'idle',
          null,
          null,
          model,
          ['code', 'tests'],
        ),
      );
    }
  });

  return topics;
}

export default function AxiomPage() {
  const baseTopics = useMemo(() => buildAxiomTopics(), []);
  const [agentStates, setAgentStates] = useState<Record<string, AgentState>>({});

  // Poll live agent state every 1.5s so avatars react: idle → seated/working with progress bar → recent → idle.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    async function poll() {
      try {
        const r = await fetch('/api/axiom/state', { cache: 'no-store' });
        if (!r.ok) return;
        const j = await r.json();
        if (!cancelled && j?.states) setAgentStates(j.states);
      } catch {
        // ignore
      } finally {
        if (!cancelled) timer = setTimeout(poll, 1500);
      }
    }
    poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  const topics = useMemo<TeamTopic[]>(() => {
    return baseTopics.map((t) => {
      const st = agentStates[t.topicId];
      if (!st || st.status === 'idle') return t;
      const isRunning = st.status === 'running';
      const liveStatus: TeamTopic['live']['status'] = st.status === 'error' ? 'recent' : st.status === 'recent' ? 'recent' : 'running';
      const startedTs = st.startedAt ? Date.parse(st.startedAt) : null;
      const updatedAt = startedTs && Number.isFinite(startedTs) ? startedTs : Date.now();
      const idleMs = isRunning ? Math.max(0, Date.now() - updatedAt) : 0;
      const freshness = isRunning
        ? 'working now'
        : st.status === 'error'
          ? 'errored'
          : 'just delivered';
      const progressLabel = typeof st.progress === 'number' ? `${Math.round(st.progress * 100)}%` : null;
      const taskSnippet = st.errorMessage ? `error: ${st.errorMessage}` : st.task || (isRunning ? 'thinking…' : null);
      return {
        ...t,
        live: {
          ...t.live,
          status: liveStatus,
          updatedAt,
          idleMs,
          freshnessLabel: freshness,
        },
        currentTask: {
          ...t.currentTask,
          snippet: taskSnippet,
          source: 'tool',
          updatedAt: st.startedAt || null,
          confidence: 'high',
          progress: typeof st.progress === 'number' ? st.progress : null,
          progressLabel,
        },
      };
    });
  }, [baseTopics, agentStates]);

  const runningCount = topics.filter((t) => t.live.status === 'running').length;
  const recentCount = topics.filter((t) => t.live.status === 'recent').length;
  const idleCount = topics.filter((t) => t.live.status === 'idle').length;

  return (
    <main className="min-h-screen bg-[var(--watch-bg)] p-3 sm:p-5">
      <div className="mx-auto flex min-h-[calc(100vh-24px)] max-w-[1600px] flex-col gap-3">
        <WatchShellHeader activeTab="axiom" />

        <div className="rounded-xl border border-[var(--watch-panel-border)] bg-[rgba(0,0,0,0.18)] px-4 py-3">
          <div className="text-[10px] uppercase tracking-[0.24em] text-[var(--watch-text-muted)]">▌ axiom operations floor</div>
          <div className="mt-2 text-sm text-[var(--watch-text-bright)] sm:text-base">
            51 Claude Code agents · 1 CEO · 10 managers · 40 coders · 10 teams of 5
          </div>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--watch-text-muted)]">
            <span><span className="text-[var(--watch-accent-strong)]">{runningCount}</span> running</span>
            <span><span className="text-[var(--watch-text-bright)]">{recentCount}</span> recent</span>
            <span><span className="text-[var(--watch-text-muted)]">{idleCount}</span> idle</span>
          </div>
        </div>

        <div className="relative flex-1 min-h-0">
          <TeamOfficeCanvas
            topics={topics}
            groupId="axiom"
            layoutVariant="axiom"
            departmentNames={[...TEAM_DOMAINS]}
          />
        </div>
      </div>
    </main>
  );
}
