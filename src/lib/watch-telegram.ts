import { promises as fs } from 'fs';
import path from 'path';
import { getWatchSnapshot, type WatchSnapshot } from '@/lib/watch-data';
import {
  getLatestSnapmoltActivity,
  getLatestSnapmoltError,
  getPrimarySnapmoltText,
  getRecentSnapmoltActivity,
} from '@/lib/snapmolt-mirror';

type TelegramState = {
  chatId?: string;
  draftId?: number;
  messageId?: number;
  mode?: 'draft' | 'message';
  lastText?: string;
  updatedAt?: string;
};

type TelegramResponse<T> = {
  ok: boolean;
  result?: T;
  description?: string;
};

type TelegramMessage = {
  message_id: number;
  chat?: {
    id: number | string;
  };
};

type TelegramUpdate = {
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  channel_post?: TelegramMessage;
  callback_query?: {
    message?: TelegramMessage;
  };
};

const STATE_FILE = path.join(process.cwd(), '.state', 'watch-telegram-state.json');
const MAX_MESSAGE_LENGTH = 4096;
const DEFAULT_DRAFT_ID = 1;

function getBotToken() {
  return process.env.WATCH_TELEGRAM_BOT_TOKEN || '';
}

function getChatIdFromEnv() {
  return process.env.WATCH_TELEGRAM_CHAT_ID || '';
}

async function readState(): Promise<TelegramState> {
  try {
    return JSON.parse(await fs.readFile(STATE_FILE, 'utf8')) as TelegramState;
  } catch {
    return {};
  }
}

async function writeState(state: TelegramState) {
  await fs.writeFile(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

async function telegram<T>(method: string, body?: Record<string, unknown>) {
  const token = getBotToken();
  if (!token) {
    throw new Error('Missing WATCH_TELEGRAM_BOT_TOKEN');
  }

  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });

  const json = (await res.json()) as TelegramResponse<T>;
  if (!res.ok || !json.ok) {
    throw new Error(json.description || `Telegram ${method} failed`);
  }

  return json.result as T;
}

function asChatId(value: unknown) {
  if (value === null || value === undefined || value === '') return '';
  return String(value);
}

async function resolveChatId(state: TelegramState) {
  if (getChatIdFromEnv()) return getChatIdFromEnv();
  if (state.chatId) return state.chatId;

  const updates = await telegram<TelegramUpdate[]>('getUpdates');
  const latest = [...updates]
    .reverse()
    .find((update) => {
      return (
        update.message?.chat?.id ||
        update.edited_message?.chat?.id ||
        update.channel_post?.chat?.id ||
        update.callback_query?.message?.chat?.id
      );
    });

  const chatId = asChatId(
    latest?.message?.chat?.id ||
      latest?.edited_message?.chat?.id ||
      latest?.channel_post?.chat?.id ||
      latest?.callback_query?.message?.chat?.id,
  );

  if (!chatId) {
    throw new Error('No Telegram chat found. Send the bot a message once, then retry.');
  }

  return chatId;
}

function block(title: string, body: string) {
  return `${title}\n${'='.repeat(title.length)}\n${body.trim() || '(empty)'}`;
}

function getPrimaryTask(snapshot: WatchSnapshot) {
  return getPrimarySnapmoltText(snapshot.sections.snapmoltOut, snapshot.sections.snapmoltErr);
}

function formatTeleprompterText(snapshot: WatchSnapshot) {
  const currentTask = getPrimaryTask(snapshot);
  const latestActivity = getLatestSnapmoltActivity(snapshot.sections.snapmoltOut);
  const latestError = getLatestSnapmoltError(snapshot.sections.snapmoltErr);
  const recentActivity = getRecentSnapmoltActivity(snapshot.sections.snapmoltOut, 3);

  const lines = [
    'SNAPMOLT TELEPROMPTER',
    `updated: ${snapshot.now}`,
    '',
    'current task',
    '------------',
    currentTask,
    '',
    'latest activity',
    '---------------',
    latestActivity,
  ];

  if (latestError) {
    lines.push('', 'latest error', '------------', latestError);
  }

  if (recentActivity.length > 0) {
    lines.push('', 'recent activity', '---------------', ...recentActivity.map((line) => `- ${line}`));
  }

  const text = lines.join('\n');
  return text.length > MAX_MESSAGE_LENGTH ? `${text.slice(0, MAX_MESSAGE_LENGTH - 4)}...` : text;
}

