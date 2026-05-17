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

export async function GET(
  request: NextRequest,
  { params }: { params: { agentId: string } },
) {
  if (!(await isAuthed(request))) {
    return NextResponse.json({ ok: false, error: 'auth required' }, { status: 401 });
  }

  const agentId = String(params.agentId || '').trim();
  if (!agentId) {
    return NextResponse.json({ ok: false, error: 'agentId required' }, { status: 400 });
  }

  try {
    const cookie = await avatarLoginCookie();
    const res = await fetch(joinUrl(AVATAR_API_URL, `/api/personas/${encodeURIComponent(agentId)}`), {
      headers: { Cookie: cookie },
      cache: 'no-store',
    });
    const data = await res.json().catch(async () => ({ detail: await res.text().catch(() => '') }));
    if (res.status === 404) {
      return NextResponse.json({ ok: true, configured: false, reason: 'no live persona' });
    }
    if (!res.ok) {
      return NextResponse.json({ ok: false, error: data?.detail || data?.error || `persona lookup failed: ${res.status}` }, { status: res.status });
    }

    const face = data?.payload?.face || {};
    const configured = Boolean(String(face?.face_id || face?.tavus_replica_id || '').trim());
    return NextResponse.json({
      ok: true,
      configured,
      provider: face?.provider || null,
      display_name: data?.summary?.display_name || agentId,
    });
  } catch (error: any) {
    return NextResponse.json({ ok: false, error: String(error?.message || error || 'persona lookup failed') }, { status: 500 });
  }
}
