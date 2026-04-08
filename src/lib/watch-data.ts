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

function readMergedLog(glob: string, perFileLines: number, totalLines: number) {
  const command = `files=$(ls -1t ${glob} 2>/dev/null | head -n 2); if [ -z "$files" ]; then exit 0; fi; for file in $files; do tail -n ${perFileLines} "$file" 2>/dev/null; done | tail -n ${totalLines}`;

  return run(`/bin/bash -lc '${command}'`);
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
      snapmoltOut: readMergedLog('/root/.pm2/logs/snapmolt-out*.log', 120, 160),
      snapmoltErr: readMergedLog('/root/.pm2/logs/snapmolt-error*.log', 80, 120),
      echoesOut: run('tail -n 40 /root/.pm2/logs/echoes-backend-out.log'),
      echoesErr: run('tail -n 40 /root/.pm2/logs/echoes-backend-error.log'),
    },
  };
}
