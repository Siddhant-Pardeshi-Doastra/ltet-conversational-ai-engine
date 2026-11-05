# Open Decisions — tracked without blocking the synthetic build

Each item lists the question, the demo default chosen, the suggested owner, and
the impact of getting it wrong. Demo defaults are **provisional assumptions**, not
approved policies.

| # | Open question (FRS area) | Demo default | Suggested owner | Impact |
|---|---|---|---|---|
| 1 | Production voice-only/channel scope | Inbound toll-free voice only; simulator is a test harness | LTET Product + DOASTRA | Channel expansion changes telephony contract (IR-01) |
| 2 | Launch-language phasing | All 12 configured; only English native-approved | LTET Comms + native reviewers | Premature launch risks recognition/quality (NFR-03, FR-37) |
| 3 | PMS/SPM/APM stage ownership + alert routing | PMS→pms, Sub-panel→spm, Apex→apm, Approval→apm | LTET Ops | Misrouting sends alerts to wrong queues (FR-30) |
| 4 | Real Finance fields/status vocabulary | Synthetic raw values incl. unmapped `Sent-to-Bank-X` | LTET Finance + API owner | Mapping errors → unreadable statuses (FR-45) |
| 5 | Are approved-but-unpaid claims in "open claims"? | `processing_and_approved` (configurable `open_claims_scope`) | LTET API owner | Affects UC-01 list and UC-02 entry |
| 6 | Mandatory authentication for payment details | OTP always on (SEC-01) | LTET Security | Weakening enables impostor disclosure |
| 7 | Helpdesk ownership/schema for logs | Engine-owned SQLite records | LTET Helpdesk lead | IR-09 contract for live write-back |
| 8 | Recording consent/retention/roles | Audio OFF; transcripts 90d, logs 3650d (labelled) | LTET Legal | Legal exposure if enabled without review (NFR-08) |
| 9 | Volumes/concurrency/helpdesk hours | 3 concurrent, Mon–Fri 09:00–18:00 IST | LTET Ops | Busy behaviour + staffing (NFR-05) |
| 10 | Approved hosting + providers | Local demo; browser speech | LTET IT + DOASTRA | Data-residency and vendor approval (NFR-07) |
| 11 | Claim selection navigation + cap | Latest-3 then batches; cap 5 | LTET Product | UX + FR-14 value |
| 12 | Full vs summarised processor query read-out | Full query text read once, then portal direction | LTET PMS leads | Length/privacy trade-off (FR-12) |
| 13 | Transfer team/hours; another-claim menu wording | Hours-driven connect; template wording | LTET Helpdesk | FR-53/25 quality |
| 14 | Payment-alert recipients + delay threshold | Stage-persona queues; 7-day demo threshold (labelled) | LTET Finance/Ops | FR-30/46 routing and noise |
| 15 | Existing/new toll-free number, owner, routing menu | None configured (simulator) | LTET IT + carrier | IR-18 go-live blocker |
| 16 | Geographic coverage | India toll-free assumption | LTET + carrier | IR-18 scope |
| 17 | Authoritative beneficiary identity/contact fields | Proposed binding+grant extension (SEC-03) | LTET Security + HR data owner | Core UC-03 authorisation model |
| 18 | Beneficiary claim/field permissions | Per-grant lists (scoped fixtures) | LTET Security | Least-privilege correctness (FR-61) |
| 19 | OTP attempt/resend/expiry policy | 3 attempts, 2 resends, 300 s expiry, rate limit 3/15 min | LTET Security | FR-58/SEC-04 tuning |
| 20 | Exact scheme names | `Demo Scheme 01..17` | LTET Product | Content only; no functional risk |
| 21 | Translation approvals | Generated drafts flagged `draft_translation` | Native-speaker reviewers | Launch quality per language (FR-37) |
| 22 | Database/API availability + auth bindings | Mock portal in demo | LTET IT | Live readiness (IR-02/04/05/06) |
| 23 | Whether saved-savings estimates from proposal C are targets | Not used anywhere | LTET PMO | Keep proposal figures out of commitments |

## Suggested next steps

1. LTET review of docs/SECURITY_DECISIONS.md (SEC-01..03 especially) — decision
   gates live deployment.
2. API-owner workshop on the openapi.yaml proposals (items 4, 5, 22).
3. Native-speaker review cycle for the 11 draft packs (item 2/21).
4. Carrier engagement for number/routing/failover (item 15).
