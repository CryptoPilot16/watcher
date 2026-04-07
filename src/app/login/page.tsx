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
    <main className="flex min-h-dvh items-center justify-center px-4 py-6">
      <div className="w-full max-w-md overflow-hidden rounded-2xl border border-[var(--watch-panel-border)] bg-[var(--watch-panel)] shadow-[0_0_70px_rgba(34,197,94,0.08)]">
        <div className="flex flex-col gap-6 p-5 sm:p-6">
          <div className="flex items-center gap-3">
            <img src="/watch-logo-v2.svg" alt="CLAWNUX Watch" className="h-11 w-auto sm:h-12" />
            <div>
              <h1 className="text-lg font-semibold text-[var(--watch-text)] sm:text-xl">
                CLAWNUX Watch
              </h1>
              <p className="text-xs uppercase tracking-[0.24em] text-[var(--watch-text-muted)]">
                isolated access gate
              </p>
            </div>
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
                className="mt-2 w-full rounded-xl border border-[var(--watch-panel-border)] bg-black/30 px-4 py-3 text-base text-[var(--watch-text)] outline-none transition focus:border-[var(--watch-accent)]"
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
              className="rounded-xl border border-[var(--watch-accent)] bg-[rgba(74,222,128,0.08)] px-4 py-3 text-base font-medium text-[var(--watch-text)] transition hover:bg-[rgba(74,222,128,0.14)] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {loading ? 'authenticating...' : 'enter watch'}
            </button>
          </form>
        </div>
      </div>
    </main>
  );
}
