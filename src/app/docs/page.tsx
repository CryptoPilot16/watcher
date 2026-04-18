import { WatchShellHeader } from '@/components/watch-shell-header';

const dashboardSections = [
  {
    title: 'Mission status banner',
    body:
      'Always-visible banner at the top of the status tab. Color-coded: green NOMINAL, amber DEGRADED, red FAULT. Shows the active OpenClaw version, model in use, and a pulsing "in session" indicator whenever the agent is actively processing a Telegram conversation.',
  },
  {
    title: 'Live session feed',
    body:
      'Reads the active session JSONL directly from the OpenClaw sessions directory. Shows real-time conversation turns — user messages, agent replies, and tool calls — newest first. Updates on every dashboard poll. This is the only source that captures live Telegram conversations; runs.sqlite only records discrete task completions.',
  },
  {
    title: 'Health cards',
    body:
      'Per-subsystem health derived from auth-state.json and runs.sqlite. Flags auth providers in cooldown or error state, consecutive run failures (3+ = FAULT), and session staleness (>2h = DEGRADED, >8h = FAULT). A session with status=running is exempt from staleness warnings.',
  },
];

const activitySections = [
  {
    title: 'Task runs',
    body:
      'Full history from runs.sqlite — task name, status, start time, duration, and terminal summary. Filters out health-probe noise ("Reply with exactly OK"). Error detail shown inline for failed runs.',
  },
  {
    title: 'Flows',
    body:
      'Multi-step flow runs from flows/registry.sqlite. Shows goal, current step, and any blocked summary so you can see where a long-running flow is stuck.',
  },
  {
    title: 'Cron',
    body:
      'Recent cron job executions read from cron/runs/*.jsonl. Deduplicated by jobId, showing the last run time and result for each scheduled task.',
  },
  {
    title: 'Snapmolt mirror',
    body:
      'Tagged activity feed from Snapmolt PM2 logs. Each line is classified as voice, http, event, error, system, task, or log. A breakdown bar chart shows the distribution of activity types across the current window.',
  },
];

const telegramSections = [
  {
    title: 'Telegram integration',
    body:
      'The watcher includes a Telegram loop (clawnux-watcher-telegram) that periodically polls /api/watch and mirrors a status summary into your configured chat.',
  },
  {
    title: 'Teleprompter mode',
    body:
      'For private chats, the bot uses Telegram draft streaming to maintain a single live-updating summary message. Falls back to standard edit-in-place if draft streaming is unavailable, and `/api/watch-telegram/init` can force a fresh summary message when needed.',
  },
];

export default function DocsPage() {
  return (
    <main className="min-h-dvh px-3 py-3 sm:px-5 sm:py-5">
      <div className="mx-auto flex max-w-6xl flex-col gap-3">
        <WatchShellHeader activeTab="docs" />

        <section className="overflow-hidden rounded-lg border border-[var(--watch-panel-border-strong)] bg-[linear-gradient(135deg,rgba(24,20,14,0.97),rgba(16,13,9,0.97))] shadow-[0_8px_40px_rgba(0,0,0,0.28)]">
          <div className="border-b border-[var(--watch-panel-border)] px-4 py-3 text-[10px] uppercase tracking-[0.3em] text-[var(--watch-accent-strong)]">
            documentation
          </div>
          <div className="grid gap-3 p-4 sm:p-5 lg:grid-cols-2">
            <article className="rounded border border-[var(--watch-panel-border)] bg-[rgba(255,255,255,0.02)] p-4">
              <div className="text-[10px] uppercase tracking-[0.28em] text-[var(--watch-text-muted)]">
                status tab
              </div>
              <div className="mt-3 flex flex-col gap-4">
                {dashboardSections.map((section) => (
                  <div key={section.title}>
                    <h2 className="text-sm font-semibold text-[var(--watch-text)]">{section.title}</h2>
                    <p className="mt-1.5 text-xs leading-6 text-[var(--watch-text-muted)]">
                      {section.body}
                    </p>
                  </div>
                ))}
              </div>
            </article>

            <article className="rounded border border-[var(--watch-panel-border)] bg-[rgba(255,255,255,0.02)] p-4">
              <div className="text-[10px] uppercase tracking-[0.28em] text-[var(--watch-text-muted)]">
                activity tabs
              </div>
              <div className="mt-3 flex flex-col gap-4">
                {activitySections.map((section) => (
                  <div key={section.title}>
                    <h2 className="text-sm font-semibold text-[var(--watch-text)]">{section.title}</h2>
                    <p className="mt-1.5 text-xs leading-6 text-[var(--watch-text-muted)]">
                      {section.body}
                    </p>
                  </div>
                ))}
              </div>
            </article>
          </div>
        </section>

        <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <article className="rounded border border-[var(--watch-panel-border)] bg-[var(--watch-panel)] p-4">
            <div className="text-[10px] uppercase tracking-[0.28em] text-[var(--watch-text-muted)]">
              routes
            </div>
            <div className="mt-3 flex flex-col gap-1 text-xs leading-6 text-[var(--watch-text)]">
              <div>`/login` — password gate</div>
              <div>`/watch` — live ops dashboard</div>
              <div>`/office-preview` — public sanitized office view</div>
              <div>`/docs` — this reference</div>
              <div>`/api/watch` — JSON snapshot</div>
              <div>`/api/team-office/instruct` — lane-bound instruction relay</div>
              <div>`/api/watch/faults/clear` — stale-fault cleanup</div>
              <div>`/api/watch-telegram` + `/init` — Telegram sync</div>
            </div>
          </article>

          <article className="rounded border border-[var(--watch-panel-border)] bg-[var(--watch-panel)] p-4">
            <div className="text-[10px] uppercase tracking-[0.28em] text-[var(--watch-text-muted)]">
              auth
            </div>
            <div className="mt-3 flex flex-col gap-1 text-xs leading-6 text-[var(--watch-text)]">
              <div>Gated by `WATCH_PASSWORD` env var.</div>
              <div>Signed `watch_access` browser session cookie, 7-day expiry.</div>
              <div>Server-side login rate limiting.</div>
              <div>Optional `WATCH_API_KEY` bearer auth for automation.</div>
            </div>
          </article>

          <article className="rounded border border-[var(--watch-panel-border)] bg-[var(--watch-panel)] p-4">
            <div className="text-[10px] uppercase tracking-[0.28em] text-[var(--watch-text-muted)]">
              operations
            </div>
            <div className="mt-3 flex flex-col gap-1 text-xs leading-6 text-[var(--watch-text)]">
              <div>Web on `127.0.0.1:3012`, Caddy proxy.</div>
              <div>PM2: watcher-web + watcher-telegram.</div>
              <div>Build required before restart.</div>
              <div>`/api/auth/logout` clears browser access immediately.</div>
            </div>
          </article>

          <article className="rounded border border-[var(--watch-panel-border)] bg-[var(--watch-panel)] p-4">
            <div className="text-[10px] uppercase tracking-[0.28em] text-[var(--watch-text-muted)]">
              telegram
            </div>
            <div className="mt-3 flex flex-col gap-1 text-xs leading-6 text-[var(--watch-text)]">
              {telegramSections.map((s) => (
                <div key={s.title}>
                  <span className="font-medium text-[var(--watch-text-bright)]">{s.title}. </span>
                  <span className="text-[var(--watch-text-muted)]">{s.body}</span>
                </div>
              ))}
            </div>
          </article>
        </section>
      </div>
    </main>
  );
}
