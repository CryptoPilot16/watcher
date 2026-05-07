import fs from 'fs';
import path from 'path';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const AXIOM_MAILBOX_DIR = process.env.WATCH_AXIOM_MAILBOX_DIR || '/var/lib/watcher/axiom-mailbox';
const RECENT_TTL_MS = 30_000; // 'recent' decays to 'idle' after 30s
const ERROR_TTL_MS = 60_000; // 'error' decays to 'idle' after 60s

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

function expectedDurationMs(topicId: string): number {
  if (topicId === 'axiom-ceo') return 180_000; // CEO opus reading large docs
  if (topicId.startsWith('axiom-mgr-')) return 120_000; // managers via codex /goal
  return 60_000; // coders
}

function readState(file: string): AgentState | null {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw) as AgentState;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export async function GET() {
  let files: string[] = [];
  try {
    files = fs.readdirSync(AXIOM_MAILBOX_DIR).filter((n) => n.endsWith('.state.json'));
  } catch {
    files = [];
  }

  const now = Date.now();
  const states: Record<string, AgentState> = {};
  let runningCount = 0;
  let recentCount = 0;
  let errorCount = 0;

  for (const fname of files) {
    const raw = readState(path.join(AXIOM_MAILBOX_DIR, fname));
    if (!raw || !raw.topicId) continue;
    const state: AgentState = { ...raw };

    if (state.status === 'running' && state.startedAt) {
      const elapsed = now - new Date(state.startedAt).getTime();
      const expected = expectedDurationMs(state.topicId);
      // Cap at 0.92 — never claim 100% until the call actually completes
      state.progress = Math.max(0.04, Math.min(0.92, elapsed / expected));
      runningCount++;
    } else if (state.status === 'recent' && state.completedAt) {
      const sinceComplete = now - new Date(state.completedAt).getTime();
      if (sinceComplete > RECENT_TTL_MS) {
        state.status = 'idle';
        state.progress = null;
        state.task = null;
      } else {
        state.progress = 1;
        recentCount++;
      }
    } else if (state.status === 'error' && state.completedAt) {
      const sinceComplete = now - new Date(state.completedAt).getTime();
      if (sinceComplete > ERROR_TTL_MS) {
        state.status = 'idle';
        state.progress = null;
        state.task = null;
      } else {
        errorCount++;
      }
    }

    states[state.topicId] = state;
  }

  return NextResponse.json({
    ok: true,
    generatedAt: new Date().toISOString(),
    states,
    summary: { running: runningCount, recent: recentCount, error: errorCount },
  });
}
