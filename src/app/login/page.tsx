'use client';

import { FormEvent, useEffect, useState } from 'react';

export default function LoginPage() {
  const [redirectTo, setRedirectTo] = useState('/watch');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const value = new URLSearchParams(window.location.search).get('redirect');
    if (value && value.startsWith('/')) {
      setRedirectTo(value);
    }
  }, []);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError('');

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          key: password,
          redirectTo,
        }),
      });

      const json = await res.json();
      if (!res.ok || !json.ok) {
        setError(json.error || 'Login failed');
        return;
      }

      window.location.replace(json.redirectTo || redirectTo);
    } catch (error: any) {
      setError(error?.message || 'Login failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-6 sm:px-6">
      <div className="grid w-full max-w-6xl gap-4 lg:grid-cols-[1.15fr_0.85fr]">
        <section className="overflow-hidden rounded-[28px] border border-[var(--watch-panel-border-strong)] bg-[linear-gradient(180deg,rgba(27,22,15,0.96),rgba(18,15,11,0.96))] shadow-[0_24px_80px_rgba(0,0,0,0.28)]">
          <div className="border-b border-[var(--watch-panel-border)] px-5 py-3 text-[10px] uppercase tracking-[0.28em] text-[var(--watch-text-muted)]">
            private monitoring dashboard / terminal shell
          </div>
          <div className="flex h-full flex-col gap-6 p-5 sm:p-7">
            <div className="flex items-start gap-4">
              <img src="/watch-logo-v3.svg" alt="CLAWNUX Watch" className="h-16 w-auto sm:h-20" />
              <div>
                <h1 className="text-2xl font-semibold text-[var(--watch-text)] sm:text-4xl">
                  CLAWNUX Watch
                </h1>
                <p className="mt-2 text-sm leading-7 text-[var(--watch-text-muted)] sm:max-w-xl">
                  A muted terminal-style web app for task visibility, runtime checks, and Telegram relay monitoring across desktop and mobile.
                </p>
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              <div className="rounded-2xl border border-[var(--watch-panel-border)] bg-[rgba(255,255,255,0.02)] p-4">
                <div className="text-[10px] uppercase tracking-[0.26em] text-[var(--watch-text-muted)]">
                  task first
                </div>
                <div className="mt-2 text-sm leading-7 text-[var(--watch-text)]">
                  The current Snapmolt task is always the primary panel.
                </div>
              </div>
              <div className="rounded-2xl border border-[var(--watch-panel-border)] bg-[rgba(255,255,255,0.02)] p-4">
                <div className="text-[10px] uppercase tracking-[0.26em] text-[var(--watch-text-muted)]">
                  docs tab
                </div>
                <div className="mt-2 text-sm leading-7 text-[var(--watch-text)]">
                  Built-in documentation explains the app flow and Telegram behavior.
                </div>
              </div>
              <div className="rounded-2xl border border-[var(--watch-panel-border)] bg-[rgba(255,255,255,0.02)] p-4">
                <div className="text-[10px] uppercase tracking-[0.26em] text-[var(--watch-text-muted)]">
                  mobile ready
                </div>
                <div className="mt-2 text-sm leading-7 text-[var(--watch-text)]">
                  Layouts collapse cleanly for quick checks from a phone.
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="overflow-hidden rounded-[28px] border border-[var(--watch-panel-border)] bg-[var(--watch-panel)] shadow-[0_24px_80px_rgba(0,0,0,0.22)]">
          <div className="border-b border-[var(--watch-panel-border)] px-5 py-3 text-[10px] uppercase tracking-[0.28em] text-[var(--watch-text-muted)]">
            access gate
          </div>
          <div className="flex flex-col gap-6 p-5 sm:p-7">
            <div>
              <h2 className="text-xl font-semibold text-[var(--watch-text)]">Authenticate</h2>
              <p className="mt-2 text-sm leading-7 text-[var(--watch-text-muted)]">
                Enter the configured watch password to open the dashboard.
              </p>
            </div>

            <form onSubmit={onSubmit} className="flex flex-col gap-4">
            <label className="text-sm text-[var(--watch-text)]">
              password
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoFocus
                autoCapitalize="none"
                autoCorrect="off"
                inputMode="text"
                spellCheck={false}
                className="mt-2 w-full rounded-2xl border border-[var(--watch-panel-border)] bg-[rgba(0,0,0,0.22)] px-4 py-3 text-base text-[var(--watch-text)] outline-none transition focus:border-[var(--watch-accent)] focus:bg-[rgba(255,255,255,0.02)]"
                placeholder="enter watch password"
              />
            </label>

            {error ? (
              <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-[var(--watch-danger)]">
                {error}
              </div>
            ) : null}

            <button
              type="submit"
              disabled={loading}
              className="rounded-2xl border border-[var(--watch-panel-border-strong)] bg-[var(--watch-accent-soft)] px-4 py-3 text-base font-medium text-[var(--watch-text)] transition hover:bg-[rgba(212,186,104,0.22)] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {loading ? 'authenticating...' : 'enter watch'}
            </button>
          </form>
          </div>
        </section>
      </div>
    </main>
  );
}
