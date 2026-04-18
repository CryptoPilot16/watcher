import type { TeamTopology } from '@/lib/watch-team';

function nowIso() {
  return new Date().toISOString();
}

export function buildDemoTeamTopology(): TeamTopology {
  const generatedAt = nowIso();
  const now = Date.now();

  return {
    generatedAt,
    groupId: 'demo-team',
    source: {
      orchestrationPath: 'demo-mode',
      sessionsIndexPath: 'demo-mode',
    },
    summary: {
      totalTopics: 5,
      running: 2,
      recent: 1,
      idle: 1,
      missingSession: 1,
    },
    topics: [
      {
        topicId: '1',
        sessionKey: 'demo:dispatcher',
        sessionFile: null,
        configured: {
          label: 'Dispatcher',
          role: 'dispatcher',
          agent: 'main',
          runtime: 'demo',
          capabilities: ['dispatch', 'triage', 'integrate'],
        },
        telegram: {
          currentTopicName: 'Dispatcher',
          lastSeenTopicName: 'Dispatcher',
          groupLabel: 'Demo Team',
          threadId: 1,
        },
        live: {
          status: 'running',
          sessionStatus: 'running',
          updatedAt: now,
          idleMs: 0,
          freshnessLabel: 'live now',
        },
        currentTask: {
          snippet: 'Triaging a new production issue and routing lane ownership.',
          source: 'plan',
          updatedAt: generatedAt,
          confidence: 'high',
          progress: 0.5,
          progressLabel: '1/2',
        },
        recent: {
          lastUserText: 'Who owns the auth hardening task?',
          lastAssistantText: 'Routing it to the coder lane now.',
          lastToolName: 'update_plan',
        },
      },
      {
        topicId: '2',
        sessionKey: 'demo:coder-1',
        sessionFile: null,
        configured: {
          label: 'Coder 1',
          role: 'generic_coder',
          agent: 'coder1',
          runtime: 'codex-demo',
          capabilities: ['code', 'fix', 'ship', 'codex'],
        },
        telegram: {
          currentTopicName: 'Coder 1',
          lastSeenTopicName: 'Coder 1',
          groupLabel: 'Demo Team',
          threadId: 2,
        },
        live: {
          status: 'running',
          sessionStatus: 'running',
          updatedAt: now - 20_000,
          idleMs: 20_000,
          freshnessLabel: '20s ago',
        },
        currentTask: {
          snippet: 'Replacing hardcoded host paths with portable env-driven config.',
          source: 'plan',
          updatedAt: generatedAt,
          confidence: 'high',
          progress: 0.75,
          progressLabel: '3/4',
        },
        recent: {
          lastUserText: 'Make the repo OSS-ready.',
          lastAssistantText: 'Adding demo mode and portable config now.',
          lastToolName: 'edit',
        },
      },
      {
        topicId: '3',
        sessionKey: 'demo:project-owner',
        sessionFile: null,
        configured: {
          label: 'Project Owner',
          role: 'project_owner_and_worker',
          agent: 'owner',
          runtime: 'demo',
          capabilities: ['own', 'build', 'review'],
        },
        telegram: {
          currentTopicName: 'Project Owner',
          lastSeenTopicName: 'Project Owner',
          groupLabel: 'Demo Team',
          threadId: 3,
        },
        live: {
          status: 'recent',
          sessionStatus: 'idle',
          updatedAt: now - 90_000,
          idleMs: 90_000,
          freshnessLabel: '2m ago',
        },
        currentTask: {
          snippet: 'Reviewed the landing-page copy refresh and approved ship.',
          source: 'yield',
          updatedAt: new Date(now - 90_000).toISOString(),
          confidence: 'medium',
          progress: 1,
          progressLabel: '100%',
        },
        recent: {
          lastUserText: 'Update the docs too.',
          lastAssistantText: 'Done, pushed with the code changes.',
          lastToolName: 'sessions_yield',
        },
      },
      {
        topicId: '4',
        sessionKey: 'demo:ops',
        sessionFile: null,
        configured: {
          label: 'Ops',
          role: 'coordination',
          agent: 'ops',
          runtime: 'demo',
          capabilities: ['coordinate', 'handoff'],
        },
        telegram: {
          currentTopicName: 'Ops',
          lastSeenTopicName: 'Ops',
          groupLabel: 'Demo Team',
          threadId: 4,
        },
        live: {
          status: 'idle',
          sessionStatus: 'waiting',
          updatedAt: now - 12 * 60_000,
          idleMs: 12 * 60_000,
          freshnessLabel: '12m ago',
        },
        currentTask: {
          snippet: 'Standing by for the next operator request.',
          source: 'none',
          updatedAt: null,
          confidence: 'low',
          progress: null,
          progressLabel: null,
        },
        recent: {
          lastUserText: null,
          lastAssistantText: null,
          lastToolName: null,
        },
      },
      {
        topicId: '5',
        sessionKey: 'demo:echoes',
        sessionFile: null,
        configured: {
          label: 'Voice',
          role: 'echoes_commands',
          agent: 'echoes',
          runtime: 'demo',
          capabilities: ['echoes', 'voice', 'ops'],
        },
        telegram: {
          currentTopicName: 'Voice',
          lastSeenTopicName: 'Voice',
          groupLabel: 'Demo Team',
          threadId: 5,
        },
        live: {
          status: 'missing',
          sessionStatus: null,
          updatedAt: null,
          idleMs: null,
          freshnessLabel: 'offline',
        },
        currentTask: {
          snippet: 'Offline in demo mode.',
          source: 'none',
          updatedAt: null,
          confidence: 'low',
          progress: null,
          progressLabel: null,
        },
        recent: {
          lastUserText: null,
          lastAssistantText: null,
          lastToolName: null,
        },
      },
    ],
  };
}

