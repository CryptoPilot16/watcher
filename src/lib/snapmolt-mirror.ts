function getLines(value?: string) {
  return (value || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
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
  return line.startsWith('[twilio-status]');
}

function pickLatest(lines: string[]) {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!isNoiseLine(line) && !isSecondaryLine(line)) {
      return line;
    }
  }

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!isNoiseLine(line)) {
      return line;
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
    if (picked.includes(line)) continue;
    picked.push(line);
  }

  return picked.reverse();
}

export function getLatestSnapmoltError(snapmoltErr?: string) {
  return pickLatest(getLines(snapmoltErr));
}
