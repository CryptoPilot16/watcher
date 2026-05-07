import fs from 'fs';
import path from 'path';
import { NextResponse } from 'next/server';
import { isAdminAuthed } from '@/lib/admin-auth';
import { getWatchApiKey } from '@/lib/auth';

export const dynamic = 'force-dynamic';

const PROJECT_DIR = process.env.WATCH_AXIOM_PROJECT_DIR || '/opt/axiom';
const MAX_RAW_BYTES = 25 * 1024 * 1024;

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
};

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
  if (stat.size > MAX_RAW_BYTES) {
    return NextResponse.json({ ok: false, error: `file too large (${stat.size} bytes, cap ${MAX_RAW_BYTES})` }, { status: 413 });
  }
  const ext = path.extname(abs).toLowerCase();
  const mime = MIME_BY_EXT[ext];
  if (!mime) {
    return NextResponse.json({ ok: false, error: `unsupported extension: ${ext || '(none)'}` }, { status: 415 });
  }
  let buf: Buffer;
  try {
    buf = await fs.promises.readFile(abs);
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: `read failed: ${err.message}` }, { status: 500 });
  }
  // Match Buffer's underlying ArrayBuffer slice exactly so the response sends just this file.
  const body = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  return new NextResponse(body, {
    status: 200,
    headers: {
      'Content-Type': mime,
      'Content-Length': String(buf.byteLength),
      'Cache-Control': 'private, max-age=60',
      'Content-Security-Policy': "default-src 'none'; img-src 'self' data:; object-src 'self';",
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
