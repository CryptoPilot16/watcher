'use client';

import Link from 'next/link';

type AdminShellHeaderProps = {
  activeTab: 'axiom' | 'tasks' | 'project' | 'settings';
};

const tabs = [
  { id: 'axiom', label: 'axiom', href: '/axiom' },
  { id: 'tasks', label: 'tasks', href: '/axiom/tasks' },
  { id: 'project', label: 'project', href: '/axiom/project' },
  { id: 'settings', label: 'settings', href: '/axiom/settings' },
] as const;

async function logout() {
  try {
    await fetch('/api/admin/auth/logout', { method: 'POST', credentials: 'same-origin' });
  } catch {}
  window.location.replace('/axiom/login');
}

export function AdminShellHeader({ activeTab }: AdminShellHeaderProps) {
  return (
    <header className="overflow-hidden rounded-lg border border-[var(--watch-panel-border-strong)] bg-[linear-gradient(180deg,rgba(27,22,15,0.97),rgba(18,15,11,0.97))] shadow-[0_8px_32px_rgba(0,0,0,0.32)] backdrop-blur">
      <div className="flex flex-col gap-3 p-3 sm:flex-row sm:items-start sm:justify-between sm:p-5">
        <div className="flex min-w-0 items-center gap-3">
          <Link href="/axiom" className="shrink-0">
            <img src="/watch-logo-v4.svg" alt="ADMIN" className="h-9 w-9 rounded sm:h-12 sm:w-12" />
          </Link>
          <div className="min-w-0">
            <div className="watch-display text-lg font-semibold uppercase text-[var(--watch-accent-strong)] sm:text-2xl">
              Admin
            </div>
            <div className="text-[10px] uppercase tracking-[0.18em] text-[var(--watch-text-muted)]">
              AXIOM Office
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1 sm:shrink-0 sm:self-start">
          {tabs.map((tab) => {
            const isActive = tab.id === activeTab;
            return (
              <Link
                key={tab.id}
                href={tab.href}
                className={`rounded border px-2 py-1.5 text-[10px] tracking-[0.15em] uppercase transition-colors whitespace-nowrap sm:px-3 sm:text-xs ${
                  isActive
                    ? 'border-[var(--watch-panel-border-strong)] bg-[var(--watch-accent-soft)] text-[var(--watch-text)]'
                    : 'border-[var(--watch-panel-border)] text-[var(--watch-text-muted)] hover:border-[var(--watch-panel-border-strong)] hover:text-[var(--watch-text)]'
                }`}
              >
                {tab.label}
              </Link>
            );
          })}
          <button
            type="button"
            onClick={logout}
            className="rounded border border-white/10 px-2 py-1.5 text-[10px] tracking-[0.15em] uppercase text-white/55 hover:border-white/30 hover:text-white/85 sm:px-3 sm:text-xs"
          >
            sign out
          </button>
        </div>
      </div>
    </header>
  );
}
