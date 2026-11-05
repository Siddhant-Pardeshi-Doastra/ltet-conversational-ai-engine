# Requirements Traceability — Release 1

Source precedence (per `docs/PROJECT_CONTEXT.md`): **A** = "LTET Abhra 3rd — FRS 1"
(primary baseline), **B** = "LTET Abhra 2nd — FRS" (supporting context), **C** =
"LTET AI Voice Abhra 1st" (business background only). This build was implemented
from the supplied **requirements digest** of those documents; the PDFs themselves
could not be rendered in the build environment, so the digest is the operative
wording and any discrepancy must be reconciled against document A before live use.

Status legend — **Implemented**: working code + test. **Simulated**: working demo
path standing in for an external dependency (explicitly labelled). **Corrected**:
implemented with a documented security amendment over the original wording
(docs/SECURITY_DECISIONS.md). **Externally blocked**: requires LTET/vendor
infrastructure or approvals; interface + readiness status provided.

Priority preserved: M = Must, S = Should.

## UC-01 / UC-02 / UC-03 coverage

| UC | Flow | Where |
|---|---|---|
| UC-01 Claim status | `server/engine/machine.js` (`loadClaims`, `narrateClaims`, `answerClaim`), `server/engine/answers.js` | tests/conversation.test.js |
| UC-02 Payment info | `buildPaymentPlans` + `answerClaim` payment branch | tests/conversation.test.js |
| UC-03 Beneficiary | `benef_ps`/`benef_name`/`challenge_pending` states + `adapters/portal.js` grants | tests/security.test.js |

## FR-01..FR-62

