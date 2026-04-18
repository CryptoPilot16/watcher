import Link from 'next/link';

const featureCards = [
  {
    eyebrow: 'status',
    title: 'Live session feed',
    body:
      'Read the active session directly, watch user turns, agent replies, and tool calls as they happen, and see when the system is actively in session.',
  },
  {
    eyebrow: 'office',
    title: '3D team office',
    body:
      'View your lanes as a live office floor with desk ownership, running and recent states, progress bars, focus modes, and swappable office or dungeon scenes.',
  },
  {
    eyebrow: 'control',
    title: 'Lane-bound web relay',
    body:
      'Send instructions into the exact bound Telegram or agent session from the office UI instead of tossing messages into the wrong lane.',
  },
  {
    eyebrow: 'activity',
    title: 'Runs, flows, and service signals',
    body:
      'Track recent task runs, multi-step flows, cron results, and useful log lines without digging through raw infrastructure output.',
  },
  {
    eyebrow: 'preview',
    title: 'Public office preview',
    body:
      'Share a sanitized read-only office view publicly while stripping private task text, and enable a DOM debug HUD when you need to verify state without trusting WebGL.',
  },
  {
    eyebrow: 'ops',
    title: 'Readable service health',
    body:
      'Keep PM2 services, auth state, and stale-fault cleanup in one place, with a layout that still works on mobile.',
  },
];

const routeCards = [
  { route: '/', note: 'public landing page' },
  { route: '/watch', note: 'authenticated dashboard with status, office, team, activity, and processes tabs' },
  { route: '/office-preview', note: 'public sanitized office view' },
  { route: '/office-preview?debug=1', note: 'public DOM debug HUD for lane mode and progress checks' },
  { route: '/docs', note: 'authenticated in-app reference' },
  { route: '/api/watch', note: 'JSON snapshot for automation or external mirrors' },
];

const shipCards = [
  'Mission banner with overall health, model, auth state, session activity, and stale-fault cleanup.',
  'Live session feed sourced from the active OpenClaw session file, not just task history.',
  'Tabbed dashboard: status, office, team, activity, and processes.',
  'Interactive team office with lane seating, progress bars, camera controls, and office or dungeon styles.',
  'Web-to-chat lane relay from the office UI into the correct bound session.',
  'Public office preview plus DOM debug mode for reliable state validation when WebGL is flaky.',
  'Recent runs, flows, cron snapshots, and service signals in one operator view.',
  'PM2 service health cards and optional Telegram watcher mirror loop.',
];

const stackCards = [
  'Next.js 14, React, and TypeScript for the app shell.',
  'Three.js, react-three-fiber, and drei for the office scene.',
  'OpenClaw session files, runs.sqlite, flow registry, cron logs, and PM2 as the live data sources.',
  'Password-gated dashboard with optional API key, session secret, and Telegram loop config.',
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
                  <div className="mt-1 text-[11px] uppercase tracking-[0.22em] text-[var(--watch-text-muted)]">self-hosted mission control for OpenClaw agent teams</div>
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
                <div className="text-[10px] uppercase tracking-[0.28em] text-[var(--watch-text-muted)]">what watcher is now</div>
                <h1 className="mt-3 max-w-3xl text-3xl font-semibold leading-tight text-[var(--watch-text-bright)] sm:text-5xl">
                  The operator layer for a live agent team.
                </h1>
                <p className="mt-4 max-w-2xl text-sm leading-7 text-[var(--watch-text-muted)] sm:text-base">
                  Watcher is a self-hosted dashboard for OpenClaw environments. It pairs a real-time session feed, lane-aware team view,
                  activity history, service health, and an interactive 3D office so you can see what the team is doing and steer the right lane fast.
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

        <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
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
            <div className="text-[10px] uppercase tracking-[0.28em] text-[var(--watch-text-muted)]">stack and setup</div>
            <div className="mt-4 rounded border border-[var(--watch-panel-border)] bg-[rgba(0,0,0,0.2)] p-4">
              <pre className="text-[11px] leading-7 text-[var(--watch-text-code)] sm:text-xs">{`npm install
bash scripts/fetch-models.sh
cp .env.example .env.local
npm run dev`}</pre>
            </div>
            <div className="mt-3 flex flex-col gap-3 text-sm leading-7 text-[var(--watch-text-muted)]">
              <p>
                Set <span className="text-[var(--watch-text-bright)]">WATCH_PASSWORD</span> for dashboard access. Add the optional API,
                session, and Telegram env vars when you want browser sessions, automation, or the Telegram mirror loop.
              </p>
              <div className="grid gap-2 sm:grid-cols-2">
                {stackCards.map((item) => (
                  <div key={item} className="rounded border border-[var(--watch-panel-border)] bg-[rgba(255,255,255,0.02)] px-3 py-2.5 text-xs leading-6 text-[var(--watch-text-muted)]">
                    {item}
                  </div>
                ))}
              </div>
            </div>
          </article>
        </section>
      </div>
    </main>
  );
}
