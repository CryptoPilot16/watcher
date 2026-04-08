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
        body: JSON.stringify({ key: password, redirectTo }),
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
      <section className="w-full max-w-sm overflow-hidden rounded-lg border border-[var(--watch-panel-border-strong)] bg-[linear-gradient(180deg,rgba(27,22,15,0.97),rgba(18,15,11,0.97))] shadow-[0_8px_32px_rgba(0,0,0,0.32)]">
        {/* Header bar */}
        <div className="border-b border-[var(--watch-panel-border)] px-5 py-3 flex items-center gap-3">
          <img src="/watch-logo-v4.svg" alt="WATCHER" className="h-8 w-8 rounded" />
          <div>
            <div className="text-[9px] uppercase tracking-[0.3em] text-[var(--watch-text-muted)]">CLAWNUX</div>
            <div className="text-sm font-semibold tracking-[0.12em] uppercase text-[var(--watch-text)]">WATCHER</div>
          </div>
        </div>

        <div className="flex flex-col gap-5 p-5">
          <div className="text-[10px] uppercase tracking-[0.3em] text-[var(--watch-accent-strong)]">
            authentication
          </div>

          <form onSubmit={onSubmit} className="flex flex-col gap-3">
            <label className="flex flex-col gap-1.5 text-[10px] uppercase tracking-[0.2em] text-[var(--watch-text-muted)]">
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
                className="rounded border border-[var(--watch-panel-border)] bg-[rgba(0,0,0,0.22)] px-3 py-2.5 text-sm text-[var(--watch-text)] outline-none transition focus:border-[var(--watch-accent)] focus:bg-[rgba(255,255,255,0.02)] font-mono"
                placeholder="enter password"
              />
            </label>

            {error ? (
              <div className="rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-[var(--watch-danger)]">
                {error}
              </div>
            ) : null}

            <button
              type="submit"
              disabled={loading}
              className="rounded border border-[var(--watch-panel-border-strong)] bg-[var(--watch-accent-soft)] px-4 py-2.5 text-xs font-medium uppercase tracking-[0.15em] text-[var(--watch-text)] transition hover:bg-[rgba(212,186,104,0.22)] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {loading ? 'authenticating...' : 'authenticate'}
            </button>
          </form>
        </div>
      </section>
    </main>
  );
}
