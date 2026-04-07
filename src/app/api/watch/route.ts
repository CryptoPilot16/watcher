import { NextResponse } from 'next/server';
import { getWatchSnapshot } from '@/lib/watch-data';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json(getWatchSnapshot());
}
