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

// A phase is broken into milestones; a milestone is broken into deliverables.
// A milestone with `deliverables.length === 0` is "scoping" — it exists as a
// placeholder so the phase can't be marked complete just because its already-
// scoped milestones happen to be done. This is the fix for the recurring
// "watcher shows complete but real scope isn't built" bug.
type Milestone = {
  id: string;        // e.g. "P2-M1"
  num: number;       // 1, 2, 3...
  name: string;      // "Two-gate schedule publish"
  scope: string;     // one-line description so the operator knows what's in this M
  owners: string;    // dept letter list, "D9" / "D9 + D5" / "all"
  deliverables: Deliverable[];
};

const PHASE0: Deliverable[] = [
  // ── D1 Foundation — spine P01..P05 + Bus + KMS ──────────────────────
  { id: 'D1-p01-svc',     label: 'P01 Identity service skeleton (Keycloak + Cedar + SpiceDB)', team: 1, evidence: ['services/p01-identity/Cargo.toml', 'services/p01-identity/src/'] },
  { id: 'D1-p01-contract',label: 'P01 Identity contract (protos/Cedar)',                       team: 1, evidence: ['contracts/protos/axiom/identity/', 'contracts/cedar/identity/', 'contracts/cedar/foundation/p01_identity.cedar', 'contracts/cedar/foundation/p01_identity.schema.cedarschema', 'contracts/protos/axiom/v1/identity.proto'] },
  { id: 'D1-p02-svc',     label: 'P02 Time service skeleton (Rust + Chrony NTS + GNSS)',       team: 1, evidence: ['services/p02-time/Cargo.toml', 'services/p02-time/src/'] },
  { id: 'D1-p02-contract',label: 'P02 Time contract (proto/asyncapi)',                          team: 1, evidence: ['contracts/protos/axiom/time/', 'contracts/asyncapi/axiom.time', 'contracts/protos/axiom/v1/time.proto', 'contracts/reference/p02_time_service_reference_sources.v1.yaml'] },
  { id: 'D1-p04-svc',     label: 'P04 Bus skeleton (NATS JetStream 2.10)',                      team: 1, evidence: ['services/p04-bus/', 'contracts/asyncapi/axiom.bus'] },
  { id: 'D1-p05-svc',     label: 'P05 Audit service skeleton (BLAKE3 hash-chain + RFC 3161)',   team: 1, evidence: ['services/p05-audit/Cargo.toml', 'services/p05-audit/src/'] },
  { id: 'D1-p05-migr',    label: 'P05 Audit append-only schema migration',                       team: 1, evidence: ['services/p05-audit/migrations/'] },
  { id: 'D1-p05-envelope',label: 'P05 Audit append envelope contract',                          team: 1, evidence: ['contracts/protos/axiom/core/v1/audit.proto', 'contracts/entities/audit'] },
  { id: 'D1-p05-anchor',  label: 'P05 RFC 3161 / OpenTimestamps external-anchor gate',          team: 1, evidence: ['contracts/reliability/p05', 'tools/validate-p05', 'contracts/entities/audit/external_anchor', 'contracts/entities/audit/anchor'] },
  { id: 'D1-replay',      label: 'P05 deterministic replay fixture / verifier',                 team: 1, evidence: ['contracts/entities/audit/replay', 'tools/validate-replay', 'tests/fixtures/audit/replay', 'contracts/replay/', 'tools/validate-deterministic-replay-gate.js', 'tools/validate-deterministic-replay-admission.js'] },
  { id: 'D1-otel-mandate',label: 'D1 OTel SDK in every P-service before merge to main',         team: 1, evidence: ['observability/otel-mandate', 'contracts/reliability/otel', 'contracts/reliability/phase0-otel-spine-gate.v1.yaml', 'contracts/reliability/phase0-otel-semantic-conventions.v1.yaml', 'tools/validate-otel-spine.js'] },
  { id: 'D1-direct-db',   label: 'D1 zero-direct-DB-from-non-D1 CI gate',                        team: 1, evidence: ['contracts/reliability/d1-direct-db', 'tools/validate-direct-db'] },
  { id: 'D1-merge-gate',  label: 'D1 Phase-0 merge-gate validator',                              team: 1, evidence: ['tools/validate-d1-phase0-merge', 'contracts/reliability/d1-phase0-merge', 'tools/validate-foundation-merge-gate.js', 'contracts/validators/foundation/d1_phase0_foundation_merge_gate.v1.yaml'] },
  { id: 'KMS-svc',        label: 'KMS service skeleton (OpenBao + HSM)',                         team: 1, evidence: ['services/kms/', 'contracts/protos/axiom/kms/'] },

  // ── D2 Governance — Rules + Doc + Design system ─────────────────────
  { id: 'D2-p06-svc',     label: 'P06 Rules service (Cedar + signed YAML rule packs)',          team: 2, evidence: ['services/p06-rules/', 'contracts/cedar/dispatch/'] },
  { id: 'D2-p06-validator',label:'P06 dispatch rule-pack validator',                            team: 2, evidence: ['tools/validate-rule-pack', 'contracts/rules/jurisdiction/easa/dispatch_gates_v0.yaml'] },
  { id: 'D2-p06-activate',label: 'P06 rule-pack activation / promotion validator',              team: 2, evidence: ['tools/validate-p06-activation', 'contracts/rules/p06_activation'] },
  { id: 'D2-cedar-cli',   label: 'Cedar CLI + Sigstore signer installed and verified',          team: 2, evidence: ['tools/cedar-sign', 'contracts/cedar/sign'] },
  { id: 'D2-regulator-mock',label:'P06 regulator-mock green for ≥14d',                          team: 2, evidence: ['contracts/rules/regulator-mock', 'tools/regulator-mock', 'tools/validate-p06-regulator-mock-suite.js'] },
  { id: 'D2-design-sys',  label: 'Design system v1 (WCAG 2.2 AA, AAA on safety-critical)',      team: 2, evidence: ['contracts/design-system/', 'web/design-system/', 'contracts/validators/governance/p08_design_system_v1_semantic_invariants.v1.yaml', 'contracts/ui/p08_design_system_v1_gate.schema.json'] },
  { id: 'D2-p07-svc',     label: 'P07 Doc service (MinIO WORM + Apicurio)',                     team: 2, evidence: ['services/p07-doc/', 'tools/validate-p07-doc-service-readiness-gate.js', 'tools/validate-p07-doc-contract.js', 'contracts/openapi/p07-doc-service.v1.yaml', 'contracts/doc/p07_doc_service_readiness_gate.schema.json'] },
  { id: 'D2-p08-shell',   label: 'P08 UI shell (Next.js 15 + React 19 + Radix)',                team: 2, evidence: ['web/app/', 'web/package.json', 'web/index.html', 'web/app.js'] },
  { id: 'D2-close-gate',  label: 'D2 Phase-0 close-gate validator',                              team: 2, evidence: ['tools/validate-d2-phase0-close', 'contracts/rules/d2_phase0_close'] },

  // ── D3 Reliability — observability spine ────────────────────────────
  { id: 'D3-p09-svc',     label: 'P09 Observability (OTel + Grafana stack)',                    team: 3, evidence: ['services/p09-observability/', 'observability/'] },
  { id: 'D3-otel-gate',   label: 'OTel SDK wired in every P-service (test gate)',               team: 3, evidence: ['tools/validate-otel-spine.js'] },
  { id: 'D3-adversarial', label: 'Adversarial CI 7-test must-fail suite green',                 team: 3, evidence: ['tools/adversarial-ci', 'contracts/reliability/adversarial', 'observability/adversarial', 'tools/validate-adversarial-ci-gate.js', 'contracts/reliability/phase0-adversarial-ci-gate.v1.yaml'] },
  { id: 'D3-slo-grafana', label: 'SLO error budgets per service in Grafana',                    team: 3, evidence: ['observability/slo', 'observability/grafana'] },
  { id: 'D3-slo-cat',     label: 'Phase-0 SLO catalogue (Sloth/Pyrra)',                          team: 3, evidence: ['contracts/reliability/phase0-slo'] },
  { id: 'D3-backup-drill',label: 'Backup-restore drill <15 min',                                 team: 3, evidence: ['contracts/reliability/phase0-backup-restore-drill.v1.yaml', 'tools/validate-dr-drill-contract.js'] },
  { id: 'D3-close-gate',  label: 'D3 Phase-0 close-readiness gate',                              team: 3, evidence: ['tools/validate-d3-phase0', 'contracts/reliability/d3-phase0-close'] },

  // ── D4 Substrate — P03 + connectors + units ─────────────────────────
  { id: 'D4-p03-svc',     label: 'P03 Data spine (Postgres 16 + Citus)',                        team: 4, evidence: ['services/p03-data/', 'contracts/asyncapi/axiom.data'] },
  { id: 'D4-airports',    label: 'OurAirports (83k rows) signed SHA-256 ingest',                team: 4, evidence: ['connectors/airports/ingest.py'] },
  { id: 'D4-fleet',       label: 'OpenSky (580k rows) signed SHA-256 ingest',                   team: 4, evidence: ['connectors/fleet/ingest.py'] },
  { id: 'D4-time-ref',    label: 'Substrate: time service reference data',                      team: 4, evidence: ['connectors/time/', 'contracts/reference/p02_time_service_reference_sources.v1.yaml', 'tests/fixtures/substrate/time_reference_invalid_missing_time_service.yaml'] },
  { id: 'D4-units',       label: 'Substrate: units quantity bus',                                team: 4, evidence: ['connectors/units/', 'contracts/entities/units', 'tools/validate-d4-units-quantity-bus.js', 'contracts/reference/units_quantity_registry.v1.yaml', 'contracts/asyncapi/axiom.core.units.v1.yaml'] },
  { id: 'D4-buf-proto',   label: 'First Buf-versioned proto registered',                         team: 4, evidence: ['contracts/protos/axiom/substrate/v1/airport.proto', 'contracts/protos/buf.yaml'] },
  { id: 'D4-buf-ci',      label: 'Buf lint + breaking gate in CI',                               team: 4, evidence: ['tools/validate-buf', 'contracts/protos/buf-ci', 'tools/validate-d4-buf-proto-registry.js', 'contracts/protos/buf.yaml', '.github/workflows/d4-substrate-buf.yml'] },
  { id: 'D4-publish-gate',label: 'D4 P10 substrate publication gate',                            team: 4, evidence: ['tools/validate-d4-p10-publish', 'contracts/entities/substrate/p10-publish'] },
  { id: 'D4-close',       label: 'D4 Phase-0 close evidence schema',                             team: 4, evidence: ['contracts/entities/substrate/phase0-close', 'tools/validate-d4-phase0-close'] },

  // ── D5 Flight Ops — gated on D1+D2 ──────────────────────────────────
  { id: 'D5-act-gate',    label: 'D5 activation pre-req: D1 spine + D2 dispatch rules ready',   team: 5, evidence: ['departments/D5_AGENT_HEALTH.md'] },
  { id: 'D5-dispatch-rel',label: 'Dispatch release contract (proto)',                            team: 5, evidence: ['contracts/protos/axiom/dispatch/v1/dispatch_release.proto', 'tools/validate-dispatch-release-rpc-contract.js'] },
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
  { id: 'D10-kickoff',    label: 'D10 kickoff: design partner + FIXM/AIXM groundwork',          team: 10, evidence: ['departments/D10_AGENT_HEALTH.md', 'departments/D10_GOAL.md'] },
  { id: 'D10-fixm',       label: 'FIXM 4.3 + AIXM 5.1.1 conformance contract',                  team: 10, evidence: ['contracts/entities/atc_flight_object.schema.json', 'contracts/asyncapi/axiom_atc_v0.yaml'] },
  { id: 'D10-cpdlc',      label: 'M84 CPDLC/ADS-C datalink admission contract',                 team: 10, evidence: ['contracts/entities/iq/m84_cpdlc', 'contracts/entities/iq/datalink', 'tools/validate-m84-datalink-gateway-contract.js', 'contracts/entities/m84_datalink_gateway_admission.schema.json'] },
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
  { id: 'X-config-not-code',label:'Acceptance: new jurisdiction onboarded <4 weeks',            team: 0, evidence: ['reports/jurisdiction-onboarding', 'contracts/rules/jurisdiction-template', 'contracts/rules/jurisdiction/', 'contracts/rules/jurisdiction_go_live_gate.schema.json', 'contracts/validators/governance/p06_jurisdiction_go_live_semantic_invariants.v1.yaml'] },
  { id: 'X-tem',          label: 'Acceptance: TEM register completeness, oldest review <12mo',  team: 0, evidence: ['contracts/rules/tem', 'reports/tem-register', 'contracts/tem/'] },
  { id: 'X-chaos',        label: 'Acceptance: subsystem independence proven by chaos tests',    team: 0, evidence: ['contracts/reliability/chaos', 'tools/chaos-test'] },
];

