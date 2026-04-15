import type { Metadata } from 'next';
import { TeamOfficeCanvas } from '@/components/team-office/team-office-canvas';
import { getTeamTopology } from '@/lib/team-topology-server';
import { parseTeamTopology, sortTeamTopics, type TeamTopic, type TeamTopology } from '@/lib/watch-team';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export const metadata: Metadata = {
  title: 'CLAWNUX Watch, Office Preview',
  description: 'Public read-only office preview for Watcher.',
};

function publicRoleLabel(topic: TeamTopic, workerIndex: number) {
  switch (topic.configured.role) {
    case 'dispatcher':
      return 'Dispatcher';
    case 'coordination':
      return 'Ops';
    case 'echoes_commands':
      return 'Voice';
    case 'project_owner_and_worker':
    case 'generic_coder':
      return `Worker ${workerIndex}`;
    default:
      return `Lane ${workerIndex}`;
  }
}

function publicStatusLine(topic: TeamTopic) {
  switch (topic.live.status) {
    case 'running':
      return 'Active lane';
    case 'recent':
      return 'Recent handoff';
    case 'missing':
      return 'Offline';
    default:
      return 'Standing by';
  }
}

function sanitizeTopology(topology: TeamTopology): TeamTopology {
  let workerIndex = 1;

  return {
    ...topology,
    topics: sortTeamTopics(topology.topics).map((topic) => {
      const publicLabel = publicRoleLabel(topic, workerIndex);
      if (
        topic.configured.role === 'project_owner_and_worker' ||
        topic.configured.role === 'generic_coder' ||
        topic.configured.role === 'unknown'
      ) {
        workerIndex += 1;
      }

      return {
        topicId: topic.topicId,
        sessionKey: `public:${topic.topicId}`,
        sessionFile: null,
        configured: {
          label: publicLabel,
          role: topic.configured.role,
          capabilities: [],
        },
        telegram: {
          currentTopicName: null,
          lastSeenTopicName: null,
          groupLabel: null,
          threadId: null,
        },
        live: {
          status: topic.live.status,
          sessionStatus: null,
          updatedAt: null,
          idleMs: null,
          freshnessLabel:
            topic.live.status === 'running'
              ? 'live now'
              : topic.live.status === 'recent'
                ? 'recently active'
                : topic.live.status === 'missing'
                  ? 'offline'
                  : 'standing by',
        },
        currentTask: {
          snippet: publicStatusLine(topic),
          source: topic.live.status === 'running' ? 'tool' : topic.live.status === 'recent' ? 'yield' : 'none',
          updatedAt: null,
          confidence: 'low',
        },
        recent: {
          lastUserText: null,
          lastAssistantText: null,
          lastToolName: null,
        },
      };
    }),
  };
}

export default function OfficePreviewPage({
  searchParams,
}: {
  searchParams?: { embed?: string };
}) {
  const embed = searchParams?.embed === '1';
  const topology = sanitizeTopology(parseTeamTopology(getTeamTopology()));

  return (
    <main className={embed ? 'h-screen overflow-hidden bg-[var(--watch-bg)]' : 'min-h-screen bg-[var(--watch-bg)] p-3 sm:p-5'}>
      <div className={embed ? 'relative h-full' : 'mx-auto flex min-h-[calc(100vh-24px)] max-w-[1600px] flex-col gap-3'}>
        {!embed && (
          <div className="rounded-xl border border-[var(--watch-panel-border)] bg-[rgba(0,0,0,0.18)] px-4 py-3">
            <div className="text-[10px] uppercase tracking-[0.24em] text-[var(--watch-text-muted)]">▌ public office preview</div>
            <div className="mt-2 text-sm text-[var(--watch-text-bright)] sm:text-base">Read-only visual preview of the Watcher office floor.</div>
            <div className="mt-1 text-xs leading-6 text-[var(--watch-text-muted)]">Live private task text is stripped. Only generic lane presence and activity states are shown here.</div>
          </div>
        )}

        <div className={embed ? 'relative h-full' : 'flex-1'}>
          <TeamOfficeCanvas topics={topology.topics} />

          <div className="pointer-events-none absolute left-3 top-3 rounded-md border border-[rgba(236,213,141,0.28)] bg-[rgba(12,10,7,0.66)] px-2.5 py-1.5 text-[10px] uppercase tracking-[0.18em] text-[var(--watch-text-bright)] backdrop-blur-sm">
            public office preview
          </div>
        </div>
      </div>
    </main>
  );
}
