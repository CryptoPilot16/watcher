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
    <header className="overflow-hidden rounded-[28px] border border-[var(--watch-panel-border-strong)] bg-[linear-gradient(180deg,rgba(27,22,15,0.96),rgba(18,15,11,0.96))] shadow-[0_24px_80px_rgba(0,0,0,0.28)] backdrop-blur">
      <div className="flex flex-col gap-4 p-4 sm:p-6">
        <div className="flex min-w-0 items-center gap-3 sm:gap-4">
          <img src="/watch-logo-v4.svg" alt="CLAWNUX Watch" className="h-12 w-auto shrink-0 sm:h-14" />
          <div className="min-w-0">
            <div className="text-[11px] uppercase tracking-[0.26em] text-[var(--watch-text-muted)]">
              CLAWNUX WATCH
            </div>
            <div className="mt-1 text-lg font-semibold text-[var(--watch-text)] sm:text-[1.7rem]">
              Private monitoring dashboard
            </div>
            <div className="mt-2 max-w-2xl text-sm leading-6 text-[var(--watch-text-muted)]">
              Task-first watcher for Snapmolt tracking.
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center">
          {tabs.map((tab) => {
            const isActive = tab.id === activeTab;

            return (
              <Link
                key={tab.id}
                href={tab.href}
                className={`rounded-xl border px-3 py-2 text-center text-sm transition ${
                  isActive
                    ? 'border-[var(--watch-panel-border-strong)] bg-[var(--watch-accent-soft)] text-[var(--watch-text)]'
                    : 'border-[var(--watch-panel-border)] text-[var(--watch-text-muted)] hover:bg-white/5 hover:text-[var(--watch-text)]'
                }`}
              >
                {tab.label}
              </Link>
            );
          })}
        </div>
      </div>
    </header>
  );
}
