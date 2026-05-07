'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { marked } from 'marked';
import { diffLines, type Change } from 'diff';
import { AdminShellHeader } from '@/components/admin-shell-header';

type TreeNode = {
  name: string;
  path: string;
  type: 'dir' | 'file';
  size?: number;
  mtime?: string;
  children?: TreeNode[];
};

type ProjectEvent = {
  ts: string;
  kind: string;
  path: string;
  size: number | null;
};

type FileResponse =
  | { ok: true; path: string; size: number; mtime: string; kind: 'text'; content: string; truncated: boolean; maxBytes: number }
  | { ok: true; path: string; size: number; mtime: string; kind: 'binary'; preview: string }
  | { ok: false; error: string };

type DiffResponse =
  | {
      ok: true;
      path: string;
      before: string | null;
      after: string | null;
      afterSource: 'live' | 'snapshot' | 'none';
      hasBefore: boolean;
      hasAfter: boolean;
      liveSize: number | null;
      liveMtime: string | null;
      maxBytes: number;
    }
  | { ok: false; error: string };

type ViewMode = 'auto' | 'source' | 'diff';

const TREE_POLL_MS = 5_000;
const SSE_RECONNECT_MS = 3_000;

// Strip the most dangerous bits from agent-authored markdown HTML before injecting.
// Agents could plausibly include <script> or onerror= handlers in rendered .md
// files; we cut those without pulling in DOMPurify for a v1.
function sanitizeMarkdownHtml(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe\s*>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '')
    .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, '')
    .replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, '')
    .replace(/javascript\s*:/gi, '');
}

