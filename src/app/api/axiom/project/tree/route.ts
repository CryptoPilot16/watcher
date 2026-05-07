import fs from 'fs';
import path from 'path';
import { NextResponse } from 'next/server';
import { isAdminAuthed } from '@/lib/admin-auth';
import { getWatchApiKey } from '@/lib/auth';

export const dynamic = 'force-dynamic';

const PROJECT_DIR = process.env.WATCH_AXIOM_PROJECT_DIR || '/opt/axiom';
const MAX_TREE_ENTRIES = 5_000;

const IGNORED_PARTS = new Set([
  'node_modules', '.git', '.next', 'dist', 'build', '.turbo', '.cache',
  'coverage', '.nyc_output', '.parcel-cache', '.vite', '.svelte-kit',
]);

type TreeNode = {
  name: string;
  path: string; // relative to PROJECT_DIR, '' for root
  type: 'dir' | 'file';
  size?: number;
  mtime?: string;
  children?: TreeNode[];
};

function shouldHide(name: string) {
  if (IGNORED_PARTS.has(name)) return true;
  if (name.startsWith('.') && name !== '.gitignore' && name !== '.env.example') return true;
  return false;
}

function authOk(request: Request) {
  const auth = request.headers.get('authorization') || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (bearer && bearer === getWatchApiKey()) return Promise.resolve(true);
  return isAdminAuthed(request as any);
}

function buildTree(absRoot: string): { tree: TreeNode; truncated: boolean } {
  let count = 0;
  let truncated = false;

  function walk(absDir: string, relDir: string): TreeNode {
    const node: TreeNode = {
      name: relDir === '' ? path.basename(absRoot) : path.basename(absDir),
      path: relDir,
      type: 'dir',
      children: [],
    };
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return node;
    }
    entries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const entry of entries) {
      if (count >= MAX_TREE_ENTRIES) {
        truncated = true;
        break;
      }
      if (shouldHide(entry.name)) continue;
      count++;
      const childAbs = path.join(absDir, entry.name);
      const childRel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        node.children!.push(walk(childAbs, childRel));
      } else if (entry.isFile()) {
        try {
          const s = fs.statSync(childAbs);
          node.children!.push({
            name: entry.name,
            path: childRel,
            type: 'file',
            size: s.size,
            mtime: s.mtime.toISOString(),
          });
        } catch {
          node.children!.push({ name: entry.name, path: childRel, type: 'file' });
        }
      }
    }
    return node;
  }

  const tree = walk(absRoot, '');
  return { tree, truncated };
}

export async function GET(request: Request) {
  if (!(await authOk(request))) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(PROJECT_DIR);
    if (!stat.isDirectory()) throw new Error('not a directory');
  } catch (err: any) {
    return NextResponse.json({
      ok: false,
      error: `project dir not accessible: ${err.message}`,
      projectDir: PROJECT_DIR,
    }, { status: 500 });
  }

  const { tree, truncated } = buildTree(PROJECT_DIR);
  return NextResponse.json({
    ok: true,
    projectDir: PROJECT_DIR,
    generatedAt: new Date().toISOString(),
    truncated,
    maxEntries: MAX_TREE_ENTRIES,
    tree,
  });
}
