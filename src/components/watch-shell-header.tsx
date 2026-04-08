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
    <header className="overflow-hidden rounded-lg border border-[var(--watch-panel-border-strong)] bg-[linear-gradient(180deg,rgba(27,22,15,0.97),rgba(18,15,11,0.97))] shadow-[0_8px_32px_rgba(0,0,0,0.32)] backdrop-blur">
      <div className="flex flex-col gap-3 p-4 sm:p-5">
        <div className="flex min-w-0 items-center gap-3">
          <img src="/watch-logo-v4.svg" alt="CLAWNUX Watch" className="h-10 w-auto shrink-0 sm:h-12" />
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-[0.3em] text-[var(--watch-text-muted)]">
              CLAWNUX WATCH
            </div>
            <div className="mt-0.5 text-base font-semibold tracking-tight text-[var(--watch-text)] sm:text-xl">
              Private monitoring dashboard
            </div>
          </div>
        </div>

        <div className="flex items-center gap-1 overflow-x-auto">
          {tabs.map((tab) => {
            const isActive = tab.id === activeTab;

            return (
              <Link
                key={tab.id}
                href={tab.href}
                className={`rounded border px-3 py-1.5 text-xs tracking-[0.15em] uppercase transition-colors whitespace-nowrap ${
                  isActive
                    ? 'border-[var(--watch-panel-border-strong)] bg-[var(--watch-accent-soft)] text-[var(--watch-text)]'
                    : 'border-[var(--watch-panel-border)] text-[var(--watch-text-muted)] hover:border-[var(--watch-panel-border-strong)] hover:text-[var(--watch-text)]'
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