| FR | Pri | Requirement (digest wording) | Implementation | Tests | Status |
|---|---|---|---|---|---|
| FR-01 | M | Resolve caller number to candidate PS No. via identity adapter | `adapters/portal.js: lookupByPhone` | conversation: BDD-01 | Implemented (mock; live adapter externally blocked) |
| FR-02 | M | Confirm PS No. digit-by-digit; one rejection retry; then employee-vs-beneficiary; SEC-01 masking amendment | `machine.js: ident_confirm`, `handlePsEntry` | conversation BDD-01/02, security SEC-01 | Corrected (masked confirmation; full number never spoken) |
| FR-03 | S | Configurable second factor; disclosure still needs sufficient auth if OTP disabled | `config.js DEFAULT_POLICY.otp/identity.second_factor`, `validatePolicy` live-mode rule | security FR-39, live-mode | Implemented |
| FR-04 | M | Transfer on failed verification or disabled/unavailable unlinked fallback | `machine.js` lockout path, `routeIdentification` | conversation BDD-30/03 | Implemented |
| FR-05 | M | Scope every lookup to verified identity and authorised claims | `loadClaims` (verified PS only), beneficiary grant filter | security SEC-03 suite | Implemented |
| FR-06 | M | Fetch open claims live at start of status flow | `loadClaims → portal.listOpenClaims` at answer time | conversation BDD-21 | Implemented |
| FR-07 | M | No open claims: explain after verification, offer human | `no_claims` state | conversation BDD-07 | Implemented |
| FR-08 | M | One claim: confirm directly. Several: latest three IDs newest first | `loadClaims`, `narrateClaims` | conversation BDD-06/04 | Implemented |
| FR-09 | M | Remaining open claims in bounded batches until selection/exit | `narrateNextBatch` | conversation BDD-05 | Implemented |
| FR-10 | M | Processing claim: state permitted stage (four named stages) | `answers.buildClaimStagePlan` (validated against STAGES) | conversation BDD-08 | Implemented |
| FR-11 | M | Approved claim: Finance approval + payment status | `answerClaim` approved branch | conversation BDD-09 | Implemented |
| FR-12 | M | Open PMS query alongside stage; direct resolution to portal | query plan in `buildClaimStagePlan` | conversation BDD-10 | Implemented |
| FR-13 | M | More-help question; another claim restarts selection | `more_help` state + `enterSelection` | conversation BDD-11 | Implemented |
| FR-14 | S | Claims-per-call cap (default 5); wrap up or offer human | cap check in `answerClaim` + `claim_cap` state | conversation cap test | Implemented |
| FR-15 | M | Caller-facing groups credited/processed/pending/failed/held; failed & held distinct | `buildPaymentPlans` group branch | conversation BDD-14 + held test | Implemented |
| FR-16 | M | Credited: authoritative amount, credit date, bank reference when authorised | credited plan + field filter | conversation BDD-12, security limited-grant | Implemented |
| FR-17 | M | Processed/pending: recorded stage/owner; invent no date | pay_processed / pay_pending templates | conversation BDD-13 | Implemented |
| FR-18 | M | Failed/held: recorded reason, alert processor, offer escalation | failed/held plans + alert effect | conversation BDD-14, security queue | Implemented |
| FR-19 | M | Never invent amounts/dates/reasons; missing = unknown | slot omission when source field absent | conversation FR-19 test | Implemented |
| FR-20 | M | Detect language, respond, switch on request | `intents.detectLanguage`, global switch handling | engine + conversation BDD-16 | Implemented |
| FR-21 | M | Mixed-language speech and spoken numbers incl. English claim/PS terms | `parseUtterance` (code-switch, NUMBER/ORDINAL words, claim regex) | engine tests | Implemented |
| FR-22 | M | Read back caller-supplied claim ID digit by digit; confirm before use | `claims_selection` claimIds path + `claim_select_confirm` | conversation | Implemented |
| FR-23 | S | Barge-in, repeat, slower-speech controls | repeat/slower intents, UI Interrupt (TTS cancel) | conversation repeat test, UI | Implemented (barge-in simulated via interrupt) |
| FR-24 | M | Explain scope, offer human for unsupported requests | `mutation` intent → `scope_explain` | conversation BDD-18 | Implemented |
| FR-25 | M | Handoff on request, distress, or two failed recognitions | human/distress intents, `recognitionFailures` | conversation BDD-17 | Implemented |
| FR-26 | M | No claim/payment mutations, invented promises, or advice outside portal data | engine cannot write portal tables; templates only | security + conversation | Implemented |
| FR-27 | M | Structured summary (verified PS, claims, intent, facts, delay, outcome, sentiment, flags, follow-up) | `postcall.buildSummary` | postcall tests | Implemented |
| FR-28 | M | Outcomes resolved/escalated/verification_failed/abandoned; terminal precedence documented | `machine.js` hangup handler | conversation + docs/WORKFLOWS.md §Precedence | Implemented |
| FR-29 | S | Analytics: drivers, repeat callers, stages, payment mix, languages, containment | `services/analytics.js` (derived from stored records) | postcall reconciliation | Implemented |
| FR-30 | M | Route alerts to stage persona via configured mapping | `alerts.raiseAlert` + policy routing; unrouted → admin | security + conversation | Implemented |
| FR-31 | S | Daily/weekly processor reports for SPM/APM | `analytics.generateReport` + UI | postcall | Implemented |
| FR-32 | M | One call-log per call + one deduplicated entry per discussed claim | `call_logs` unique(session), `call_claim_entries` unique(session,claim) | postcall | Implemented |
| FR-33 | M | Claim-linked document history of what was communicated (call history, not uploads) | `claim_document_history` at finalize | postcall | Implemented |
| FR-34 | S | Immutable final logs; append-only notes; controlled retention | DB triggers + `retention.js` audited purge | postcall immutability + retention | Implemented |
| FR-35 | M | Alert queue with acknowledge/close, persisted + audited | `alerts` table + routes + audit events | security RBAC test | Implemented |
| FR-36 | M | Role-based transcript/recording access; summaries default | `canViewTranscripts` + audited access | security SEC-05 | Implemented |
| FR-37 | S | Versioned language packs/prompts/escalation editable with approval + audit | `language_packs` versions + admin approve + audit | engine packs test | Implemented (prompts version via policy/config governance) |
| FR-38 | S | Search calls, review permitted transcripts, tag incorrect answers | `/api/calls?q=`, review_tags | api tests | Implemented |
| FR-39 | S | Configure identity policy, caps, retention, hours, busy, beneficiary checks, OTP limits; reject unsafe config | policy_configs + `validatePolicy` | security + postcall | Implemented |
| FR-40 | M | Direct payment intent still runs verification + selection; also enter from approved claim | `claimIntent` handling in claims_selection | conversation BDD-22 | Implemented |
| FR-41 | M | Non-approved claim: stage/query answer and NO payment info | stage plans prepended + pay_not_applicable | conversation BDD-23 | Implemented |
| FR-42 | M | Finance unavailable: truthful, human/callback, failure log; no cached answer | FinanceUnavailableError path | conversation BDD-24 | Implemented |
| FR-43 | M | Amount dispute: immediate handoff with context, no debate | dispute intent → transfer + dispute alert | conversation BDD-25 | Implemented |
| FR-44 | M | Finance approval stated BEFORE payment status | plan ordering (approval first) | conversation credited test | Implemented |
| FR-45 | M | Configurable raw→caller-facing mapping; unmapped unreadable, not guessed | policy.payment_status_mapping + pay_unmapped | conversation BDD-27 | Implemented |
| FR-46 | S | Flag processed/pending delayed after configurable threshold; summary + alert | `isDelayed` + delayed flag + payment_delayed alert | api FR-45/46 test | Implemented (demo threshold labelled synthetic) |
| FR-47 | M | Toll-free greeting identifies LTET + automated assistant; recording notice first | greeting + recording_notice | conversation BDD-28 | Implemented |
| FR-48 | S | Unlinked/hidden: collect PS No., challenge to registered channel; disclose only after verification | ident_enter + `registeredChallengeTarget` | conversation BDD-29 | Implemented |
| FR-49 | S | Protected keypad entry for PS/claim/OTP; no read-back or storage of OTPs | keypad path; OTP digits never stored; spoken codes refused | security SEC-04 | Implemented |
| FR-50 | S | Offer language choices when unclear after first sentence | language offer + unclear handling | engine/conversation | Implemented |
| FR-51 | S | Capacity/busy fallback: human, callback, portal | busy check at session create + busy_fallback state | conversation BDD-32 | Implemented |
| FR-52 | M | Unexpected hang-up: end session, abandoned outcome, post-call processing still runs | hangup handler + finalize job | conversation BDD-33 | Implemented |
| FR-53 | S | Humans unavailable: state configured hours, create callback if accepted | transfer fail → hours + callback_offer | conversation after-hours path | Implemented |
| FR-54 | M | Ask employee vs beneficiary when number doesn't establish path | `caller_type` state + statedRole routing | conversation/security | Implemented |
| FR-55 | M | Capture and confirm employee PS No. digit by digit | benef_ps + ps_confirm_readback | security beneficiary tests | Implemented |
| FR-56 | M | Profile/beneficiary lookup failure: generic cannot-verify, one retry, then human | generic failure messages, no enumeration | security sc-25 style | Implemented |
| FR-57 | M | OTP to beneficiary's calling number — phone-control step only; binding required (SEC-03) | benef_ps grant check before challenge | security SEC-03 suite | Corrected |
| FR-58 | M | Configurable OTP expiry/resend/attempt limits; human path on limit | otp policy + resendChallenge + lockout | conversation BDD-30/39 | Implemented |
| FR-59 | M | SMS-incapable beneficiary number: no SMS attempt; human/portal | sms_capable gate before challenge | security FR-59 test | Implemented |
| FR-60 | S | Name/relationship comparison when configured; never reveals names; name alone never authenticates | benef_name state (policy-gated) | code + scenario sc-27 | Implemented (off by default) |
| FR-61 | M | Verified beneficiaries reach only permitted claims/fields | grant filter in loadClaims + fieldFilter in plans | security SEC-03 | Implemented |
| FR-62 | M | Record beneficiary caller type, protected number, checks passed; never change registered contacts | session caller_type + verification attempts; portal untouched | security FR-62 test | Implemented |

