import fs from 'fs';
import path from 'path';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const AXIOM_MAILBOX_DIR = process.env.WATCH_AXIOM_MAILBOX_DIR || '/var/lib/watcher/axiom-mailbox';

type MailboxEntry = {
  ts: string;
  sessionKey: string;
  agentId?: string;
  groupId?: string;
  message: string;
  reply?: string;
};

function readMailboxFile(filePath: string): MailboxEntry[] {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return raw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as MailboxEntry;
        } catch {
          return null;
        }
      })
      .filter((v): v is MailboxEntry => v !== null);
  } catch {
    return [];
  }
}

function topicMeta(sessionKey: string): { role: 'ceo' | 'manager' | 'coder' | 'unknown'; team: number | null; coderIndex: number | null; label: string } {
  const id = sessionKey.replace(/^axiom:/, '');
  if (id === 'axiom-ceo') return { role: 'ceo', team: null, coderIndex: null, label: 'CEO · Orchestrator' };
  const mgr = id.match(/^axiom-mgr-(\d+)$/);
  if (mgr) return { role: 'manager', team: Number(mgr[1]), coderIndex: null, label: `Team ${mgr[1]} · Manager` };
  const coder = id.match(/^axiom-coder-(\d+)-(\d+)$/);
  if (coder) return { role: 'coder', team: Number(coder[1]), coderIndex: Number(coder[2]), label: `Team ${coder[1]} · Coder ${coder[2]}` };
  return { role: 'unknown', team: null, coderIndex: null, label: id || sessionKey };
}

export async function GET() {
  let files: string[] = [];
  try {
    files = fs
      .readdirSync(AXIOM_MAILBOX_DIR)
      .filter((name) => name.endsWith('.jsonl'))
      .map((name) => path.join(AXIOM_MAILBOX_DIR, name));
  } catch {
    files = [];
  }

  const entries: Array<MailboxEntry & ReturnType<typeof topicMeta>> = [];
  for (const file of files) {
    for (const entry of readMailboxFile(file)) {
      entries.push({ ...entry, ...topicMeta(entry.sessionKey) });
    }
  }

  entries.sort((a, b) => (b.ts > a.ts ? 1 : b.ts < a.ts ? -1 : 0));

  return NextResponse.json({
    ok: true,
    generatedAt: new Date().toISOString(),
    mailboxDir: AXIOM_MAILBOX_DIR,
    total: entries.length,
    entries,
  });
}