export function buildDemoWatchSnapshot() {
  const now = nowIso();
  const nowMs = Date.now();
  const teamTopology = buildDemoTeamTopology();

  return {
    ok: true,
    now,
    status: 'demo',
    summary: 'Demo-mode watcher snapshot',
    sections: {
      openclawMeta: JSON.stringify({
        version: 'demo-mode',
        model: 'openai-codex/gpt-5.4',
        thinking: 'high',
        heartbeat: '5m',
        maxFlows: 4,
        maxSubagents: 8,
        authProviders: [
          { id: 'openai', errorCount: 0, cooldownUntil: null, lastUsed: nowMs - 15_000, lastFailureAt: null, cooldownReason: null },
        ],
        sessions: [
          { key: 'agent:main:main', status: 'running', updatedAt: nowMs - 5_000, model: 'openai-codex/gpt-5.4', channel: 'telegram' },
          { key: 'demo:coder-1', status: 'running', updatedAt: nowMs - 20_000, model: 'openai-codex/gpt-5.4', channel: 'telegram' },
        ],
        configHealthy: true,
      }),
      openclawSession: JSON.stringify([
        { kind: 'user', ts: now, text: 'Make the repo OSS-ready.' },
        { kind: 'reply', ts: now, text: 'Adding portable config and demo mode now.' },
        { kind: 'tool', ts: now, name: 'edit', detail: 'src/lib/runtime-config.ts' },
        { kind: 'reply', ts: now, text: 'Done, build is clean and the docs are updated.' },
      ]),
      openclawRuns: JSON.stringify([
        {
          task_id: 'demo-1',
          label: 'build',
          status: 'succeeded',
          ts: new Date(nowMs - 4 * 60_000).toISOString(),
          task: 'npm run build',
          terminal_outcome: 'success',
          terminal_summary: 'Build passed for demo mode.',
          error: '',
          source_id: 'demo',
        },
        {
          task_id: 'demo-2',
          label: 'docs',
          status: 'succeeded',
          ts: new Date(nowMs - 12 * 60_000).toISOString(),
          task: 'Refresh README and landing copy',
          terminal_outcome: 'success',
          terminal_summary: 'Docs updated for OSS onboarding.',
          error: '',
          source_id: 'demo',
        },
      ]),
      openclawFlows: JSON.stringify([
        {
          flow_id: 'demo-flow-1',
          status: 'running',
          sync_mode: 'async',
          ts: new Date(nowMs - 15 * 60_000).toISOString(),
          updated_at: new Date(nowMs - 60_000).toISOString(),
          ended_at: '',
          goal: 'Prepare Watcher for open-source self-hosters',
          current_step: 'portable config + demo mode',
          blocked_summary: '',
        },
      ]),
      openclawCron: JSON.stringify([
        {
          ts: nowMs - 20 * 60_000,
          jobId: 'watch-telegram',
          action: 'mirror',
          status: 'ok',
          error: null,
          summary: 'Telegram summary refreshed',
          durationMs: 842,
          nextRunAtMs: nowMs + 40 * 60_000,
        },
      ]),
      teamTopology: JSON.stringify(teamTopology),
      watchFaultState: JSON.stringify({ clearedRunFaultAt: null, clearedSessionIdleAt: null }),
      pm2: 'demo mode\nwatcher-web online\nwatcher-telegram online',
      pm2Json: JSON.stringify([
        { name: 'watcher-web', pid: 43210, monit: { cpu: 1.2, memory: 72 * 1024 * 1024 }, pm2_env: { status: 'online', exec_mode: 'fork_mode', restart_time: 0, pm_uptime: nowMs - 2 * 60 * 60 * 1000, version: '0.1.0' } },
        { name: 'watcher-telegram', pid: 43211, monit: { cpu: 0.3, memory: 38 * 1024 * 1024 }, pm2_env: { status: 'online', exec_mode: 'fork_mode', restart_time: 0, pm_uptime: nowMs - 2 * 60 * 60 * 1000, version: '0.1.0' } },
      ]),
      updateResult: 'demo mode enabled, no host update command output available',
      snapmoltOut: '[demo] mirror: refreshed status summary',
      snapmoltErr: '',
      echoesOut: '[demo] voice engine healthy',
      echoesErr: '',
    },
  };
}
