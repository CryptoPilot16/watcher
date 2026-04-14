import { NextResponse } from 'next/server';
import { clearStaleFaults } from '@/lib/watch-data';

export const dynamic = 'force-dynamic';

export async function POST() {
  const state = clearStaleFaults();
  return NextResponse.json({ ok: true, state });
}