// Phase-1 (Operate) deliverables — masterplan §15.1, lessons from Phase-0 close push.
// Each item has BOTH an evidence path AND (where applicable) a validator the
// roadmap API gates quality on. Path discipline: deliverable file paths chosen
// to match where agents naturally ship, not aspirational locations.
const PHASE1: Deliverable[] = [
  // ── D5 DISPATCH (Flight Ops Phase-1 runtime) ───────────────────────────
  { id: 'P1-D5-rel-impl',     label: 'P1 Dispatch release service (Rust impl of dispatch_release.proto)',  team: 5, evidence: ['services/p11-dispatch/Cargo.toml', 'services/p11-dispatch/src/'] },
  { id: 'P1-D5-flight-cycle', label: 'P1 Flight-cycle workflow runtime',                                    team: 5, evidence: ['services/p11-dispatch/src/flight_cycle.rs', 'contracts/workflows/dispatch_flight_cycle_runtime.v1.yaml'] },
  { id: 'P1-D5-efb',          label: 'P1 EFB mobile shell (offline reconcile, captain accept)',             team: 5, evidence: ['mobile/efb/', 'web/efb-mobile/'] },
  { id: 'P1-D5-weather',      label: 'P1 Weather connector (METAR/TAF live ingest)',                        team: 5, evidence: ['connectors/weather/', 'contracts/connectors/weather.v1.yaml'] },
  { id: 'P1-D5-notam',        label: 'P1 NOTAM connector (ICAO live ingest)',                               team: 5, evidence: ['connectors/notam/', 'contracts/connectors/notam.v1.yaml'] },
  { id: 'P1-D5-atc-slots',    label: 'P1 ATC slots connector (Eurocontrol/CDM live)',                       team: 5, evidence: ['connectors/atc-slots/', 'contracts/connectors/atc_slots.v1.yaml'] },
  { id: 'P1-D5-acars',        label: 'P1 ACARS connector (downlink ingest)',                                team: 5, evidence: ['connectors/acars/', 'contracts/connectors/acars.v1.yaml'] },
  { id: 'P1-D5-fdm',          label: 'P1 FDM connector (flight data monitoring ingest)',                    team: 5, evidence: ['connectors/fdm/', 'contracts/connectors/fdm.v1.yaml'] },
  { id: 'P1-D5-latency-real', label: 'P1 Real-world latency budget validated against live traffic',         team: 5, evidence: ['reports/dispatch-latency-real-validation.md', 'contracts/reliability/dispatch-latency-p1.v1.yaml'] },

  // ── D6 CREW (Phase-1 runtime) ──────────────────────────────────────────
  { id: 'P1-D6-roster-impl',  label: 'P1 CBA roster generation runtime',                                    team: 6, evidence: ['services/p12-crew/Cargo.toml', 'services/p12-crew/src/roster.rs'] },
  { id: 'P1-D6-duty-eval',    label: 'P1 Duty-rule evaluation service',                                     team: 6, evidence: ['services/p12-crew/src/duty.rs', 'contracts/workflows/crew_duty_eval_runtime.v1.yaml'] },
  { id: 'P1-D6-fdtl',         label: 'P1 FDTL enforcement (flight duty time limits)',                       team: 6, evidence: ['services/p12-crew/src/fdtl.rs', 'contracts/rules/fdtl_enforcement_v1.yaml'] },
  { id: 'P1-D6-bidline',      label: 'P1 Bidline awarding engine',                                          team: 6, evidence: ['services/p12-crew/src/bidline.rs', 'contracts/workflows/bidline_award_v1.yaml'] },
  { id: 'P1-D6-trip-pairing', label: 'P1 Trip-pairing engine',                                              team: 6, evidence: ['services/p12-crew/src/trip_pairing.rs', 'contracts/workflows/trip_pairing_v1.yaml'] },

  // ── D7 TECH (Phase-1 runtime) ──────────────────────────────────────────
  { id: 'P1-D7-mel-runtime',  label: 'P1 MEL runtime + dispatch-gate enforcement',                          team: 7, evidence: ['services/p13-tech/Cargo.toml', 'services/p13-tech/src/mel.rs', 'tools/validate-tech-dispatch-gate.js'] },
  { id: 'P1-D7-ad-sb-track',  label: 'P1 AD/SB compliance tracker',                                         team: 7, evidence: ['services/p13-tech/src/ad_sb.rs', 'contracts/workflows/ad_sb_compliance_v1.yaml'] },
  { id: 'P1-D7-tech-state',   label: 'P1 Aircraft technical-state service',                                 team: 7, evidence: ['services/p13-tech/src/tech_state.rs', 'contracts/workflows/aircraft_tech_state_runtime.v1.yaml'] },
  { id: 'P1-D7-defect-mgmt',  label: 'P1 Defect-management workflow',                                       team: 7, evidence: ['services/p13-tech/src/defect.rs', 'contracts/workflows/defect_management_v1.yaml'] },

  // ── D8 SAFETY / SMS (Phase-1 runtime) ──────────────────────────────────
  { id: 'P1-D8-sms-rt',       label: 'P1 SMS runtime + just-culture firewall enforcement',                  team: 8, evidence: ['services/p14-sms/Cargo.toml', 'services/p14-sms/src/'] },
  { id: 'P1-D8-fdm-exceed',   label: 'P1 FDM exceedance detection',                                         team: 8, evidence: ['services/p14-sms/src/fdm_exceedance.rs', 'contracts/workflows/fdm_exceedance_v1.yaml'] },
  { id: 'P1-D8-tem-runtime',  label: 'P1 TEM register active management',                                   team: 8, evidence: ['services/p14-sms/src/tem.rs', 'contracts/workflows/tem_active_management_v1.yaml'] },
  { id: 'P1-D8-avsec',        label: 'P1 AVSEC runtime',                                                    team: 8, evidence: ['services/p14-sms/src/avsec.rs', 'contracts/workflows/avsec_runtime_v1.yaml'] },

  // ── UX (Phase-1 user-facing) ───────────────────────────────────────────
  { id: 'P1-UX-shell',        label: 'P1 Web shell (Next.js 15 + Radix, real)',                             team: 2, evidence: ['web/package.json', 'web/app/layout.tsx', 'web/app/page.tsx'] },
  { id: 'P1-UX-design-sys',   label: 'P1 Design system v1 components (WCAG 2.2 AA)',                        team: 2, evidence: ['web/components/', 'web/lib/design-tokens.ts'] },
  { id: 'P1-UX-dispatch',     label: 'P1 Dispatch console UI',                                              team: 5, evidence: ['web/app/dispatch/page.tsx', 'web/components/dispatch/'] },
  { id: 'P1-UX-crew',         label: 'P1 Crew rostering UI',                                                team: 6, evidence: ['web/app/crew/page.tsx', 'web/components/crew/'] },
  { id: 'P1-UX-tech',         label: 'P1 Tech / MEL UI',                                                    team: 7, evidence: ['web/app/tech/page.tsx', 'web/components/tech/'] },
  { id: 'P1-UX-sms',          label: 'P1 SMS reporting UI',                                                 team: 8, evidence: ['web/app/sms/page.tsx', 'web/components/sms/'] },

  // ── Deployment + ops readiness ─────────────────────────────────────────
  { id: 'P1-OPS-dockerfiles', label: 'P1 Dockerfiles for every P-service',                                  team: 3, evidence: ['services/p01-identity/Dockerfile', 'services/p11-dispatch/Dockerfile'] },
  { id: 'P1-OPS-systemd',     label: 'P1 systemd unit files for every P-service',                           team: 3, evidence: ['infra/systemd/'] },
  { id: 'P1-OPS-caddy',       label: 'P1 Caddy reverse-proxy config (TLS, /p01.. routes)',                  team: 3, evidence: ['infra/caddy/Caddyfile'] },
  { id: 'P1-OPS-deploy',      label: 'P1 Deploy script (build → ship → reload)',                            team: 3, evidence: ['infra/deploy.sh', 'tools/deploy.sh'] },
  { id: 'P1-OPS-ci',          label: 'P1 CI workflow (cargo + validators + buf)',                           team: 3, evidence: ['.github/workflows/ci.yml'] },
  { id: 'P1-OPS-replay-drill',label: 'P1 Replay drill executed (junior <10min)',                            team: 3, evidence: ['reports/audit-replay-drill.log'] },
  { id: 'P1-OPS-chaos-drill', label: 'P1 Chaos drill executed (P02/P04/P05/P10 outages)',                   team: 3, evidence: ['reports/chaos-drill.log'] },
];

