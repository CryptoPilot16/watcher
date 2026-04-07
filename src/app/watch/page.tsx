'use client';

import { useEffect, useState } from 'react';

type WatchData = {
  ok: boolean;
  now: string;
  status: string;
  summary: string;
  sections: Record<string, string>;
};

function cleanBlock(value?: string) {
  return value?.trim() || '';
}

function getPrimaryTask(data: WatchData | null) {
  if (!data) return 'loading current Snapmolt task';

  const updateResult = cleanBlock(data.sections.updateResult);
  if (updateResult) return updateResult;

  const snapmoltOut = cleanBlock(data.sections.snapmoltOut);
  if (snapmoltOut) {
    const lines = snapmoltOut
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

    return lines.at(-1) || 'Snapmolt is running but has not emitted a task summary yet';
  }

  return 'No Snapmolt task text available yet';
}

export default function WatchPage() {
  const [data, setData] = useState<WatchData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const primaryTask = getPrimaryTask(data);
  const secondarySections = Object.entries(data?.sections || {}).filter(
    ([key]) => key !== 'updateResult',
  );

  useEffect(() => {
    let active = true;

    async function load() {
      try {
        const res = await fetch('/api/watch', {
          cache: 'no-store',
          credentials: 'same-origin',
        });

        if (res.status === 401) {
          window.location.replace('/login?redirect=/watch');
          return;
        }

        const json = (await res.json()) as WatchData;
        if (!active) return;
        setData(json);
        setError(null);
      } catch (err: any) {
        if (!active) return;
        setError(err?.message || 'failed to load watch data');
      }
    }

    load();
    const timer = window.setInterval(load, 5000);

    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  return (
    <main className="min-h-dvh px-4 py-4 sm:px-6 sm:py-6">
      <div className="mx-auto flex max-w-7xl flex-col gap-4">
        <header className="overflow-hidden rounded-2xl border border-[var(--watch-panel-border)] bg-[var(--watch-panel)] shadow-[0_0_60px_rgba(34,197,94,0.08)] backdrop-blur">
          <div className="flex flex-col gap-4 p-4 sm:p-6">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex min-w-0 items-center gap-3">
                <img
                  src="/watch-logo-v2.svg"
                  alt="CLAWNUX Watch"
                  className="h-12 w-auto sm:h-14"
                />
                <div className="min-w-0">
                  <div className="truncate text-lg font-semibold text-[var(--watch-text)] sm:text-2xl">
                    watch.clawnux.com
                  </div>
                  <div className="text-xs uppercase tracking-[0.22em] text-[var(--watch-text-muted)] sm:text-sm">
                    standalone live watcher
                  </div>
                </div>
              </div>

              <button
                type="button"
                className="rounded-xl border border-[var(--watch-panel-border)] px-3 py-2 text-sm text-[var(--watch-text)] transition hover:bg-white/5"
                onClick={() => {
                  document.cookie = 'watch_access=; Max-Age=0; Path=/; SameSite=Lax';
                  window.location.replace('/login?redirect=/watch');
                }}
              >
                logout
              </button>
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              <div className="rounded-xl border border-[var(--watch-panel-border)] bg-black/20 p-3">
                <div className="text-[11px] uppercase tracking-[0.2em] text-[var(--watch-text-muted)]">
                  status
                </div>
                <div className="mt-2 text-base font-semibold text-[var(--watch-accent)]">
                  {data?.status || 'loading'}
                </div>
              </div>
              <div className="rounded-xl border border-[var(--watch-panel-border)] bg-black/20 p-3">
                <div className="text-[11px] uppercase tracking-[0.2em] text-[var(--watch-text-muted)]">
                  summary
                </div>
                <div className="mt-2 text-sm text-[var(--watch-text)]">
                  {data?.summary || 'collecting runtime state'}
                </div>
              </div>
              <div className="rounded-xl border border-[var(--watch-panel-border)] bg-black/20 p-3">
                <div className="text-[11px] uppercase tracking-[0.2em] text-[var(--watch-text-muted)]">
                  updated
                </div>
                <div className="mt-2 text-sm text-[var(--watch-text)]">
                  {data?.now || 'pending'}
                </div>
              </div>
            </div>

            {error ? (
              <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-[var(--watch-danger)]">
                {error}
              </div>
            ) : null}
          </div>
        </header>

        <section className="grid gap-4 xl:grid-cols-2">
          <article className="overflow-hidden rounded-2xl border border-[var(--watch-accent)] bg-[linear-gradient(135deg,rgba(18,28,19,0.96),rgba(12,18,14,0.92))] shadow-[0_0_80px_rgba(74,222,128,0.12)] xl:col-span-2">
            <div className="border-b border-[var(--watch-accent)]/30 px-4 py-3 text-[11px] uppercase tracking-[0.25em] text-[var(--watch-accent)]">
              current snapmolt task
            </div>
            <div className="p-4 sm:p-6">
              <pre className="whitespace-pre-wrap break-words font-mono text-sm leading-7 text-[var(--watch-text)] sm:text-base">
                {primaryTask}
              </pre>
            </div>
          </article>

          {data
            ? secondarySections.map(([key, value]) => (
                <article
                  key={key}
                  className="overflow-hidden rounded-2xl border border-[var(--watch-panel-border)] bg-[var(--watch-panel)]"
                >
                  <div className="border-b border-[var(--watch-panel-border)] px-4 py-3 text-[11px] uppercase tracking-[0.25em] text-[var(--watch-text-muted)]">
                    {key}
                  </div>
                  <pre className="max-h-[45vh] overflow-auto p-4 text-xs leading-6 text-[var(--watch-text)] sm:max-h-[52vh]">
                    {value || '(empty)'}
                  </pre>
                </article>
              ))
            : Array.from({ length: 4 }).map((_, index) => (
                <div
                  key={index}
                  className="h-40 animate-pulse rounded-2xl border border-[var(--watch-panel-border)] bg-[var(--watch-panel)]"
                />
              ))}
        </section>
      </div>
    </main>
  );
}
