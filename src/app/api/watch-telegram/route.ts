import { NextResponse } from 'next/server';
import { readWatchTelegramState, syncWatchTelegramMessage } from '@/lib/watch-telegram';

export const dynamic = 'force-dynamic';

async function runSync(forceNewMessage = false) {
  try {
    const result = await syncWatchTelegramMessage({ forceNewMessage });
    const state = await readWatchTelegramState();
    return NextResponse.json({ ...result, state });
  } catch (error: any) {
    return NextResponse.json(
      {
        ok: false,
        error: String(error?.message || error || 'Telegram sync failed'),
      },
      { status: 500 },
    );
  }
}

export async function GET() {
  return runSync(false);
}

export async function POST() {
  return runSync(false);
}
