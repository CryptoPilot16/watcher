import { WatchShellHeader } from '@/components/watch-shell-header';

const appSections = [
  {
    title: 'What the dashboard does',
    body:
      'The Watch tab is the live operations surface. It keeps the current Snapmolt task in the primary panel, then shows the surrounding runtime context below it so the operator can see status, logs, and failure signals without leaving the page.',
  },
  {
    title: 'Primary task panel',
    body:
      'The large top panel is reserved for the current Snapmolt task text. It prefers the latest task result file and falls back to the newest visible Snapmolt log line if no task text is available.',
  },
  {
    title: 'Secondary runtime panels',
    body:
      'The lower panels expose supporting runtime details such as PM2 process state, Snapmolt stdout and stderr, and selected backend logs. They are intentionally secondary so the current task stays first.',
  },
];

const telegramSections = [
  {
    title: 'Telegram integration',
    body:
      'The app includes a Telegram loop that periodically calls the local watcher API and mirrors the latest operator summary into Telegram. The loop is managed by PM2 and loads its configuration from .env.local.',
  },
  {
    title: 'Teleprompter mode',
    body:
      'For private chats, the bot now uses Telegram draft streaming through sendMessageDraft. That produces a single teleprompter-style message draft focused on the current Snapmolt task, the latest activity line, the latest error, and a short recent activity list.',
  },
  {
    title: 'Fallback behavior',
    body:
      'If Telegram draft streaming is unavailable for the chat, the bot falls back to the standard single-message workflow and edits or recreates the tracked message as needed. The state file stores the active mode, chat id, and tracking identifiers.',
  },
];

export default function DocsPage() {
  return (
    <main className="min-h-dvh px-4 py-4 sm:px-6 sm:py-6">
      <div className="mx-auto flex max-w-6xl flex-col gap-4">
        <WatchShellHeader activeTab="docs" />

        <section className="overflow-hidden rounded-[28px] border border-[var(--watch-panel-border-strong)] bg-[linear-gradient(135deg,rgba(34,28,18,0.96),rgba(18,15,11,0.96))] shadow-[0_24px_80px_rgba(0,0,0,0.24)]">
          <div className="border-b border-[var(--watch-panel-border)] px-4 py-3 text-[11px] uppercase tracking-[0.25em] text-[var(--watch-accent-strong)]">
            documentation
          </div>
          <div className="grid gap-4 p-4 sm:p-6 lg:grid-cols-2">
            <article className="rounded-[24px] border border-[var(--watch-panel-border)] bg-[rgba(255,255,255,0.02)] p-5">
              <div className="text-[11px] uppercase tracking-[0.24em] text-[var(--watch-text-muted)]">
                app flow
              </div>
              <div className="mt-3 flex flex-col gap-4">
                {appSections.map((section) => (
                  <div key={section.title}>
                    <h2 className="text-base font-semibold text-[var(--watch-text)]">{section.title}</h2>
                    <p className="mt-2 text-sm leading-7 text-[var(--watch-text-muted)]">
                      {section.body}
                    </p>
                  </div>
                ))}
              </div>
            </article>

            <article className="rounded-[24px] border border-[var(--watch-panel-border)] bg-[rgba(255,255,255,0.02)] p-5">
              <div className="text-[11px] uppercase tracking-[0.24em] text-[var(--watch-text-muted)]">
                telegram flow
              </div>
              <div className="mt-3 flex flex-col gap-4">
                {telegramSections.map((section) => (
                  <div key={section.title}>
                    <h2 className="text-base font-semibold text-[var(--watch-text)]">{section.title}</h2>
                    <p className="mt-2 text-sm leading-7 text-[var(--watch-text-muted)]">
                      {section.body}
                    </p>
                  </div>
                ))}
              </div>
            </article>
          </div>
        </section>

        <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          <article className="rounded-[24px] border border-[var(--watch-panel-border)] bg-[var(--watch-panel)] p-4 shadow-[0_18px_50px_rgba(0,0,0,0.18)]">
            <div className="text-[11px] uppercase tracking-[0.24em] text-[var(--watch-text-muted)]">
              routes
            </div>
            <div className="mt-3 text-sm leading-7 text-[var(--watch-text)]">
              <div>`/watch` is the live dashboard.</div>
              <div>`/docs` explains the product and integration behavior.</div>
              <div>`/api/watch` exposes the current runtime snapshot.</div>
              <div>`/api/watch-telegram` triggers a Telegram sync.</div>
            </div>
          </article>

          <article className="rounded-[24px] border border-[var(--watch-panel-border)] bg-[var(--watch-panel)] p-4 shadow-[0_18px_50px_rgba(0,0,0,0.18)]">
            <div className="text-[11px] uppercase tracking-[0.24em] text-[var(--watch-text-muted)]">
              auth
            </div>
            <div className="mt-3 text-sm leading-7 text-[var(--watch-text)]">
              <div>Access is controlled by `WATCH_PASSWORD`.</div>
              <div>The app no longer carries a hardcoded password fallback in repo code.</div>
              <div>Authenticated access is stored in the `watch_access` cookie.</div>
            </div>
          </article>

          <article className="rounded-[24px] border border-[var(--watch-panel-border)] bg-[var(--watch-panel)] p-4 shadow-[0_18px_50px_rgba(0,0,0,0.18)] md:col-span-2 xl:col-span-1">
            <div className="text-[11px] uppercase tracking-[0.24em] text-[var(--watch-text-muted)]">
              operations
            </div>
            <div className="mt-3 text-sm leading-7 text-[var(--watch-text)]">
              <div>The web app listens on `127.0.0.1:3012`.</div>
              <div>Caddy serves `watch.clawnux.com`.</div>
              <div>PM2 manages both the web surface and the Telegram loop.</div>
            </div>
          </article>
        </section>
      </div>
    </main>
  );
}
