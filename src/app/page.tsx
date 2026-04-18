import Link from 'next/link';

const featureCards = [
  {
    eyebrow: 'dashboard',
    title: 'Authenticated ops view',
    body:
      'Watch live session turns, system health, team lanes, activity, and service status from one operator screen.',
  },
  {
    eyebrow: 'visualization',
    title: '3D office preview',
    body:
      'Render your agent team as a live office floor with lane-aware seating, worker states, and a public read-only preview.',
  },
  {
    eyebrow: 'control',
    title: 'Lane-aware routing',
    body:
      'Send work into bound Telegram or agent sessions from the web UI instead of broadcasting into the wrong lane.',
  },
  {
    eyebrow: 'ops',
    title: 'Built for real operators',
    body:
      'Self-hosted, mobile-friendly, and designed to surface the essentials instead of burying them in raw logs.',
  },
];

const routeCards = [
  { route: '/', note: 'public landing page' },
  { route: '/watch', note: 'authenticated dashboard' },
  { route: '/office-preview', note: 'public office preview' },
  { route: '/office-preview?debug=1', note: 'public debug HUD' },
  { route: '/docs', note: 'authenticated reference' },
];

const shipCards = [
  'Mission status banner with auth, session, and run health.',
  'Live session feed built from active OpenClaw session files.',
  'Activity view for recent runs, flows, and service signals.',
  'Processes view with readable PM2 service health cards.',
  'Telegram polling loop for mirrored watcher summaries.',
  'Interactive office scene with public sanitized preview.',
];

export default function HomePage() {
  return (
    <main className="min-h-dvh px-3 py-3 sm:px-5 sm:py-5">
      <div className="mx-auto flex max-w-6xl flex-col gap-3">
        <section className="overflow-hidden rounded-lg border border-[var(--watch-panel-border-strong)] bg-[linear-gradient(135deg,rgba(24,20,14,0.97),rgba(16,13,9,0.97))] shadow-[0_8px_40px_rgba(0,0,0,0.28)]">
          <div className="flex flex-col gap-6 p-4 sm:p-6">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <img src="/watch-logo-v4.svg" alt="Watcher" className="h-11 w-11 rounded sm:h-14 sm:w-14" />
                <div>
                  <div className="watch-display text-2xl font-semibold uppercase text-[var(--watch-accent-strong)] sm:text-4xl">Watcher</div>
                  <div className="mt-1 text-[11px] uppercase tracking-[0.22em] text-[var(--watch-text-muted)]">self-hosted mission control for agent teams</div>
                </div>
              </div>

              <div className="flex flex-wrap gap-2">
                <Link href="/office-preview" className="rounded border border-[var(--watch-panel-border)] px-3 py-2 text-xs uppercase tracking-[0.16em] text-[var(--watch-text)] transition-colors hover:border-[var(--watch-panel-border-strong)] hover:text-[var(--watch-accent-strong)]">
                  office preview
                </Link>
                <Link href="/login?redirect=%2Fwatch" className="rounded border border-[var(--watch-panel-border-strong)] bg-[var(--watch-accent-soft)] px-3 py-2 text-xs uppercase tracking-[0.16em] text-[var(--watch-text)] transition-colors hover:border-[var(--watch-accent)] hover:text-[var(--watch-accent-strong)]">
                  open dashboard
                </Link>
                <a href="https://github.com/CryptoPilot16/watcher" target="_blank" rel="noreferrer" className="rounded border border-[var(--watch-panel-border)] px-3 py-2 text-xs uppercase tracking-[0.16em] text-[var(--watch-text)] transition-colors hover:border-[var(--watch-panel-border-strong)] hover:text-[var(--watch-accent-strong)]">
                  github
                </a>
              </div>
            </div>

            <div className="grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
              <div className="rounded border border-[var(--watch-panel-border)] bg-[rgba(255,255,255,0.02)] p-4 sm:p-5">
                <div className="text-[10px] uppercase tracking-[0.28em] text-[var(--watch-text-muted)]">what watcher is</div>
                <h1 className="mt-3 max-w-3xl text-3xl font-semibold leading-tight text-[var(--watch-text-bright)] sm:text-5xl">
                  A clean operator view for live agent systems.
                </h1>
                <p className="mt-4 max-w-2xl text-sm leading-7 text-[var(--watch-text-muted)] sm:text-base">
                  Watcher gives you a self-hosted control surface for OpenClaw-style agent stacks. It combines live session monitoring,
                  team visualization, recent execution activity, and service health into a dashboard that stays readable on desktop and mobile.
                </p>
              </div>

              <div className="rounded border border-[var(--watch-panel-border)] bg-[rgba(255,255,255,0.02)] p-4 sm:p-5">
                <div className="text-[10px] uppercase tracking-[0.28em] text-[var(--watch-text-muted)]">what ships today</div>
                <div className="mt-3 flex flex-col gap-3 text-sm leading-7 text-[var(--watch-text-muted)]">
                  {shipCards.map((item) => (
                    <div key={item} className="flex items-start gap-3">
                      <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--watch-accent)]" />
                      <span>{item}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {featureCards.map((card) => (
            <article key={card.title} className="rounded border border-[var(--watch-panel-border)] bg-[var(--watch-panel)] p-4">
              <div className="text-[10px] uppercase tracking-[0.24em] text-[var(--watch-text-muted)]">{card.eyebrow}</div>
              <h2 className="mt-3 text-lg font-semibold text-[var(--watch-text-bright)]">{card.title}</h2>
              <p className="mt-2 text-sm leading-7 text-[var(--watch-text-muted)]">{card.body}</p>
            </article>
          ))}
        </section>

        <section className="grid gap-3 lg:grid-cols-[0.95fr_1.05fr]">
          <article className="rounded border border-[var(--watch-panel-border)] bg-[var(--watch-panel)] p-4 sm:p-5">
            <div className="text-[10px] uppercase tracking-[0.28em] text-[var(--watch-text-muted)]">routes</div>
            <div className="mt-4 flex flex-col gap-3">
              {routeCards.map((card) => (
                <div key={card.route} className="rounded border border-[var(--watch-panel-border)] bg-[rgba(255,255,255,0.02)] px-3 py-3">
                  <div className="text-sm font-semibold text-[var(--watch-text-bright)]">{card.route}</div>
                  <div className="mt-1 text-xs uppercase tracking-[0.16em] text-[var(--watch-text-muted)]">{card.note}</div>
                </div>
              ))}
            </div>
          </article>

          <article className="rounded border border-[var(--watch-panel-border)] bg-[var(--watch-panel)] p-4 sm:p-5">
            <div className="text-[10px] uppercase tracking-[0.28em] text-[var(--watch-text-muted)]">open source setup</div>
            <div className="mt-4 rounded border border-[var(--watch-panel-border)] bg-[rgba(0,0,0,0.2)] p-4">
              <pre className="text-[11px] leading-7 text-[var(--watch-text-code)] sm:text-xs">{`npm install
bash scripts/fetch-models.sh
cp .env.example .env.local
npm run dev`}</pre>
            </div>
            <p className="mt-3 text-sm leading-7 text-[var(--watch-text-muted)]">
              Set <span className="text-[var(--watch-text-bright)]">WATCH_PASSWORD</span> for the dashboard login. Add the optional Telegram env vars if you want
              the watcher summary loop enabled.
            </p>
          </article>
        </section>
      </div>
    </main>
  );
}
