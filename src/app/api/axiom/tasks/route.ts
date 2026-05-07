import fs from 'fs';
import path from 'path';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const AXIOM_MAILBOX_DIR = process.env.WATCH_AXIOM_MAILBOX_DIR || '/var/lib/watcher/axiom-mailbox';
const RETENTION_DAYS = Number(process.env.WATCH_AXIOM_TASKS_RETENTION_DAYS || 7);

type MailboxEntry = {
  ts: string;
  sessionKey: string;
  agentId?: string;
  groupId?: string;
  message: string;
  reply?: string;
};

function isJsonl(name: string) {
  // mailbox file naming: `<safe-session-key>.jsonl`
  return name.endsWith('.jsonl') && !name.startsWith('.');
}

function listMailboxFiles(): string[] {
  try {
    return fs
      .readdirSync(AXIOM_MAILBOX_DIR)
      .filter(isJsonl)
      .map((name) => path.join(AXIOM_MAILBOX_DIR, name));
  } catch {
    return [];
  }
}

function readMailboxFile(filePath: string): MailboxEntry[] {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return raw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as MailboxEntry;
        } catch {
          return null;
        }
      })
      .filter((v): v is MailboxEntry => v !== null);
  } catch {
    return [];
  }
}

function topicMeta(sessionKey: string): { role: 'ceo' | 'manager' | 'coder' | 'unknown'; team: number | null; coderIndex: number | null; label: string } {
  const id = sessionKey.replace(/^axiom:/, '');
  if (id === 'axiom-ceo') return { role: 'ceo', team: null, coderIndex: null, label: 'CEO · Orchestrator' };
  const mgr = id.match(/^axiom-mgr-(\d+)$/);
  if (mgr) return { role: 'manager', team: Number(mgr[1]), coderIndex: null, label: `Team ${mgr[1]} · Manager` };
  const coder = id.match(/^axiom-coder-(\d+)-(\d+)$/);
  if (coder) return { role: 'coder', team: Number(coder[1]), coderIndex: Number(coder[2]), label: `Team ${coder[1]} · Coder ${coder[2]}` };
  return { role: 'unknown', team: null, coderIndex: null, label: id || sessionKey };
}

// Lazy retention sweep: rewrite each mailbox file in place, dropping entries
// older than RETENTION_DAYS. Cheap on small files; bounded by listMailboxFiles().
function sweepRetention(): { removedEntries: number } {
  if (RETENTION_DAYS <= 0) return { removedEntries: 0 };
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const file of listMailboxFiles()) {
    const entries = readMailboxFile(file);
    if (!entries.length) continue;
    const kept = entries.filter((e) => {
      const ts = Date.parse(e.ts || '');
      return Number.isFinite(ts) ? ts >= cutoff : true;
    });
    if (kept.length === entries.length) continue;
    removed += entries.length - kept.length;
    try {
      const next = kept.length ? kept.map((e) => JSON.stringify(e)).join('\n') + '\n' : '';
      fs.writeFileSync(file, next);
    } catch {
      // best-effort
    }
  }
  return { removedEntries: removed };
}

export async function GET() {
  // Run a passive sweep on read so we don't need a separate cron.
  sweepRetention();

  const entries: Array<MailboxEntry & ReturnType<typeof topicMeta>> = [];
  for (const file of listMailboxFiles()) {
    for (const entry of readMailboxFile(file)) {
      entries.push({ ...entry, ...topicMeta(entry.sessionKey) });
    }
  }
  entries.sort((a, b) => (b.ts > a.ts ? 1 : b.ts < a.ts ? -1 : 0));

  return NextResponse.json({
    ok: true,
    generatedAt: new Date().toISOString(),
    mailboxDir: AXIOM_MAILBOX_DIR,
    retentionDays: RETENTION_DAYS,
    total: entries.length,
    entries,
  });
}

// DELETE /api/axiom/tasks            → clear ALL task entries (jsonl files truncated)
// DELETE /api/axiom/tasks?role=ceo   → clear entries matching role
// DELETE /api/axiom/tasks?sessionKey=axiom:axiom-ceo → clear one session's entries
//
// Truncates rather than deletes so the file's existence stays consistent for
// downstream callers (state.json, .session, etc. live alongside in the same dir).
export async function DELETE(request: Request) {
  const url = new URL(request.url);
  const roleFilter = (url.searchParams.get('role') || '').trim().toLowerCase();
  const sessionKeyFilter = (url.searchParams.get('sessionKey') || '').trim();

  let cleared = 0;
  let filesTouched = 0;

  for (const file of listMailboxFiles()) {
    const entries = readMailboxFile(file);
    if (!entries.length) continue;

    let kept: MailboxEntry[];
    if (sessionKeyFilter) {
      kept = entries.filter((e) => e.sessionKey !== sessionKeyFilter);
    } else if (roleFilter && ['ceo', 'manager', 'coder', 'unknown'].includes(roleFilter)) {
      kept = entries.filter((e) => topicMeta(e.sessionKey).role !== roleFilter);
    } else {
      kept = [];
    }

    if (kept.length === entries.length) continue;
    cleared += entries.length - kept.length;
    filesTouched++;
    try {
      const next = kept.length ? kept.map((e) => JSON.stringify(e)).join('\n') + '\n' : '';
      fs.writeFileSync(file, next);
    } catch (err: any) {
      return NextResponse.json({ ok: false, error: `write failed for ${path.basename(file)}: ${err.message}` }, { status: 500 });
    }
  }

  return NextResponse.json({
    ok: true,
    cleared,
    filesTouched,
    filter: sessionKeyFilter ? { sessionKey: sessionKeyFilter } : roleFilter ? { role: roleFilter } : { all: true },
  });
}
