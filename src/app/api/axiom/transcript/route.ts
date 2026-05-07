import fs from 'fs';
import path from 'path';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const AXIOM_MAILBOX_DIR = process.env.WATCH_AXIOM_MAILBOX_DIR || '/var/lib/watcher/axiom-mailbox';
const RETENTION_MS = 24 * 60 * 60 * 1000; // 24h

type Entry = {
  ts: string;
  sessionKey: string;
  agentId?: string;
  groupId?: string;
  message: string;
  reply?: string;
};

function safeKey(sessionKey: string) {
  return sessionKey.replace(/[^a-z0-9_.\-:]/gi, '_').slice(0, 200) || 'unknown';
}

function jsonlFile(sessionKey: string) {
  return path.join(AXIOM_MAILBOX_DIR, `${safeKey(sessionKey)}.jsonl`);
}

function sessionFile(sessionKey: string) {
  return path.join(AXIOM_MAILBOX_DIR, `${safeKey(sessionKey)}.session`);
}

function readEntries(filePath: string): Entry[] {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return raw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line) as Entry; } catch { return null; }
      })
      .filter((v): v is Entry => v !== null);
  } catch {
    return [];
  }
}

/** GET /api/axiom/transcript?sessionKey=axiom:axiom-ceo
 *  Returns the conversation history for the agent, auto-pruning entries older than 24h.
 *  If pruning happened, the JSONL file is rewritten without the old entries.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const sessionKey = (url.searchParams.get('sessionKey') || '').trim();
  if (!sessionKey.startsWith('axiom:')) {
    return NextResponse.json({ ok: false, error: 'invalid sessionKey' }, { status: 400 });
  }

  const file = jsonlFile(sessionKey);
  const all = readEntries(file);
  const now = Date.now();
  const fresh = all.filter((e) => {
    const t = Date.parse(e.ts || '');
    return Number.isFinite(t) && now - t <= RETENTION_MS;
  });
  const purged = all.length - fresh.length;

  if (purged > 0) {
    try {
      const body = fresh.map((e) => JSON.stringify(e)).join('\n');
      fs.writeFileSync(file, body ? body + '\n' : '');
    } catch {
      // best-effort; ignore
    }
  }

  return NextResponse.json({
    ok: true,
    sessionKey,
    entries: fresh,
    purged,
    retentionMs: RETENTION_MS,
  });
}

/** DELETE /api/axiom/transcript?sessionKey=axiom:axiom-ceo
 *  Clears the conversation: truncates the JSONL and removes the .session UUID so the next
 *  message starts a fresh claude session with a new system prompt.
 */
export async function DELETE(request: Request) {
  const url = new URL(request.url);
  const sessionKey = (url.searchParams.get('sessionKey') || '').trim();
  if (!sessionKey.startsWith('axiom:')) {
    return NextResponse.json({ ok: false, error: 'invalid sessionKey' }, { status: 400 });
  }

  const jsonl = jsonlFile(sessionKey);
  const session = sessionFile(sessionKey);
  let cleared = 0;
  try {
    if (fs.existsSync(jsonl)) {
      cleared = readEntries(jsonl).length;
      fs.writeFileSync(jsonl, '');
    }
  } catch {}
  try {
    if (fs.existsSync(session)) fs.unlinkSync(session);
  } catch {}

  return NextResponse.json({ ok: true, sessionKey, cleared });
}
