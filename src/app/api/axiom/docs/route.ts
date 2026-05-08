import fs from 'fs';
import path from 'path';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const PROJECT_DIR = process.env.WATCH_AXIOM_PROJECT_DIR || '/opt/axiom';

// Pull mermaid diagrams out of AXIOM_DIAGRAMS.md so the docs page can render
// them as visuals. Source-of-truth lives in the project repo; this endpoint
// just reads + slices it. Rendering happens client-side via mermaid.js.
function extractMermaid(md: string): { id: string; title: string; mermaid: string }[] {
  const out: { id: string; title: string; mermaid: string }[] = [];
  // Split on the section headings ## D-NN ·
  const sections = md.split(/^## (?=D-\d{2}\b)/m).slice(1);
  for (const sec of sections) {
    const headingMatch = sec.match(/^(D-\d{2})\s*·\s*(.+)$/m);
    if (!headingMatch) continue;
    const id = headingMatch[1];
    const title = headingMatch[2].trim();
    const mermaidMatch = sec.match(/```mermaid\n([\s\S]+?)\n```/);
    if (!mermaidMatch) continue;
    out.push({ id, title, mermaid: mermaidMatch[1] });
  }
  return out;
}

function safeRead(rel: string): string | null {
  try {
    return fs.readFileSync(path.join(PROJECT_DIR, rel), 'utf8');
  } catch {
    return null;
  }
}

export async function GET() {
  const diagramsMd = safeRead('AXIOM_DIAGRAMS.md');
  const diagrams = diagramsMd ? extractMermaid(diagramsMd) : [];
  const lessonsMd = safeRead('AXIOM_PHASE0_LESSONS.md');

  // Vibe-coder explanation copy. Lives here, not in the project, because this
  // is the operator-facing UI talking — it's allowed to be casual. The
  // serious docs in /opt/axiom remain serious.
  const sections = [
    {
      id: 'what-is-axiom',
      heading: 'What AXIOM is, in 60 seconds',
      body:
        "AXIOM is an entire airline operating system. Not a tool, not a SaaS bolted on the side — the whole thing. Dispatch, crew, tech ops, safety, sales, finance, regulators, ATC integration, all running off one consistent data spine instead of 60 spreadsheets and 12 vendor portals.\n\nIt's built around a central rule: nothing is real unless it's on the AXIOM substrate. No side spreadsheet. No tribal knowledge. No 'just check with Bob.' Every operational decision leaves a hash-chained audit trail (P05). Every contract is versioned (P07). Every rule is data, not code (P06).\n\nIt's also an experiment in agent-built software. The platform itself is being built by an agent floor — 41 AI agents (Claude + Codex), one CEO, ten dept managers, thirty coders — running in autopilot under an operator.",
    },
    {
      id: 'the-stack',
      heading: 'The stack, casually',
      body:
        'Backend: Rust services (one per platform-core capability — P01..P10) talking over NATS JetStream, persisting to Postgres 16 + Citus. Object store is MinIO (WORM bucket for documents). Schema registry is Apicurio. KMS is OpenBao. Identity is Keycloak with Cedar policies on top.\n\nFrontend: Next.js 15 + React 19 + Radix. WCAG 2.2 AA (AAA on safety-critical screens). The mobile EFB is a separate React Native app, signed-bundle delivery so a captain can sign for a release while offline.\n\nObservability: OpenTelemetry → Grafana + Prometheus + Loki. Every P-service must emit OTel before it merges (D1 OTel mandate gate enforces this).\n\nDeployment target: VPS-class infra. Docker compose for the substrate, systemd units for the Rust binaries, Caddy as the public reverse proxy. Optional: Fly.io machines for codex-agent traffic that the VPS IP gets blocked from by Cloudflare.',
    },
    {
      id: 'how-a-flight-works',
      heading: 'How a flight cycle moves through the system',
      body:
        "When dispatch releases a flight, the release event hits P04 (the bus). Every interested subsystem subscribes — crew sees the duty assignment, tech sees the aircraft tail tied to the release, SMS arms its monitors. The release writes a hash-chained event into P05 (audit). When the captain accepts the release on the EFB, that's another P05 event. When weather updates mid-flight via M73, the dispatch service re-evaluates and (if needed) re-issues a release amendment — fully traced.\n\nThe key thing: there's no parallel email chain, no spreadsheet update, no Slack message that holds operational truth. The release event IS the truth, and you can replay every flight cycle from those events alone in under 10 minutes.",
    },
    {
      id: 'phase-plan',
      heading: 'Phase plan (where we are)',
      body:
        'AXIOM ships in 6 phases over ~36 months (AI-floor delivery, planning ±35%, $7–10M gross / ~€4.5–6.5M net of SIFIDE II R&D credit):\n\n• Phase 0 — Foundation. Done. P01..P10 contracts, validators, audit chain, identity, time, bus, doc service, design system. ~3.5K artifact files. 81 of 82 validators green.\n\n• Phase 1 — Operate. AOC-critical: dispatch, crew, tech ops, safety. Connectors for weather/NOTAM/ATC slots/ACARS/FDM. The MVP target. We are HERE.\n\n• Phase 2 — Sell & Serve. Commercial side: sales, customer self-serve, cabin ops.\n\n• Phase 3 — Run Business. Back office: finance, HR, procurement, legal, QA.\n\n• Phase 4 — Harden & Extend. Security review, regulatory expansion, environmental, training.\n\n• Phase 5 — Saleability & Scale. Multi-tenant, third-party AOCs onboarding, white-label.',
    },
    {
      id: 'mvp-deploy',
      heading: 'How the MVP deploys to your VPS',
      body:
        "One VPS, three layers. (1) The substrate — Postgres+Citus, NATS, MinIO, Apicurio, OpenBao, OTel collector — runs as docker-compose under a non-root user. (2) The Rust P-services run as systemd units, talking to the substrate over localhost. (3) Caddy fronts everything on 443 with auto-LetsEncrypt and routes /p01..., /p11... to the right service.\n\nFrontend is Next.js, also a systemd unit. EFB mobile is a signed React Native bundle pulled by the device.\n\nDeploy script (`infra/deploy.sh`) does: cargo build --release → systemctl reload → caddy reload. Validators (`tools/run-all-validators.js`) gate every merge.\n\nThe agent floor (this watcher you're looking at) runs separately so a hot-reload of the platform never kills agent work, and vice versa.",
    },
    {
      id: 'what-this-watcher-is',
      heading: "What is this watcher you're using right now?",
      body:
        "This is the agent-floor control plane. It's a Next.js app (running on port 3012, Caddy-proxied) that drives 41 agents through one or more 'cycles per minute' of autonomous work on the AXIOM platform.\n\nWhat each tab does:\n• /axiom — the floor view. Watch managers + coders work in real time.\n• /axiom/work — task lane view, what each agent is doing right now.\n• /axiom/roadmap — the phase progress bar. Each item is a deliverable; built means evidence-on-disk; qualityHealthy means evidence-on-disk AND its validator exits 0.\n• /axiom/tasks — historical task feed.\n• /axiom/project — file/folder browser into /opt/axiom.\n• /axiom/settings — token-usage tracker. Cap is enforced; agents pause at the cap.\n• /axiom/docs — this page.\n\nThe autopilot pauses on $-cap, on operator command (touch /var/lib/watcher/axiom-autopilot.paused), or by Telegram bot.",
    },
    {
      id: 'lessons',
      heading: 'Lessons from Phase 0 close',
      body: lessonsMd
        ? 'Distilled from the 70%→100% close push (2026-05-08). Full doc: AXIOM_PHASE0_LESSONS.md.\n\n1. % built must mean validator-passes, not file-existence (otherwise agents ship at the wrong path and the % silently drifts).\n2. Manager prompts must include anti-loop rules: pick from REMAINING, do NOT elaborate already-built items, allocate ALL coders every cycle.\n3. Slow engines (codex /goal) must dispatch fire-and-forget; cycles never block on them.\n4. Engine ↔ model match is mandatory (codex on ChatGPT only accepts gpt-5.x).\n5. CEO directives must be ≤2 deliverables — long ones SIGKILL inside the cgroup.\n6. Live drills (replay, chaos) are NOT software — flag them as drill: true on the roadmap.\n7. Validator pass rate is a hard gate, not a metric. Target ≥99%.'
        : 'Phase 0 lessons document not yet generated.',
    },
  ];

  return NextResponse.json({
    ok: true,
    generatedAt: new Date().toISOString(),
    sections,
    diagrams,
    lessonsAvailable: !!lessonsMd,
  });
}
