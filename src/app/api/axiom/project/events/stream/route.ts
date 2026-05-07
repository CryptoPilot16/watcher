import fs from 'fs';
import { isAdminAuthed } from '@/lib/admin-auth';
import { getWatchApiKey } from '@/lib/auth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const EVENT_LOG = process.env.WATCH_AXIOM_PROJECT_EVENT_LOG || '/var/lib/watcher/axiom-project-events.jsonl';
const HEARTBEAT_MS = 15_000;

function authOk(request: Request): Promise<boolean> {
  const auth = request.headers.get('authorization') || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (bearer && bearer === getWatchApiKey()) return Promise.resolve(true);
  return isAdminAuthed(request as any);
}

// SSE feed: streams every new line appended to the watcher's event JSONL.
// Initial backfill is bounded so reconnects don't replay the whole log.
export async function GET(request: Request) {
  if (!(await authOk(request))) {
    return new Response('Unauthorized', { status: 401 });
  }

  const url = new URL(request.url);
  const since = url.searchParams.get('since') || '';

  let position = 0;
  let watcher: fs.FSWatcher | null = null;
  let heartbeatTimer: NodeJS.Timeout | null = null;
  let aborted = false;
  let pumping = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();

      const send = (data: string) => {
        if (aborted) return;
        try { controller.enqueue(enc.encode(data)); } catch {}
      };

      const sendEvent = (name: string, payload: unknown) => {
        const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
        send(`event: ${name}\ndata: ${body}\n\n`);
      };

      const close = () => {
        if (aborted) return;
        aborted = true;
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        try { watcher?.close(); } catch {}
        try { controller.close(); } catch {}
      };

      // Backfill: read the tail of the log up to since (or last 64KB) so the
      // client gets recent context immediately, then we tail forward.
      try {
        const stat = fs.statSync(EVENT_LOG);
        const TAIL = 64 * 1024;
        const start = Math.max(0, stat.size - TAIL);
        if (start > 0) {
          const fh = fs.openSync(EVENT_LOG, 'r');
          const buf = Buffer.alloc(stat.size - start);
          fs.readSync(fh, buf, 0, buf.length, start);
          fs.closeSync(fh);
          let text = buf.toString('utf8');
          const nl = text.indexOf('\n');
          if (nl >= 0) text = text.slice(nl + 1);
          for (const line of text.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              const ev = JSON.parse(trimmed);
              if (since && typeof ev.ts === 'string' && ev.ts <= since) continue;
              sendEvent('file', ev);
            } catch {}
          }
        }
        position = stat.size;
      } catch {
        try { fs.mkdirSync(require('path').dirname(EVENT_LOG), { recursive: true }); fs.writeFileSync(EVENT_LOG, ''); } catch {}
        position = 0;
      }

      sendEvent('hello', { eventLog: EVENT_LOG, ts: new Date().toISOString() });

      const pumpAppendedBytes = () => {
        if (aborted || pumping) return;
        pumping = true;
        try {
          const stat = fs.statSync(EVENT_LOG);
          if (stat.size < position) {
            // Log was truncated (rotated by the watcher). Reset.
            position = 0;
          }
          if (stat.size === position) return;
          const fh = fs.openSync(EVENT_LOG, 'r');
          const len = stat.size - position;
          const buf = Buffer.alloc(len);
          fs.readSync(fh, buf, 0, len, position);
          fs.closeSync(fh);
          position = stat.size;
          for (const line of buf.toString('utf8').split('\n')) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              const ev = JSON.parse(trimmed);
              sendEvent('file', ev);
            } catch {}
          }
        } catch (err: any) {
          sendEvent('error', { message: String(err?.message || err) });
        } finally {
          pumping = false;
        }
      };

      try {
        watcher = fs.watch(EVENT_LOG, { persistent: false }, () => pumpAppendedBytes());
      } catch {
        // If the file doesn't exist yet, fall back to a slow poll.
        const poll = setInterval(() => {
          if (aborted) { clearInterval(poll); return; }
          try { fs.statSync(EVENT_LOG); } catch { return; }
          clearInterval(poll);
          try { watcher = fs.watch(EVENT_LOG, { persistent: false }, () => pumpAppendedBytes()); } catch {}
          pumpAppendedBytes();
        }, 1000);
      }

      heartbeatTimer = setInterval(() => {
        send(`: ping ${Date.now()}\n\n`);
      }, HEARTBEAT_MS);

      const signal = (request as any).signal as AbortSignal | undefined;
      signal?.addEventListener('abort', close);
    },

    cancel() {
      aborted = true;
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      try { watcher?.close(); } catch {}
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
