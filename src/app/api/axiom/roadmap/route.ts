import fs from 'fs';
import path from 'path';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const PROJECT_DIR = process.env.WATCH_AXIOM_PROJECT_DIR || '/opt/axiom';

// Phase 0 manifest. Each entry is a deliverable; pick the first match for
// "evidence on disk" — the deliverable counts as built when ANY of the
// listed paths exists. Path strings are interpreted as relative-to-project
// glob-ish patterns; we do simple prefix / extension matching here, no full
// glob engine, to keep this dependency-free.
type Deliverable = {
  id: string;
  label: string;
  team: number;
  evidence: string[]; // any one matching = built
};

const PHASE0: Deliverable[] = [
  // ── D1 Foundation — spine P01..P05 + Bus + KMS ──────────────────────
  { id: 'D1-p01-svc',     label: 'P01 Identity service skeleton (Keycloak + Cedar + SpiceDB)', team: 1, evidence: ['services/p01-identity/Cargo.toml', 'services/p01-identity/src/'] },
  { id: 'D1-p01-contract',label: 'P01 Identity contract (protos/Cedar)',                       team: 1, evidence: ['contracts/protos/axiom/identity/', 'contracts/cedar/identity/'] },
  { id: 'D1-p02-svc',     label: 'P02 Time service skeleton (Rust + Chrony NTS + GNSS)',       team: 1, evidence: ['services/p02-time/Cargo.toml', 'services/p02-time/src/'] },
  { id: 'D1-p02-contract',label: 'P02 Time contract (proto/asyncapi)',                          team: 1, evidence: ['contracts/protos/axiom/time/', 'contracts/asyncapi/axiom.time'] },
  { id: 'D1-p04-svc',     label: 'P04 Bus skeleton (NATS JetStream 2.10)',                      team: 1, evidence: ['services/p04-bus/', 'contracts/asyncapi/axiom.bus'] },
  { id: 'D1-p05-svc',     label: 'P05 Audit service skeleton (BLAKE3 hash-chain + RFC 3161)',   team: 1, evidence: ['services/p05-audit/Cargo.toml', 'services/p05-audit/src/'] },
  { id: 'D1-p05-migr',    label: 'P05 Audit append-only schema migration',                       team: 1, evidence: ['services/p05-audit/migrations/'] },
  { id: 'D1-p05-envelope',label: 'P05 Audit append envelope contract',                          team: 1, evidence: ['contracts/protos/axiom/core/v1/audit.proto', 'contracts/entities/audit'] },
  { id: 'D1-p05-anchor',  label: 'P05 RFC 3161 / OpenTimestamps external-anchor gate',          team: 1, evidence: ['contracts/reliability/p05', 'tools/validate-p05', 'contracts/entities/audit/external_anchor', 'contracts/entities/audit/anchor'] },
  { id: 'D1-replay',      label: 'P05 deterministic replay fixture / verifier',                 team: 1, evidence: ['contracts/entities/audit/replay', 'tools/validate-replay', 'tests/fixtures/audit/replay'] },
  { id: 'D1-otel-mandate',label: 'D1 OTel SDK in every P-service before merge to main',         team: 1, evidence: ['observability/otel-mandate', 'contracts/reliability/otel'] },
  { id: 'D1-direct-db',   label: 'D1 zero-direct-DB-from-non-D1 CI gate',                        team: 1, evidence: ['contracts/reliability/d1-direct-db', 'tools/validate-direct-db'] },
  { id: 'D1-merge-gate',  label: 'D1 Phase-0 merge-gate validator',                              team: 1, evidence: ['tools/validate-d1-phase0-merge', 'contracts/reliability/d1-phase0-merge'] },
  { id: 'KMS-svc',        label: 'KMS service skeleton (OpenBao + HSM)',                         team: 1, evidence: ['services/kms/', 'contracts/protos/axiom/kms/'] },

  // ── D2 Governance — Rules + Doc + Design system ─────────────────────
  { id: 'D2-p06-svc',     label: 'P06 Rules service (Cedar + signed YAML rule packs)',          team: 2, evidence: ['services/p06-rules/', 'contracts/cedar/dispatch/'] },
  { id: 'D2-p06-validator',label:'P06 dispatch rule-pack validator',                            team: 2, evidence: ['tools/validate-rule-pack', 'contracts/rules/jurisdiction/easa/dispatch_gates_v0.yaml'] },
  { id: 'D2-p06-activate',label: 'P06 rule-pack activation / promotion validator',              team: 2, evidence: ['tools/validate-p06-activation', 'contracts/rules/p06_activation'] },
  { id: 'D2-cedar-cli',   label: 'Cedar CLI + Sigstore signer installed and verified',          team: 2, evidence: ['tools/cedar-sign', 'contracts/cedar/sign'] },
  { id: 'D2-regulator-mock',label:'P06 regulator-mock green for ≥14d',                          team: 2, evidence: ['contracts/rules/regulator-mock', 'tools/regulator-mock'] },
  { id: 'D2-design-sys',  label: 'Design system v1 (WCAG 2.2 AA, AAA on safety-critical)',      team: 2, evidence: ['contracts/design-system/', 'web/design-system/'] },
  { id: 'D2-p07-svc',     label: 'P07 Doc service (MinIO WORM + Apicurio)',                     team: 2, evidence: ['services/p07-doc/'] },
  { id: 'D2-p08-shell',   label: 'P08 UI shell (Next.js 15 + React 19 + Radix)',                team: 2, evidence: ['web/app/', 'web/package.json'] },
  { id: 'D2-close-gate',  label: 'D2 Phase-0 close-gate validator',                              team: 2, evidence: ['tools/validate-d2-phase0-close', 'contracts/rules/d2_phase0_close'] },

  // ── D3 Reliability — observability spine ────────────────────────────
  { id: 'D3-p09-svc',     label: 'P09 Observability (OTel + Grafana stack)',                    team: 3, evidence: ['services/p09-observability/', 'observability/'] },
  { id: 'D3-otel-gate',   label: 'OTel SDK wired in every P-service (test gate)',               team: 3, evidence: ['tools/validate-otel-spine.js'] },
  { id: 'D3-adversarial', label: 'Adversarial CI 7-test must-fail suite green',                 team: 3, evidence: ['tools/adversarial-ci', 'contracts/reliability/adversarial', 'observability/adversarial'] },
  { id: 'D3-slo-grafana', label: 'SLO error budgets per service in Grafana',                    team: 3, evidence: ['observability/slo', 'observability/grafana'] },
  { id: 'D3-slo-cat',     label: 'Phase-0 SLO catalogue (Sloth/Pyrra)',                          team: 3, evidence: ['contracts/reliability/phase0-slo'] },
  { id: 'D3-backup-drill',label: 'Backup-restore drill <15 min',                                 team: 3, evidence: ['contracts/reliability/phase0-backup-restore-drill.v1.yaml', 'tools/validate-dr-drill-contract.js'] },
  { id: 'D3-close-gate',  label: 'D3 Phase-0 close-readiness gate',                              team: 3, evidence: ['tools/validate-d3-phase0', 'contracts/reliability/d3-phase0-close'] },

  // ── D4 Substrate — P03 + connectors + units ─────────────────────────
  { id: 'D4-p03-svc',     label: 'P03 Data spine (Postgres 16 + Citus)',                        team: 4, evidence: ['services/p03-data/', 'contracts/asyncapi/axiom.data'] },
  { id: 'D4-airports',    label: 'OurAirports (83k rows) signed SHA-256 ingest',                team: 4, evidence: ['connectors/airports/ingest.py'] },
  { id: 'D4-fleet',       label: 'OpenSky (580k rows) signed SHA-256 ingest',                   team: 4, evidence: ['connectors/fleet/ingest.py'] },
  { id: 'D4-time-ref',    label: 'Substrate: time service reference data',                      team: 4, evidence: ['connectors/time/'] },
  { id: 'D4-units',       label: 'Substrate: units quantity bus',                                team: 4, evidence: ['connectors/units/', 'contracts/entities/units'] },
  { id: 'D4-buf-proto',   label: 'First Buf-versioned proto registered',                         team: 4, evidence: ['contracts/protos/axiom/substrate/v1/airport.proto', 'contracts/protos/buf.yaml'] },
  { id: 'D4-buf-ci',      label: 'Buf lint + breaking gate in CI',                               team: 4, evidence: ['tools/validate-buf', 'contracts/protos/buf-ci'] },
  { id: 'D4-publish-gate',label: 'D4 P10 substrate publication gate',                            team: 4, evidence: ['tools/validate-d4-p10-publish', 'contracts/entities/substrate/p10-publish'] },
  { id: 'D4-close',       label: 'D4 Phase-0 close evidence schema',                             team: 4, evidence: ['contracts/entities/substrate/phase0-close', 'tools/validate-d4-phase0-close'] },

  // ── D5 Flight Ops — gated on D1+D2 ──────────────────────────────────
  { id: 'D5-act-gate',    label: 'D5 activation pre-req: D1 spine + D2 dispatch rules ready',   team: 5, evidence: ['departments/D5_AGENT_HEALTH.md'] },
  { id: 'D5-dispatch-rel',label: 'Dispatch release contract (proto)',                            team: 5, evidence: ['contracts/protos/axiom/dispatch/v1/dispatch_release.proto'] },
  { id: 'D5-flight-cycle',label: 'Dispatch flight-cycle workflow contract',                      team: 5, evidence: ['contracts/workflows/dispatch_flight_cycle.v1.yaml'] },
  { id: 'D5-latency',     label: 'Dispatch latency-budget published contract',                   team: 5, evidence: ['contracts/asyncapi/dispatch-release.v1.yaml', 'contracts/entities/dispatch/latency_budget'] },
  { id: 'D5-captain',     label: 'Captain-acceptance gate schema (EFB offline reconcile)',       team: 5, evidence: ['contracts/entities/flight_ops_phase0.yaml', 'contracts/entities/dispatch/captain_acceptance'] },

  // ── D6 Crew — gated on D1+D2 ────────────────────────────────────────
  { id: 'D6-act-gate',    label: 'D6 activation pre-req: D1 spine + D2 rules ready',            team: 6, evidence: ['departments/D6_AGENT_HEALTH.md'] },
  { id: 'D6-cba-roster',  label: 'CBA roster-gate AsyncAPI',                                    team: 6, evidence: ['contracts/asyncapi/crew/cba_roster_gate.v1.yaml'] },
  { id: 'D6-cba-rule',    label: 'CBA-as-data rule-pack scaffold',                              team: 6, evidence: ['contracts/rules/cba_rule_contract_v0.yaml'] },
  { id: 'D6-duty',        label: 'Crew duty-rule evaluation schema',                            team: 6, evidence: ['contracts/entities/crew/crew_duty_rule_evaluation.schema.json'] },
  { id: 'D6-people-auth', label: 'Person-activity authorisation gRPC contract',                 team: 6, evidence: ['contracts/entities/crew/person_activity', 'contracts/protos/axiom/crew/'] },

  // ── D7 Engineering — gated on D1+D4 ─────────────────────────────────
  { id: 'D7-act-gate',    label: 'D7 activation pre-req: D1 spine + D4 substrate ready',        team: 7, evidence: ['departments/D7_AGENT_HEALTH.md'] },
  { id: 'D7-tech-state',  label: 'Aircraft technical-state contract',                           team: 7, evidence: ['contracts/entities/tech/aircraft_technical_state.schema.json'] },
  { id: 'D7-disp-gate',   label: 'Technical dispatch-gate contract + validator',                team: 7, evidence: ['contracts/entities/tech/technical_dispatch_gate.schema.json', 'tools/validate-tech-dispatch-gate.js'] },
  { id: 'D7-mel',         label: 'MEL item schema',                                              team: 7, evidence: ['contracts/entities/tech/mel_item.schema.json'] },
  { id: 'D7-ad-sb',       label: 'AD/SB compliance semantic invariants',                        team: 7, evidence: ['contracts/entities/tech/ad_sb_compliance.schema.json', 'contracts/entities/tech/ad_sb_invariants'] },
  { id: 'D7-close',       label: 'D7 Phase-0 close evidence schema',                            team: 7, evidence: ['contracts/entities/tech/d7_phase0_close_evidence.schema.json'] },

  // ── D8 Safety — gated on D1+D3 ──────────────────────────────────────
  { id: 'D8-act-gate',    label: 'D8 activation pre-req: D1 spine + D3 observability ready',   team: 8, evidence: ['departments/D8_AGENT_HEALTH.md'] },
  { id: 'D8-just-culture',label: 'M17 just-culture firewall (Cedar + JSON Schema)',            team: 8, evidence: ['contracts/cedar/sms/just_culture_firewall.cedar', 'contracts/entities/m17_sms_voluntary_report.schema.json'] },
  { id: 'D8-firewall-test',label:'M17 firewall validator with adversarial leak probes',         team: 8, evidence: ['tools/validate-sms', 'contracts/entities/m17_sms_redacted_projection.schema.json'] },
  { id: 'D8-avsec',       label: 'AVSEC (M18) security-event contract',                        team: 8, evidence: ['contracts/asyncapi/axiom.avsec.v0.yaml', 'contracts/entities/m18_avsec_security_event.schema.json', 'tools/validate-avsec-contract.js'] },
  { id: 'D8-forbidden',   label: 'D8 forbidden-surface extract schema',                         team: 8, evidence: ['contracts/entities/m17_sms_voluntary_report.schema.json', 'contracts/entities/d8_forbidden_surface'] },
  { id: 'D8-close',       label: 'D8 Phase-0 close-gate validator',                             team: 8, evidence: ['tools/validate-d8-phase0-close', 'contracts/entities/d8_phase0_close'] },

  // ── D9 Commercial — gated on D1+D2 (P07) ────────────────────────────
  { id: 'D9-act-gate',    label: 'D9 activation pre-req: D1 spine + P07 (Doc) ready',           team: 9, evidence: ['departments/D9_AGENT_HEALTH.md'] },
  { id: 'D9-settle',      label: 'Settlement spine contract (Customer/Ticket/Cargo/Invoice)',  team: 9, evidence: ['contracts/entities/commercial/settlement_finance_entities.yaml'] },
  { id: 'D9-slots',       label: 'Slots + traffic-rights two-gate publish check',               team: 9, evidence: ['contracts/entities/commercial/slots_rights_entities.yaml'] },
  { id: 'D9-corsia',      label: 'CORSIA ledger readiness AsyncAPI topic family',               team: 9, evidence: ['contracts/asyncapi/commercial/', 'contracts/entities/commercial/corsia'] },
  { id: 'D9-close',       label: 'D9 Phase-0 close-gate validator',                             team: 9, evidence: ['tools/validate-d9-phase0-close', 'contracts/entities/commercial/phase0_close'] },

  // ── D10 ATC / IQ — kickoff ──────────────────────────────────────────
  { id: 'D10-kickoff',    label: 'D10 kickoff: design partner + FIXM/AIXM groundwork',          team: 10, evidence: ['departments/D10_AGENT_HEALTH.md'] },
  { id: 'D10-fixm',       label: 'FIXM 4.3 + AIXM 5.1.1 conformance contract',                  team: 10, evidence: ['contracts/entities/atc_flight_object.schema.json', 'contracts/asyncapi/axiom_atc_v0.yaml'] },
  { id: 'D10-cpdlc',      label: 'M84 CPDLC/ADS-C datalink admission contract',                 team: 10, evidence: ['contracts/entities/iq/m84_cpdlc', 'contracts/entities/iq/datalink'] },
  { id: 'D10-p20-dp',     label: 'P20 cross-tenant DP aggregate release (no-lite privacy)',    team: 10, evidence: ['contracts/entities/iq/p20_dp_aggregate_release.schema.json'] },
  { id: 'D10-swim',       label: 'M80 SWIM ingest schema',                                      team: 10, evidence: ['contracts/entities/m80_swim_ingest.schema.json'] },
  { id: 'D10-close',      label: 'D10 Phase-0 close gate (M73/M74/M75/M80/M83/P20)',           team: 10, evidence: ['tools/validate-d10-phase0-close', 'contracts/entities/iq/d10_phase0_close'] },

  // ── CEO / shared — Phase-0 binding acceptance criteria ──────────────
  { id: 'X-od-decisions', label: 'OD-01..OD-07 open decisions resolved',                        team: 0, evidence: ['reports/od-resolutions', 'AXIOM_DECISIONS.md', 'departments/decisions'] },
  { id: 'X-techstack-locked',label:'AXIOM_TECHSTACK.md locked at Phase-0 close',                team: 0, evidence: ['AXIOM_TECHSTACK.md'] },
  { id: 'X-masterplan-locked',label:'AXIOM_MASTERPLAN.md final and locked',                     team: 0, evidence: ['AXIOM_MASTERPLAN.md'] },
  { id: 'X-replay-junior',label: 'Acceptance: any past flight cycle reproducible <10min',       team: 0, evidence: ['reports/audit-replay-acceptance', 'contracts/reliability/replay-acceptance'] },
  { id: 'X-zero-manual',  label: 'Acceptance: zero manual data entry on regulator submission',  team: 0, evidence: ['reports/regulator-zero-manual', 'tools/validate-regulator-pack'] },
  { id: 'X-ssot',         label: 'Acceptance: zero side-spreadsheets in active ops',            team: 0, evidence: ['reports/ssot-attestation', 'contracts/reliability/ssot'] },
  { id: 'X-config-not-code',label:'Acceptance: new jurisdiction onboarded <4 weeks',            team: 0, evidence: ['reports/jurisdiction-onboarding', 'contracts/rules/jurisdiction-template'] },
  { id: 'X-tem',          label: 'Acceptance: TEM register completeness, oldest review <12mo',  team: 0, evidence: ['contracts/rules/tem', 'reports/tem-register'] },
  { id: 'X-chaos',        label: 'Acceptance: subsystem independence proven by chaos tests',    team: 0, evidence: ['contracts/reliability/chaos', 'tools/chaos-test'] },
];

