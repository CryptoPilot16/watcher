'use client';

import { useEffect, useState } from 'react';
import { WatchShellHeader } from '@/components/watch-shell-header';

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
        <WatchShellHeader activeTab="watch" />

        {error ? (
          <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-[var(--watch-danger)]">
            {error}
          </div>
        ) : null}

        <section className="grid gap-4 xl:grid-cols-2">
          <article className="overflow-hidden rounded-[28px] border border-[var(--watch-panel-border-strong)] bg-[linear-gradient(135deg,rgba(36,29,18,0.96),rgba(18,15,11,0.96))] shadow-[0_24px_80px_rgba(0,0,0,0.24)] xl:col-span-2">
            <div className="border-b border-[var(--watch-panel-border)] px-4 py-3 text-[11px] uppercase tracking-[0.25em] text-[var(--watch-accent-strong)]">
              snapmolt mirror
            </div>
            <div className="grid gap-6 p-4 sm:p-6 lg:grid-cols-[1.4fr_0.6fr]">
              <pre className="min-h-[280px] rounded-[24px] border border-[var(--watch-panel-border-strong)] bg-[rgba(0,0,0,0.24)] p-5 text-base leading-8 text-[var(--watch-text)] sm:text-[1.05rem]">
                {primaryTask}
              </pre>

              <div className="grid gap-3">
                <div className="rounded-[24px] border border-[var(--watch-panel-border)] bg-[rgba(255,255,255,0.02)] p-4">
                  <div className="text-[10px] uppercase tracking-[0.26em] text-[var(--watch-text-muted)]">
                    priority view
                  </div>
                  <div className="mt-2 text-sm leading-7 text-[var(--watch-text)]">
                    Snapmolt mirror is the main surface and stays above every other signal on the page.
                  </div>
                </div>
                <div className="rounded-[24px] border border-[var(--watch-panel-border)] bg-[rgba(255,255,255,0.02)] p-4">
                  <div className="text-[10px] uppercase tracking-[0.26em] text-[var(--watch-text-muted)]">
                    latest sync
                  </div>
                  <div className="mt-2 text-sm leading-7 text-[var(--watch-text)]">
                    This page refreshes every 5 seconds and mirrors the same watcher state used by the Telegram relay.
                  </div>
                </div>
              </div>
            </div>
          </article>

          <section className="grid gap-3 sm:grid-cols-3 xl:col-span-2">
            <div className="rounded-[24px] border border-[var(--watch-panel-border)] bg-[var(--watch-panel)] p-4 shadow-[0_18px_50px_rgba(0,0,0,0.18)]">
              <div className="text-[11px] uppercase tracking-[0.2em] text-[var(--watch-text-muted)]">
                status
              </div>
              <div className="mt-2 text-base font-semibold text-[var(--watch-accent)]">
                {data?.status || 'loading'}
              </div>
            </div>
            <div className="rounded-[24px] border border-[var(--watch-panel-border)] bg-[var(--watch-panel)] p-4 shadow-[0_18px_50px_rgba(0,0,0,0.18)]">
              <div className="text-[11px] uppercase tracking-[0.2em] text-[var(--watch-text-muted)]">
                summary
              </div>
              <div className="mt-2 text-sm text-[var(--watch-text)]">
                {data?.summary || 'collecting runtime state'}
              </div>
            </div>
            <div className="rounded-[24px] border border-[var(--watch-panel-border)] bg-[var(--watch-panel)] p-4 shadow-[0_18px_50px_rgba(0,0,0,0.18)]">
              <div className="text-[11px] uppercase tracking-[0.2em] text-[var(--watch-text-muted)]">
                updated
              </div>
              <div className="mt-2 text-sm text-[var(--watch-text)]">
                {data?.now || 'pending'}
              </div>
            </div>
          </section>

          {data
            ? secondarySections.map(([key, value]) => (
                <article
                  key={key}
                  className="overflow-hidden rounded-[24px] border border-[var(--watch-panel-border)] bg-[var(--watch-panel)] shadow-[0_18px_50px_rgba(0,0,0,0.18)]"
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
                  className="h-40 animate-pulse rounded-[24px] border border-[var(--watch-panel-border)] bg-[var(--watch-panel)]"
                />
              ))}
        </section>
      </div>
    </main>
  );
}
