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
      <section className="w-full max-w-md overflow-hidden rounded-[28px] border border-[var(--watch-panel-border-strong)] bg-[linear-gradient(180deg,rgba(27,22,15,0.96),rgba(18,15,11,0.96))] shadow-[0_24px_80px_rgba(0,0,0,0.28)]">
        <div className="flex flex-col gap-6 p-5 sm:p-7">
          <div className="flex justify-center">
            <img src="/watch-logo-v4.svg" alt="CLAWNUX Watch" className="h-16 w-auto sm:h-20" />
          </div>

          <div className="text-center">
            <h1 className="text-xl font-semibold uppercase tracking-[0.18em] text-[var(--watch-text)]">
              Authentication
            </h1>
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
                placeholder="password"
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
              {loading ? 'authenticating...' : 'authenticate'}
            </button>
          </form>
        </div>
      </section>
    </main>
  );
}
