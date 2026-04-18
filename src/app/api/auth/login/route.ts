import { NextRequest, NextResponse } from 'next/server';
import {
  WATCH_COOKIE_NAME,
  WATCH_SESSION_MAX_AGE_SECONDS,
  createSessionToken,
  getClientIp,
  getLoginSecret,
  matchesLoginSecret,
} from '@/lib/auth';

export const dynamic = 'force-dynamic';

const WINDOW_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 8;
const BLOCK_MS = 15 * 60 * 1000;

type AttemptState = {
  attempts: number[];
  blockedUntil: number;
};

const loginAttempts = new Map<string, AttemptState>();

function getAttemptState(key: string) {
  const now = Date.now();
  const current = loginAttempts.get(key);
  if (!current) return { attempts: [], blockedUntil: 0 };

  const trimmed = current.attempts.filter((ts) => now - ts <= WINDOW_MS);
  const blockedUntil = current.blockedUntil > now ? current.blockedUntil : 0;
  const next = { attempts: trimmed, blockedUntil };
  loginAttempts.set(key, next);
  return next;
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const key = String(body?.key || '');
  const secret = getLoginSecret();
  const redirectTo =
    typeof body?.redirectTo === 'string' && body.redirectTo.startsWith('/')
      ? body.redirectTo
      : '/watch';

  if (!secret) {
    return NextResponse.json({ ok: false, error: 'Watch password is not configured' }, { status: 500 });
  }

  const ip = getClientIp(request);
  const attempt = getAttemptState(ip);
  if (attempt.blockedUntil > Date.now()) {
    return NextResponse.json(
      { ok: false, error: 'Too many attempts. Try again in a few minutes.' },
      { status: 429 },
    );
  }

  if (!matchesLoginSecret(key)) {
    attempt.attempts.push(Date.now());
    if (attempt.attempts.length >= MAX_ATTEMPTS) {
      attempt.blockedUntil = Date.now() + BLOCK_MS;
    }
    loginAttempts.set(ip, attempt);

    return NextResponse.json({ ok: false, error: 'Invalid password' }, { status: 401 });
  }

  loginAttempts.delete(ip);

  const proto = request.headers.get('x-forwarded-proto') || request.nextUrl.protocol.replace(':', '');
  const secure = proto === 'https';

  const response = NextResponse.json({ ok: true, redirectTo });
  response.cookies.set(WATCH_COOKIE_NAME, await createSessionToken(), {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    maxAge: WATCH_SESSION_MAX_AGE_SECONDS,
  });

  return response;
}
