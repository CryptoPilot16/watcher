'use client';

import { useEffect, useState } from 'react';
import { AdminShellHeader } from '@/components/admin-shell-header';

type ActionStat = {
  type: 'image' | 'pdf' | 'document' | 'voice' | 'code' | 'text';
  count: number;
  totalCostUsd: number;
  avgCostUsd: number;
  totalDurationMs: number;
  avgDurationMs: number;
};

type AgentUsage = {
  topicId: string;
  callsLastHour: number;
};

type SettingsResponse = {
  ok: boolean;
  generatedAt: string;
  cap: {
    dailyUsd: number;
    defaultUsd: number;
    maxDailyUsd: number;
    overrideActive: boolean;
    overrideUpdatedAt: string | null;
    overrideUpdatedBy: string | null;
    callsPerHourPerAgent: number;
  };
  today: { spentUsd: number; remainingUsd: number; percentUsed: number; dayKey: string; alertedAtPercent: number | null };
  agents: AgentUsage[];
  actions: ActionStat[];
  actionWindow: { days: number; entriesWithCost: number; oldestEntryTs: string | null };
  killSwitch: { enabled: boolean; alertsEnabled: boolean; reason: string | null; updatedAt: string | null; updatedBy: string | null };
};

// Tokens are the user-facing unit. The underlying cost data is still USD-priced
// (cap, spend, per-action totals — kept that way so the budget cap still
// throttles consistently), but we present everything as the equivalent token
// count using a blended ~$10/M output-heavy rate. So $1 ≈ 100K tok, the $10
// default cap ≈ 1M tok.
const USD_PER_MTOK = 10;
function usdToTokens(usd: number): number {
  return Math.max(0, usd) * (1_000_000 / USD_PER_MTOK);
}
function fmtTokens(usd: number): string {
  const t = usdToTokens(usd);
  if (t === 0) return '0 tok';
  if (t < 1_000) return `${Math.round(t)} tok`;
  if (t < 1_000_000) return `${(t / 1_000).toFixed(t < 10_000 ? 1 : 0)}K tok`;
  if (t < 1_000_000_000) return `${(t / 1_000_000).toFixed(t < 10_000_000 ? 2 : 1)}M tok`;
  return `${(t / 1_000_000_000).toFixed(2)}B tok`;
}

