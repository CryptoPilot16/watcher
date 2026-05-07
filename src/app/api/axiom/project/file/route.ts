import fs from 'fs';
import path from 'path';
import { NextResponse } from 'next/server';
import { isAdminAuthed } from '@/lib/admin-auth';
import { getWatchApiKey } from '@/lib/auth';

export const dynamic = 'force-dynamic';

const PROJECT_DIR = process.env.WATCH_AXIOM_PROJECT_DIR || '/opt/axiom';
const MAX_TEXT_BYTES = 256 * 1024; // 256KB cap for inline display

const BINARY_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.tiff',
  '.pdf', '.zip', '.tar', '.gz', '.tgz', '.bz2', '.xz', '.7z',
  '.mp3', '.mp4', '.webm', '.mov', '.wav', '.flac', '.ogg',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.so', '.dll', '.exe', '.bin', '.dylib', '.a', '.o',
  '.wasm', '.node',
]);

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

  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: `not found: ${err.message}` }, { status: 404 });
  }
  if (stat.isDirectory()) {
    return NextResponse.json({ ok: false, error: 'path is a directory' }, { status: 400 });
  }

  const ext = path.extname(abs).toLowerCase();
  const isBinary = BINARY_EXTS.has(ext);
  const truncated = stat.size > MAX_TEXT_BYTES;

  if (isBinary) {
    return NextResponse.json({
      ok: true,
      path: relPath,
      size: stat.size,
      mtime: stat.mtime.toISOString(),
      kind: 'binary',
      preview: `(binary file — ${ext || 'unknown ext'} — ${stat.size} bytes)`,
      truncated: false,
    });
  }

  let buf: Buffer;
  try {
    buf = await fs.promises.readFile(abs);
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: `read failed: ${err.message}` }, { status: 500 });
  }
  const sliced = truncated ? buf.subarray(0, MAX_TEXT_BYTES) : buf;
  // Detect non-UTF8 / mostly-binary heuristically (high ratio of nul or non-printable bytes).
  let nul = 0;
  for (let i = 0; i < Math.min(sliced.length, 4096); i++) if (sliced[i] === 0) nul++;
  if (nul > 4) {
    return NextResponse.json({
      ok: true,
      path: relPath,
      size: stat.size,
      mtime: stat.mtime.toISOString(),
      kind: 'binary',
      preview: `(file appears to be binary — ${stat.size} bytes)`,
      truncated: false,
    });
  }
  const content = sliced.toString('utf8');
  return NextResponse.json({
    ok: true,
    path: relPath,
    size: stat.size,
    mtime: stat.mtime.toISOString(),
    kind: 'text',
    content,
    truncated,
    maxBytes: MAX_TEXT_BYTES,
  });
}