## IR-01..IR-18 (integration points)

| IR | Purpose | Status |
|---|---|---|
| IR-01 | Telephony audio/keypad/events/warm transfer | Simulated — call simulator + signed webhook boundary implemented; real carrier externally blocked |
| IR-02 | Read-only PS/registered-contact lookup | Mock implemented; live adapter interface + readiness status |
| IR-03 | Isolated OTP send/verify | Implemented locally (hashed, rate-limited, demo inbox); live provider externally blocked, fails closed |
| IR-04 | Live open-claims list | Mock implemented (live fetch per call) |
| IR-05 | Stage/query detail | Mock implemented |
| IR-06 | Finance approval/payment detail + status vocabulary | Mock implemented incl. unmapped raw statuses |
| IR-07 | Least-privilege identity/claim reads, limited Helpdesk writes | Implemented (engine read-only on portal; writes limited to helpdesk-owned records) |
| IR-08 | Change events for analytics | Not required for Release 1 scope; analytics derived from engine records (documented) |
| IR-09 | Helpdesk call/summary/history/alert API | Implemented locally as engine-owned records; live LTET Helpdesk API externally blocked |
| IR-10 | Portal-owned processor notifications, optional email/SMS | Implemented as work queues; email/SMS not configured (would need provider) |
| IR-11 | ASR | Simulated — browser SpeechRecognition + typed text; live provider externally blocked |
| IR-12 | TTS | Simulated — browser SpeechSynthesis; live provider externally blocked |
| IR-13 | Structured LLM (approved region/data handling) | Simulated — deterministic no-key intent classifier; live adapter contract documented; never decides access/facts |
| IR-14 | Analytics/report store | Implemented (SQLite-derived; export in UI) |
| IR-15 | Portal roles/service credentials | Demo: seeded staff users; live: SSO adapter documented, externally blocked |
| IR-16 | Metrics/audit | Implemented (audit_events, latency samples) |
| IR-17 | Optional consented recordings | Deliberately OFF (SEC-07); config flag provided |
| IR-18 | Toll-free carrier routing/failover | Externally blocked — operator configuration; documented in DEPLOYMENT.md |

