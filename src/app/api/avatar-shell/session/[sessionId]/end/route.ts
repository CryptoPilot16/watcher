import { NextRequest, NextResponse } from 'next/server';
import { isAuthed } from '@/lib/auth';

export const dynamic = 'force-dynamic';

const AVATAR_API_URL = process.env.WATCH_AVATAR_SHELL_API_URL || 'http://127.0.0.1:3014';
const AVATAR_USERNAME = process.env.WATCH_AVATAR_SHELL_USERNAME || '';
const AVATAR_PASSWORD = process.env.WATCH_AVATAR_SHELL_PASSWORD || '';

function joinUrl(base: string, path: string) {
  return `${base.replace(/\/$/, '')}${path}`;
}

async function avatarLoginCookie() {
  if (!AVATAR_USERNAME || !AVATAR_PASSWORD) {
    throw new Error('WATCH_AVATAR_SHELL_USERNAME/PASSWORD not configured');
  }
  const res = await fetch(joinUrl(AVATAR_API_URL, '/auth/login'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: AVATAR_USERNAME, password: AVATAR_PASSWORD }),
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`avatar login failed: ${res.status}`);
  const cookie = res.headers.get('set-cookie')?.split(';')[0];
  if (!cookie) throw new Error('avatar login returned no session cookie');
  return cookie;
}

export async function POST(
  request: NextRequest,
  { params }: { params: { sessionId: string } },
) {
  if (!(await isAuthed(request))) {
    return NextResponse.json({ ok: false, error: 'auth required' }, { status: 401 });
  }

  try {
    const cookie = await avatarLoginCookie();
    const res = await fetch(joinUrl(AVATAR_API_URL, `/api/sessions/${encodeURIComponent(params.sessionId)}/end`), {
      method: 'POST',
      headers: { Cookie: cookie },
      cache: 'no-store',
    });
    const data = await res.json().catch(async () => ({ detail: await res.text().catch(() => '') }));
    if (!res.ok) {
      return NextResponse.json({ ok: false, error: data?.detail || data?.error || `avatar end failed: ${res.status}` }, { status: res.status });
    }
    return NextResponse.json({ ok: true, ...data });
  } catch (error: any) {
    return NextResponse.json({ ok: false, error: String(error?.message || error || 'avatar end failed') }, { status: 500 });
  }
}
