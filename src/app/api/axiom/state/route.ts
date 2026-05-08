import fs from 'fs';
import path from 'path';
import { NextResponse } from 'next/server';

// Snapshot of session UUIDs that have a live claude/codex process backing
// them. Built once per state-route GET by scanning /proc cmdlines. Used to
// detect zombies (state file says "running" but no live subprocess matches
// its session id), which auto-decay even before they hit RUNNING_ZOMBIE_TTL.
function liveSessionUuids(): Set<string> {
  const uuids = new Set<string>();
  let entries: string[] = [];
  try {
    entries = fs.readdirSync('/proc');
  } catch {
    return uuids;
  }
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    let cmd = '';
    try {
      cmd = fs.readFileSync(`/proc/${name}/cmdline`, 'utf8');
    } catch { continue; }
    if (!cmd) continue;
    if (!cmd.includes('claude') && !cmd.includes('codex')) continue;
    // session UUIDs look like 8-4-4-4-12 hex
    const matches = cmd.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi);
    if (matches) for (const m of matches) uuids.add(m.toLowerCase());
  }
  return uuids;
}

function readSessionUuid(sessionKey: string): string | null {
  const safe = sessionKey.replace(/[^a-z0-9_.\-:]/gi, '_').slice(0, 200) || 'unknown';
  const file = path.join(process.env.WATCH_AXIOM_MAILBOX_DIR || '/var/lib/watcher/axiom-mailbox', `${safe}.session`);
  try {
    const raw = fs.readFileSync(file, 'utf8').trim().toLowerCase();
    return /^[0-9a-f-]{36}$/.test(raw) ? raw : null;
  } catch {
    return null;
  }
}

export const dynamic = 'force-dynamic';

const AXIOM_MAILBOX_DIR = process.env.WATCH_AXIOM_MAILBOX_DIR || '/var/lib/watcher/axiom-mailbox';
const RECENT_TTL_MS = 30_000; // 'recent' decays to 'idle' after 30s
const ERROR_TTL_MS = 60_000; // 'error' decays to 'idle' after 60s
// 'running' for longer than this is almost certainly a zombie — the parent
// watcher-web was restarted mid-call (--die-with-parent killed the
// subprocess) but the state file still claims running because no completion
// event was written. Auto-decay so the autopilot's next cycle re-dispatches.
const RUNNING_ZOMBIE_TTL_MS = 5 * 60_000;

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
  // Cross-reference live processes once per request so zombies auto-decay
  // immediately — not after the 5 min TTL. Without this the floor reports
  // ghost "running" agents long after watcher-web restarts have killed the
  // underlying subprocess.
  const live = liveSessionUuids();

  for (const fname of files) {
    const raw = readState(path.join(AXIOM_MAILBOX_DIR, fname));
    if (!raw || !raw.topicId) continue;
    const state: AgentState = { ...raw };

    if (state.status === 'running' && state.startedAt) {
      const elapsed = now - new Date(state.startedAt).getTime();
      const sessionKey = state.sessionKey || `axiom:${state.topicId}`;
      const sid = readSessionUuid(sessionKey);
      const isLive = sid ? live.has(sid) : null;
      // Auto-decay zombies. Two paths:
      //   (a) elapsed > 5 min — definitely stale
      //   (b) state's session UUID is not in the live process snapshot AND
      //       elapsed > 30s (30s grace so we don't false-positive a call
      //       that hasn't yet spawned its subprocess).
      const isZombie = elapsed > RUNNING_ZOMBIE_TTL_MS || (isLive === false && elapsed > 30_000);
      if (isZombie) {
        state.status = 'idle';
        state.progress = null;
        state.task = null;
        states[state.topicId] = state;
        continue;
      }
      const expected = expectedDurationMs(state.topicId);
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
