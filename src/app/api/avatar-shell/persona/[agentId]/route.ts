import { NextRequest, NextResponse } from 'next/server';
import { isAuthed } from '@/lib/auth';

export const dynamic = 'force-dynamic';

const AVATAR_API_URL = process.env.WATCH_AVATAR_SHELL_API_URL || 'http://127.0.0.1:3014';
const AVATAR_PUBLIC_URL = process.env.WATCH_AVATAR_SHELL_PUBLIC_URL || 'https://agent.clawnux.com';
const AVATAR_USERNAME = process.env.WATCH_AVATAR_SHELL_USERNAME || '';
const AVATAR_PASSWORD = process.env.WATCH_AVATAR_SHELL_PASSWORD || '';
const FACE_ASSET_VERSION = '20260518c';

function joinUrl(base: string, path: string) {
  return `${base.replace(/\/$/, '')}${path}`;
}

function faceAsset(path: string) {
  return joinUrl(AVATAR_PUBLIC_URL, `${path}?v=${FACE_ASSET_VERSION}`);
}

const TAVUS_FACE_PREVIEWS: Record<string, string> = {
  rcc28da86847: faceAsset('/agent-faces/hermes.jpg'),
  rf4e9d9790f0: faceAsset('/agent-faces/snapmolt.jpg'),
};

const SIMLI_FACE_PREVIEWS: Record<string, string> = {
  '5fc23ea5-8175-4a82-aaaf-cdd8c88543dc': faceAsset('/agent-faces/simli-snapmolt.jpg'),
  '6926a39d-638b-49c5-9328-79efa034e9a4': faceAsset('/agent-faces/housekeeping.jpg'),
  f0ba4efe794645de9955c04a04c367b9: faceAsset('/agent-faces/simli-hermes.jpg'),
  'f0ba4efe-7946-45de-9955-c04a04c367b9': faceAsset('/agent-faces/simli-hermes.jpg'),
};

function previewForFace(face: any) {
  const provider = String(face?.provider || '').trim().toLowerCase();
  const faceId = String(face?.face_id || '').trim();
  const replicaId = String(face?.tavus_replica_id || '').trim();

  if (provider === 'tavus' && replicaId && TAVUS_FACE_PREVIEWS[replicaId]) {
    return { preview_url: TAVUS_FACE_PREVIEWS[replicaId], video_source: 'Tavus' };
  }
  if (provider === 'simli' && faceId && SIMLI_FACE_PREVIEWS[faceId]) {
    return { preview_url: SIMLI_FACE_PREVIEWS[faceId], video_source: 'Simli' };
  }
  if (replicaId && TAVUS_FACE_PREVIEWS[replicaId]) {
    return { preview_url: TAVUS_FACE_PREVIEWS[replicaId], video_source: 'Tavus' };
  }
  if (faceId && SIMLI_FACE_PREVIEWS[faceId]) {
    return { preview_url: SIMLI_FACE_PREVIEWS[faceId], video_source: 'Simli' };
  }
  return { preview_url: null, video_source: provider || null };
}

async function avatarLoginCookie() {
  if (!AVATAR_USERNAME || !AVATAR_PASSWORD) {
    throw new Error('WATCH_AVATAR_SHELL_USERNAME/PASSWORD not configured');
  }
  const res = await fetch(joinUrl(AVATAR_API_URL, '/auth/login'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: AVATAR_USERNAME, password: AVATAR_PASSWORD }),
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`avatar login failed: ${res.status}`);
  const cookie = res.headers.get('set-cookie')?.split(';')[0];
  if (!cookie) throw new Error('avatar login returned no session cookie');
  return cookie;
}

export async function GET(
  request: NextRequest,
  { params }: { params: { agentId: string } },
) {
  if (!(await isAuthed(request))) {
    return NextResponse.json({ ok: false, error: 'auth required' }, { status: 401 });
  }

  const agentId = String(params.agentId || '').trim();
  if (!agentId) {
    return NextResponse.json({ ok: false, error: 'agentId required' }, { status: 400 });
  }

  try {
    const cookie = await avatarLoginCookie();
    const res = await fetch(joinUrl(AVATAR_API_URL, `/api/personas/${encodeURIComponent(agentId)}`), {
      headers: { Cookie: cookie },
      cache: 'no-store',
    });
    const data = await res.json().catch(async () => ({ detail: await res.text().catch(() => '') }));
    if (res.status === 404) {
      return NextResponse.json({ ok: true, configured: false, reason: 'no live persona' });
    }
    if (!res.ok) {
      return NextResponse.json({ ok: false, error: data?.detail || data?.error || `persona lookup failed: ${res.status}` }, { status: res.status });
    }

    const face = data?.payload?.face || {};
    const configured = Boolean(String(face?.face_id || face?.tavus_replica_id || '').trim());
    const preview = previewForFace(face);
    return NextResponse.json({
      ok: true,
      configured,
      provider: face?.provider || null,
      ...preview,
      display_name: data?.summary?.display_name || agentId,
    });
  } catch (error: any) {
    return NextResponse.json({ ok: false, error: String(error?.message || error || 'persona lookup failed') }, { status: 500 });
  }
}
