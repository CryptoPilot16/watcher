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
