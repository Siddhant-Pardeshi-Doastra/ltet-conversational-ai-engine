# Team Overview — slide-ready summary

## The problem

Processors at the LTET Employee Trust Portal are interrupted by routine
claim-status and payment enquiries. Employees wait on calls; processors lose
focus work; answers depend on current portal data and must be auditable.

## What we built

**LTET Conversational AI Engine — Release 1.0**, a complete working platform by DOASTRA:

- An **automated helpline assistant** that answers *verified* enquiries for
  claim status (UC-01), Finance payment information (UC-02) and listed
  beneficiaries (UC-03) across **17 schemes** in **22 languages**.
- A **deterministic conversation engine** — every spoken fact is templated,
  fetched live from the portal, and validated against a fresh source snapshot
  before it is spoken. Nothing is invented; nothing unverified is disclosed.
- **Post-call intelligence**: immutable call logs, claim-linked document history,
  structured summaries, processor alerts and analytics — produced by a durable
  worker that survives crashes and replays.
- A **staff console** with a call simulator (incl. isolated demo SMS inbox),
  processor work queue, claim context, analytics and governed administration.

## Workflow in one line

Greeting + AI/recording notice → language (12) → masked identity confirmation →
OTP to the **registered** channel → authorisation → claim selection → live
validated answer → more help / human / callback → durable post-call records.

## Security highlights (deliberate corrections, documented)

- Caller-ID match or knowing a PS No. **never** grants access — OTP to the
  registered channel is mandatory by default (SEC-01/02).
- Beneficiaries need a **previously verified binding + an explicit scoped grant**;
  an OTP to their own phone alone is not enough (SEC-03 — proposed extension).
- OTPs are hashed, keypad-only, replay-safe, and absent from every transcript,
  log and model input (SEC-04). Signed webhooks with replay protection (SEC-07).
- Role-based access everywhere server-side; transcripts are audited and restricted
  (SEC-05); unverified callers can never attach history to a claim (SEC-06).

## What the demo shows (10–15 min, docs/DEMO_GUIDE.md)

Verified employee enquiry → stage + open query → credited payment (approval
first) → failed/delayed payment alert → scoped beneficiary → **impostor denied
despite knowing the PS No.** → outage with callback → durable logs/history →
processor acknowledge/close → analytics + configuration audit.

## Architecture in one slide

Node 22 + Express + SQLite (zero native deps) · deterministic state machine ·
typed adapters for identity/claims/Finance/OTP/speech with explicit
not-configured statuses · durable outbox worker · no-build web console ·
77 automated tests incl. a live-mode gating suite run in a separate process.

## Honest status

| Ready | Not yet (external) |
|---|---|
| Agent mode + exhaustive resolution search, tested | LTET API contracts + credentials |
| Security boundaries + audit trails | Carrier/toll-free + failover |
| Demo data, scenarios, reset tools | Native-speaker language sign-off |
| CI (lint + tests, no paid keys) | Real-audio recognition metrics |
| Docs: traceability, security, deployment | Legal review of recording/retention |

**Not production-ready by design**: real identity, APIs, telephony, language
quality and security/privacy acceptance are pending LTET/vendor decisions
(docs/OPEN_DECISIONS.md — 23 tracked items with owners).