## NFR-01..NFR-13

| NFR | Target | Status / evidence |
|---|---|---|
| NFR-01 | Zero factual errors in tested corpus | Fact validation blocks mismatches before TTS (tests/engine + conversation); objective stated as design/acceptance target |
| NFR-02 | p95 answer-start ≤ 2s | Instrumented (`call_latency`, simulator-labelled); local sim avg ~1ms compute; real-voice measurement pending |
| NFR-03 | ≥95% first-attempt recognition per language | Requires real audio evaluation — externally blocked, honestly listed |
| NFR-04 | ≥99.5% availability in hours | Deployment monitoring required — not demonstrable locally |
| NFR-05 | Configurable concurrency | busy policy + test; no certified scale claims |
| NFR-06 | Summary/log/alert ≤ 5 min of hang-up | Worker finalises immediately; queue age instrumented (`queueStats`) |
| NFR-07 | Encryption, least privilege, secret management | Documented deployment requirements (DEPLOYMENT.md §Security); demo uses labelled dev secrets |
| NFR-08 | AI/recording notice, masking, approved hosting, retention | Notice + masking implemented; legal review listed as pending |
| NFR-09 | Answer provenance + immutable audit | answer_evidence + audit_events + immutable call_logs (tested) |
| NFR-10 | Human/callback degradation | Transfer→hours→callback chain tested; carrier failover external |
| NFR-11 | Observability of latency/errors/transfers/languages/containment | Analytics + health endpoints |
| NFR-12 | Versioned prompts/models/glossary; regression tests before publish | Policy versioning + language pack versions + CI regression suite |
| NFR-13 | Configurable max call duration with polite wrap-up | `max_call_minutes` policy + duration wrap state |