function fmtDuration(ms: number): string {
  if (!ms) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

function actionColor(type: ActionStat['type']): string {
  if (type === 'image') return '#fb923c';
  if (type === 'pdf') return '#f87171';
  if (type === 'document') return '#fcd34d';
  if (type === 'voice') return '#a78bfa';
  if (type === 'code') return '#7dd3fc';
  return '#86efac';
}

function actionLabel(type: ActionStat['type']): string {
  if (type === 'image') return 'image (vision)';
  if (type === 'pdf') return 'pdf (vision · per page)';
  if (type === 'document') return 'document (text)';
  if (type === 'voice') return 'voice (whisper local)';
  if (type === 'code') return 'code (codex)';
  return 'text (claude)';
}

function progressBarColor(percent: number): string {
  if (percent >= 90) return '#ef4444';
  if (percent >= 70) return '#fbbf24';
  return '#86efac';
}

type TaskEstimate = {
  task: string;
  detail: string;
  type: ActionStat['type'];
  lowUsd: number;
  highUsd: number;
};

// Nominal per-task token-equivalent cost ranges. These are NOT real billed charges —
// the agents run on Claude Pro/Max and ChatGPT memberships, so nothing is actually
// invoiced. The numbers are what the same call would have cost via the public API
// (Sonnet 4.6: $3/M in, $15/M out · GPT-5 Codex: ~$2/M in, ~$10/M out).
const TASK_ESTIMATES: TaskEstimate[] = [
  // Plain text
  { task: 'CEO short ack',                detail: 'one-line text reply, no context',           type: 'text',     lowUsd: 0.003, highUsd: 0.010 },
  { task: 'CEO text briefing',            detail: 'multi-paragraph markdown, no attachment',   type: 'text',     lowUsd: 0.020, highUsd: 0.060 },
  // Voice (Whisper transcribes locally — no LLM cost for the audio itself)
  { task: 'Voice → short reply',          detail: 'WhatsApp/Telegram voice note (≤30s)',       type: 'voice',    lowUsd: 0.005, highUsd: 0.020 },
  { task: 'Voice → long reply',           detail: 'voice note (1–3min) + structured answer',   type: 'voice',    lowUsd: 0.020, highUsd: 0.080 },
  // Images (vision)
  { task: 'Image · 1 screenshot',         detail: 'one photo/screenshot, structured reply',    type: 'image',    lowUsd: 0.060, highUsd: 0.150 },
  { task: 'Image · multi-shot briefing',  detail: 'multiple images, full markdown analysis',   type: 'image',    lowUsd: 0.250, highUsd: 0.600 },
  // PDFs (Claude tokenizes each page as text + image — typically $0.02–0.05 per page input + output)
  { task: 'PDF · 1–2 pages',              detail: 'invoice, short letter, single-page memo',   type: 'pdf',      lowUsd: 0.030, highUsd: 0.080 },
  { task: 'PDF · short doc (3–10 pgs)',   detail: 'spec, brief, manual section',               type: 'pdf',      lowUsd: 0.080, highUsd: 0.300 },
  { task: 'PDF · long doc (20+ pgs)',     detail: 'full report, dense document, contract',     type: 'pdf',      lowUsd: 0.350, highUsd: 1.200 },
  // Other documents (.txt, .md, .csv, .json, code files — text-only ingestion)
  { task: 'Document · text file',         detail: '.txt / .md / .csv / .json — plain ingest',  type: 'document', lowUsd: 0.010, highUsd: 0.060 },
  { task: 'Document · large dataset',     detail: 'CSV/JSON dump, big log file',                type: 'document', lowUsd: 0.060, highUsd: 0.300 },
  // Code agents (Codex/Claude)
  { task: 'Manager dispatch (Codex)',     detail: '/goal planning, no file edits',             type: 'code',     lowUsd: 0.010, highUsd: 0.030 },
  { task: 'Coder · single-file edit',     detail: 'one focused change in /opt/axiom',          type: 'code',     lowUsd: 0.030, highUsd: 0.080 },
  { task: 'Coder · multi-file feature',   detail: 'reads + edits across several files',        type: 'code',     lowUsd: 0.150, highUsd: 0.400 },
  { task: 'Coder · repo-wide refactor',   detail: 'broad reads, many edits, long context',     type: 'code',     lowUsd: 0.400, highUsd: 1.200 },
];

export default function SettingsPage() {
  const [data, setData] = useState<SettingsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch('/api/axiom/settings', { cache: 'no-store' });
        const json = (await res.json()) as SettingsResponse;
        if (!cancelled) {
          setData(json);
          setError(null);
        }
      } catch (e: any) {
        if (!cancelled) setError(String(e?.message || e || 'failed to load'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    const interval = setInterval(load, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  const percent = data?.today.percentUsed ?? 0;
  const barColor = progressBarColor(percent);
  const totalActionCost = (data?.actions || []).reduce((s, a) => s + a.totalCostUsd, 0);

  async function refreshSettings() {
    const res = await fetch('/api/axiom/settings', { cache: 'no-store' });
    const json = (await res.json()) as SettingsResponse;
    setData(json);
    setError(null);
  }

  async function killAllTokenConsumers() {
    if (!window.confirm('Emergency stop AXIOM token consumers? This sets allowance to 0, pauses autopilot, kills visible agent state, disables alerts, and stops the PM2 driver.')) return;
    setActionBusy(true);
    setActionMessage(null);
    try {
      const res = await fetch('/api/axiom/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'kill-all', updatedBy: 'settings-ui' }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error || 'kill switch failed');
      setActionMessage(`Emergency stop armed · allowance $0 · max $${json.maxDailyUsd} · ${json.killedAgents || 0} agent states cleared`);
      await refreshSettings();
    } catch (e: any) {
      setActionMessage(`Emergency stop failed: ${String(e?.message || e)}`);
    } finally {
      setActionBusy(false);
    }
  }

  async function setAllowance(capUsd: number) {
    setActionBusy(true);
    setActionMessage(null);
    try {
      const res = await fetch('/api/axiom/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set-allowance', capUsd, updatedBy: 'settings-ui' }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error || 'allowance update failed');
      setActionMessage(`Allowance set to $${capUsd}/day · hard max $${json.maxDailyUsd}`);
      await refreshSettings();
    } catch (e: any) {
      setActionMessage(`Allowance update failed: ${String(e?.message || e)}`);
    } finally {
      setActionBusy(false);
    }
  }

  return (
    <main className="min-h-screen bg-[var(--watch-bg)] p-3 sm:p-5">
      <div className="mx-auto flex min-h-[calc(100vh-24px)] max-w-[1200px] flex-col gap-3">
        <AdminShellHeader activeTab="settings" />

        <div className="rounded-xl border border-[var(--watch-panel-border)] bg-[rgba(0,0,0,0.18)] px-4 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="text-[10px] uppercase tracking-[0.24em] text-[var(--watch-text-muted)]">▌ usage &amp; allowance</div>
            <span className="rounded-full border border-[#86efac]/30 bg-[#86efac]/10 px-2 py-0.5 text-[9px] uppercase tracking-[0.18em] text-[#86efac]">
              membership-backed · 0 invoiced
            </span>
          </div>
          <div className="mt-2 text-sm text-[var(--watch-text-bright)] sm:text-base">
            Live token-usage tracker for the AXIOM 41-agent floor. Auto-refreshes every 5s.
          </div>
          <div className="mt-1 text-[11px] text-[var(--watch-text-muted)]">
            No API keys are used — Claude and Codex agents run on subscription memberships. Token counts below are derived from the same per-call usage data the public API would have charged for, blended at ~$10/M tok so you can compare task weights and watch the daily cap. Nothing is actually being billed.
          </div>
        </div>

        {loading && !data && (
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
            <div className="rounded-xl border border-[#ef4444]/40 bg-[#450a0a]/20 p-4 sm:p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="text-[10px] uppercase tracking-[0.24em] text-[#fca5a5]">▌ emergency token controls</div>
                  <div className="mt-2 text-sm text-[var(--watch-text-bright)]">
                    Kill switch: {data.killSwitch.enabled ? <span className="text-[#f87171]">ON — token calls blocked</span> : <span className="text-[#86efac]">off</span>}
                  </div>
                  <div className="mt-1 text-[11px] text-[var(--watch-text-muted)]">
                    Current allowance {fmtTokens(data.cap.dailyUsd)} · hard max {fmtTokens(data.cap.maxDailyUsd)} / day. Emergency stop sets allowance to 0, pauses autopilot, disables AXIOM usage alerts, and stops the PM2 driver.
                    {data.killSwitch.updatedAt ? ` Last changed ${new Date(data.killSwitch.updatedAt).toLocaleString()}` : ''}
                  </div>
                  {data.killSwitch.reason && <div className="mt-1 text-[10px] text-[#fca5a5]">{data.killSwitch.reason}</div>}
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={actionBusy}
                    onClick={killAllTokenConsumers}
                    className="rounded-lg border border-[#ef4444]/60 bg-[#ef4444]/20 px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-[#fecaca] transition hover:bg-[#ef4444]/30 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    kill all token consumers
                  </button>
                  <button
                    type="button"
                    disabled={actionBusy}
                    onClick={() => setAllowance(0)}
                    className="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-[10px] uppercase tracking-[0.18em] text-[var(--watch-text-bright)] transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    allowance $0
                  </button>
                  <button
                    type="button"
                    disabled={actionBusy}
                    onClick={() => setAllowance(50)}
                    className="rounded-lg border border-[#86efac]/40 bg-[#86efac]/10 px-3 py-2 text-[10px] uppercase tracking-[0.18em] text-[#bbf7d0] transition hover:bg-[#86efac]/20 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    cap $50 max
                  </button>
                </div>
              </div>
              {actionMessage && <div className="mt-3 text-[11px] text-[#fbbf24]">{actionMessage}</div>}
            </div>

            <div className="rounded-xl border border-[var(--watch-panel-border)] bg-[rgba(0,0,0,0.18)] p-4 sm:p-5">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div className="text-[10px] uppercase tracking-[0.24em] text-[var(--watch-text-muted)]">▌ daily allowance — across all 41 agents</div>
                <div className="text-[10px] uppercase tracking-[0.18em] text-[var(--watch-text-muted)]">resets at UTC midnight · {data.today.dayKey}</div>
              </div>
              <div className="mt-3 flex flex-wrap items-baseline gap-3">
                <div className="text-3xl font-semibold text-[var(--watch-text-bright)]" style={{ color: barColor }}>
                  {fmtTokens(data.today.spentUsd)}
                </div>
                <div className="text-sm text-[var(--watch-text-muted)]">
                  / {fmtTokens(data.cap.dailyUsd)} <span className="text-[10px] uppercase tracking-[0.16em]">today</span>
                </div>
                <div className="ml-auto text-xs text-[var(--watch-text-muted)]">
                  <span className="text-[var(--watch-text-bright)]">{percent.toFixed(1)}%</span> used · {fmtTokens(data.today.remainingUsd)} remaining
                </div>
              </div>
              <div className="mt-3 h-2.5 w-full overflow-hidden rounded-full bg-[rgba(255,255,255,0.05)]">
                <div
                  className="h-full transition-all duration-500 ease-out"
                  style={{ width: `${Math.min(100, percent)}%`, backgroundColor: barColor }}
                />
              </div>
              <div className="mt-3 grid grid-cols-2 gap-3 text-[11px] sm:grid-cols-4">
                <div className="rounded border border-white/5 bg-[rgba(255,255,255,0.02)] p-2">
                  <div className="uppercase tracking-[0.16em] text-[var(--watch-text-muted)]">allowance / day</div>
                  <div className="mt-1 text-[var(--watch-text-bright)]">{fmtTokens(data.cap.dailyUsd)}</div>
                </div>
                <div className="rounded border border-white/5 bg-[rgba(255,255,255,0.02)] p-2">
                  <div className="uppercase tracking-[0.16em] text-[var(--watch-text-muted)]">used today</div>
                  <div className="mt-1 text-[var(--watch-text-bright)]">{fmtTokens(data.today.spentUsd)}</div>
                </div>
                <div className="rounded border border-white/5 bg-[rgba(255,255,255,0.02)] p-2">
                  <div className="uppercase tracking-[0.16em] text-[var(--watch-text-muted)]">remaining</div>
                  <div className="mt-1 text-[var(--watch-text-bright)]">{fmtTokens(data.today.remainingUsd)}</div>
                </div>
                <div className="rounded border border-white/5 bg-[rgba(255,255,255,0.02)] p-2">
                  <div className="uppercase tracking-[0.16em] text-[var(--watch-text-muted)]">per-agent rate</div>
                  <div className="mt-1 text-[var(--watch-text-bright)]">{data.cap.callsPerHourPerAgent}/hr</div>
                </div>
              </div>
              <div className="mt-3 space-y-1 text-[11px] text-[var(--watch-text-muted)]">
                <div>
                  Change the allowance from Telegram: <span className="text-[var(--watch-text-bright)]">/budget set 20</span> · <span className="text-[var(--watch-text-bright)]">/budget +5</span> · <span className="text-[var(--watch-text-bright)]">/budget reset</span>. The CEO bot also DMs you a 🚨 alert when usage crosses 90%.
                </div>
                {data.cap.overrideActive && (
                  <div className="text-[#fbbf24]">
                    Override active: cap set from default {fmtTokens(data.cap.defaultUsd)} → {fmtTokens(data.cap.dailyUsd)}
                    {data.cap.overrideUpdatedAt ? ` · set ${new Date(data.cap.overrideUpdatedAt).toLocaleString()}` : ''}
                    {data.cap.overrideUpdatedBy ? ` · by ${data.cap.overrideUpdatedBy}` : ''}
                  </div>
                )}
                {data.today.alertedAtPercent != null && (
                  <div className="text-[#f87171]">
                    Telegram alert sent today at {data.today.alertedAtPercent}% threshold.
                  </div>
                )}
                <div>
                  Once the allowance is hit — or set to 0 — all AXIOM agent calls are blocked until you raise the cap. Hard max is $50/day.
                </div>
              </div>
            </div>

            <div className="rounded-xl border border-[var(--watch-panel-border)] bg-[rgba(0,0,0,0.18)] p-4 sm:p-5">
              <div className="flex flex-wrap items-center gap-2">
                <div className="text-[10px] uppercase tracking-[0.24em] text-[var(--watch-text-muted)]">▌ estimated tokens per task</div>
                <span className="rounded-full border border-[#fbbf24]/30 bg-[#fbbf24]/10 px-2 py-0.5 text-[9px] uppercase tracking-[0.18em] text-[#fbbf24]">
                  nominal · covered by membership
                </span>
              </div>
              <div className="mt-2 text-[11px] text-[var(--watch-text-muted)]">
                These ranges are token-equivalents the same call would have consumed on the public API (Sonnet 4.6: $3/M in · $15/M out · GPT-5 Codex: ~$2/M in · ~$10/M out), shown here to compare task weights against the daily allowance. The actual invoice from your Claude Pro/Max + ChatGPT memberships is unaffected.
              </div>
              <div className="mt-3 overflow-hidden rounded-lg border border-white/5">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="bg-[rgba(255,255,255,0.03)] text-[10px] uppercase tracking-[0.16em] text-[var(--watch-text-muted)]">
                      <th className="px-3 py-2">task</th>
                      <th className="px-3 py-2">type</th>
                      <th className="px-3 py-2 text-right">range (tokens)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {TASK_ESTIMATES.map((est) => (
                      <tr key={est.task} className="border-t border-white/5">
                        <td className="px-3 py-2">
                          <div className="text-[var(--watch-text-bright)]">{est.task}</div>
                          <div className="text-[10px] text-[var(--watch-text-muted)]">{est.detail}</div>
                        </td>
                        <td className="px-3 py-2">
                          <span className="inline-flex items-center gap-2">
                            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: actionColor(est.type) }} />
                            <span className="text-[11px]" style={{ color: actionColor(est.type) }}>{actionLabel(est.type)}</span>
                          </span>
                        </td>
                        <td className="px-3 py-2 text-right text-[var(--watch-text-bright)]">
                          {fmtTokens(est.lowUsd)} – {fmtTokens(est.highUsd)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="mt-2 text-[10px] text-[var(--watch-text-muted)]">
                Image/vision calls dominate spend — a single METAR-style screenshot briefing is roughly <span className="text-[var(--watch-text-bright)]">10–60×</span> a plain text reply.
              </div>
            </div>

            <div className="rounded-xl border border-[var(--watch-panel-border)] bg-[rgba(0,0,0,0.18)] p-4 sm:p-5">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div className="text-[10px] uppercase tracking-[0.24em] text-[var(--watch-text-muted)]">▌ average tokens by action type</div>
                <div className="text-[10px] uppercase tracking-[0.18em] text-[var(--watch-text-muted)]">
                  last {data.actionWindow.days}d · {data.actionWindow.entriesWithCost} priced calls
                </div>
              </div>
              {data.actions.length === 0 ? (
                <div className="mt-3 text-[11px] text-[var(--watch-text-muted)]">
                  No priced calls yet — action breakdown becomes available once new calls land with the upgraded cost-tracking schema.
                </div>
              ) : (
                <div className="mt-3 overflow-hidden rounded-lg border border-white/5">
                  <table className="w-full text-left text-xs">
                    <thead>
                      <tr className="bg-[rgba(255,255,255,0.03)] text-[10px] uppercase tracking-[0.16em] text-[var(--watch-text-muted)]">
                        <th className="px-3 py-2">type</th>
                        <th className="px-3 py-2 text-right">calls</th>
                        <th className="px-3 py-2 text-right">avg tokens</th>
                        <th className="px-3 py-2 text-right">total tokens</th>
                        <th className="px-3 py-2 text-right">avg duration</th>
                        <th className="px-3 py-2 text-right">share</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.actions.map((a) => {
                        const share = totalActionCost > 0 ? (a.totalCostUsd / totalActionCost) * 100 : 0;
                        return (
                          <tr key={a.type} className="border-t border-white/5">
                            <td className="px-3 py-2">
                              <span className="inline-flex items-center gap-2">
                                <span className="h-2 w-2 rounded-full" style={{ backgroundColor: actionColor(a.type) }} />
                                <span style={{ color: actionColor(a.type) }}>{actionLabel(a.type)}</span>
                              </span>
                            </td>
                            <td className="px-3 py-2 text-right text-[var(--watch-text-bright)]">{a.count}</td>
                            <td className="px-3 py-2 text-right text-[var(--watch-text-bright)]">{fmtTokens(a.avgCostUsd)}</td>
                            <td className="px-3 py-2 text-right text-[var(--watch-text-bright)]">{fmtTokens(a.totalCostUsd)}</td>
                            <td className="px-3 py-2 text-right text-[var(--watch-text-muted)]">{fmtDuration(a.avgDurationMs)}</td>
                            <td className="px-3 py-2 text-right">
                              <div className="flex items-center justify-end gap-2">
                                <div className="h-1.5 w-16 overflow-hidden rounded bg-[rgba(255,255,255,0.05)]">
                                  <div className="h-full" style={{ width: `${share}%`, backgroundColor: actionColor(a.type) }} />
                                </div>
                                <span className="w-10 text-right text-[var(--watch-text-muted)]">{share.toFixed(0)}%</span>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div className="rounded-xl border border-[var(--watch-panel-border)] bg-[rgba(0,0,0,0.18)] p-4 sm:p-5">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div className="text-[10px] uppercase tracking-[0.24em] text-[var(--watch-text-muted)]">▌ active agents — last hour</div>
                <div className="text-[10px] uppercase tracking-[0.18em] text-[var(--watch-text-muted)]">
                  {data.agents.length} of 41 active · cap {data.cap.callsPerHourPerAgent}/hr each
                </div>
              </div>
              {data.agents.length === 0 ? (
                <div className="mt-3 text-[11px] text-[var(--watch-text-muted)]">No agent calls in the last hour.</div>
              ) : (
                <div className="mt-3 space-y-2">
                  {data.agents.map((agent) => {
                    const pct = Math.min(100, (agent.callsLastHour / data.cap.callsPerHourPerAgent) * 100);
                    const color = pct >= 80 ? '#fbbf24' : '#7dd3fc';
                    return (
                      <div key={agent.topicId} className="flex items-center gap-3 text-xs">
                        <div className="w-44 truncate text-[var(--watch-text-bright)]">{agent.topicId}</div>
                        <div className="flex-1 overflow-hidden rounded bg-[rgba(255,255,255,0.05)]">
                          <div className="h-1.5" style={{ width: `${pct}%`, backgroundColor: color }} />
                        </div>
                        <div className="w-24 text-right text-[var(--watch-text-muted)]">
                          <span className="text-[var(--watch-text-bright)]">{agent.callsLastHour}</span> / {data.cap.callsPerHourPerAgent}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </main>
  );
}