function fmtSize(bytes?: number | null) {
  if (bytes === undefined || bytes === null) return '';
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${(bytes / 1024 / 1024).toFixed(2)}M`;
}

function fmtAgo(ts?: string) {
  if (!ts) return '';
  const ms = Date.now() - new Date(ts).getTime();
  if (ms < 1000) return 'just now';
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

function eventKindIcon(kind: string) {
  if (kind === 'modified' || kind === 'change') return '✎';
  if (kind === 'created-or-renamed') return '＋';
  if (kind === 'deleted') return '✕';
  if (kind === 'watcher-online') return '◉';
  return '·';
}

function eventKindColor(kind: string) {
  if (kind === 'modified' || kind === 'change') return '#f7c763';
  if (kind === 'created-or-renamed') return '#7ee787';
  if (kind === 'deleted') return '#f08585';
  if (kind === 'watcher-online') return '#58d9ff';
  return '#9e8967';
}

function languageHint(path: string) {
  const ext = path.split('.').pop()?.toLowerCase() || '';
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx',
    py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java',
    sh: 'shell', bash: 'shell', md: 'markdown', json: 'json',
    yaml: 'yaml', yml: 'yaml', toml: 'toml', html: 'html', css: 'css',
    scss: 'scss', sql: 'sql', dockerfile: 'dockerfile',
  };
  return map[ext] || 'plaintext';
}

export default function ProjectPage() {
  const [tree, setTree] = useState<TreeNode | null>(null);
  const [projectDir, setProjectDir] = useState<string>('');
  const [treeError, setTreeError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [events, setEvents] = useState<ProjectEvent[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['']));
  const [fileResp, setFileResp] = useState<FileResponse | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [diffResp, setDiffResp] = useState<DiffResponse | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>('auto');
  const [streamConnected, setStreamConnected] = useState(false);
  const [mobilePane, setMobilePane] = useState<'tree' | 'events' | 'viewer'>('events');
  const flashRef = useRef<Map<string, number>>(new Map());
  const [, setFlashTick] = useState(0);

  const pollTree = useCallback(async () => {
    try {
      const r = await fetch('/api/axiom/project/tree', { cache: 'no-store', credentials: 'same-origin' });
      const j = await r.json();
      if (j.ok) {
        setTree(j.tree);
        setProjectDir(j.projectDir || '');
        setTruncated(!!j.truncated);
        setTreeError(null);
      } else {
        setTreeError(j.error || 'tree fetch failed');
      }
    } catch (err: any) {
      setTreeError(err?.message || 'tree fetch failed');
    }
  }, []);

  // Live SSE subscription for file events — instant, no polling.
  useEffect(() => {
    let es: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    const connect = () => {
      if (cancelled) return;
      es = new EventSource('/api/axiom/project/events/stream', { withCredentials: true });
      es.addEventListener('hello', () => setStreamConnected(true));
      es.addEventListener('file', (msg) => {
        try {
          const ev = JSON.parse((msg as MessageEvent).data) as ProjectEvent;
          setEvents((prev) => {
            const merged = [...prev, ev];
            return merged.length > 300 ? merged.slice(-300) : merged;
          });
          if (ev.path) flashRef.current.set(ev.path, Date.now());
          setFlashTick((t) => t + 1);
        } catch {}
      });
      es.onerror = () => {
        setStreamConnected(false);
        try { es?.close(); } catch {}
        es = null;
        if (cancelled) return;
        reconnectTimer = setTimeout(connect, SSE_RECONNECT_MS);
      };
    };

    connect();
    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      try { es?.close(); } catch {}
    };
  }, []);

  useEffect(() => {
    pollTree();
    const t1 = setInterval(pollTree, TREE_POLL_MS);
    return () => clearInterval(t1);
  }, [pollTree]);

  // Decay flashes: remove paths flashed >4s ago.
  useEffect(() => {
    const t = setInterval(() => {
      const now = Date.now();
      let changed = false;
      for (const [k, ts] of flashRef.current.entries()) {
        if (now - ts > 4_000) {
          flashRef.current.delete(k);
          changed = true;
        }
      }
      if (changed) setFlashTick((t2) => t2 + 1);
    }, 1000);
    return () => clearInterval(t);
  }, []);

  const onToggle = useCallback((p: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  }, []);

  const fetchDiff = useCallback(async (relPath: string) => {
    setDiffLoading(true);
    setDiffResp(null);
    try {
      const r = await fetch(`/api/axiom/project/diff?path=${encodeURIComponent(relPath)}`, {
        cache: 'no-store',
        credentials: 'same-origin',
      });
      const j: DiffResponse = await r.json();
      setDiffResp(j);
    } catch (err: any) {
      setDiffResp({ ok: false, error: err?.message || 'fetch failed' });
    } finally {
      setDiffLoading(false);
    }
  }, []);

  const onSelect = useCallback(async (node: TreeNode) => {
    if (node.type !== 'file') return;
    setSelectedPath((prev) => {
      // Reset view-mode preference when switching to a different file.
      if (prev !== node.path) setViewMode('auto');
      return node.path;
    });
    // On mobile, auto-flip to the viewer pane so tap-to-open feels native.
    setMobilePane('viewer');
    setFileLoading(true);
    setFileResp(null);
    setDiffResp(null);
    try {
      const r = await fetch(`/api/axiom/project/file?path=${encodeURIComponent(node.path)}`, {
        cache: 'no-store',
        credentials: 'same-origin',
      });
      const j: FileResponse = await r.json();
      setFileResp(j);
    } catch (err: any) {
      setFileResp({ ok: false, error: err?.message || 'fetch failed' });
    } finally {
      setFileLoading(false);
    }
    // Eagerly fetch the diff snapshot in parallel — many users will toggle to it.
    fetchDiff(node.path);
  }, [fetchDiff]);

  // Auto-refresh selected file when an event mentions it.
  useEffect(() => {
    if (!selectedPath || !events.length) return;
    const last = events[events.length - 1];
    if (last.path === selectedPath) {
      onSelect({ name: selectedPath.split('/').pop() || selectedPath, path: selectedPath, type: 'file' });
    }
  }, [events, selectedPath, onSelect]);

  // Did the most recent event for the selected file produce a diff worth showing?
  // If so, surface a "diff available" hint by auto-flipping to diff mode the first
  // time we have a non-trivial change. Idempotent if user has already chosen a mode.
  useEffect(() => {
    if (viewMode !== 'auto' || !diffResp?.ok) return;
    if (diffResp.hasBefore && diffResp.hasAfter && diffResp.before !== diffResp.after) {
      setViewMode('diff');
    }
  }, [diffResp, viewMode]);

  const recentEvents = useMemo(() => events.slice().reverse(), [events]);
  const flashed = flashRef.current;

  return (
    <main className="min-h-screen bg-[var(--watch-bg)] p-3 sm:p-5">
      <div className="mx-auto flex min-h-[calc(100vh-24px)] max-w-[1600px] flex-col gap-3">
        <AdminShellHeader activeTab="project" />

        <div className="rounded-xl border border-[var(--watch-panel-border)] bg-[rgba(0,0,0,0.18)] px-4 py-3">
          <div className="flex items-center justify-between gap-2 text-[10px] uppercase tracking-[0.24em] text-[var(--watch-text-muted)]">
            <span>▌ axiom project — what the agents are building</span>
            <span className="flex items-center gap-1.5">
              <span
                className={`inline-block h-2 w-2 rounded-full ${streamConnected ? 'bg-emerald-400' : 'bg-amber-400'}`}
                style={{ boxShadow: streamConnected ? '0 0 6px rgba(74,222,128,0.7)' : '0 0 6px rgba(251,191,36,0.7)' }}
              />
              <span>{streamConnected ? 'live' : 'reconnecting'}</span>
            </span>
          </div>
          <div className="mt-2 text-sm text-[var(--watch-text-bright)] sm:text-base">
            {projectDir || '(loading)'} · {events.length} recent file events
          </div>
          {truncated && (
            <div className="mt-1 text-xs text-amber-300">tree truncated — showing first {5_000} entries</div>
          )}
          {treeError && (
            <div className="mt-1 text-xs text-red-300">tree error: {treeError}</div>
          )}
        </div>

        {/* Mobile pane switcher — hidden on lg+ where all three panes show side-by-side. */}
        <div className="flex shrink-0 items-stretch gap-1 lg:hidden">
          {(['tree', 'events', 'viewer'] as const).map((p) => {
            const active = mobilePane === p;
            const counts = p === 'events' ? ` (${recentEvents.length})` : '';
            return (
              <button
                key={p}
                type="button"
                onClick={() => setMobilePane(p)}
                className={`flex-1 rounded-md border px-2 py-2 text-[11px] uppercase tracking-[0.15em] transition-colors ${
                  active
                    ? 'border-[var(--watch-panel-border-strong)] bg-[var(--watch-accent-soft)] text-[var(--watch-text-bright)]'
                    : 'border-[var(--watch-panel-border)] text-[var(--watch-text-muted)] hover:text-[var(--watch-text)]'
                }`}
              >
                {p}{counts}
              </button>
            );
          })}
        </div>

        <div className="grid flex-1 min-h-0 grid-cols-1 gap-3 lg:grid-cols-[280px_minmax(0,1fr)_minmax(0,1.5fr)]">
          {/* tree pane */}
          <div className={`flex min-h-0 flex-col rounded-xl border border-[var(--watch-panel-border)] bg-[rgba(0,0,0,0.18)] ${mobilePane === 'tree' ? '' : 'hidden'} lg:flex`}>
            <div className="border-b border-[var(--watch-panel-border)] px-3 py-2 text-[10px] uppercase tracking-[0.18em] text-[var(--watch-text-muted)]">
              tree
            </div>
            <div className="flex-1 overflow-y-auto py-1">
              {tree ? (
                <TreeWithFlash
                  node={tree}
                  flashed={flashed}
                  selected={selectedPath}
                  expanded={expanded}
                  onToggle={onToggle}
                  onSelect={onSelect}
                />
              ) : (
                <div className="px-3 py-2 text-xs text-[var(--watch-text-muted)]">loading…</div>
              )}
            </div>
          </div>

          {/* events pane */}
          <div className={`flex min-h-0 flex-col rounded-xl border border-[var(--watch-panel-border)] bg-[rgba(0,0,0,0.18)] ${mobilePane === 'events' ? '' : 'hidden'} lg:flex`}>
            <div className="border-b border-[var(--watch-panel-border)] px-3 py-2 text-[10px] uppercase tracking-[0.18em] text-[var(--watch-text-muted)]">
              recent file events ({recentEvents.length})
            </div>
            <div className="flex-1 overflow-y-auto">
              {recentEvents.length === 0 ? (
                <div className="px-3 py-2 text-xs text-[var(--watch-text-muted)]">no events yet — agents haven't touched the project since the watcher started.</div>
              ) : (
                <ul className="divide-y divide-white/5">
                  {recentEvents.map((ev, i) => (
                    <li
                      key={`${ev.ts}-${i}`}
                      onClick={() => ev.path && onSelect({ name: ev.path.split('/').pop() || ev.path, path: ev.path, type: 'file' })}
                      className="cursor-pointer px-3 py-1.5 text-xs hover:bg-white/5"
                    >
                      <div className="flex items-baseline gap-2">
                        <span style={{ color: eventKindColor(ev.kind) }} className="w-3 shrink-0 font-mono">{eventKindIcon(ev.kind)}</span>
                        <span className="truncate font-mono text-[var(--watch-text-bright)]">{ev.path || '(watcher)'}</span>
                        <span className="ml-auto shrink-0 text-[10px] text-[var(--watch-text-muted)]">{fmtAgo(ev.ts)}</span>
                      </div>
                      <div className="ml-5 text-[10px] text-[var(--watch-text-muted)]">
                        {ev.kind}{ev.size !== null && ev.size !== undefined ? ` · ${fmtSize(ev.size)}` : ''}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          {/* viewer pane */}
          <ViewerPane
            className={`${mobilePane === 'viewer' ? '' : 'hidden'} lg:flex`}
            selectedPath={selectedPath}
            fileResp={fileResp}
            fileLoading={fileLoading}
            diffResp={diffResp}
            diffLoading={diffLoading}
            viewMode={viewMode}
            setViewMode={setViewMode}
          />
        </div>
      </div>
    </main>
  );
}

function TreeWithFlash({
  node,
  flashed,
  selected,
  expanded,
  onToggle,
  onSelect,
}: {
  node: TreeNode;
  flashed: Map<string, number>;
  selected: string | null;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  onSelect: (node: TreeNode) => void;
}) {
  // Apply a brief amber tint to recently-touched files.
  const decorate = (n: TreeNode, depth: number): React.ReactElement | null => {
    const isFlash = flashed.has(n.path);
    const isDir = n.type === 'dir';
    const isExpanded = expanded.has(n.path) || depth === 0;
    const isSelected = !isDir && selected === n.path;
    const indent = depth * 12;
    return (
      <div key={n.path}>
        <div
          onClick={() => (isDir ? onToggle(n.path) : onSelect(n))}
          className={`flex cursor-pointer items-center gap-1 px-1.5 py-0.5 text-xs transition-colors ${
            isSelected ? 'bg-[var(--watch-accent-soft)] text-[var(--watch-text-bright)]' : 'hover:bg-white/5'
          } ${isFlash ? 'bg-amber-500/20' : ''}`}
          style={{ paddingLeft: indent + 6 }}
        >
          <span className="w-3 text-[10px] text-[var(--watch-text-muted)]">
            {isDir ? (isExpanded ? '▾' : '▸') : ' '}
          </span>
          <span className="truncate font-mono">
            {isDir ? <span className="text-[var(--watch-accent-strong)]">{n.name}/</span> : n.name}
          </span>
          {!isDir && n.size !== undefined && (
            <span className="ml-auto shrink-0 text-[10px] text-[var(--watch-text-muted)]">{fmtSize(n.size)}</span>
          )}
        </div>
        {isDir && isExpanded && n.children?.map((c) => decorate(c, depth + 1))}
      </div>
    );
  };
  return decorate(node, 0);
}

// ── viewer pane ─────────────────────────────────────────────────────────────

type ResolvedView = 'rendered-md' | 'source' | 'diff';

function resolveView(viewMode: ViewMode, selectedPath: string | null, hasMd: boolean, hasDiff: boolean): ResolvedView {
  if (viewMode === 'diff' && hasDiff) return 'diff';
  if (viewMode === 'source') return 'source';
  // auto: prefer diff if there's a meaningful one, then markdown, then source.
  if (viewMode === 'auto' && hasDiff) return 'diff';
  if (hasMd && (viewMode === 'auto' || viewMode === 'diff' /* but no diff */)) return 'rendered-md';
  return 'source';
}

function ViewerPane({
  className,
  selectedPath,
  fileResp,
  fileLoading,
  diffResp,
  diffLoading,
  viewMode,
  setViewMode,
}: {
  className?: string;
  selectedPath: string | null;
  fileResp: FileResponse | null;
  fileLoading: boolean;
  diffResp: DiffResponse | null;
  diffLoading: boolean;
  viewMode: ViewMode;
  setViewMode: (m: ViewMode) => void;
}) {
  const isMd = !!selectedPath && /\.(md|markdown)$/i.test(selectedPath);
  const fileText = fileResp?.ok && fileResp.kind === 'text' ? fileResp.content : null;
  const fileBinary = fileResp?.ok && fileResp.kind === 'binary' ? fileResp : null;
  const fileError = fileResp?.ok === false ? fileResp.error : null;

  const diffOk = diffResp?.ok === true;
  const hasMeaningfulDiff = !!(
    diffOk
    && diffResp.hasBefore
    && diffResp.hasAfter
    && diffResp.before !== diffResp.after
  );

  const resolved = resolveView(viewMode, selectedPath, isMd, hasMeaningfulDiff);

  return (
    <div className={`flex min-h-0 flex-col rounded-xl border border-[var(--watch-panel-border)] bg-[rgba(0,0,0,0.18)] ${className || ''}`}>
      <div className="flex items-center justify-between gap-2 border-b border-[var(--watch-panel-border)] px-3 py-2 text-[10px] uppercase tracking-[0.18em] text-[var(--watch-text-muted)]">
        <span className="truncate">viewer{selectedPath ? ` · ${selectedPath}` : ''}</span>
        <span className="flex shrink-0 items-center gap-2">
          {selectedPath && fileText !== null && (
            <span className="flex items-center gap-1">
              {(['source', 'diff'] as const).map((m) => {
                const enabled = m !== 'diff' || hasMeaningfulDiff;
                const isActive = resolved === m || (m === 'source' && resolved === 'rendered-md');
                return (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setViewMode(m)}
                    disabled={!enabled}
                    className={`rounded border px-1.5 py-0.5 text-[10px] tracking-[0.1em] transition-colors ${
                      isActive
                        ? 'border-[var(--watch-panel-border-strong)] bg-[var(--watch-accent-soft)] text-[var(--watch-text-bright)]'
                        : 'border-[var(--watch-panel-border)] text-[var(--watch-text-muted)] hover:border-[var(--watch-panel-border-strong)] hover:text-[var(--watch-text)]'
                    } disabled:cursor-not-allowed disabled:opacity-30`}
                    title={m === 'diff' && !enabled ? 'no previous snapshot to diff against yet' : ''}
                  >
                    {m}
                  </button>
                );
              })}
            </span>
          )}
          {selectedPath && fileText !== null && (
            <span className="text-[10px]">{languageHint(selectedPath)} · {fmtSize(fileResp!.ok && fileResp.kind === 'text' ? fileResp.size : 0)}</span>
          )}
        </span>
      </div>
      <div className="flex-1 overflow-y-auto">
        {!selectedPath ? (
          <div className="px-3 py-2 text-xs text-[var(--watch-text-muted)]">select a file in the tree or events feed.</div>
        ) : fileLoading ? (
          <div className="px-3 py-2 text-xs text-[var(--watch-text-muted)]">loading file…</div>
        ) : fileError ? (
          <div className="px-3 py-2 text-xs text-red-300">error: {fileError}</div>
        ) : fileBinary ? (
          (() => {
            const ext = (selectedPath.split('.').pop() || '').toLowerCase();
            const isImage = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico'].includes(ext);
            const isPdf = ext === 'pdf';
            if (isImage) {
              return (
                <div className="flex h-full flex-col">
                  <div className="border-b border-white/5 px-3 py-1.5 text-[10px] uppercase tracking-[0.16em] text-[var(--watch-text-muted)]">
                    image · {fileBinary.size.toLocaleString()} bytes · {ext}
                  </div>
                  <div className="flex-1 overflow-auto p-3">
                    <img
                      src={`/api/axiom/project/raw?path=${encodeURIComponent(selectedPath)}`}
                      alt={selectedPath}
                      className="max-w-full rounded border border-white/10"
                    />
                  </div>
                </div>
              );
            }
            if (isPdf) {
              return (
                <div className="flex h-full flex-col">
                  <div className="border-b border-white/5 px-3 py-1.5 text-[10px] uppercase tracking-[0.16em] text-[var(--watch-text-muted)]">
                    pdf · {fileBinary.size.toLocaleString()} bytes
                  </div>
                  <iframe
                    src={`/api/axiom/project/raw?path=${encodeURIComponent(selectedPath)}#view=FitH`}
                    title={selectedPath}
                    className="h-full w-full flex-1 bg-white"
                  />
                </div>
              );
            }
            return <div className="px-3 py-2 text-xs text-[var(--watch-text-muted)]">{fileBinary.preview}</div>;
          })()
        ) : fileText !== null ? (
          <>
            {fileResp!.ok && fileResp.kind === 'text' && fileResp.truncated && (
              <div className="bg-amber-900/40 px-3 py-1.5 text-[10px] text-amber-200">
                file truncated to first {(fileResp.maxBytes / 1024) | 0}KB
              </div>
            )}
            {resolved === 'diff' ? (
              <DiffView diffResp={diffResp} loading={diffLoading} />
            ) : resolved === 'rendered-md' ? (
              <article
                className="axiom-md p-4 text-[13px] leading-relaxed text-[var(--watch-text)]"
                dangerouslySetInnerHTML={{
                  __html: sanitizeMarkdownHtml(
                    marked.parse(fileText, { gfm: true, breaks: false, async: false }) as string,
                  ),
                }}
              />
            ) : (
              <pre className="whitespace-pre-wrap break-words p-3 font-mono text-[11px] leading-[1.45] text-[var(--watch-text)]">
                {fileText}
              </pre>
            )}
          </>
        ) : null}
      </div>
    </div>
  );
}

