import { NextRequest, NextResponse } from 'next/server';
import { WATCH_COOKIE_NAME, getWatchSecret } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const key = String(body?.key || '');
  const secret = getWatchSecret();
  const redirectTo =
    typeof body?.redirectTo === 'string' && body.redirectTo.startsWith('/')
      ? body.redirectTo
      : '/watch';

  if (!secret) {
    return NextResponse.json({ ok: false, error: 'Watch password is not configured' }, { status: 500 });
  }

  if (key !== secret) {
    return NextResponse.json({ ok: false, error: 'Invalid password' }, { status: 401 });
  }

  const proto = request.headers.get('x-forwarded-proto') || request.nextUrl.protocol.replace(':', '');
  const secure = proto === 'https';

  const response = NextResponse.json({ ok: true, redirectTo });
  response.cookies.set(WATCH_COOKIE_NAME, secret, {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 30,
  });

  return response;
}
