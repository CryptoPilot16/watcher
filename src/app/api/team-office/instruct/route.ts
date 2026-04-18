import fs from 'fs';
import path from 'path';
import { NextResponse } from 'next/server';
import { execFile, spawn } from 'child_process';
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

function resolveSession(agentId: string, sessionKey: string, threadId: string) {
  if (!agentId) return { sessionId: null, resolvedKey: sessionKey || null, acpBound: false };
  const sessionsPath = path.join('/root/.openclaw/agents', agentId, 'sessions', 'sessions.json');
  try {
    const raw = fs.readFileSync(sessionsPath, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, { sessionId?: string; deliveryContext?: { threadId?: number | string } }>;
    const direct = sessionKey ? parsed?.[sessionKey] : null;
    if (typeof direct?.sessionId === 'string' && direct.sessionId.trim()) {
      return { sessionId: direct.sessionId.trim(), resolvedKey: sessionKey || null, acpBound: false };
    }

    const fallback = Object.entries(parsed).find(([key, value]) => {
      if (!threadId) return false;
      const resolvedThreadId = value?.deliveryContext?.threadId;
      return String(resolvedThreadId || '') === threadId && key.includes(':telegram:');
    });
    if (fallback && typeof fallback[1]?.sessionId === 'string' && fallback[1].sessionId.trim()) {
      return {
        sessionId: fallback[1].sessionId.trim(),
        resolvedKey: fallback[0],
        acpBound: !fallback[0].includes(':topic:'),
      };
    }
  } catch {
    // ignore
  }
  return { sessionId: null, resolvedKey: sessionKey || null, acpBound: false };
}

async function openclaw(args: string[], timeout: number) {
  return run('openclaw', args, { timeout });
}

function launchOpenclaw(args: string[]) {
  const child = spawn('openclaw', args, {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  return child.pid ?? null;
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
  const resolved = resolveSession(agentId, effectiveSessionKey, threadId);
  const injectArgs = resolved.sessionId
    ? ['agent', '--session-id', resolved.sessionId, '-m', message, '--deliver', '--json']
    : ['agent', '--agent', agentId, '-m', message, '--json'];
  const mirrorArgs = groupId && threadId
    ? ['message', 'send', '--channel', 'telegram', '--target', groupId, '--thread-id', threadId, '--message', `[from web] ${message}`, '--json']
    : null;

  let injectPid: number | null = null;
  if (resolved.sessionId) {
    try {
      injectPid = launchOpenclaw(injectArgs);
    } catch (error: any) {
      return NextResponse.json(
        { ok: false, error: String(error?.message || 'agent inject failed').trim() },
        { status: 500 },
      );
    }
  }

  const mirrorResult = mirrorArgs
    ? await Promise.allSettled([openclaw(mirrorArgs, MIRROR_TIMEOUT_MS)]).then(([result]) => result)
    : { status: 'fulfilled', value: null } as const;

  if (!resolved.sessionId) {
    const injectResult = await Promise.allSettled([openclaw(injectArgs, INJECT_TIMEOUT_MS)]).then(([result]) => result);
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
      delivered: false,
      mirrored,
      mirrorError,
      sessionResolved: false,
      sessionKey: resolved.resolvedKey || null,
      sessionId: null,
      stdout: injectResult.value.stdout.trim(),
    });
  }

  const mirrored = mirrorResult.status === 'fulfilled' && mirrorResult.value !== null;
  const mirrorError = mirrorResult.status === 'rejected'
    ? String((mirrorResult.reason as any)?.stderr || (mirrorResult.reason as any)?.message || 'mirror failed').trim()
    : null;

  return NextResponse.json({
    ok: true,
    injected: true,
    delivered: true,
    queued: true,
    pid: injectPid,
    mirrored,
    mirrorError,
    sessionResolved: true,
    sessionKey: resolved.resolvedKey || null,
    sessionId: resolved.sessionId,
    acpBound: resolved.acpBound,
    stdout: '',
  });
}