// ── diff view ───────────────────────────────────────────────────────────────

function DiffView({ diffResp, loading }: { diffResp: DiffResponse | null; loading: boolean }) {
  const computed = useMemo<Change[] | null>(() => {
    if (!diffResp || !diffResp.ok) return null;
    if (!diffResp.hasBefore || !diffResp.hasAfter) return null;
    return diffLines(diffResp.before || '', diffResp.after || '');
  }, [diffResp]);

  if (loading) {
    return <div className="px-3 py-2 text-xs text-[var(--watch-text-muted)]">loading diff…</div>;
  }
  if (!diffResp) return null;
  if (!diffResp.ok) {
    return <div className="px-3 py-2 text-xs text-red-300">diff error: {diffResp.error}</div>;
  }
  if (!diffResp.hasBefore && diffResp.hasAfter) {
    return (
      <div className="px-3 py-2 text-xs text-[var(--watch-text-muted)]">
        no previous snapshot for this file yet — the watcher captured the first version on its most recent change. Wait for the next edit and the diff will populate here.
      </div>
    );
  }
  if (!diffResp.hasAfter && diffResp.hasBefore) {
    return (
      <div className="px-3 py-2 text-xs text-[var(--watch-text-muted)]">
        file was deleted. Last captured contents:
        <pre className="mt-2 whitespace-pre-wrap break-words rounded bg-rose-900/20 p-2 font-mono text-[11px] text-rose-200">
          {diffResp.before}
        </pre>
      </div>
    );
  }
  if (!computed) {
    return <div className="px-3 py-2 text-xs text-[var(--watch-text-muted)]">no diff available.</div>;
  }
  if (computed.length === 1 && !computed[0].added && !computed[0].removed) {
    return <div className="px-3 py-2 text-xs text-[var(--watch-text-muted)]">no changes since the previous snapshot.</div>;
  }

  let added = 0;
  let removed = 0;
  for (const part of computed) {
    if (!part.value) continue;
    const lines = (part.value.match(/\n/g) || []).length || 1;
    if (part.added) added += lines;
    else if (part.removed) removed += lines;
  }

  return (
    <div className="font-mono text-[11px] leading-[1.5]">
      <div className="border-b border-[var(--watch-panel-border)] bg-black/30 px-3 py-1.5 text-[10px] uppercase tracking-[0.12em] text-[var(--watch-text-muted)]">
        <span className="text-emerald-300">+{added}</span>
        <span className="mx-2">/</span>
        <span className="text-rose-300">-{removed}</span>
        <span className="ml-3">vs. previous snapshot</span>
      </div>
      <div className="px-0 py-0">
        {computed.map((part, i) => (
          <DiffPart key={i} part={part} />
        ))}
      </div>
    </div>
  );
}

function DiffPart({ part }: { part: Change }) {
  if (!part.value) return null;
  const lines = part.value.split('\n');
  // diffLines often leaves a trailing "" because of the terminal newline.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const bg = part.added ? 'bg-emerald-900/30' : part.removed ? 'bg-rose-900/30' : '';
  const fg = part.added ? 'text-emerald-200' : part.removed ? 'text-rose-200' : 'text-[var(--watch-text-muted)]';
  const marker = part.added ? '+' : part.removed ? '-' : ' ';
  return (
    <>
      {lines.map((line, j) => (
        <div key={j} className={`flex ${bg}`}>
          <span className={`w-6 shrink-0 select-none px-2 text-right ${fg}`}>{marker}</span>
          <span className={`min-w-0 flex-1 whitespace-pre-wrap break-words pr-3 ${fg}`}>{line || ' '}</span>
        </div>
      ))}
    </>
  );
}
