import { NextRequest, NextResponse } from 'next/server';
import {
  ADMIN_COOKIE_NAME,
  ADMIN_SESSION_MAX_AGE_SECONDS,
  createAdminSessionToken,
  getAdminLoginSecret,
  getClientIp,
  matchesAdminLoginSecret,
} from '@/lib/admin-auth';

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
  const cur = loginAttempts.get(key);
  if (!cur) return { attempts: [], blockedUntil: 0 };
  const trimmed = cur.attempts.filter((ts) => now - ts <= WINDOW_MS);
  const blockedUntil = cur.blockedUntil > now ? cur.blockedUntil : 0;
  const next = { attempts: trimmed, blockedUntil };
  loginAttempts.set(key, next);
  return next;
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const key = String(body?.key || '');
  const secret = getAdminLoginSecret();
  const redirectTo = typeof body?.redirectTo === 'string' && body.redirectTo.startsWith('/axiom')
    ? body.redirectTo
    : '/axiom';

  if (!secret) {
    return NextResponse.json({ ok: false, error: 'Admin password is not configured' }, { status: 500 });
  }

  const ip = getClientIp(request);
  const attempt = getAttemptState(ip);
  if (attempt.blockedUntil) {
    return NextResponse.json({ ok: false, error: 'too many attempts, try again later' }, { status: 429 });
  }

  if (!matchesAdminLoginSecret(key)) {
    attempt.attempts.push(Date.now());
    if (attempt.attempts.length >= MAX_ATTEMPTS) {
      attempt.blockedUntil = Date.now() + BLOCK_MS;
    }
    loginAttempts.set(ip, attempt);
    return NextResponse.json({ ok: false, error: 'wrong password' }, { status: 401 });
  }

  loginAttempts.delete(ip);
  const token = await createAdminSessionToken();
  if (!token) {
    return NextResponse.json({ ok: false, error: 'failed to mint session' }, { status: 500 });
  }

  const response = NextResponse.json({ ok: true, redirectTo });
  response.cookies.set(ADMIN_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: request.nextUrl.protocol === 'https:',
    path: '/',
    maxAge: ADMIN_SESSION_MAX_AGE_SECONDS,
  });
  return response;
}