const DEPARTMENTS = ['Foundation', 'Governance', 'Reliability', 'Substrate', 'Flight Ops', 'Crew', 'Engineering', 'Safety', 'Commercial', 'ATC / IQ'];

// Phase 0 — single Foundation milestone wrapping every Phase-0 deliverable.
// All Phase-0 work was one push; we keep one milestone so the structure is
// uniform across phases.
const PHASE0_MILESTONES: Milestone[] = [
  {
    id: 'P0-M1', num: 1,
    name: 'Foundation close',
    scope: 'AXIOM-CORE, ID, LOG, RULE, UI, DOC, OBS, LINK, KMS. Reference data ingest. Department close-gates.',
    owners: 'all',
    deliverables: PHASE0,
  },
];

// Phase 1 — single Operate milestone wrapping every Phase-1 deliverable.
const PHASE1_MILESTONES: Milestone[] = [
  {
    id: 'P1-M1', num: 1,
    name: 'Operate runtime',
    scope: 'AXIOM-DISPATCH, CREW, TECH, SMS runtimes + weather/NOTAM/ATC-slots/ACARS/FDM connectors + UX shells.',
    owners: 'D5 D6 D7 D8 + UX/Ops',
    deliverables: PHASE1,
  },
];

// Phase 2 — Sell & Serve (months 8–16, $1.3–2M). AXIOM_MASTERPLAN.md §15.1
// names: "AXIOM-COMM, AXIOM-CUST, AXIOM-OPS, AXIOM-CABIN. NDC/GDS, DCS, BSP/CASS, baggage."
// Milestone breakdown follows that scope. Every milestone shipped in the M1
// "two-gate" push goes under M1; the remaining four are placeholders so the
// phase can't show complete until they're scoped + built.
const PHASE2_MILESTONES: Milestone[] = [
  {
    id: 'P2-M1', num: 1,
    name: 'Two-gate schedule publish',
    scope: 'Slots + traffic-rights two-gate check before any schedule reaches NDC/GDS. Doctrine: §9.',
    owners: 'D9',
    deliverables: [
      { id: 'P2-M1-schema',       label: 'D9 commercial two-gate PG schema (9 canonical entities)',                                                                                              team: 9, evidence: ['services/p03-data/migrations/0002_commercial_two_gate.sql'] },
      { id: 'P2-M1-work-order',   label: 'D9 work order with c9-1/c9-2/c9-3 coder briefs',                                                                                                       team: 9, evidence: ['departments/D9_PHASE2_WORK_ORDER.md'] },
      { id: 'P2-M1-seeder',       label: 'D9 seed-commercial-two-gate.sh fixture (route/ASA/designation/permit/ownership/slots)',                                                                team: 9, evidence: ['scripts/seed-commercial-two-gate.sh'] },
      { id: 'P2-M1-cli-cmd',      label: 'axiom-cli `commercial gate-check <id>` subcommand',                                                                                                    team: 9, evidence: ['services/axiom-cli/src/main.rs'] },
      { id: 'P2-M1-demo',         label: 'demo-two-gate.sh (3 schedules: GREEN, SLOT_BLOCKED, RIGHTS_BLOCKED)',                                                                                  team: 9, evidence: ['scripts/demo-two-gate.sh'] },
      { id: 'P2-M1-close-report', label: 'M1 close report (two-gate)',                                                                                                                           team: 9, evidence: ['reports/PHASE2_M1_TWO_GATE_DEMO.md'] },
      { id: 'P2-M1-cba-pgaspac',  label: 'AE PGA/SPAC BTE 33/2009 Layer-2 CBA pack (alongside UPA23)',                                                                                          team: 2, evidence: ['contracts/cba/pga_spac_bte_33_2009/', 'contracts/rules/cba/pga_spac_bte_33_2009/'] },
      { id: 'P2-M1-rule-pack',    label: 'Commercial two-gate rule pack v0',                                                                                                                     team: 9, evidence: ['contracts/rules/commercial_two_gate_v0.yaml'] },
      { id: 'P2-M1-validators',   label: 'D9 commercial validators (board-deck, CORSIA, IFRS16, loyalty, ownership-control, sales-channel, two-gate)',                                          team: 9, evidence: ['contracts/validators/commercial/'] },
      { id: 'P2-M1-entities',     label: 'D9 slots-rights canonical entities contract',                                                                                                          team: 9, evidence: ['contracts/entities/commercial/slots_rights_entities.yaml'] },
    ],
  },
  {
    id: 'P2-M2', num: 2,
    name: 'AXIOM-COMM (NDC/GDS distribution)',
    scope: 'IATA NDC 21.3 schedule + offer + order management; GDS connectors (Amadeus, Sabre, Travelport); fare publication; ATPCO category fares.',
    owners: 'D9',
    deliverables: [
      { id: 'P2-M2-work-order',      label: 'D9 M2 work order (AXIOM-COMM / NDC + GDS coder briefs)',                                                                  team: 9, evidence: ['departments/D9_PHASE2_M2_WORK_ORDER.md'] },
      { id: 'P2-M2-entities',        label: 'AXIOM-COMM canonical entities (offer / order / ticket / fare / baggage-offer)',                                            team: 9, evidence: ['contracts/entities/commercial/axiom_comm_entities.yaml'] },
      { id: 'P2-M2-ndc-proto',       label: 'IATA NDC 21.3 message proto (AirShopping, OfferPrice, OrderCreate/View/Retrieve/Cancel)',                                  team: 9, evidence: ['contracts/protos/axiom/commercial/v1/ndc.proto'] },
      { id: 'P2-M2-svc-skel',        label: 'P15 AXIOM-COMM service skeleton',                                                                                          team: 9, evidence: ['services/p15-comm/Cargo.toml', 'services/p15-comm/src/'] },
      { id: 'P2-M2-pg-schema',       label: 'D9 NDC/GDS PG schema (offer / order / fare_rule / ticket tables)',                                                         team: 9, evidence: ['services/p03-data/migrations/0003_commercial_ndc_gds.sql'] },
      { id: 'P2-M2-asyncapi',        label: 'AXIOM-COMM AsyncAPI (offer-published, order-created, order-cancelled, baggage-offered)',                                   team: 9, evidence: ['contracts/asyncapi/commercial/axiom_comm_v0.yaml'] },
      { id: 'P2-M2-atpco-rule-pack', label: 'ATPCO category-fare publication rule pack v0 (cat-1/2/3/4/19 fare-rule subset)',                                           team: 9, evidence: ['contracts/rules/commercial_atpco_fare_pack_v0.yaml'] },
      { id: 'P2-M2-gds-adapter',     label: 'GDS adapter contract (Amadeus / Sabre / Travelport — one interface, three impl manifests)',                                team: 9, evidence: ['contracts/connectors/gds_adapter.v1.yaml'] },
      { id: 'P2-M2-ndc-validator',   label: 'NDC offer + order admission validator (Cedar + JSON schema invariants)',                                                   team: 9, evidence: ['contracts/validators/commercial/d9_ndc_admission_semantic_invariants.v1.yaml', 'tools/validate-ndc-admission.js'] },
      { id: 'P2-M2-atpco-validator', label: 'ATPCO fare-rule pack validator',                                                                                           team: 9, evidence: ['tools/validate-atpco-fare-pack.js'] },
      { id: 'P2-M2-demo',            label: 'demo-ndc-offer-order.sh (shop → price → order → ticket — 3 scenarios: PUBLISHED, FARE_BLOCKED, OWNERSHIP_BLOCKED)',        team: 9, evidence: ['scripts/demo-ndc-offer-order.sh'] },
      { id: 'P2-M2-close-report',    label: 'M2 close report (NDC/GDS distribution demo)',                                                                               team: 9, evidence: ['reports/PHASE2_M2_NDC_DEMO.md'] },
    ],
  },
  {
    id: 'P2-M3', num: 3,
    name: 'AXIOM-CUST (DCS + baggage)',
    scope: 'Departure Control System: check-in, seat assignment, boarding, weight-and-balance handoff. Baggage tracking per IATA Resolution 753.',
    owners: 'D9 + D5 + D6',
    deliverables: [
      { id: 'P2-M3-work-order',      label: 'D9 M3 work order (AXIOM-CUST / DCS + baggage coder briefs)',                                                                team: 9, evidence: ['departments/D9_PHASE2_M3_WORK_ORDER.md'] },
      { id: 'P2-M3-entities',        label: 'AXIOM-CUST canonical entities (passenger journey / check-in / seat / boarding pass / baggage tag / mishandled bag)',         team: 9, evidence: ['contracts/entities/customer/axiom_cust_entities.yaml'] },
      { id: 'P2-M3-dcs-proto',       label: 'DCS proto (CheckIn / SeatAssign / Board / WBHandoff / Manifest)',                                                              team: 9, evidence: ['contracts/protos/axiom/customer/v1/dcs.proto'] },
      { id: 'P2-M3-svc-skel',        label: 'P16 AXIOM-CUST service skeleton',                                                                                              team: 9, evidence: ['services/p16-cust/Cargo.toml', 'services/p16-cust/src/'] },
      { id: 'P2-M3-pg-schema',       label: 'DCS + baggage PG schema (passenger_journey / checkin / seat / boarding / baggage_tag / scan_event tables)',                    team: 9, evidence: ['services/p03-data/migrations/0004_customer_dcs.sql'] },
      { id: 'P2-M3-asyncapi',        label: 'AXIOM-CUST AsyncAPI (passenger-accepted, seat-assigned, boarded, baggage-tagged, baggage-scanned, baggage-mishandled)',        team: 9, evidence: ['contracts/asyncapi/customer/axiom_cust_v0.yaml'] },
      { id: 'P2-M3-wb-handoff',      label: 'W&B handoff contract — DCS final passenger/baggage counts → dispatch release (D5 boundary)',                                   team: 5, evidence: ['contracts/entities/customer/wb_handoff_to_dispatch.schema.json'] },
      { id: 'P2-M3-boarding-wf',     label: 'Boarding gate workflow (gate process, last-call, no-show, off-load — D6 cabin/ground boundary)',                              team: 6, evidence: ['contracts/workflows/boarding_v1.yaml'] },
      { id: 'P2-M3-res753-entities', label: 'IATA Resolution 753 baggage tracking entities (4 mandatory tracking points: acceptance / loading / transfer / arrival)',       team: 9, evidence: ['contracts/entities/customer/baggage_res753_entities.yaml'] },
      { id: 'P2-M3-dcs-validator',   label: 'DCS admission validator (Cedar + JSON schema invariants: doc check, seat capacity, boarding cutoffs)',                         team: 9, evidence: ['contracts/validators/customer/d9_dcs_admission_invariants.v1.yaml', 'tools/validate-dcs-admission.js'] },
      { id: 'P2-M3-res753-validator',label: 'Res. 753 tracking validator (all 4 tracking points logged before flight close)',                                              team: 9, evidence: ['tools/validate-res753-tracking.js'] },
      { id: 'P2-M3-demo',            label: 'demo-checkin-board-bag.sh (5 pax: 3 GREEN, 1 NO_SHOW, 1 MISHANDLED_BAG; show 4 scan points fire)',                            team: 9, evidence: ['scripts/demo-checkin-board-bag.sh'] },
      { id: 'P2-M3-close-report',    label: 'M3 close report (DCS + baggage demo)',                                                                                          team: 9, evidence: ['reports/PHASE2_M3_DCS_BAGGAGE_DEMO.md'] },
    ],
  },
  {
    id: 'P2-M4', num: 4,
    name: 'AXIOM-OPS (BSP/CASS settlement)',
    scope: 'IATA BSP (passenger) + CASS (cargo) settlement integration; remittance/reconciliation; IFRS 15 revenue recognition for tickets.',
    owners: 'D9',
    deliverables: [],
  },
  {
    id: 'P2-M5', num: 5,
    name: 'AXIOM-CABIN (cabin operations)',
    scope: 'Cabin-crew duty integration, IFE/IFC manifest, catering uplift, retail-onboard cycle.',
    owners: 'D9 + D6',
    deliverables: [],
  },
];

