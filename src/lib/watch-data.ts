import { execSync } from 'child_process';

export type WatchSnapshot = {
  ok: true;
  now: string;
  status: string;
  summary: string;
  sections: Record<string, string>;
};

function run(command: string) {
  try {
    return execSync(command, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error: any) {
    const out = String(error?.stdout || error?.stderr || error?.message || 'command failed').trim();
    return `ERROR: ${out}`;
  }
}

export function getWatchSnapshot(): WatchSnapshot {
  return {
    ok: true,
    now: new Date().toISOString(),
    status: 'working',
    summary: 'Live ops watcher',
    sections: {
      pm2: run('pm2 list'),
      updateResult: run('cat /root/.openclaw/tasks/update-command.result 2>/dev/null || true'),
      snapmoltOut: run('tail -n 60 /root/.pm2/logs/snapmolt-out.log'),
      snapmoltErr: run('tail -n 60 /root/.pm2/logs/snapmolt-error.log'),
      echoesOut: run('tail -n 40 /root/.pm2/logs/echoes-backend-out.log'),
      echoesErr: run('tail -n 40 /root/.pm2/logs/echoes-backend-error.log'),
    },
  };
}
