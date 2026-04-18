import type { NextRequest } from 'next/server';

export const WATCH_COOKIE_NAME = 'watch_access';
export const WATCH_SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

type SessionPayload = {
  v: 1;
  iat: number;
  exp: number;
  nonce: string;
};

const encoder = new TextEncoder();
let cachedSessionKeyPromise: Promise<CryptoKey | null> | null = null;

export function getLoginSecret() {
  return process.env.WATCH_PASSWORD || process.env.WATCH_API_KEY || '';
}

export function getWatchSecret() {
  return getLoginSecret();
}

export function getWatchApiKey() {
  return process.env.WATCH_API_KEY || getLoginSecret();
}

export function getSessionSecret() {
  return process.env.WATCH_SESSION_SECRET || getLoginSecret();
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

export function getClientIp(request: NextRequest) {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    return forwarded.split(',')[0]?.trim() || 'unknown';
  }
  return request.headers.get('x-real-ip') || 'unknown';
}

function constantTimeEqual(left: string, right: string) {
  const max = Math.max(left.length, right.length);
  let mismatch = left.length === right.length ? 0 : 1;

  for (let index = 0; index < max; index += 1) {
    const leftCode = index < left.length ? left.charCodeAt(index) : 0;
    const rightCode = index < right.length ? right.charCodeAt(index) : 0;
    mismatch |= leftCode ^ rightCode;
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
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function getSessionKey() {
  const secret = getSessionSecret();
  if (!secret) return null;

  if (!cachedSessionKeyPromise) {
    cachedSessionKeyPromise = crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
  }

  return cachedSessionKeyPromise;
}

async function signSessionPayload(encodedPayload: string) {
  const key = await getSessionKey();
  if (!key) return '';
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(encodedPayload));
  return bytesToBase64Url(new Uint8Array(signature));
}

export async function createSessionToken() {
  const now = Math.floor(Date.now() / 1000);
  const nonceBytes = new Uint8Array(16);
  crypto.getRandomValues(nonceBytes);

  const payload: SessionPayload = {
    v: 1,
    iat: now,
    exp: now + WATCH_SESSION_MAX_AGE_SECONDS,
    nonce: bytesToBase64Url(nonceBytes),
  };

  const encodedPayload = bytesToBase64Url(encoder.encode(JSON.stringify(payload)));
  const signature = await signSessionPayload(encodedPayload);
  return `${encodedPayload}.${signature}`;
}

export async function verifySessionToken(token: string | undefined | null) {
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

export function matchesLoginSecret(value: string) {
  const secret = getLoginSecret();
  if (!secret) return false;
  return constantTimeEqual(value, secret);
}

export function matchesApiKey(value: string) {
  const apiKey = getWatchApiKey();
  if (!apiKey) return false;
  return constantTimeEqual(value, apiKey);
}

export async function isAuthed(request: NextRequest) {
  const authHeader = request.headers.get('authorization');
  const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : '';
  const cookieValue = request.cookies.get(WATCH_COOKIE_NAME)?.value;

  if (matchesApiKey(bearerToken)) return true;
  return verifySessionToken(cookieValue);
}
