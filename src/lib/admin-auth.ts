import type { NextRequest } from 'next/server';

export const ADMIN_COOKIE_NAME = 'admin_access';
export const ADMIN_SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

type SessionPayload = {
  v: 1;
  iat: number;
  exp: number;
  nonce: string;
};

const encoder = new TextEncoder();
let cachedSessionKeyPromise: Promise<CryptoKey | null> | null = null;

export function getAdminLoginSecret() {
  // Fail closed: no fallback password. WATCH_AXIOM_PASSWORD must be set in env
  // (or .env.local) for the AXIOM admin zone to accept any login. If unset,
  // the login route returns 500 ("Admin password is not configured") and the
  // zone is fully locked.
  return process.env.WATCH_AXIOM_PASSWORD || '';
}

export function getAdminSessionSecret() {
  return process.env.WATCH_AXIOM_SESSION_SECRET || getAdminLoginSecret();
}

function constantTimeEqual(left: string, right: string) {
  const max = Math.max(left.length, right.length);
  let mismatch = left.length === right.length ? 0 : 1;
  for (let i = 0; i < max; i++) {
    const l = i < left.length ? left.charCodeAt(i) : 0;
    const r = i < right.length ? right.charCodeAt(i) : 0;
    mismatch |= l ^ r;
  }
  return mismatch === 0;
}

function bytesToBase64Url(bytes: Uint8Array) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlToBytes(value: string) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padding = '='.repeat((4 - (normalized.length % 4 || 4)) % 4);
  const binary = atob(`${normalized}${padding}`);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

async function getSessionKey() {
  const secret = getAdminSessionSecret();
  if (!secret) return null;
  if (!cachedSessionKeyPromise) {
    cachedSessionKeyPromise = crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    ) as Promise<CryptoKey | null>;
  }
  return cachedSessionKeyPromise;
}

async function signSessionPayload(encodedPayload: string) {
  const key = await getSessionKey();
  if (!key) return null;
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(encodedPayload));
  return bytesToBase64Url(new Uint8Array(sig));
}

export async function createAdminSessionToken() {
  const now = Math.floor(Date.now() / 1000);
  const nonceBytes = new Uint8Array(16);
  crypto.getRandomValues(nonceBytes);
  const payload: SessionPayload = {
    v: 1,
    iat: now,
    exp: now + ADMIN_SESSION_MAX_AGE_SECONDS,
    nonce: bytesToBase64Url(nonceBytes),
  };
  const encodedPayload = bytesToBase64Url(encoder.encode(JSON.stringify(payload)));
  const signature = await signSessionPayload(encodedPayload);
  return `${encodedPayload}.${signature}`;
}

export async function verifyAdminSessionToken(token: string | undefined | null) {
  if (!token) return false;
  const [encodedPayload, signature] = token.split('.');
  if (!encodedPayload || !signature) return false;
  const expected = await signSessionPayload(encodedPayload);
  if (!expected || !constantTimeEqual(signature, expected)) return false;
  try {
    const payload = JSON.parse(new TextDecoder().decode(base64UrlToBytes(encodedPayload))) as SessionPayload;
    if (payload?.v !== 1) return false;
    if (typeof payload.exp !== 'number') return false;
    return payload.exp > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

export function matchesAdminLoginSecret(value: string) {
  const secret = getAdminLoginSecret();
  if (!secret) return false;
  return constantTimeEqual(value, secret);
}

export async function isAdminAuthed(request: NextRequest | Request) {
  let cookieValue: string | undefined;
  if ('cookies' in request && typeof (request as NextRequest).cookies?.get === 'function') {
    cookieValue = (request as NextRequest).cookies.get(ADMIN_COOKIE_NAME)?.value;
  } else {
    const cookieHeader = request.headers.get('cookie') || '';
    const match = cookieHeader.match(new RegExp(`(?:^|; )${ADMIN_COOKIE_NAME}=([^;]+)`));
    cookieValue = match?.[1];
  }
  return verifyAdminSessionToken(cookieValue);
}

export function getClientIp(request: NextRequest) {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0]?.trim() || 'unknown';
  return request.headers.get('x-real-ip') || 'unknown';
}
