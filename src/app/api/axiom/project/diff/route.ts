import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { NextResponse } from 'next/server';
import { isAdminAuthed } from '@/lib/admin-auth';
import { getWatchApiKey } from '@/lib/auth';

export const dynamic = 'force-dynamic';

const PROJECT_DIR = process.env.WATCH_AXIOM_PROJECT_DIR || '/opt/axiom';
const SNAPSHOT_DIR = process.env.WATCH_AXIOM_PROJECT_SNAPSHOT_DIR || '/var/lib/watcher/axiom-project-snapshots';
const MAX_BYTES = 256 * 1024;

function authOk(request: Request) {
  const auth = request.headers.get('authorization') || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (bearer && bearer === getWatchApiKey()) return Promise.resolve(true);
  return isAdminAuthed(request as any);
}

function safeResolve(rel: string): string | null {
  if (!rel || rel.includes('\0')) return null;
  const abs = path.resolve(PROJECT_DIR, rel);
  const root = path.resolve(PROJECT_DIR) + path.sep;
  if (!abs.startsWith(root) && abs !== path.resolve(PROJECT_DIR)) return null;
  return abs;
}

function snapshotDirFor(rel: string) {
  const hash = crypto.createHash('sha1').update(rel).digest('hex');
  return path.join(SNAPSHOT_DIR, hash);
}

function readMaybe(file: string): string | null {
  try {
    const buf = fs.readFileSync(file);
    if (buf.length > MAX_BYTES) return buf.subarray(0, MAX_BYTES).toString('utf8');
    return buf.toString('utf8');
  } catch {
    return null;
  }
}

export async function GET(request: Request) {
  if (!(await authOk(request))) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }
  const url = new URL(request.url);
  const relPath = (url.searchParams.get('path') || '').trim();
  if (!relPath) {
    return NextResponse.json({ ok: false, error: 'missing ?path' }, { status: 400 });
  }
  const abs = safeResolve(relPath);
  if (!abs) {
    return NextResponse.json({ ok: false, error: 'invalid path' }, { status: 400 });
  }

  const dir = snapshotDirFor(relPath);
  const before = readMaybe(path.join(dir, 'before.txt'));
  // The "after" is always the live file when it exists. Fall back to the
  // captured state.txt only for deletes (where the live file is gone).
  let after: string | null = null;
  let afterSource: 'live' | 'snapshot' | 'none' = 'none';
  let liveSize: number | null = null;
  let liveMtime: string | null = null;
  try {
    const s = fs.statSync(abs);
    liveSize = s.size;
    liveMtime = s.mtime.toISOString();
    if (s.size <= MAX_BYTES) {
      after = fs.readFileSync(abs).toString('utf8');
      afterSource = 'live';
    }
  } catch {
    after = readMaybe(path.join(dir, 'state.txt'));
    afterSource = after === null ? 'none' : 'snapshot';
  }

  return NextResponse.json({
    ok: true,
    path: relPath,
    before,
    after,
    afterSource,
    hasBefore: before !== null,
    hasAfter: after !== null,
    liveSize,
    liveMtime,
    maxBytes: MAX_BYTES,
  });
}
