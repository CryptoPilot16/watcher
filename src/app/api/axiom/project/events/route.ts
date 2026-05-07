import fs from 'fs';
import { NextResponse } from 'next/server';
import { isAdminAuthed } from '@/lib/admin-auth';
import { getWatchApiKey } from '@/lib/auth';

export const dynamic = 'force-dynamic';

const EVENT_LOG = process.env.WATCH_AXIOM_PROJECT_EVENT_LOG || '/var/lib/watcher/axiom-project-events.jsonl';
const DEFAULT_LIMIT = 200;
const MAX_TAIL_BYTES = 512 * 1024;

type Event = {
  ts: string;
  kind: string;
  path: string;
  size: number | null;
};

function authOk(request: Request) {
  const auth = request.headers.get('authorization') || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (bearer && bearer === getWatchApiKey()) return Promise.resolve(true);
  return isAdminAuthed(request as any);
}

function tailEvents(): Event[] {
  let stat: fs.Stats;
  try { stat = fs.statSync(EVENT_LOG); }
  catch { return []; }
  const start = Math.max(0, stat.size - MAX_TAIL_BYTES);
  const fd = fs.openSync(EVENT_LOG, 'r');
  const len = Math.min(MAX_TAIL_BYTES, stat.size);
  const buf = Buffer.alloc(len);
  fs.readSync(fd, buf, 0, len, start);
  fs.closeSync(fd);
  let text = buf.toString('utf8');
  if (start > 0) {
    const nl = text.indexOf('\n');
    if (nl >= 0) text = text.slice(nl + 1);
  }
  const out: Event[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as Event;
      out.push(parsed);
    } catch {}
  }
  return out;
}

export async function GET(request: Request) {
  if (!(await authOk(request))) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }
  const url = new URL(request.url);
  const since = url.searchParams.get('since') || '';
  const limit = Math.min(1_000, Math.max(1, Number(url.searchParams.get('limit') || DEFAULT_LIMIT)));

  const events = tailEvents();
  const filtered = since ? events.filter((e) => e.ts > since) : events;
  const sliced = filtered.slice(-limit);
  return NextResponse.json({
    ok: true,
    generatedAt: new Date().toISOString(),
    eventLog: EVENT_LOG,
    total: filtered.length,
    events: sliced,
  });
}
