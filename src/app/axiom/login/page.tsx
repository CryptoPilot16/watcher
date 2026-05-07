'use client';

import { FormEvent, useEffect, useState } from 'react';

export default function AdminLoginPage() {
  const [redirectTo, setRedirectTo] = useState('/axiom');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const value = new URLSearchParams(window.location.search).get('redirect');
    if (value && value.startsWith('/axiom')) {
      setRedirectTo(value);
    }
  }, []);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/admin/auth/login', {
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
    } catch (e: any) {
      setError(e?.message || 'Login failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-6 sm:px-6">
      <section className="w-full max-w-sm overflow-hidden rounded-lg border border-[var(--watch-panel-border-strong)] bg-[linear-gradient(180deg,rgba(27,22,15,0.97),rgba(18,15,11,0.97))] shadow-[0_8px_32px_rgba(0,0,0,0.32)]">
        <div className="border-b border-[var(--watch-panel-border)] px-5 py-3 flex items-center gap-3">
          <img src="/watch-logo-v4.svg" alt="" className="h-8 w-8 rounded" />
          <div>
            <div className="watch-display text-base font-semibold uppercase text-[var(--watch-accent-strong)]">
              Admin
            </div>
            <div className="text-[10px] uppercase tracking-[0.18em] text-[var(--watch-text-muted)]">
              AXIOM Office · operator gate
            </div>
          </div>
        </div>

        <form onSubmit={onSubmit} className="space-y-3 px-5 py-5">
          <label className="block">
            <span className="text-[11px] uppercase tracking-[0.16em] text-[var(--watch-text-muted)]">password</span>
            <input
              type="password"
              autoFocus
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1 w-full rounded border border-white/10 bg-[rgba(255,255,255,0.04)] px-3 py-2 text-sm text-white/90 placeholder:text-white/30 focus:border-[rgba(214,189,111,0.5)] focus:outline-none"
              placeholder="enter admin password"
            />
          </label>
          {error && (
            <div className="text-[11px] uppercase tracking-[0.14em] text-[#f87171]">{error}</div>
          )}
          <button
            type="submit"
            disabled={loading || !password}
            className="w-full rounded border border-[var(--watch-panel-border-strong)] bg-[var(--watch-accent-soft)] px-3 py-2 text-[11px] uppercase tracking-[0.18em] text-[var(--watch-text)] transition-opacity disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? 'signing in…' : 'enter admin'}
          </button>
        </form>
      </section>
    </main>
  );
}