export function formatWatchTelegramText(snapshot: WatchSnapshot) {
  const text = [
    'CLAWNUX WATCH',
    `status: ${snapshot.status}`,
    `updated: ${snapshot.now}`,
    `summary: ${snapshot.summary}`,
    '',
    block('pm2', snapshot.sections.pm2 || ''),
    '',
    block('updateResult', snapshot.sections.updateResult || ''),
    '',
    block('snapmoltOut', snapshot.sections.snapmoltOut || ''),
    '',
    block('snapmoltErr', snapshot.sections.snapmoltErr || ''),
  ].join('\n');

  return text.length > MAX_MESSAGE_LENGTH ? `${text.slice(0, MAX_MESSAGE_LENGTH - 4)}...` : text;
}

export async function syncWatchTelegramMessage(options?: { forceNewMessage?: boolean }) {
  const snapshot = getWatchSnapshot();
  const text = formatTeleprompterText(snapshot);
  const state = options?.forceNewMessage ? {} : await readState();
  const chatId = await resolveChatId(state);
  const draftId =
    options?.forceNewMessage
      ? (state.draftId || DEFAULT_DRAFT_ID) + 1
      : state.draftId || DEFAULT_DRAFT_ID;

  if (!options?.forceNewMessage && state.lastText === text) {
    return {
      ok: true,
      action: 'unchanged',
      chatId,
      draftId,
      messageId: state.messageId,
      snapshot,
    };
  }

  const nextState: TelegramState = {
    ...state,
    chatId,
    draftId,
    lastText: text,
    mode: 'draft',
    updatedAt: snapshot.now,
  };

  try {
    await telegram('sendMessageDraft', {
      chat_id: Number(chatId),
      draft_id: draftId,
      text,
    });

    delete nextState.messageId;
    await writeState(nextState);

    return {
      ok: true,
      action: options?.forceNewMessage ? 'redrafted' : 'drafted',
      chatId,
      draftId,
      snapshot,
    };
  } catch (error: any) {
    const message = String(error?.message || '');
    const draftUnsupported =
      message.includes('private chat') ||
      message.includes('chat not found') ||
      message.includes('method not found') ||
      message.includes('Bad Request');

    if (!draftUnsupported) {
      throw error;
    }
  }

  if (!options?.forceNewMessage && state.messageId) {
    try {
      await telegram('editMessageText', {
        chat_id: chatId,
        message_id: state.messageId,
        text,
        disable_web_page_preview: true,
      });

      nextState.messageId = state.messageId;
      nextState.mode = 'message';
      await writeState(nextState);

      return {
        ok: true,
        action: 'edited',
        chatId,
        messageId: state.messageId,
        snapshot,
      };
    } catch (error: any) {
      const message = String(error?.message || '');
      const retryable =
        message.includes('message to edit not found') ||
        message.includes('message can\'t be edited') ||
        message.includes('message identifier is not specified');

      if (!retryable) {
        throw error;
      }
    }
  }

  const created = await telegram<TelegramMessage>('sendMessage', {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
    disable_notification: true,
  });

  nextState.messageId = created.message_id;
  nextState.mode = 'message';
  await writeState(nextState);

  return {
    ok: true,
    action: options?.forceNewMessage ? 'reset' : 'created',
    chatId,
    messageId: created.message_id,
    snapshot,
  };
}

export async function readWatchTelegramState() {
  return readState();
}
