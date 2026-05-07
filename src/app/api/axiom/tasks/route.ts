import fs from 'fs';
import path from 'path';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const AXIOM_MAILBOX_DIR = process.env.WATCH_AXIOM_MAILBOX_DIR || '/var/lib/watcher/axiom-mailbox';
const AXIOM_ARCHIVE_DIR = process.env.WATCH_AXIOM_TASKS_ARCHIVE_DIR || '/var/lib/watcher/axiom-mailbox-archive';
const RETENTION_DAYS = Number(process.env.WATCH_AXIOM_TASKS_RETENTION_DAYS || 1);
const ARCHIVE_DAYS = Number(process.env.WATCH_AXIOM_TASKS_ARCHIVE_DAYS || 7);

type MailboxEntry = {
  ts: string;
  sessionKey: string;
  agentId?: string;
  groupId?: string;
  message: string;
  reply?: string;
};

function isJsonl(name: string) {
  return name.endsWith('.jsonl') && !name.startsWith('.');
}

function listFilesIn(dir: string): string[] {
  try {
    return fs.readdirSync(dir).filter(isJsonl).map((name) => path.join(dir, name));
  } catch {
    return [];
  }
}

function readJsonl(filePath: string): MailboxEntry[] {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return raw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line) as MailboxEntry; } catch { return null; }
      })
      .filter((v): v is MailboxEntry => v !== null);
  } catch {
    return [];
  }
}

function writeJsonl(filePath: string, entries: MailboxEntry[]) {
  const next = entries.length ? entries.map((e) => JSON.stringify(e)).join('\n') + '\n' : '';
  fs.writeFileSync(filePath, next);
}

