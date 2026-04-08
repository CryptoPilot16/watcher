export type ActivityTag = 'voice' | 'http' | 'event' | 'error' | 'system' | 'task' | 'log';

export type ActivityItem = {
  text: string;
  tag: ActivityTag;
};

function detectTag(line: string): ActivityTag {
  if (line.startsWith('[twilio-status]')) return 'voice';

  const bracketMatch = line.match(/^\[([^\]]+)\]/);
  if (bracketMatch) {
    const t = bracketMatch[1].toLowerCase();
    if (t.includes('error') || t.includes('err') || t.includes('warn')) return 'error';
    if (t.includes('http') || t.includes('request') || t.includes('api')) return 'http';
    if (t.includes('webhook') || t.includes('event') || t.includes('trigger')) return 'event';
    if (t.includes('voice') || t.includes('call') || t.includes('twilio')) return 'voice';
    if (t.includes('system') || t.includes('server') || t.includes('session')) return 'system';
    if (t.includes('task') || t.includes('job') || t.includes('cron')) return 'task';
  }

  if (/\b(GET|POST|PUT|DELETE|PATCH)\b/.test(line)) return 'http';
  if (/error|exception|traceback|failed|crash/i.test(line)) return 'error';
  if (/call|phone|voice|dial|ring/i.test(line)) return 'voice';
  if (/webhook|incoming event|trigger/i.test(line)) return 'event';
  if (/session|listen|port\s+\d/i.test(line)) return 'system';
  if (/task|job|schedul|queue/i.test(line)) return 'task';

  return 'log';
}

export function getStructuredSnapmoltActivity(snapmoltOut?: string, limit = 10): ActivityItem[] {
  const lines = getLines(snapmoltOut);
  const picked: ActivityItem[] = [];
  const seen = new Set<string>();

  for (let i = lines.length - 1; i >= 0 && picked.length < limit; i--) {
    const line = lines[i];
    if (isNoiseLine(line)) continue;
    const text = formatLine(line);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    picked.push({ text, tag: detectTag(line) });
  }

  return picked.reverse();
}

export function getActivityBreakdown(
  items: ActivityItem[],
): Array<{ tag: ActivityTag; count: number }> {
  const counts = new Map<ActivityTag, number>();
  for (const item of items) {
    counts.set(item.tag, (counts.get(item.tag) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count);
}

function getLines(value?: string) {
  return (value || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function extractTwilioPayload(line: string) {
  if (!line.startsWith('[twilio-status]')) return null;

  try {
    return JSON.parse(line.replace(/^\[twilio-status\]\s*/, ''));
  } catch {
    return null;
  }
}

function formatPhone(value: string) {
  if (!value) return 'unknown number';
  return value.replace(/\s+/g, '');
}

function formatDuration(seconds?: string) {
  if (!seconds) return '';
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return '';
  return ` (${value}s)`;
}

function formatLine(line: string) {
  const twilio = extractTwilioPayload(line);
  if (twilio) {
    const target = formatPhone(String(twilio.To || twilio.Called || ''));
    const status = String(twilio.CallStatus || 'updated').replace(/-/g, ' ');
    const duration = formatDuration(String(twilio.CallDuration || twilio.Duration || ''));
    return `Outbound call to ${target} ${status}${duration}`;
  }

  return line;
}

function isNoiseLine(line: string) {
  return (
    !line ||
    line === '(empty)' ||
    line.startsWith('at ') ||
    line.startsWith('snapmolt listening on port ') ||
    line.startsWith('[echoes] Session ready') ||
    /^Already on latest \(v[0-9.]+\)\.$/.test(line)
  );
}

function isSecondaryLine(line: string) {
  return false;
}

function pickLatest(lines: string[]) {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!isNoiseLine(line) && !isSecondaryLine(line)) {
      return formatLine(line);
    }
  }

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!isNoiseLine(line)) {
      return formatLine(line);
    }
  }

  return '';
}

export function getPrimarySnapmoltText(snapmoltOut?: string, snapmoltErr?: string) {
  const primary = pickLatest(getLines(snapmoltOut));
  if (primary) return primary;

  const fallbackError = pickLatest(getLines(snapmoltErr));
  if (fallbackError) return fallbackError;

  return 'No active Snapmolt activity yet';
}

export function getLatestSnapmoltActivity(snapmoltOut?: string) {
  return pickLatest(getLines(snapmoltOut)) || 'No recent activity';
}

export function getRecentSnapmoltActivity(snapmoltOut?: string, limit = 3) {
  const lines = getLines(snapmoltOut);
  const picked: string[] = [];

  for (let index = lines.length - 1; index >= 0 && picked.length < limit; index -= 1) {
    const line = lines[index];
    if (isNoiseLine(line)) continue;
    const formatted = formatLine(line);
    if (!formatted) continue;
    if (picked.includes(formatted)) continue;
    picked.push(formatted);
  }

  return picked.reverse();
}

export function getLatestSnapmoltError(snapmoltErr?: string) {
  return pickLatest(getLines(snapmoltErr));
}
