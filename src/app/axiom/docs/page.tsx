'use client';

import { useEffect, useRef, useState } from 'react';
import { AdminShellHeader } from '@/components/admin-shell-header';

type Section = { id: string; heading: string; body: string };
type Diagram = { id: string; title: string; mermaid: string };
type DocsResponse = {
  ok: boolean;
  generatedAt: string;
  sections: Section[];
  diagrams: Diagram[];
  lessonsAvailable: boolean;
};

// Map diagram IDs to which "vibe" section they live under, so we can interleave
// the casual prose with the structural diagrams instead of dumping all 10 at
// the bottom.
const DIAGRAM_PLACEMENT: Record<string, string> = {
  'D-01': 'the-stack',
  'D-02': 'the-stack',
  'D-03': 'the-stack',
  'D-04': 'phase-plan',
  'D-05': 'how-a-flight-works',
  'D-06': 'how-a-flight-works',
  'D-07': 'how-a-flight-works',
  'D-08': 'how-a-flight-works',
  'D-09': 'mvp-deploy',
  'D-10': 'phase-plan',
};

function mermaidLink(diagram: Diagram): string {
  // mermaid.live accepts a base64 of {code, mermaid: {theme: 'dark'}}
  try {
    const payload = { code: diagram.mermaid, mermaid: { theme: 'dark' } };
    const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(payload))));
    return `https://mermaid.live/edit#base64:${b64}`;
  } catch {
    return 'https://mermaid.live';
  }
}

function MermaidBlock({ diagram }: { diagram: Diagram }) {
  const ref = useRef<HTMLDivElement>(null);
  const [rendered, setRendered] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    async function render() {
      try {
        const mermaid = (await import('mermaid')).default;
        mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'loose', fontFamily: 'inherit' });
        const id = `m-${diagram.id.replace(/[^a-z0-9]/gi, '')}-${Date.now()}`;
        const { svg } = await mermaid.render(id, diagram.mermaid);
        if (!cancelled) setRendered(svg);
      } catch (e: any) {
        if (!cancelled) setErr(String(e?.message || e || 'mermaid render failed'));
      }
    }
    render();
    return () => {
      cancelled = true;
    };
  }, [diagram.id, diagram.mermaid]);

  return (
    <div className="rounded-xl border border-[var(--watch-panel-border)] bg-[rgba(0,0,0,0.18)] p-4 sm:p-5">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <div className="text-[10px] uppercase tracking-[0.24em] text-[var(--watch-text-muted)]">
          ▌ {diagram.id} · {diagram.title}
        </div>
        <a
          href={mermaidLink(diagram)}
          target="_blank"
          rel="noreferrer"
          className="text-[10px] uppercase tracking-[0.16em] text-[var(--watch-text-muted)] hover:text-[var(--watch-text-bright)]"
        >
          edit on mermaid.live ↗
        </a>
      </div>
      <div ref={ref} className="overflow-x-auto rounded bg-[rgba(255,255,255,0.02)] p-3">
        {err ? (
          <pre className="whitespace-pre-wrap text-[11px] text-[#f87171]">{err}\n\n{diagram.mermaid}</pre>
        ) : rendered ? (
          <div dangerouslySetInnerHTML={{ __html: rendered }} />
        ) : (
          <div className="text-[11px] text-[var(--watch-text-muted)]">rendering…</div>
        )}
      </div>
    </div>
  );
}

function SectionView({ section, diagrams }: { section: Section; diagrams: Diagram[] }) {
  const placedHere = diagrams.filter((d) => DIAGRAM_PLACEMENT[d.id] === section.id);
  return (
    <section id={section.id} className="space-y-3">
      <div className="rounded-xl border border-[var(--watch-panel-border)] bg-[rgba(0,0,0,0.18)] p-4 sm:p-5">
        <div className="text-[10px] uppercase tracking-[0.24em] text-[var(--watch-text-muted)]">▌ {section.heading}</div>
        <div className="mt-3 space-y-3 text-sm leading-relaxed text-[var(--watch-text-bright)] sm:text-[15px]">
          {section.body.split('\n\n').map((p, i) => (
            <p key={i} className="whitespace-pre-wrap">
              {p}
            </p>
          ))}
        </div>
      </div>
      {placedHere.map((d) => (
        <MermaidBlock key={d.id} diagram={d} />
      ))}
    </section>
  );
}

