import { NextResponse } from 'next/server';
import { clearRunFaults } from '@/lib/watch-data';

export const dynamic = 'force-dynamic';

export async function POST() {
  const state = clearRunFaults();
  return NextResponse.json({ ok: true, state });
}
