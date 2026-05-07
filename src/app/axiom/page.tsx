'use client';

import dynamic from 'next/dynamic';
import { useMemo } from 'react';
import { WatchShellHeader } from '@/components/watch-shell-header';
import { buildAxiomAgents } from '@/components/axiom-office/axiom-canvas';

const AxiomOfficeCanvas = dynamic(
  () => import('@/components/axiom-office/axiom-canvas').then((mod) => mod.AxiomOfficeCanvas),
  { ssr: false, loading: () => <div className="h-[86dvh] min-h-[560px] w-full animate-pulse rounded-xl border border-[var(--watch-panel-border)] bg-[var(--watch-panel)]" /> },
);

export default function AxiomPage() {
  const agents = useMemo(() => buildAxiomAgents(), []);

  return (
    <main className="mx-auto flex max-w-[1400px] flex-col gap-3 p-3 sm:gap-4 sm:p-5">
      <WatchShellHeader activeTab="axiom" />
      <section className="rounded-lg border border-[var(--watch-panel-border)] bg-[var(--watch-panel)] p-3 sm:p-4">
        <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 className="text-sm font-semibold uppercase tracking-[0.2em] text-[var(--watch-text-bright)]">AXIOM Office</h2>
          <span className="text-[11px] uppercase tracking-[0.15em] text-[var(--watch-text-muted)]">
            51 Claude Code agents · 10 teams of 5 · 1 CEO
          </span>
        </div>
        <AxiomOfficeCanvas agents={agents} />
      </section>
    </main>
  );
}
