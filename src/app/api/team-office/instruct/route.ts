import { NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { promisify } from 'util';

export const dynamic = 'force-dynamic';

const run = promisify(execFile);

type Body = {
  agentId?: string;
  groupId?: string;
  threadId?: number | string;
  message?: string;
};

async function openclaw(args: string[]) {
  return run('openclaw', args, { timeout: 20_000 });
}

export async function POST(request: Request) {
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 });
  }

  const agentId = String(body.agentId || '').trim();
  const groupId = String(body.groupId || '').trim();
  const threadId = body.threadId === undefined || body.threadId === null ? '' : String(body.threadId).trim();
  const message = String(body.message || '').trim();

  if (!agentId) return NextResponse.json({ ok: false, error: 'missing agentId' }, { status: 400 });
  if (!message) return NextResponse.json({ ok: false, error: 'empty message' }, { status: 400 });
  if (message.length > 4000) return NextResponse.json({ ok: false, error: 'message too long' }, { status: 400 });

  const injectArgs = ['agent', '--agent', agentId, '-m', message, '--json'];
  const mirrorArgs = groupId && threadId
    ? ['message', 'send', '--target', groupId, '--thread-id', threadId, '--message', `[from web] ${message}`, '--json']
    : null;

  const [injectResult, mirrorResult] = await Promise.allSettled([
    openclaw(injectArgs),
    mirrorArgs ? openclaw(mirrorArgs) : Promise.resolve(null),
  ]);

  if (injectResult.status === 'rejected') {
    const error = injectResult.reason;
    return NextResponse.json(
      {
        ok: false,
        error: String(error?.stderr || error?.message || 'agent inject failed').trim(),
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
    mirrored,
    mirrorError,
    stdout: injectResult.value.stdout.trim(),
  });
}