function appendJsonl(filePath: string, entries: MailboxEntry[]) {
  if (!entries.length) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const text = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
  fs.appendFileSync(filePath, text);
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

function archivePathFor(liveFile: string): string {
  return path.join(AXIOM_ARCHIVE_DIR, path.basename(liveFile));
}

// Two-tier sweep:
//   1. Move entries older than RETENTION_DAYS from live → archive (still traceable).
//   2. Hard-delete archived entries older than ARCHIVE_DAYS.
function sweepRetention(): { archived: number; deleted: number } {
  const now = Date.now();
  let archived = 0;
  let deleted = 0;

  if (RETENTION_DAYS > 0) {
    const liveCutoff = now - RETENTION_DAYS * 24 * 60 * 60 * 1000;
    for (const file of listFilesIn(AXIOM_MAILBOX_DIR)) {
      const entries = readJsonl(file);
      if (!entries.length) continue;
      const keepLive: MailboxEntry[] = [];
      const toArchive: MailboxEntry[] = [];
      for (const e of entries) {
        const ts = Date.parse(e.ts || '');
        if (Number.isFinite(ts) && ts < liveCutoff) toArchive.push(e);
        else keepLive.push(e);
      }
      if (toArchive.length === 0) continue;
      try {
        appendJsonl(archivePathFor(file), toArchive);
        writeJsonl(file, keepLive);
        archived += toArchive.length;
      } catch {
        // best-effort
      }
    }
  }

  if (ARCHIVE_DAYS > 0) {
    const archiveCutoff = now - ARCHIVE_DAYS * 24 * 60 * 60 * 1000;
    for (const file of listFilesIn(AXIOM_ARCHIVE_DIR)) {
      const entries = readJsonl(file);
      if (!entries.length) {
        try { fs.unlinkSync(file); } catch {}
        continue;
      }
      const kept = entries.filter((e) => {
        const ts = Date.parse(e.ts || '');
        return Number.isFinite(ts) ? ts >= archiveCutoff : true;
      });
      if (kept.length === entries.length) continue;
      deleted += entries.length - kept.length;
      try {
        if (kept.length === 0) fs.unlinkSync(file);
        else writeJsonl(file, kept);
      } catch {
        // best-effort
      }
    }
  }

  return { archived, deleted };
}

export async function GET(request: Request) {
  const sweep = sweepRetention();
  const url = new URL(request.url);
  const include = (url.searchParams.get('include') || 'live').trim().toLowerCase();
  const showArchived = include === 'archived' || include === 'all';
  const showLive = include !== 'archived';

  const out: Array<MailboxEntry & ReturnType<typeof topicMeta> & { archived: boolean }> = [];

  if (showLive) {
    for (const file of listFilesIn(AXIOM_MAILBOX_DIR)) {
      for (const entry of readJsonl(file)) {
        out.push({ ...entry, ...topicMeta(entry.sessionKey), archived: false });
      }
    }
  }
  if (showArchived) {
    for (const file of listFilesIn(AXIOM_ARCHIVE_DIR)) {
      for (const entry of readJsonl(file)) {
        out.push({ ...entry, ...topicMeta(entry.sessionKey), archived: true });
      }
    }
  }

  out.sort((a, b) => (b.ts > a.ts ? 1 : b.ts < a.ts ? -1 : 0));

  // Cheap header counts for UI.
  let liveCount = 0;
  let archivedCount = 0;
  for (const file of listFilesIn(AXIOM_MAILBOX_DIR)) liveCount += readJsonl(file).length;
  for (const file of listFilesIn(AXIOM_ARCHIVE_DIR)) archivedCount += readJsonl(file).length;

  return NextResponse.json({
    ok: true,
    generatedAt: new Date().toISOString(),
    mailboxDir: AXIOM_MAILBOX_DIR,
    archiveDir: AXIOM_ARCHIVE_DIR,
    retentionDays: RETENTION_DAYS,
    archiveDays: ARCHIVE_DAYS,
    sweep,
    counts: { live: liveCount, archived: archivedCount, total: liveCount + archivedCount },
    total: out.length,
    entries: out,
  });
}

// DELETE /api/axiom/tasks                       → ARCHIVE all live entries (default; "clear")
// DELETE /api/axiom/tasks?role=ceo              → ARCHIVE entries matching role
// DELETE /api/axiom/tasks?sessionKey=<key>      → ARCHIVE one session's live entries
// DELETE /api/axiom/tasks?scope=archive         → HARD-DELETE archived entries (with optional role/sessionKey)
//
// "Clear" semantically still means "remove from the live tasks view" — but
// entries get archived (not destroyed) so they remain traceable for the
// archive retention window. Use ?scope=archive to actually purge the archive.
export async function DELETE(request: Request) {
  const url = new URL(request.url);
  const roleFilter = (url.searchParams.get('role') || '').trim().toLowerCase();
  const sessionKeyFilter = (url.searchParams.get('sessionKey') || '').trim();
  const scope = (url.searchParams.get('scope') || 'live').trim().toLowerCase(); // 'live' | 'archive'

  function matches(e: MailboxEntry): boolean {
    if (sessionKeyFilter) return e.sessionKey === sessionKeyFilter;
    if (roleFilter && ['ceo', 'manager', 'coder', 'unknown'].includes(roleFilter)) {
      return topicMeta(e.sessionKey).role === roleFilter;
    }
    return true; // unscoped → applies to everything
  }

  const sourceDir = scope === 'archive' ? AXIOM_ARCHIVE_DIR : AXIOM_MAILBOX_DIR;
  let archived = 0;
  let deleted = 0;
  let filesTouched = 0;

  for (const file of listFilesIn(sourceDir)) {
    const entries = readJsonl(file);
    if (!entries.length) continue;
    const removed = entries.filter(matches);
    const kept = entries.filter((e) => !matches(e));
    if (removed.length === 0) continue;
    filesTouched++;
    try {
      if (scope === 'archive') {
        // Hard delete: just rewrite without the matched entries.
        if (kept.length === 0) fs.unlinkSync(file);
        else writeJsonl(file, kept);
        deleted += removed.length;
      } else {
        // "Clear" from live → move to archive instead of dropping.
        appendJsonl(archivePathFor(file), removed);
        writeJsonl(file, kept);
        archived += removed.length;
      }
    } catch (err: any) {
      return NextResponse.json({ ok: false, error: `write failed for ${path.basename(file)}: ${err.message}` }, { status: 500 });
    }
  }

  return NextResponse.json({
    ok: true,
    scope,
    archived,
    deleted,
    filesTouched,
    filter: sessionKeyFilter ? { sessionKey: sessionKeyFilter } : roleFilter ? { role: roleFilter } : { all: true },
  });
}
