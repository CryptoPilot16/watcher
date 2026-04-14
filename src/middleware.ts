import { NextRequest, NextResponse } from 'next/server';
import { isAuthed } from '@/lib/auth';

const PUBLIC_FILE = /\.(.*)$/;

function getRedirectUrl(request: NextRequest, pathname: string, search = '') {
  const url = request.nextUrl.clone();
  const proto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
  const hostHeader =
    request.headers.get('x-forwarded-host')?.split(',')[0]?.trim() ||
    request.headers.get('host')?.split(',')[0]?.trim();

  if (proto) url.protocol = `${proto}:`;

  if (hostHeader) {
    const [hostname, port] = hostHeader.split(':');
    url.hostname = hostname;
    url.port = port || '';
  }

  if (!hostHeader && proto === 'https') {
    url.port = '';
  }

  url.pathname = pathname;
  url.search = search;
  return url;
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (
    pathname === '/login' ||
    pathname.startsWith('/api/auth/login') ||
    pathname.startsWith('/_next/') ||
    PUBLIC_FILE.test(pathname)
  ) {
    return NextResponse.next();
  }

  if (pathname === '/') {
    return NextResponse.redirect(getRedirectUrl(request, '/watch'));
  }

  if (isAuthed(request)) {
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
