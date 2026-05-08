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
  // P01 Identity
  { id: 'P01-svc',     label: 'P01 Identity service skeleton (Keycloak + Cedar + SpiceDB)', team: 1, evidence: ['services/p01-identity/Cargo.toml', 'services/p01-identity/src/'] },
  { id: 'P01-contract',label: 'P01 Identity contract',                                       team: 1, evidence: ['contracts/protos/axiom/identity/', 'contracts/cedar/identity/'] },
  // P02 Time
  { id: 'P02-svc',     label: 'P02 Time service skeleton (Rust + NTS + GNSS)',               team: 1, evidence: ['services/p02-time/Cargo.toml', 'services/p02-time/src/'] },
  { id: 'P02-contract',label: 'P02 Time contract',                                            team: 1, evidence: ['contracts/protos/axiom/time/', 'contracts/asyncapi/axiom.time'] },
  // P03 Data
  { id: 'P03-svc',     label: 'P03 Data spine (Postgres 16 + Citus)',                         team: 4, evidence: ['services/p03-data/', 'contracts/asyncapi/axiom.data'] },
  // P04 Bus
  { id: 'P04-svc',     label: 'P04 Bus skeleton (NATS JetStream)',                            team: 1, evidence: ['services/p04-bus/', 'contracts/asyncapi/axiom.bus'] },
  // P05 Audit
  { id: 'P05-svc',     label: 'P05 Audit service skeleton (BLAKE3 + RFC 3161)',               team: 1, evidence: ['services/p05-audit/Cargo.toml', 'services/p05-audit/src/'] },
  { id: 'P05-migrations',label:'P05 Audit append-only schema migration',                      team: 1, evidence: ['services/p05-audit/migrations/'] },
  { id: 'P05-contract',label: 'P05 Audit append envelope contract',                            team: 1, evidence: ['contracts/protos/axiom/core/v1/audit.proto', 'contracts/entities/audit'] },
  // P06 Rules
  { id: 'P06-svc',     label: 'P06 Rules service (Cedar + signed rule packs)',                team: 2, evidence: ['services/p06-rules/', 'contracts/cedar/dispatch/'] },
  { id: 'P06-validator',label:'P06 dispatch rule-pack validator',                              team: 2, evidence: ['tools/validate-rule-pack', 'contracts/rules/jurisdiction/easa/dispatch_gates_v0.yaml'] },
  // P07 Doc
  { id: 'P07-svc',     label: 'P07 Doc service (MinIO WORM + Apicurio)',                      team: 0, evidence: ['services/p07-doc/'] },
  // P08 UI
  { id: 'P08-shell',   label: 'P08 UI shell (Next.js 15 + React 19 + Radix)',                 team: 0, evidence: ['web/'] },
  // P09 Observability
  { id: 'P09-svc',     label: 'P09 Observability (OTel + Grafana)',                            team: 3, evidence: ['services/p09-observability/', 'observability/'] },
  { id: 'P09-otel-gate',label:'P09 OTel spine gate (npm test)',                                team: 3, evidence: ['tools/validate-otel-spine.js'] },
  { id: 'P09-slos',    label: 'P09 Phase-0 SLO catalogue (Sloth/Pyrra)',                       team: 3, evidence: ['contracts/reliability/', 'observability/slo'] },
  // KMS
  { id: 'KMS-svc',     label: 'KMS service (OpenBao + HSM)',                                   team: 0, evidence: ['services/kms/'] },
  // Reference data substrates (m4)
  { id: 'sub-airports',label: 'Substrate: airports ETL (OurAirports)',                         team: 4, evidence: ['connectors/airports/ingest.py'] },
  { id: 'sub-fleet',   label: 'Substrate: fleet ETL (OpenSky)',                                 team: 4, evidence: ['connectors/fleet/ingest.py'] },
  { id: 'sub-time',    label: 'Substrate: time service refdata',                               team: 4, evidence: ['connectors/time/'] },
  { id: 'sub-units',   label: 'Substrate: units quantity bus',                                  team: 4, evidence: ['connectors/units/', 'contracts/entities/units'] },
  // Cross-cutting Phase-0 contracts (each manager's domain)
  { id: 'D5-dispatch', label: 'Flight Ops: dispatch release contract',                          team: 5, evidence: ['contracts/protos/axiom/dispatch/v1/dispatch_release.proto'] },
  { id: 'D6-cba',      label: 'Crew: CBA-as-data scaffold',                                    team: 6, evidence: ['contracts/asyncapi/crew/cba_roster_gate.v1.yaml', 'contracts/rules/cba_rule_contract_v0.yaml'] },
  { id: 'D7-tech',     label: 'Engineering: technical-state contract',                          team: 7, evidence: ['contracts/entities/tech/technical_dispatch_gate.schema.json', 'tools/validate-tech-dispatch-gate.js'] },
  { id: 'D8-sms',      label: 'Safety: M17 just-culture firewall',                              team: 8, evidence: ['contracts/cedar/sms/just_culture_firewall.cedar', 'contracts/entities/m17_sms_voluntary_report.schema.json'] },
  { id: 'D9-settle',   label: 'Commercial: settlement spine contract',                          team: 9, evidence: ['contracts/entities/commercial/settlement_finance_entities.yaml'] },
  { id: 'D10-atc',     label: 'ATC/IQ: cross-tenant DP aggregate release',                      team: 10, evidence: ['contracts/entities/iq/p20_dp_aggregate_release.schema.json', 'contracts/entities/atc_flight_object.schema.json'] },
];

const DEPARTMENTS = ['Foundation', 'Governance', 'Reliability', 'Substrate', 'Flight Ops', 'Crew', 'Engineering', 'Safety', 'Commercial', 'ATC / IQ'];

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
  };
  cache = { ts: now, payload };
  return NextResponse.json(payload);
}
