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
      <div className="border-b border-[var(--watch-panel-border)] px-4 py-2 text-[10px] uppercase tracking-[0.28em] text-[var(--watch-text-muted)] sm:px-6">
        operator shell / authenticated session / watch.clawnux.com
      </div>

      <div className="flex flex-col gap-5 p-4 sm:p-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex min-w-0 items-start gap-4">
            <img src="/watch-logo-v3.svg" alt="CLAWNUX Watch" className="h-14 w-auto sm:h-16" />
            <div className="min-w-0">
              <div className="text-[11px] uppercase tracking-[0.26em] text-[var(--watch-text-muted)]">
                CLAWNUX WATCH
              </div>
              <div className="mt-2 break-all text-xl font-semibold text-[var(--watch-text)] sm:text-[2rem]">
                watch.clawnux.com
              </div>
              <div className="mt-2 max-w-2xl text-sm leading-7 text-[var(--watch-text-muted)]">
                Terminal-style control surface for task visibility, live runtime monitoring, and Telegram relay output.
              </div>
            </div>
          </div>

          <div className="flex flex-col items-stretch gap-3 sm:items-end">
            <div className="rounded-full border border-[var(--watch-panel-border)] bg-[var(--watch-accent-soft)] px-3 py-1 text-[10px] uppercase tracking-[0.26em] text-[var(--watch-accent-strong)]">
              mobile-ready web app
            </div>

            <div className="flex flex-wrap items-center gap-2">
            {tabs.map((tab) => {
              const isActive = tab.id === activeTab;

              return (
                <Link
                  key={tab.id}
                  href={tab.href}
                  className={`rounded-xl border px-3 py-2 text-sm transition ${
                    isActive
                      ? 'border-[var(--watch-panel-border-strong)] bg-[var(--watch-accent-soft)] text-[var(--watch-text)]'
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

        <div className="grid gap-3 sm:grid-cols-3">
          <div className="rounded-2xl border border-[var(--watch-panel-border)] bg-[rgba(255,255,255,0.02)] px-4 py-3">
            <div className="text-[10px] uppercase tracking-[0.26em] text-[var(--watch-text-muted)]">
              interface
            </div>
            <div className="mt-2 text-sm text-[var(--watch-text)]">terminal-inspired / muted amber / task-first</div>
          </div>
          <div className="rounded-2xl border border-[var(--watch-panel-border)] bg-[rgba(255,255,255,0.02)] px-4 py-3">
            <div className="text-[10px] uppercase tracking-[0.26em] text-[var(--watch-text-muted)]">
              routing
            </div>
            <div className="mt-2 text-sm text-[var(--watch-text)]">watch + docs tabs with a shared shell</div>
          </div>
          <div className="rounded-2xl border border-[var(--watch-panel-border)] bg-[rgba(255,255,255,0.02)] px-4 py-3">
            <div className="text-[10px] uppercase tracking-[0.26em] text-[var(--watch-text-muted)]">
              viewport
            </div>
            <div className="mt-2 text-sm text-[var(--watch-text)]">optimized for desktop monitoring and handheld checks</div>
          </div>
        </div>
      </div>
    </header>
  );
}
