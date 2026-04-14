import fs from 'fs';
import type { TeamTopology, TeamTaskConfidence, TeamTaskSource, TeamTopic, TeamTopicLiveStatus } from '@/lib/watch-team';

const ORCHESTRATION_FILE = '/root/.openclaw/workspace/state/orchestration.json';
const SESSIONS_FILE = '/root/.openclaw/agents/main/sessions/sessions.json';
const RECENT_THRESHOLD_MS = 90 * 60 * 1000;

type SessionIndexEntry = {
  sessionId?: string;
  sessionFile?: string;
  updatedAt?: number;
  status?: string;
  channel?: string;
  deliveryContext?: {
    threadId?: number;
  };
  origin?: {
    label?: string;
  };
};

type TopicSignal = {
  snippet: string | null;
  source: TeamTaskSource;
  confidence: TeamTaskConfidence;
  updatedAt: string | null;
  score: number;
};

type TopicSessionParse = {
  currentTopicName: string | null;
  lastSeenTopicName: string | null;
  lastUserText: string | null;
  lastAssistantText: string | null;
  lastToolName: string | null;
  currentTask: TopicSignal;
};

function readJsonSafe<T>(filePath: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function truncate(text: string | null | undefined, max = 160) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return null;
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

function timeAgo(updatedAt: number | null) {
  if (!updatedAt) return 'never';
  const ms = Date.now() - updatedAt;
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

function deriveCapabilities(role: string, runtime?: string) {
  const capabilities = new Set<string>();

  if (role === 'dispatcher') {
    capabilities.add('dispatch');
    capabilities.add('triage');
    capabilities.add('integrate');
  }
  if (role === 'coordination') {
    capabilities.add('coordinate');
    capabilities.add('handoff');
  }
  if (role === 'project_owner_and_worker') {
    capabilities.add('own');
    capabilities.add('build');
    capabilities.add('review');
  }
  if (role === 'generic_coder') {
    capabilities.add('code');
    capabilities.add('fix');
    capabilities.add('ship');
  }
  if (role === 'echoes_commands') {
    capabilities.add('echoes');
    capabilities.add('voice');
    capabilities.add('ops');
  }

  if (runtime?.includes('codex')) capabilities.add('codex');
  if (runtime?.includes('persistent')) capabilities.add('persistent');
  if (runtime?.includes('main')) capabilities.add('main');

  return [...capabilities];
}

function cleanAssistantText(raw: string) {
  const text = String(raw || '')
    .replace(/\[\[reply_to_current\]\]\s*/g, '')
    .trim();

  if (!text || text === 'NO_REPLY') return null;
  return truncate(text, 160);
}

function parseMetadataBlocks(rawText: string) {
  const topicNames: string[] = [];
  const labels: string[] = [];
  const re = /```json\s*([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(rawText))) {
    try {
      const parsed = JSON.parse(match[1]);
      if (parsed?.topic_name) topicNames.push(String(parsed.topic_name));
      if (parsed?.conversation_label) labels.push(String(parsed.conversation_label));
      if (parsed?.group_subject) labels.push(String(parsed.group_subject));
    } catch {
      // ignore bad metadata blocks
    }
  }
  return {
    topicName: topicNames.at(-1) ?? null,
    groupLabel: labels.find((value) => value && !value.includes('topic:')) ?? labels.at(-1) ?? null,
  };
}

function cleanUserText(rawText: string) {
  let text = String(rawText || '').trim();
  const meta = parseMetadataBlocks(text);

  if (text.includes('Conversation info (untrusted metadata)')) {
    const fenceRe = /```(?:json)?\s*[\s\S]*?```/g;
    const fences = [...text.matchAll(fenceRe)];
    if (fences.length > 0) {
      const last = fences.at(-1);
      if (last?.index !== undefined) {
        text = text.slice(last.index + last[0].length).trim();
      }
    }
  }

  if (!text || text.startsWith('Reply with exactly') || text.startsWith('You are running a boot')) {
    return { text: null, topicName: meta.topicName, groupLabel: meta.groupLabel };
  }

  return {
    text: truncate(text, 160),
    topicName: meta.topicName,
    groupLabel: meta.groupLabel,
  };
}

function parseSignalFromUpdatePlan(obj: any, timestamp: string): TopicSignal | null {
  const details = obj?.message?.details || {};
  const plan = Array.isArray(details?.plan) ? details.plan : [];
  if (plan.length === 0) return null;

  const inProgress = plan.find((step: any) => step?.status === 'in_progress');
  const completed = [...plan].reverse().find((step: any) => step?.status === 'completed');
  const step = inProgress || completed;
  if (!step?.step) return null;

  return {
    snippet: truncate(step.step, 160),
    source: 'plan',
    confidence: 'high',
    updatedAt: timestamp || null,
    score: 300,
  };
}

function parseSignalFromYield(obj: any): TopicSignal | null {
  const timestamp = obj?.timestamp || null;
  const direct = truncate(obj?.message?.details?.message || obj?.content || '', 160);
  if (!direct) return null;
  return {
    snippet: direct,
    source: 'yield',
    confidence: 'high',
    updatedAt: timestamp,
    score: 280,
  };
}

function maybePickSignal(current: TopicSignal, candidate: TopicSignal | null) {
  if (!candidate?.snippet) return current;
  if (candidate.score > current.score) return candidate;
  if (candidate.score === current.score && (candidate.updatedAt || '') >= (current.updatedAt || '')) return candidate;
  return current;
}

function parseTopicSession(sessionFile: string | null): TopicSessionParse {
  const emptySignal: TopicSignal = {
    snippet: null,
    source: 'none',
    confidence: 'low',
    updatedAt: null,
    score: 0,
  };

  if (!sessionFile || !fs.existsSync(sessionFile)) {
    return {
      currentTopicName: null,
      lastSeenTopicName: null,
      lastUserText: null,
      lastAssistantText: null,
      lastToolName: null,
      currentTask: emptySignal,
    };
  }

  const raw = fs.readFileSync(sessionFile, 'utf8');
  const lines = raw.split('\n').filter(Boolean).slice(-140);

  let currentTopicName: string | null = null;
  let lastSeenTopicName: string | null = null;
  let lastUserText: string | null = null;
  let lastAssistantText: string | null = null;
  let lastToolName: string | null = null;
  let currentTask = emptySignal;

  for (const line of lines) {
    let obj: any = null;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    const timestamp = obj?.timestamp || null;

    if (obj?.type === 'custom_message' && obj?.customType === 'openclaw.sessions_yield') {
      currentTask = maybePickSignal(currentTask, parseSignalFromYield(obj));
      continue;
    }

    if (obj?.type !== 'message') continue;
    const message = obj?.message || {};
    const role = message?.role;

    if (role === 'user') {
      const parts = Array.isArray(message?.content) ? message.content : [];
      const rawText = parts.map((part: any) => part?.text ?? part?.content ?? '').join(' ');
      const cleaned = cleanUserText(rawText);
      if (cleaned.topicName) {
        currentTopicName = cleaned.topicName;
        lastSeenTopicName = cleaned.topicName;
      }
      if (cleaned.text) {
        lastUserText = cleaned.text;
        currentTask = maybePickSignal(currentTask, {
          snippet: cleaned.text,
          source: 'user',
          confidence: 'medium',
          updatedAt: timestamp,
          score: 180,
        });
      }
      continue;
    }

    if (role === 'assistant') {
      const parts = Array.isArray(message?.content) ? message.content : [];
      const assistantTextParts: string[] = [];
      for (const part of parts) {
        if (part?.type === 'text' && part?.text) {
          assistantTextParts.push(String(part.text));
        }
        if (part?.type === 'toolCall' && part?.name) {
          lastToolName = String(part.name);
        }
      }
      const cleaned = cleanAssistantText(assistantTextParts.join(' '));
      if (cleaned) {
        lastAssistantText = cleaned;
        currentTask = maybePickSignal(currentTask, {
          snippet: cleaned,
          source: 'assistant',
          confidence: 'low',
          updatedAt: timestamp,
          score: 100,
        });
      }
      continue;
    }

    if (role === 'toolResult') {
      const toolName = String(message?.toolName || '');
      if (toolName) lastToolName = toolName;

      if (toolName === 'update_plan') {
        currentTask = maybePickSignal(currentTask, parseSignalFromUpdatePlan(obj, timestamp));
        continue;
      }

      if (toolName === 'sessions_yield') {
        currentTask = maybePickSignal(currentTask, parseSignalFromYield(obj));
        continue;
      }

      if (toolName === 'sessions_spawn') {
        const label = message?.details?.label || message?.details?.childSessionKey || 'worker task';
        currentTask = maybePickSignal(currentTask, {
          snippet: truncate(`delegated ${label}`, 160),
          source: 'tool',
          confidence: 'low',
          updatedAt: timestamp,
          score: 80,
        });
      }
    }
  }

  return {
    currentTopicName,
    lastSeenTopicName,
    lastUserText,
    lastAssistantText,
    lastToolName,
    currentTask,
  };
}

function computeLiveStatus(session: SessionIndexEntry | undefined): TeamTopic['live'] {
  if (!session) {
    return {
      status: 'missing',
      sessionStatus: null,
      updatedAt: null,
      idleMs: null,
      freshnessLabel: 'missing',
    };
  }

  const updatedAt = typeof session.updatedAt === 'number' ? session.updatedAt : null;
  const idleMs = updatedAt ? Math.max(0, Date.now() - updatedAt) : null;
  let status: TeamTopicLiveStatus = 'idle';

  if (session.status === 'running') {
    status = 'running';
  } else if (idleMs !== null && idleMs <= RECENT_THRESHOLD_MS) {
    status = 'recent';
  }

  return {
    status,
    sessionStatus: session.status ?? null,
    updatedAt,
    idleMs,
    freshnessLabel: session.status === 'running' ? 'live now' : timeAgo(updatedAt),
  };
}

function getSessionEntry(
  sessionsIndex: Record<string, SessionIndexEntry>,
  groupId: string,
  topicId: string,
) {
  const directKey = `agent:main:telegram:group:${groupId}:topic:${topicId}`;
  if (sessionsIndex[directKey]) return { key: directKey, session: sessionsIndex[directKey] };

  const fallback = Object.entries(sessionsIndex).find(([key, value]) => {
    return key.includes(`topic:${topicId}`) || value?.deliveryContext?.threadId === Number(topicId);
  });

  if (!fallback) return { key: directKey, session: undefined };
  return { key: fallback[0], session: fallback[1] };
}

export function getTeamTopology(): string {
  const orchestration = readJsonSafe<any>(ORCHESTRATION_FILE, {});
  const sessionsIndex = readJsonSafe<Record<string, SessionIndexEntry>>(SESSIONS_FILE, {});
  const groupId = String(orchestration?.telegramTeam?.groupId || '');
  const lanes = Array.isArray(orchestration?.telegramTeam?.lanes) ? orchestration.telegramTeam.lanes : [];

  const topics: TeamTopic[] = lanes.map((lane: any) => {
    const topicId = String(lane?.topicId || '');
    const resolved = getSessionEntry(sessionsIndex, groupId, topicId);
    const session = resolved.session;
    const sessionFile = session?.sessionFile || (session?.sessionId ? `/root/.openclaw/agents/main/sessions/${session.sessionId}-topic-${topicId}.jsonl` : null);
    const parsed = parseTopicSession(sessionFile && fs.existsSync(sessionFile) ? sessionFile : null);
    const live = computeLiveStatus(session);

    return {
      topicId,
      sessionKey: resolved.key,
      sessionFile: sessionFile && fs.existsSync(sessionFile) ? sessionFile : null,
      configured: {
        label: String(lane?.label || `Topic ${topicId}`),
        role: String(lane?.role || 'unknown'),
        agent: lane?.agent || undefined,
        runtime: lane?.runtime || undefined,
        capabilities: deriveCapabilities(String(lane?.role || ''), lane?.runtime || undefined),
      },
      telegram: {
        currentTopicName: parsed.currentTopicName,
        lastSeenTopicName: parsed.lastSeenTopicName,
        groupLabel: session?.origin?.label || null,
        threadId: Number(topicId) || null,
      },
      live,
      currentTask: {
        snippet: parsed.currentTask.snippet,
        source: parsed.currentTask.source,
        updatedAt: parsed.currentTask.updatedAt,
        confidence: parsed.currentTask.confidence,
      },
      recent: {
        lastUserText: parsed.lastUserText,
        lastAssistantText: parsed.lastAssistantText,
        lastToolName: parsed.lastToolName,
      },
    };
  });

  const summary = {
    totalTopics: topics.length,
    running: topics.filter((topic) => topic.live.status === 'running').length,
    recent: topics.filter((topic) => topic.live.status === 'recent').length,
    idle: topics.filter((topic) => topic.live.status === 'idle').length,
    missingSession: topics.filter((topic) => topic.live.status === 'missing').length,
  };

  const payload: TeamTopology = {
    generatedAt: new Date().toISOString(),
    groupId,
    source: {
      orchestrationPath: ORCHESTRATION_FILE,
      sessionsIndexPath: SESSIONS_FILE,
    },
    summary,
    topics,
  };

  return JSON.stringify(payload);
}