const DEPARTMENTS = ['Foundation', 'Governance', 'Reliability', 'Substrate', 'Flight Ops', 'Crew', 'Engineering', 'Safety', 'Commercial', 'ATC / IQ'];

// Multi-phase platform plan from AXIOM_MASTERPLAN.md §15.1.
// Phase 0 has detailed deliverables tracked above; future phases shown as
// high-level scope so the operator sees the trajectory beyond Phase 0.
const PHASES = [
  { num: 0, name: 'Foundation',         months: '0–6',   deliverable: 'AXIOM-CORE, ID, LOG, RULE, UI, DOC, OBS, LINK, KMS, reference data', cost: '$2.5–4M',  rationale: 'Nothing else builds honestly without this.' },
  { num: 1, name: 'Operate',             months: '6–18',  deliverable: 'AXIOM-DISPATCH, CREW, TECH, SMS. Weather, NOTAM, ATC slots, ACARS, FDM connectors',     cost: '$6–10M',   rationale: 'AOC-critical.' },
  { num: 2, name: 'Sell & Serve',        months: '12–24', deliverable: 'AXIOM-COMM, CUST, OPS, CABIN. NDC/GDS, DCS, BSP/CASS, baggage',                          cost: '$4–7M',    rationale: 'Revenue + customer experience.' },
  { num: 3, name: 'Run Business',        months: '18–30', deliverable: 'AXIOM-FIN, HR, PROC, LEGAL, QA. Tax engine, IFRS 16, payroll connectors',                cost: '$3–5M',    rationale: 'Internal back office.' },
  { num: 4, name: 'Harden & Extend',     months: '24–42', deliverable: 'AXIOM-SEC, CYBER, ENV, TRAIN, ERP',                                                       cost: '$3–6M',    rationale: 'Hardening & regulatory expansion.' },
  { num: 5, name: 'Saleability & Scale', months: '36–48', deliverable: 'Multi-tenant maturity, ≥1 third-party AOC running AXIOM, onboarding playbook',           cost: '$1.5–4M',  rationale: 'Externally validated.' },
];

