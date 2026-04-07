import { NextResponse } from 'next/server';
import { readWatchTelegramState, syncWatchTelegramMessage } from '@/lib/watch-telegram';

export const dynamic = 'force-dynamic';

export async function POST() {
  try {
    const result = await syncWatchTelegramMessage({ forceNewMessage: true });
    const state = await readWatchTelegramState();
    return NextResponse.json({ ...result, state });
  } catch (error: any) {
    return NextResponse.json(
      {
        ok: false,
        error: String(error?.message || error || 'Telegram init failed'),
      },
      { status: 500 },
    );
  }
}
