import fs from 'fs';
import path from 'path';
import { NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { promisify } from 'util';

export const dynamic = 'force-dynamic';

const run = promisify(execFile);
const INJECT_TIMEOUT_MS = 90_000;
const MIRROR_TIMEOUT_MS = 20_000;

type Body = {
  agentId?: string;
  sessionKey?: string;
  groupId?: string;
  threadId?: number | string;
  message?: string;
};

function deriveSessionKey(agentId: string, groupId: string, threadId: string) {
  if (!agentId || !groupId || !threadId) return null;
  return `agent:${agentId}:telegram:group:${groupId}:topic:${threadId}`;
}

function resolveSessionId(agentId: string, sessionKey: string) {
  if (!agentId || !sessionKey) return null;
  const sessionsPath = path.join('/root/.openclaw/agents', agentId, 'sessions', 'sessions.json');
  try {
    const raw = fs.readFileSync(sessionsPath, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, { sessionId?: string }>;
    const entry = parsed?.[sessionKey];
    return typeof entry?.sessionId === 'string' && entry.sessionId.trim() ? entry.sessionId.trim() : null;
  } catch {
    return null;
  }
}

async function openclaw(args: string[], timeout: number) {
  return run('openclaw', args, { timeout });
}

export async function POST(request: Request) {
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 });
  }

  const agentId = String(body.agentId || '').trim();
  const sessionKey = String(body.sessionKey || '').trim();
  const groupId = String(body.groupId || '').trim();
  const threadId = body.threadId === undefined || body.threadId === null ? '' : String(body.threadId).trim();
  const message = String(body.message || '').trim();

  if (!agentId) return NextResponse.json({ ok: false, error: 'missing agentId' }, { status: 400 });
  if (!message) return NextResponse.json({ ok: false, error: 'empty message' }, { status: 400 });
  if (message.length > 4000) return NextResponse.json({ ok: false, error: 'message too long' }, { status: 400 });

  const effectiveSessionKey = sessionKey || deriveSessionKey(agentId, groupId, threadId) || '';
  const sessionId = resolveSessionId(agentId, effectiveSessionKey);
  const injectArgs = sessionId
    ? ['agent', '--session-id', sessionId, '-m', message, '--deliver', '--json']
    : ['agent', '--agent', agentId, '-m', message, '--json'];
  const mirrorArgs = groupId && threadId
    ? ['message', 'send', '--channel', 'telegram', '--target', groupId, '--thread-id', threadId, '--message', `[from web] ${message}`, '--json']
    : null;

  const [injectResult, mirrorResult] = await Promise.allSettled([
    openclaw(injectArgs, INJECT_TIMEOUT_MS),
    mirrorArgs ? openclaw(mirrorArgs, MIRROR_TIMEOUT_MS) : Promise.resolve(null),
  ]);

  if (injectResult.status === 'rejected') {
    const error = injectResult.reason as any;
    const timedOut = Boolean(error?.killed || error?.signal === 'SIGTERM');
    return NextResponse.json(
      {
        ok: false,
        error: timedOut
          ? 'agent turn timed out before Watcher got a response'
          : String(error?.stderr || error?.message || 'agent inject failed').trim(),
      },
      { status: 500 },
    );
  }

  const mirrored = mirrorResult.status === 'fulfilled' && mirrorResult.value !== null;
  const mirrorError = mirrorResult.status === 'rejected'
    ? String((mirrorResult.reason as any)?.stderr || (mirrorResult.reason as any)?.message || 'mirror failed').trim()
    : null;

  return NextResponse.json({
    ok: true,
    injected: true,
    delivered: Boolean(sessionId),
    mirrored,
    mirrorError,
    sessionResolved: Boolean(sessionId),
    sessionKey: effectiveSessionKey || null,
    sessionId,
    stdout: injectResult.value.stdout.trim(),
  });
}