export default function DocsPage() {
  const [data, setData] = useState<DocsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    fetch('/api/axiom/docs', { cache: 'no-store' })
      .then((r) => r.json())
      .then((j) => setData(j))
      .catch((e) => setError(String(e?.message || e || 'failed to load')));
  }, []);

  return (
    <main className="min-h-screen bg-[var(--watch-bg)] p-3 sm:p-5">
      <div className="mx-auto flex min-h-[calc(100vh-24px)] max-w-[1100px] flex-col gap-3">
        <AdminShellHeader activeTab="docs" />

        <div className="rounded-xl border border-[var(--watch-panel-border)] bg-[rgba(0,0,0,0.18)] px-4 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="text-[10px] uppercase tracking-[0.24em] text-[var(--watch-text-muted)]">▌ AXIOM docs · vibe-coder edition</div>
            <span className="rounded-full border border-[#86efac]/30 bg-[#86efac]/10 px-2 py-0.5 text-[9px] uppercase tracking-[0.18em] text-[#86efac]">
              Phase 0 · complete
            </span>
            <span className="rounded-full border border-[#7dd3fc]/30 bg-[#7dd3fc]/10 px-2 py-0.5 text-[9px] uppercase tracking-[0.18em] text-[#7dd3fc]">
              Phase 1 · in flight
            </span>
          </div>
          <div className="mt-2 text-sm text-[var(--watch-text-bright)]">
            What AXIOM is, the stack, how a flight cycle moves through it, and how to deploy it on a single VPS — explained without jargon. Diagrams sourced from <code className="rounded bg-white/5 px-1 text-[12px]">/opt/axiom/AXIOM_DIAGRAMS.md</code>; deeper docs are linked at the bottom.
          </div>
        </div>

        {!data && !error && (
          <div className="rounded-xl border border-[var(--watch-panel-border)] bg-[rgba(0,0,0,0.18)] p-4 text-xs uppercase tracking-[0.18em] text-[var(--watch-text-muted)]">
            loading…
          </div>
        )}
        {error && (
          <div className="rounded-xl border border-[var(--watch-panel-border)] bg-[rgba(0,0,0,0.18)] p-4 text-xs text-[#f87171]">
            error: {error}
          </div>
        )}

        {data && (
          <>
            {/* TOC */}
            <div className="rounded-xl border border-[var(--watch-panel-border)] bg-[rgba(0,0,0,0.18)] p-3 sm:p-4">
              <div className="text-[10px] uppercase tracking-[0.24em] text-[var(--watch-text-muted)]">▌ jump to</div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {data.sections.map((s) => (
                  <a
                    key={s.id}
                    href={`#${s.id}`}
                    className="rounded border border-[var(--watch-panel-border)] px-2 py-1 text-[10px] uppercase tracking-[0.16em] text-[var(--watch-text-muted)] hover:border-[var(--watch-panel-border-strong)] hover:text-[var(--watch-text-bright)]"
                  >
                    {s.heading.split(',')[0]}
                  </a>
                ))}
              </div>
            </div>

            {data.sections.map((s) => (
              <SectionView key={s.id} section={s} diagrams={data.diagrams} />
            ))}

            <div className="rounded-xl border border-[var(--watch-panel-border)] bg-[rgba(0,0,0,0.18)] p-4 sm:p-5">
              <div className="text-[10px] uppercase tracking-[0.24em] text-[var(--watch-text-muted)]">▌ deeper docs (in /opt/axiom)</div>
              <ul className="mt-3 space-y-1 text-sm text-[var(--watch-text-bright)]">
                <li>
                  <code className="rounded bg-white/5 px-1 text-[12px]">AXIOM_MASTERPLAN.md</code> — the binding plan, all 5 phases, costs, rationale
                </li>
                <li>
                  <code className="rounded bg-white/5 px-1 text-[12px]">AXIOM_TECHSTACK.md</code> — every dependency, every version, every why
                </li>
                <li>
                  <code className="rounded bg-white/5 px-1 text-[12px]">AXIOM_DIAGRAMS.md</code> — source for every diagram on this page
                </li>
                <li>
                  <code className="rounded bg-white/5 px-1 text-[12px]">AXIOM_DEPARTMENTS.md</code> — D1..D10 roles, OD-NN process
                </li>
                <li>
                  <code className="rounded bg-white/5 px-1 text-[12px]">AXIOM_PHASE0_LESSONS.md</code> — what we learned closing Phase 0
                </li>
              </ul>
            </div>
          </>
        )}
      </div>
    </main>
  );
}