// Phase 3+ — Run Business / Harden / Productise. Milestones not yet scoped.
// Adding a known-scope placeholder per phase keeps the "scoping" gate honest:
// the phase can't go complete just because nobody filled it in.
const PHASE3_MILESTONES: Milestone[] = [];
const PHASE4_MILESTONES: Milestone[] = [];
const PHASE5_MILESTONES: Milestone[] = [];

// ── Overlay manifest ────────────────────────────────────────────────
// The autopilot CEO orchestrator nominates cross-team contributions at
// paths outside the hardcoded manifest above. Without overlay merging,
// those teams stay at total=0 → their coders get skipped by the driver's
// idle-team backstop → only 1 manager + 3 coders ever run per cycle.
// The overlay file lets the driver inject CEO-allocated deliverables AS
// IF they were in the manifest, unlocking the full floor. Operator can
// review + promote into source on PR review; or just leave them in the
// overlay and let autopilot keep working.
const OVERLAY_FILE = process.env.WATCH_AXIOM_ROADMAP_OVERLAY || '/var/lib/watcher/axiom-roadmap-overlay.json';

type OverlayDeliverable = { id: string; label: string; team: number; evidence: string[]; milestoneId: string };
type OverlayFile = { generatedAt?: string; entries: OverlayDeliverable[] };

