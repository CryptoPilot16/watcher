import path from 'path';

function envFlag(value: string | undefined) {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

const HOME_DIR = process.env.HOME || '/root';

export const WATCH_DEMO_MODE = envFlag(process.env.WATCH_DEMO_MODE);
export const WATCH_OPENCLAW_DIR = process.env.WATCH_OPENCLAW_DIR || process.env.OPENCLAW_HOME || path.join(HOME_DIR, '.openclaw');
export const WATCH_AGENTS_ROOT = path.join(WATCH_OPENCLAW_DIR, 'agents');
export const WATCH_MAIN_SESSIONS_FILE = path.join(WATCH_AGENTS_ROOT, 'main', 'sessions', 'sessions.json');
export const WATCH_ORCHESTRATION_FILE = process.env.WATCH_ORCHESTRATION_FILE || path.join(WATCH_OPENCLAW_DIR, 'workspace', 'state', 'orchestration.json');
export const WATCH_RUNS_DB = path.join(WATCH_OPENCLAW_DIR, 'tasks', 'runs.sqlite');
export const WATCH_FLOWS_DB = path.join(WATCH_OPENCLAW_DIR, 'flows', 'registry.sqlite');
export const WATCH_UPDATE_RESULT_PATH = process.env.WATCH_UPDATE_RESULT_PATH || path.join(WATCH_OPENCLAW_DIR, 'tasks', 'update-command.result');

export const WATCH_PM2_BIN = process.env.WATCH_PM2_BIN || 'pm2';
export const WATCH_PM2_HOME = process.env.WATCH_PM2_HOME || path.join(HOME_DIR, '.pm2');
export const WATCH_OPENCLAW_BIN = process.env.WATCH_OPENCLAW_BIN || 'openclaw';
export const WATCH_SNAPMOLT_PROCESS = process.env.WATCH_SNAPMOLT_PROCESS || 'snapmolt';
export const WATCH_ECHOES_PROCESS = process.env.WATCH_ECHOES_PROCESS || 'echoes-backend';

export function pm2LogGlob(processName: string, stream: 'out' | 'error') {
  return path.join(WATCH_PM2_HOME, 'logs', `${processName}-${stream}*.log`);
}

export function pm2LogFile(processName: string, stream: 'out' | 'error') {
  return path.join(WATCH_PM2_HOME, 'logs', `${processName}-${stream}.log`);
}
