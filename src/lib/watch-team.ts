export type TeamTopicLiveStatus = 'running' | 'recent' | 'idle' | 'missing';
export type TeamTaskSource = 'plan' | 'yield' | 'user' | 'assistant' | 'tool' | 'none';
export type TeamTaskConfidence = 'high' | 'medium' | 'low';

export type TeamTopic = {
  topicId: string;
  sessionKey: string;
  sessionFile: string | null;
  configured: {
    label: string;
    role: string;
    agent?: string;
    runtime?: string;
    capabilities: string[];
  };
  telegram: {
    currentTopicName: string | null;
    lastSeenTopicName: string | null;
    groupLabel: string | null;
    threadId: number | null;
  };
  live: {
    status: TeamTopicLiveStatus;
    sessionStatus: string | null;
    updatedAt: number | null;
    idleMs: number | null;
    freshnessLabel: string;
  };
  currentTask: {
    snippet: string | null;
    source: TeamTaskSource;
    updatedAt: string | null;
    confidence: TeamTaskConfidence;
    progress: number | null;
    progressLabel: string | null;
  };
  recent: {
    lastUserText: string | null;
    lastAssistantText: string | null;
    lastToolName: string | null;
  };
};

export type TeamTopology = {
  generatedAt: string;
  groupId: string;
  source: {
    orchestrationPath: string;
    sessionsIndexPath: string;
  };
  summary: {
    totalTopics: number;
    running: number;
    recent: number;
    idle: number;
    missingSession: number;
  };
  topics: TeamTopic[];
};

const emptyTopology: TeamTopology = {
  generatedAt: '',
  groupId: '',
  source: {
    orchestrationPath: '',
    sessionsIndexPath: '',
  },
  summary: {
    totalTopics: 0,
    running: 0,
    recent: 0,
    idle: 0,
    missingSession: 0,
  },
  topics: [],
};

export function parseTeamTopology(raw: string | undefined): TeamTopology {
  try {
    const parsed = JSON.parse(raw || '') as TeamTopology;
    return {
      ...emptyTopology,
      ...parsed,
      source: {
        ...emptyTopology.source,
        ...(parsed?.source || {}),
      },
      summary: {
        ...emptyTopology.summary,
        ...(parsed?.summary || {}),
      },
      topics: Array.isArray(parsed?.topics) ? parsed.topics : [],
    };
  } catch {
    return emptyTopology;
  }
}

export function topicRoleRank(role: string) {
  switch (role) {
    case 'dispatcher':
      return 0;
    case 'coordination':
      return 1;
    case 'project_owner_and_worker':
      return 2;
    case 'generic_coder':
      return 3;
    case 'echoes_commands':
      return 4;
    default:
      return 5;
  }
}

export function topicDisplayLabel(topic: TeamTopic) {
  return topic.telegram.currentTopicName || topic.telegram.lastSeenTopicName || topic.configured.label || `Topic ${topic.topicId}`;
}

export function sortTeamTopics(topics: TeamTopic[]) {
  return [...topics].sort((a, b) => {
    const roleRank = topicRoleRank(a.configured.role) - topicRoleRank(b.configured.role);
    if (roleRank !== 0) return roleRank;

    const statusRank = liveStatusRank(a.live.status) - liveStatusRank(b.live.status);
    if (statusRank !== 0) return statusRank;

    return topicDisplayLabel(a).localeCompare(topicDisplayLabel(b));
  });
}

export function liveStatusRank(status: TeamTopicLiveStatus) {
  switch (status) {
    case 'running':
      return 0;
    case 'recent':
      return 1;
    case 'idle':
      return 2;
    case 'missing':
      return 3;
    default:
      return 4;
  }
}