function loadOverlay(): OverlayFile {
  try {
    const txt = fs.readFileSync(OVERLAY_FILE, 'utf8');
    const parsed = JSON.parse(txt);
    if (parsed && Array.isArray(parsed.entries)) return parsed as OverlayFile;
  } catch {}
  return { entries: [] };
}

function applyOverlay(allMilestones: Milestone[][]): void {
  // Mutates the milestone arrays in place by appending overlay deliverables
  // to the matching milestone (by id). Overlay entries with no matching
  // milestone are dropped silently — they'd need a manifest milestone first.
  const overlay = loadOverlay();
  if (!overlay.entries.length) return;
  const byMilestone = new Map<string, Deliverable[]>();
  for (const e of overlay.entries) {
    if (!byMilestone.has(e.milestoneId)) byMilestone.set(e.milestoneId, []);
    byMilestone.get(e.milestoneId)!.push({ id: e.id, label: e.label, team: e.team, evidence: e.evidence });
  }
  for (const phaseMilestones of allMilestones) {
    for (const m of phaseMilestones) {
      const extra = byMilestone.get(m.id);
      if (!extra || !extra.length) continue;
      // Dedupe by id — if a later overlay write repeats an id, last wins.
      const existing = new Map<string, Deliverable>();
      for (const d of m.deliverables) existing.set(d.id, d);
      for (const d of extra) existing.set(d.id, d);
      m.deliverables = Array.from(existing.values());
    }
  }
}