function evidenceMatches(rel: string): { built: boolean; matchedPath: string | null; size: number } {
  const abs = path.join(PROJECT_DIR, rel);
  // Trailing slash = directory existence (recursive: at least one file inside)
  if (rel.endsWith('/')) {
    try {
      const stat = fs.statSync(abs);
      if (stat.isDirectory()) {
        const entries = fs.readdirSync(abs);
        if (entries.length > 0) return { built: true, matchedPath: rel, size: 0 };
      }
    } catch {}
    return { built: false, matchedPath: null, size: 0 };
  }
  // No trailing slash: file existence (or directory if explicit)
  try {
    const stat = fs.statSync(abs);
    if (stat.isFile()) return { built: true, matchedPath: rel, size: stat.size };
    if (stat.isDirectory()) {
      // If it's a directory match without trailing slash, check it has content
      const entries = fs.readdirSync(abs);
      if (entries.length > 0) return { built: true, matchedPath: rel, size: 0 };
    }
  } catch {}
  // Try as a prefix on the parent dir's listing — handles "contracts/asyncapi/axiom.time" as a stem
  try {
    const parent = path.dirname(abs);
    const stem = path.basename(abs);
    const entries = fs.readdirSync(parent);
    for (const e of entries) {
      if (e.startsWith(stem)) {
        return { built: true, matchedPath: path.join(path.dirname(rel), e), size: 0 };
      }
    }
  } catch {}
  return { built: false, matchedPath: null, size: 0 };
}

