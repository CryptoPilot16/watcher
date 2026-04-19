import { NextRequest, NextResponse } from 'next/server';
import { isAuthed } from '@/lib/auth';

const PUBLIC_FILE = /\.(.*)$/;

function getRedirectUrl(request: NextRequest, pathname: string, search = '') {
  const url = request.nextUrl.clone();
  const proto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
  const forwardedHost = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim();
  const host = request.headers.get('host')?.split(',')[0]?.trim();
  const origin = request.headers.get('origin')?.trim();
  const referer = request.headers.get('referer')?.trim();
  const configuredBase = process.env.WATCH_URL?.trim();

  const internalHost = (value?: string | null) => {
    const lowered = String(value || '').toLowerCase();
    return !lowered || lowered.startsWith('127.0.0.1') || lowered.startsWith('localhost');
  };

  const originHost = (() => {
    try { return origin ? new URL(origin).host : null; } catch { return null; }
  })();
  const refererHost = (() => {
    try { return referer ? new URL(referer).host : null; } catch { return null; }
  })();
  const configuredUrl = (() => {
    try { return configuredBase ? new URL(configuredBase) : null; } catch { return null; }
  })();

  const hostHeader = [forwardedHost, host, originHost, refererHost]
    .find((value) => value && !internalHost(value))
    || (!internalHost(forwardedHost) ? forwardedHost : null)
    || (!internalHost(host) ? host : null)
    || (configuredUrl && !internalHost(configuredUrl.host) ? configuredUrl.host : null)
    || forwardedHost
    || host;

  if (proto) url.protocol = `${proto}:`;
  else if (configuredUrl?.protocol) url.protocol = configuredUrl.protocol;

  if (hostHeader) {
    const [hostname, port] = hostHeader.split(':');
    url.hostname = hostname;
    url.port = port || '';
  } else if (configuredUrl?.host) {
    url.hostname = configuredUrl.hostname;
    url.port = configuredUrl.port;
  }

  if (!hostHeader && (proto === 'https' || configuredUrl?.protocol === 'https:')) {
    url.port = '';
  }

  url.pathname = pathname;
  url.search = search;
  return url;
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (
    pathname === '/' ||
    pathname === '/login' ||
    pathname.startsWith('/office-preview') ||
    pathname.startsWith('/api/auth/login') ||
    pathname.startsWith('/_next/') ||
    PUBLIC_FILE.test(pathname)
  ) {
    return NextResponse.next();
  }

  if (await isAuthed(request)) {
    return NextResponse.next();
  }

  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const redirectPath = `${pathname}${request.nextUrl.search || ''}`;
  return NextResponse.redirect(
    getRedirectUrl(request, '/login', `?redirect=${encodeURIComponent(redirectPath)}`),
  );
}

export const config = {
  matcher: ['/((?!_next/static|_next/image).*)'],
};