// Multi-phase platform plan from AXIOM_MASTERPLAN.md §15.1.
// Phase 0 has detailed deliverables tracked above; future phases shown as
// high-level scope so the operator sees the trajectory beyond Phase 0.
const PHASES = [
  { num: 0, name: 'Foundation',         months: '0–3',   deliverable: 'AXIOM-CORE, ID, LOG, RULE, UI, DOC, OBS, LINK, KMS, reference data', cost: '$400–600K',  rationale: 'Nothing else builds honestly without this.' },
  { num: 1, name: 'Operate',             months: '3–9',   deliverable: 'AXIOM-DISPATCH, CREW, TECH, SMS. Weather, NOTAM, ATC slots, ACARS, FDM connectors',     cost: '$1.8–2.5M',  rationale: 'AOC-critical.' },
  { num: 2, name: 'Sell & Serve',        months: '8–16',  deliverable: 'AXIOM-COMM, CUST, OPS, CABIN. NDC/GDS, DCS, BSP/CASS, baggage',                          cost: '$1.3–2.0M',  rationale: 'Revenue + customer experience.' },
  { num: 3, name: 'Run Business',        months: '14–22', deliverable: 'AXIOM-FIN, HR, PROC, LEGAL, QA. Tax engine, IFRS 16, payroll connectors',                cost: '$1.0–1.5M',  rationale: 'Internal back office.' },
  { num: 4, name: 'Harden & Extend',     months: '20–30', deliverable: 'AXIOM-SEC, CYBER, ENV, TRAIN, ERP. Phase-4 audit gate (15 external audits)',             cost: '$1.5–2.0M',  rationale: 'Hardening & regulatory expansion.' },
  { num: 5, name: 'Saleability & Scale', months: '26–36', deliverable: 'Multi-tenant maturity, ≥1 third-party AOC running AXIOM, onboarding playbook',           cost: '$1.0–1.4M',  rationale: 'Externally validated.' },
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

// Read the validator pass-matrix produced by `tools/run-all-validators.js`.
// File-existence is the cheap signal; this turns it into "validator-passes"
// — the missing third leg of "is Phase-0 actually green". An item with a
// validator path in its evidence list whose validator FAILED gets a
// qualityFailed flag and is excluded from the qualityBuilt rollup.
type ValidatorResult = { validator: string; passed: boolean; exitCode: number | null; signal: string | null; durationMs: number };
type ValidatorMatrix = { generatedAt: string; total: number; passed: number; failed: number; passRate: number; results: ValidatorResult[] };

function loadValidatorMatrix(): ValidatorMatrix | null {
  const f = path.join(PROJECT_DIR, 'reports/phase0-validator-pass-matrix.json');
  try {
    const txt = fs.readFileSync(f, 'utf8');
    return JSON.parse(txt) as ValidatorMatrix;
  } catch {
    return null;
  }
}

function validatorsForItem(evidence: string[]): string[] {
  return evidence.filter((e) => /(^|\/)tools\/validate-[^/]+\.js$/.test(e));
}

// ── Evaluated shapes (what the UI consumes) ─────────────────────────────
type EvaluatedDeliverable = Deliverable & {
  phase: number;
  milestoneId: string;
  built: boolean;
  matchedPath: string | null;
  size: number;
  qualityFailed: boolean | null;     // null = no validators in evidence
  failedValidators: string[];
};

type MilestoneStatus = 'scoping' | 'in_progress' | 'closed';

type EvaluatedMilestone = {
  id: string;
  num: number;
  name: string;
  scope: string;
  owners: string;
  phase: number;
  status: MilestoneStatus;
  built: number;
  total: number;
  qualityHealthy: number;        // built AND not qualityFailed
  qualityBlocked: number;        // built AND qualityFailed
  deliverables: EvaluatedDeliverable[];
};

type PhaseSummary = {
  phase: number;
  name: string;
  milestonesTotal: number;
  milestonesClosed: number;
  milestonesScoping: number;
  milestonesInProgress: number;
  built: number;                 // sum of built deliverables across milestones
  total: number;                 // sum of total deliverables across scoped milestones
  complete: boolean;             // every milestone closed AND none scoping
};

function evalDeliverable(
  d: Deliverable,
  phase: number,
  milestoneId: string,
  matrix: ValidatorMatrix | null,
  passByValidator: Map<string, boolean>,
): EvaluatedDeliverable {
  let hit: { built: boolean; matchedPath: string | null; size: number } = { built: false, matchedPath: null, size: 0 };
  for (const ev of d.evidence) {
    hit = evidenceMatches(ev);
    if (hit.built) break;
  }
  const itemValidators = validatorsForItem(d.evidence);
  let qualityFailed: boolean | null = null;
  let failedValidators: string[] = [];
  if (itemValidators.length && matrix) {
    const known = itemValidators.filter((v) => passByValidator.has(v));
    if (known.length) {
      failedValidators = known.filter((v) => !passByValidator.get(v));
      qualityFailed = failedValidators.length > 0;
    }
  }
  return { ...d, phase, milestoneId, ...hit, qualityFailed, failedValidators };
}

function evalMilestone(
  m: Milestone,
  phase: number,
  matrix: ValidatorMatrix | null,
  passByValidator: Map<string, boolean>,
): EvaluatedMilestone {
  const deliverables = m.deliverables.map((d) => evalDeliverable(d, phase, m.id, matrix, passByValidator));
  const total = deliverables.length;
  const built = deliverables.filter((d) => d.built).length;
  const qualityHealthy = deliverables.filter((d) => d.built && d.qualityFailed !== true).length;
  const qualityBlocked = deliverables.filter((d) => d.built && d.qualityFailed === true).length;
  let status: MilestoneStatus;
  if (total === 0) status = 'scoping';
  else if (qualityHealthy === total) status = 'closed';
  else status = 'in_progress';
  return { id: m.id, num: m.num, name: m.name, scope: m.scope, owners: m.owners, phase, status, built, total, qualityHealthy, qualityBlocked, deliverables };
}

function summarizePhase(phaseNum: number, name: string, milestones: EvaluatedMilestone[]): PhaseSummary {
  const milestonesTotal = milestones.length;
  const milestonesClosed = milestones.filter((m) => m.status === 'closed').length;
  const milestonesScoping = milestones.filter((m) => m.status === 'scoping').length;
  const milestonesInProgress = milestones.filter((m) => m.status === 'in_progress').length;
  const built = milestones.reduce((acc, m) => acc + m.built, 0);
  const total = milestones.reduce((acc, m) => acc + m.total, 0);
  // A phase is complete only when (a) at least one milestone is defined,
  // (b) none are scoping placeholders, (c) all scoped milestones are closed.
  const complete = milestonesTotal > 0 && milestonesScoping === 0 && milestonesClosed === milestonesTotal;
  return { phase: phaseNum, name, milestonesTotal, milestonesClosed, milestonesScoping, milestonesInProgress, built, total, complete };
}

export async function GET() {
  const now = Date.now();
  if (cache && now - cache.ts < CACHE_TTL_MS) {
    return NextResponse.json({ ...cache.payload, cached: true });
  }
  const matrix = loadValidatorMatrix();
  const passByValidator = new Map<string, boolean>();
  if (matrix) for (const r of matrix.results) passByValidator.set(r.validator, r.passed);

  // Apply autopilot CEO's overlay deliverables before evaluation.
  // We clone the manifests so source arrays stay untouched cycle-to-cycle.
  const phase0Src = PHASE0_MILESTONES.map((m) => ({ ...m, deliverables: [...m.deliverables] }));
  const phase1Src = PHASE1_MILESTONES.map((m) => ({ ...m, deliverables: [...m.deliverables] }));
  const phase2Src = PHASE2_MILESTONES.map((m) => ({ ...m, deliverables: [...m.deliverables] }));
  const phase3Src = PHASE3_MILESTONES.map((m) => ({ ...m, deliverables: [...m.deliverables] }));
  const phase4Src = PHASE4_MILESTONES.map((m) => ({ ...m, deliverables: [...m.deliverables] }));
  const phase5Src = PHASE5_MILESTONES.map((m) => ({ ...m, deliverables: [...m.deliverables] }));
  applyOverlay([phase0Src, phase1Src, phase2Src, phase3Src, phase4Src, phase5Src]);

  const phase0Milestones = phase0Src.map((m) => evalMilestone(m, 0, matrix, passByValidator));
  const phase1Milestones = phase1Src.map((m) => evalMilestone(m, 1, matrix, passByValidator));
  const phase2Milestones = phase2Src.map((m) => evalMilestone(m, 2, matrix, passByValidator));
  const phase3Milestones = phase3Src.map((m) => evalMilestone(m, 3, matrix, passByValidator));
  const phase4Milestones = phase4Src.map((m) => evalMilestone(m, 4, matrix, passByValidator));
  const phase5Milestones = phase5Src.map((m) => evalMilestone(m, 5, matrix, passByValidator));

  const phaseSummaries: PhaseSummary[] = [
    summarizePhase(0, 'Foundation',         phase0Milestones),
    summarizePhase(1, 'Operate',            phase1Milestones),
    summarizePhase(2, 'Sell & Serve',       phase2Milestones),
    summarizePhase(3, 'Run Business',       phase3Milestones),
    summarizePhase(4, 'Harden & Extend',    phase4Milestones),
    summarizePhase(5, 'Productise',         phase5Milestones),
  ];

  // Phase advance: the first phase that isn't `complete` is the current one.
  // Operator override stays via WATCH_AXIOM_CURRENT_PHASE.
  let computedCurrentPhase = 5;
  for (const s of phaseSummaries) {
    if (!s.complete) { computedCurrentPhase = s.phase; break; }
  }
  const currentPhase = process.env.WATCH_AXIOM_CURRENT_PHASE
    ? Number(process.env.WATCH_AXIOM_CURRENT_PHASE)
    : computedCurrentPhase;

  const milestonesByPhase: Record<number, EvaluatedMilestone[]> = {
    0: phase0Milestones, 1: phase1Milestones, 2: phase2Milestones,
    3: phase3Milestones, 4: phase4Milestones, 5: phase5Milestones,
  };
  const activeMilestones = milestonesByPhase[currentPhase] ?? [];

  // ── Backward-compatible flattened view ──────────────────────────────
  // The autopilot driver (scripts/axiom-driver.mjs) and any other consumer
  // that pre-dates the milestone tier reads `items`, `byTeam`, and
  // `overall`. Build those from the active phase's milestones so the
  // existing manager-brief pipeline keeps working unchanged. Note this
  // intentionally flattens across milestones — for the autopilot all that
  // matters is "for this team, what's still unbuilt in the active phase".
  const activeItems = activeMilestones.flatMap((m) => m.deliverables);
  const byTeam: Record<number, { team: number; dept: string; built: number; total: number; qualityHealthy: number }> = {};
  for (let n = 0; n <= 10; n++) {
    byTeam[n] = { team: n, dept: n === 0 ? 'CEO / shared' : DEPARTMENTS[n - 1], built: 0, total: 0, qualityHealthy: 0 };
  }
  for (const it of activeItems) {
    byTeam[it.team].total += 1;
    if (it.built) byTeam[it.team].built += 1;
    if (it.built && it.qualityFailed !== true) byTeam[it.team].qualityHealthy += 1;
  }
  const builtCount = activeItems.filter((i) => i.built).length;
  const qualityHealthyCount = activeItems.filter((i) => i.built && i.qualityFailed !== true).length;
  const totalCount = activeItems.length;

  const payload = {
    ok: true,
    generatedAt: new Date().toISOString(),
    currentPhase,
    phases: PHASES,
    phaseSummaries,
    milestones: activeMilestones,
    allMilestones: milestonesByPhase,
    // Backward-compat (autopilot driver):
    items: activeItems,
    byTeam: Object.values(byTeam).filter((b) => b.total > 0),
    overall: {
      built: builtCount,
      total: totalCount,
      percent: totalCount ? Math.round((builtCount / totalCount) * 100) : 0,
      qualityHealthy: qualityHealthyCount,
      qualityPercent: totalCount ? Math.round((qualityHealthyCount / totalCount) * 100) : 0,
    },
    validatorMatrix: matrix
      ? {
          generatedAt: matrix.generatedAt,
          total: matrix.total,
          passed: matrix.passed,
          failed: matrix.failed,
          passRate: matrix.passRate,
        }
      : null,
    departments: DEPARTMENTS,
  };
  cache = { ts: now, payload };
  return NextResponse.json(payload);
}
