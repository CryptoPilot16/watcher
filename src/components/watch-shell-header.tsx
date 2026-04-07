'use client';

import Link from 'next/link';

type WatchShellHeaderProps = {
  activeTab: 'watch' | 'docs';
};

const tabs = [
  { id: 'watch', label: 'watch', href: '/watch' },
  { id: 'docs', label: 'docs', href: '/docs' },
] as const;

export function WatchShellHeader({ activeTab }: WatchShellHeaderProps) {
  return (
    <header className="overflow-hidden rounded-2xl border border-[var(--watch-panel-border)] bg-[var(--watch-panel)] shadow-[0_0_60px_rgba(34,197,94,0.08)] backdrop-blur">
      <div className="flex flex-col gap-4 p-4 sm:p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <img src="/watch-logo-v2.svg" alt="CLAWNUX Watch" className="h-12 w-auto sm:h-14" />
            <div className="min-w-0">
              <div className="truncate text-lg font-semibold text-[var(--watch-text)] sm:text-2xl">
                watch.clawnux.com
              </div>
              <div className="text-xs uppercase tracking-[0.22em] text-[var(--watch-text-muted)] sm:text-sm">
                private monitoring dashboard
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {tabs.map((tab) => {
              const isActive = tab.id === activeTab;

              return (
                <Link
                  key={tab.id}
                  href={tab.href}
                  className={`rounded-xl border px-3 py-2 text-sm transition ${
                    isActive
                      ? 'border-[var(--watch-accent)] bg-[rgba(74,222,128,0.12)] text-[var(--watch-text)]'
                      : 'border-[var(--watch-panel-border)] text-[var(--watch-text-muted)] hover:bg-white/5 hover:text-[var(--watch-text)]'
                  }`}
                >
                  {tab.label}
                </Link>
              );
            })}

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
        </div>
      </div>
    </header>
  );
}
