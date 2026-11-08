# Architecture

## Stack and rationale

| Layer | Choice | Why |
|---|---|---|
| Runtime | Node.js 22 (ESM), single process | built-in `node:sqlite` → zero native deps, instant local setup; adequate for demo load |
| HTTP | Express 4 | minimal, well-known; hand-rolled sessions/RBAC/validation to keep the dependency surface tiny |
| Persistence | SQLite (WAL, FKs, triggers) | relational integrity, durable jobs, immutability triggers; one file, easy backup |
| Frontend | No-build vanilla ES-module SPA + SVG charts | zero build chain, fully inspectable, fast |
| Worker | In-process durable outbox loop | survives restart, retries, dead-letter, replay — no in-memory-only timers |
| Tests | node:test (6 suites, 77 tests) | no extra deps; exercises real HTTP + real DB |
| Speech/LLM | Deterministic no-key adapters; browser ASR/TTS in the simulator | reproducible demos without credentials; typed swap-in points for live providers |

## Component diagram

```
                        ┌────────────────────────────────────────────────┐
   Staff console        │  public/ SPA (Overview, Simulator, Calls,      │
   (browser) ───────────►  Queue, Claim Context, Analytics, Admin,      │
                        │  Scenarios & Health)                           │
                        └───────────────┬────────────────────────────────┘
                                        │ fetch (session cookie)
                        ┌───────────────▼────────────────────────────────┐
   Carrier/IVR (live)   │  Express API (server/routes)                   │
   webhook ────────────►│  auth · calls · staff · admin · demo · health  │
   (HMAC + nonce)       │────────────────────────────────────────────────│
                        │  Conversation engine (server/engine)           │
                        │   machine.js  deterministic state machine      │
                        │   conversation.js free-form understanding      │
                        │   resolution.js exhaustive resolution search   │
                        │   intents.js  no-key NLU (22 languages)        │
                        │   answers.js  fact-safe plans + validation     │
                        │────────────────────────────────────────────────│
                        │  Adapters (server/adapters)                    │
                        │   portal.js (IR-02/04/05/06)  otp.js (IR-03)   │
                        │   speech.js (IR-11/12/13)     errors.js        │
                        │────────────────────────────────────────────────│
                        │  Services                                      │
                        │   calls.js  verification.js  alerts.js         │
                        │   policy.js postcall.js (worker) analytics.js  │
                        │   retention.js audit.js scenarios.js           │
                        └───────────────┬────────────────────────────────┘
                                        │ node:sqlite (WAL)
                        ┌───────────────▼────────────────────────────────┐
                        │  data/ltet.db                                  │
                        │  portal_*  (synthetic system of record)        │
                        │  call_* / alerts / jobs / audit / policy_cfgs  │
                        │  otp_challenges (hashes only) / mock_otp_inbox │
                        └────────────────────────────────────────────────┘
```

## Trust boundaries

1. **Caller ↔ engine**: caller input (speech/DTMF) is untrusted data. Embedded
   instructions in utterances or processor-query text cannot alter tools or facts —
   the machine only consumes parsed intents and template slots (injection tests).
2. **Portal ↔ engine**: the engine treats portal responses as facts to validate,
   never as instructions. The engine has **no write path** to portal tables.
3. **Frontend ↔ backend**: UI hiding is not access control. Every scoped decision
   (claims, transcripts, queue actions, exports) re-checks the server session.
   Verified identity is bound server-side to the call session; a client boolean
   can never grant access.
4. **Verification secrets**: OTPs exist only in the challenge table (salted hash)
   and the demo mock inbox. They never enter the LLM/ASR path, transcripts, logs,
   analytics, URLs or error messages (tested).
5. **Demo vs live**: demo tools (reset, faults, inbox, role switch) are gated on
   `LTET_MODE=demo` and return 403 in live mode (separate-process test).

## Conversation engine

States: `greeting → language → caller_type → ident_confirm / ident_enter /
ident_enter_confirm / benef_ps / benef_name → challenge_pending →
claims_selection → claim_select_confirm → claim_answer → more_help / no_claims /
claim_cap → transfer_pending → callback_offer / busy_fallback → ending → ended`.

- Transitions are checked (`checkTransition`); unknown/out-of-order events are made
  safe (logged anomaly, state preserved).
- Every answer is a **plan** (typed slots) built from a live portal fetch and
  **validated against a fresh source snapshot** before rendering. Validation
  compares plan slots to the fresh source (amounts in integer paise, dates, status
  semantics, stage membership, negation). Failure → one safe rebuild → else a
  no-facts fallback. Nothing unvalidated is spoken.
- Answer provenance (NFR-09): each protected fact records an `answer_evidence` row
  (source ref, portal version, retrieval time, snapshot).

## Post-call worker lifecycle (durable)

```
hangup ─► outbox job finalize:{session} (unique idempotency key)
             │
             ▼
   worker tick (2s) ── claims one queued job atomically (status=running + heartbeat)
             │
             ├─ step log      : one immutable call_logs row (locked_at at birth;
             │                  UPDATE/DELETE blocked by triggers; retention purge
             │                  only via one-way retention_deleted marker)
             ├─ step history  : per discussed claim (unique) — SEC-06: only when
             │                  session.verified_ps_no == claim.ps_no
             ├─ step alerts   : defensive re-raise (dedupe key keeps distinct calls/issues)
             ├─ step latency  : simulator-labelled samples (NFR-02)
             ▼
           done   (failure → attempts++, backoff → dead-letter + audit; admin replay)
```

Crash safety: startup `recoverStaleJobs()` re-queues `running` jobs with stale
heartbeats; every step is idempotent (unique constraints), so retries never
duplicate history or alerts (tested: duplicate webhooks, replays, injected crash).

## Data model (logical)

- **Synthetic portal**: employees, registered_contacts, beneficiaries,
  beneficiary_bindings* + access_grants* (proposed SEC-03 extension), schemes,
  claims, processor_queries, finance_payments.
- **Engine/Helpdesk**: staff_users/sessions, call_sessions(+ctx), call_events,
  transcript_segments (protected flag), verification_attempts, otp_challenges,
  mock_otp_inbox (demo-only), call_claim_entries, answer_evidence,
  claim_document_history, call_logs (immutable), processor_notes, alerts,
  callback_requests, jobs, policy_configs, language_packs, review_tags, reports,
  call_latency, webhook_nonces, audit_events.
- Money in **integer minor units (paise)**; timestamps ISO-UTC, displayed
  **Asia/Kolkata**; IDs/phones as strings.

## Sequence (happy path, UC-02)

```
Caller        Engine                         Portal(mock)          Worker
  │ call.started │                                │                   │
  │  "yes" ─────► masked PS confirm ─────────────►│ lookupByPhone     │
  │  "yes" ─────► OTP challenge (hash) ──────────►│                   │
  │  [keypad] ──► verify ──► verified(session)    │                   │
  │  "payment?"─► listOpenClaims ────────────────►│ live fetch        │
  │              │ select + confirm claim         │                   │
  │              │ getFinancePayment ────────────►│ raw status        │
  │              │ build plans → validate vs FRESH snapshot           │
  │ ◄─ "approved… credited ₹24,500.00 on …"       │                   │
  │  "no" ───────► ending → hangup ──────────────────────────────────►│ finalize
  │                                               │   one log + history + summary + alerts
```