let cache: { ts: number; payload: any } | null = null;
const CACHE_TTL_MS = 10_000;

export async function GET() {
  const now = Date.now();
  if (cache && now - cache.ts < CACHE_TTL_MS) {
    return NextResponse.json({ ...cache.payload, cached: true });
  }
  const items = PHASE0.map((d) => {
    let hit: { built: boolean; matchedPath: string | null; size: number } = { built: false, matchedPath: null, size: 0 };
    for (const ev of d.evidence) {
      hit = evidenceMatches(ev);
      if (hit.built) break;
    }
    return { ...d, ...hit };
  });
  // Per-team rollup
  const byTeam: Record<number, { built: number; total: number; team: number; dept: string }> = {};
  for (let n = 0; n <= 10; n++) byTeam[n] = { built: 0, total: 0, team: n, dept: n === 0 ? 'CEO / shared' : DEPARTMENTS[n - 1] };
  for (const it of items) {
    byTeam[it.team].total += 1;
    if (it.built) byTeam[it.team].built += 1;
  }
  const built = items.filter((i) => i.built).length;
  const total = items.length;
  const payload = {
    ok: true,
    generatedAt: new Date().toISOString(),
    overall: { built, total, percent: total ? Math.round((built / total) * 100) : 0 },
    byTeam: Object.values(byTeam).filter((b) => b.total > 0),
    items,
    phases: PHASES,
    currentPhase: 0,
  };
  cache = { ts: now, payload };
  return NextResponse.json(payload);
}
