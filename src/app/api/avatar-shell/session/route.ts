import { NextRequest, NextResponse } from 'next/server';
import { isAuthed } from '@/lib/auth';

export const dynamic = 'force-dynamic';

const AVATAR_API_URL = process.env.WATCH_AVATAR_SHELL_API_URL || 'http://127.0.0.1:3014';
const AVATAR_PUBLIC_URL = process.env.WATCH_AVATAR_SHELL_PUBLIC_URL || 'https://agent.clawnux.com';
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
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`avatar login failed: ${res.status}${detail ? ` ${detail}` : ''}`);
  }
  const cookie = res.headers.get('set-cookie')?.split(';')[0];
  if (!cookie) throw new Error('avatar login returned no session cookie');
  return cookie;
}

export async function POST(request: NextRequest) {
  if (!(await isAuthed(request))) {
    return NextResponse.json({ ok: false, error: 'auth required' }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const agentId = String(body?.agentId || '').trim();
  if (!agentId) {
    return NextResponse.json({ ok: false, error: 'agentId required' }, { status: 400 });
  }

  try {
    const cookie = await avatarLoginCookie();
    const res = await fetch(joinUrl(AVATAR_API_URL, '/api/sessions'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
      },
      body: JSON.stringify({
        agent_id: agentId,
        client: 'watcher',
        voice_profile: 'brief_status',
        exclusive: false,
      }),
      cache: 'no-store',
    });
    const data = await res.json().catch(async () => ({ detail: await res.text().catch(() => '') }));
    if (!res.ok) {
      return NextResponse.json({ ok: false, error: data?.detail || data?.error || `avatar session failed: ${res.status}` }, { status: res.status });
    }
    return NextResponse.json({
      ok: true,
      ...data,
      public_url: joinUrl(AVATAR_PUBLIC_URL, `/agent/${encodeURIComponent(agentId)}`),
      voice_profile: 'brief_status',
    });
  } catch (error: any) {
    return NextResponse.json({ ok: false, error: String(error?.message || error || 'avatar session failed') }, { status: 500 });
  }
}
