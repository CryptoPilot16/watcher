import { NextRequest, NextResponse } from 'next/server';
import { isAuthed } from '@/lib/auth';

const PUBLIC_FILE = /\.(.*)$/;

function getRequestOrigin(request: NextRequest) {
  const proto = request.headers.get('x-forwarded-proto') || request.nextUrl.protocol.replace(':', '');
  const host =
    request.headers.get('x-forwarded-host') ||
    request.headers.get('host') ||
    request.nextUrl.host;

  return `${proto}://${host}`;
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
    return NextResponse.redirect(new URL('/watch', getRequestOrigin(request)));
  }

  if (isAuthed(request)) {
    return NextResponse.next();
  }

  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const loginUrl = new URL('/login', getRequestOrigin(request));
  loginUrl.searchParams.set('redirect', pathname);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image).*)'],
};
