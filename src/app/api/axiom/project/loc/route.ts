import fs from 'fs';
import path from 'path';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const PROJECT_DIR = process.env.WATCH_AXIOM_PROJECT_DIR || '/opt/axiom';

// Extensions counted as "code". Skips lockfiles, generated lockfiles, large
// data dumps. The point is "what have the agents authored", not "what's on
// disk including dependencies".
const COUNTED_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.rs', '.go', '.java', '.cs', '.kt', '.swift', '.rb', '.php',
  '.sh', '.bash', '.zsh',
  '.yaml', '.yml', '.json', '.toml', '.xml',
  '.proto', '.cedar', '.cedarschema',
  '.sql', '.graphql', '.gql',
  '.md', '.mdx', '.txt',
  '.html', '.css', '.scss',
]);

const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.next', 'dist', 'build', '.turbo', '.cache',
  'coverage', '.nyc_output', '.parcel-cache', '.vite', 'target',
  '__pycache__', '.venv', 'venv', '.tox',
]);

const MAX_FILE_BYTES = 1_000_000; // skip files > 1MB (probably data dumps)

let cache: { ts: number; payload: any } | null = null;
const CACHE_TTL_MS = 15_000;

type FileBucket = { files: number; lines: number; bytes: number };

function countLines(file: string): number {
  try {
    const buf = fs.readFileSync(file);
    if (buf.length > MAX_FILE_BYTES) return 0;
    let n = 0;
    for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) n++;
    // If file doesn't end in newline, count the trailing line.
    if (buf.length > 0 && buf[buf.length - 1] !== 0x0a) n++;
    return n;
  } catch {
    return 0;
  }
}

function walk(dir: string, depth: number, byExt: Map<string, FileBucket>, byTopDir: Map<string, FileBucket>, total: FileBucket) {
  if (depth > 12) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch { return; }
  for (const ent of entries) {
    if (IGNORED_DIRS.has(ent.name)) continue;
    if (ent.name.startsWith('.') && depth === 0) continue;
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      walk(abs, depth + 1, byExt, byTopDir, total);
    } else if (ent.isFile()) {
      const ext = path.extname(ent.name).toLowerCase();
      if (!COUNTED_EXT.has(ext)) continue;
      let stat: fs.Stats;
      try { stat = fs.statSync(abs); } catch { continue; }
      if (stat.size > MAX_FILE_BYTES) continue;
      const lines = countLines(abs);
      const bytes = stat.size;
      // by ext
      const eb = byExt.get(ext) || { files: 0, lines: 0, bytes: 0 };
      eb.files += 1; eb.lines += lines; eb.bytes += bytes;
      byExt.set(ext, eb);
      // by top-level directory (relative to PROJECT_DIR)
      const rel = path.relative(PROJECT_DIR, abs);
      const top = rel.split(path.sep)[0] || '(root)';
      const tb = byTopDir.get(top) || { files: 0, lines: 0, bytes: 0 };
      tb.files += 1; tb.lines += lines; tb.bytes += bytes;
      byTopDir.set(top, tb);
      // total
      total.files += 1; total.lines += lines; total.bytes += bytes;
    }
  }
}

export async function GET() {
  const now = Date.now();
  if (cache && now - cache.ts < CACHE_TTL_MS) {
    return NextResponse.json({ ...cache.payload, cached: true, age: now - cache.ts });
  }
  const byExt = new Map<string, FileBucket>();
  const byTopDir = new Map<string, FileBucket>();
  const total: FileBucket = { files: 0, lines: 0, bytes: 0 };
  walk(PROJECT_DIR, 0, byExt, byTopDir, total);
  // sort + serialize
  const sortedExt = [...byExt.entries()].sort((a, b) => b[1].lines - a[1].lines)
    .map(([ext, b]) => ({ ext, ...b }));
  const sortedDir = [...byTopDir.entries()].sort((a, b) => b[1].lines - a[1].lines)
    .map(([dir, b]) => ({ dir, ...b }));
  const payload = {
    ok: true,
    generatedAt: new Date().toISOString(),
    projectDir: PROJECT_DIR,
    total,
    byExt: sortedExt,
    byTopDir: sortedDir,
  };
  cache = { ts: now, payload };
  return NextResponse.json(payload);
}