## BDD-01..BDD-42 mapping

Executed in `tests/conversation.test.js` (C), `tests/security.test.js` (S),
`tests/postcall.test.js` (P), `tests/api.test.js` (A), `tests/engine.test.js` (E).
Where the original acceptance wording would allow the weak identity flow, the test
implements the **corrected SEC expectation** and the original wording is preserved
in docs/SECURITY_DECISIONS.md (§Decision register).

| BDD | Scenario | Test |
|---|---|---|
| 01 | Linked-number confirmation | C (masked + OTP still required — corrected per SEC-01) |
| 02 | PS rejection twice → caller-type question | C sc-29 (rejects then caller_type) |
| 03 | Unlinked fallback disabled → transfer | C routeIdentification (policy off) — covered via security policy test |
| 04 | Latest three claim selection | C BDD-06/08 |
| 05 | Remaining claims batches | C BDD-06/08 (more) |
| 06 | One claim | C BDD-06 |
| 07 | No claims | C BDD-07 |
| 08 | Each processing stage | C BDD-08 + stage mixes across seeds |
| 09 | Approved claim | C BDD-09/12 |
| 10 | Open PMS query | C BDD-10 |
| 11 | Another-claim loop + cap | C BDD-11 |
| 12 | Credited payment | C BDD-12 |
| 13 | Pending without date | C BDD-13 |
| 14 | Failed payment | C BDD-14 (+held) |
| 15 | Hindi-English mixed speech | E code-switch + C language |
| 16 | Language switch | C BDD-16 |
| 17 | Two recognition failures → human | C BDD-17 |
| 18 | Refusal to approve/expedite | C BDD-18 |
| 19 | Post-call summary/alert | P |
| 20 | One log/multiple claim histories/immutable | P |
| 21 | Portal failure | C BDD-21 |
| 22 | Direct payment intent | C (payment intent via selection) |
| 23 | Non-approved claim → no payment info | C BDD-23 |
| 24 | Finance unavailable | C BDD-24 |
| 25 | Payment dispute | C BDD-25 |
| 26 | Delay threshold | A FR-45/46 |
| 27 | Unmapped payment state | C BDD-27 |
| 28 | Toll-free greeting/notice | C BDD-28 |
| 29 | Unlinked employee OTP | C BDD-31 flow |
| 30 | Failed OTP | C BDD-30 |
| 31 | Keypad PS entry | C BDD-31 |
| 32 | All lines busy | C BDD-32 |
| 33 | Mid-call hang-up | C BDD-33 |
| 34 | Human unavailable (hours+callback) | C after-hours path |
| 35 | Unclear language | C recognition-failure path + language offer |
| 36 | Employee/beneficiary branch | C/S beneficiary tests |
| 37 | Beneficiary verification | S (corrected: binding+grant per SEC-03) |
| 38 | Generic profile failure | S (generic cannot-verify) |
| 39 | OTP attempts exceeded | C BDD-30/39 |
| 40 | SMS-incapable beneficiary | S FR-59 |
| 41 | Beneficiary name mismatch | S name state (policy-gated; scenario sc-27) |
| 42 | Beneficiary call metadata | S FR-62 |

## Coverage gaps honestly stated

- Original BDD-01/37 weak-identity acceptance paths are intentionally NOT
  implemented as specified — see docs/SECURITY_DECISIONS.md (SEC-01, SEC-03).
- FR-60 name comparison and BDD-41 are implemented but disabled by default
  (config-gated); the automated suite covers the code path indirectly and the
  scenario catalogue documents how to enable it.
- IR-08 change-event ingestion is out of Release 1 scope; analytics derive from
  engine-owned records instead (documented in WORKFLOWS.md §Analytics definitions).
