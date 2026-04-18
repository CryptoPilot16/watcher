import { NextRequest, NextResponse } from 'next/server';
import { WATCH_COOKIE_NAME } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const proto = request.headers.get('x-forwarded-proto') || request.nextUrl.protocol.replace(':', '');
  const secure = proto === 'https';

  const response = NextResponse.json({ ok: true });
  response.cookies.set(WATCH_COOKIE_NAME, '', {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });

  return response;
}
