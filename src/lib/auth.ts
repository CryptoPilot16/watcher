import type { NextRequest } from 'next/server';

export const WATCH_COOKIE_NAME = 'watch_access';

export function getWatchSecret() {
  return process.env.WATCH_PASSWORD || process.env.WATCH_API_KEY || '';
}

export function getRequestHost(request: NextRequest) {
  return (
    request.headers.get('x-forwarded-host') ||
    request.headers.get('host') ||
    request.nextUrl.host ||
    ''
  )
    .split(',')[0]
    .trim()
    .replace(/:\d+$/, '')
    .toLowerCase();
}

export function isAuthed(request: NextRequest) {
  const secret = getWatchSecret();
  if (!secret) return false;

  const authHeader = request.headers.get('authorization');
  const cookieValue = request.cookies.get(WATCH_COOKIE_NAME)?.value;
  const queryValue = request.nextUrl.searchParams.get('api_key');

  return authHeader === `Bearer ${secret}` || cookieValue === secret || queryValue === secret;
}
