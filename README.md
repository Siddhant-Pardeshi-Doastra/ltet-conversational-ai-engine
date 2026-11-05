# LTET Conversational AI Engine — Release 1 (Demo Build)

A voice-assistant engine for the **LTET Employee Trust Portal** that answers
**verified** claim-status, Finance-payment and listed-beneficiary enquiries over an
India toll-free helpline, then produces auditable post-call records for processors.
Built by DOASTRA as a complete, runnable **Release 1 demo**: backend + frontend +
durable worker + tests + governed administration, all on synthetic data.

> **This is a demo build on synthetic data only.** No real employees, claims,
> payments, phone numbers or carriers exist here. Live deployment requires the
> external integrations and approvals listed in [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md)
> and [docs/OPEN_DECISIONS.md](docs/OPEN_DECISIONS.md).

![Overview](docs/screenshots/overview.png)
![Call Simulator](docs/screenshots/simulator.png)

## What Release 1 does

- **UC-01 Claim status** — authenticated enquiries across 17 configurable schemes:
  zero/one/many open claims, latest-three narration then bounded batches,
  processing-stage answers (PMS Processor → Sub-panel Review → Apex Panel Review →
  Approval), open PMS-processor queries read out alongside the stage, another-claim
  loop, five-claims-per-call cap.
- **UC-02 Payment information** — Finance approval stated first, then the payment
  group mapped from raw Finance status (credited / processed / pending / failed /
  held). Credited speaks the authoritative amount, credit date and bank reference;
  processed/pending invent no date; failed/held speak the recorded reason, alert the
  responsible processor and offer escalation. Disputes transfer immediately.
  Unavailable Finance data never produces a cached answer.
- **UC-03 Listed beneficiaries** — employee-vs-beneficiary branch, PS-No. capture
  with digit-by-digit confirmation, challenge to the beneficiary's calling number,
  and **least-privilege enforcement via a trusted binding + explicit grant**
  (proposed security extension — see [docs/SECURITY_DECISIONS.md](docs/SECURITY_DECISIONS.md)).
- **Vernacular conversation** — all 12 FRS languages configured (English, Hindi,
  Bengali, Marathi, Tamil, Telugu, Gujarati, Punjabi, Malayalam, Kannada, Odia,
  Assamese) with code-switching, spoken numbers and ordinals. English is
  native-approved; the other packs are labelled *draft translations* pending
  native-speaker sign-off (FR-37).
- **Post-call intelligence** — durable outbox worker creates the immutable call log,
  deduplicated claim entries, document history, structured English summary,
  processor alerts and analytics. It survives restarts and replays.
- **Staff console** — Overview, Call Simulator (with isolated demo SMS inbox),
  Calls, Processor Work Queue, Claim Context, Analytics, Administration
  (versioned policy with approval/publish/rollback), Scenarios & Integration Health.

## Release boundary

Out of scope (per the Release 1 FRS): outbound/proactive AI calls, voice claim
submission or edits, document upload, payment execution, bank-account changes,
international toll-free, production WhatsApp/chat channels. The browser call
simulator is a demonstration/testing interface, not an additional production channel.

## Quickstart

Prerequisites: **Node.js ≥ 22.13** (uses the built-in `node:sqlite`; no native deps).
No API keys required — every external dependency runs as an explicit mock.

```bash
npm install
npm run seed     # deterministic synthetic fixtures (17 schemes, 14 employees, 24 claims, staff)
npm start        # http://127.0.0.1:8787
```

Or in one step: `npm run demo`.

**Demo users** (labelled demo credential, password `Demo#Pass1`):

| User | Role | Sees |
|---|---|---|
| `pms1`, `pms2` | PMS Processor | PMS-stage alerts, claim context in stage |
| `spm1` | SPM | Sub-panel Review queue |
| `apm1` | APM | Apex Panel Review + Approval queue |
| `admin1` | Administrator | Everything incl. administration + demo tools |
| `auditor1` | Auditor | Read-only incl. transcripts (FR-36) |

Sign in, open **Call Simulator**, press a caller preset (e.g. *Credited payment
(Vikram)*), confirm the masked PS No., read the OTP from the **DEMO MOCK SMS INBOX**
panel, enter it on the keypad, and ask *"what is my payment status"*.
[docs/DEMO_GUIDE.md](docs/DEMO_GUIDE.md) has the full 10–15 minute team walkthrough.

## Commands

| Command | What it does |
|---|---|
| `npm run seed` | Apply migrations + seed synthetic fixtures (add `--force` via `node server/seed.js --force` to reset) |
| `npm start` | Start engine + staff console + post-call worker |
| `npm test` | 77 automated tests: engine, conversation (BDD-mapped), security (SEC-mapped), post-call durability, API, live-mode gating |
| `npm run lint` | Syntax check all sources |
| `npm run demo` | Reseed + start |

## Configuration

Copy `.env.example` → `.env`. Defaults run the demo safely. Key settings:

- `LTET_MODE=demo|live` — in **live** mode with missing integration config,
  readiness **fails** and private workflows stay disabled. There is no silent
  fallback to synthetic data, and all demo tools (reset / fault injection / mock
  OTP inbox / role switcher) are hard-blocked and audited.
- `SESSION_SECRET`, `TELEPHONY_WEBHOOK_SECRET` — required in live mode.
- `IDENTITY_API_URL`, `PORTAL_CLAIMS_API_URL`, `FINANCE_API_URL`, `OTP_PROVIDER_URL`
  — live adapter endpoints (IR-02/04/05/06/03).
- `ENABLE_CALL_RECORDINGS=false` — audio storage stays off pending approved
  consent/storage policy (SEC-07/NFR-08).

Runtime policy (helpdesk hours, claims cap, OTP limits, stage→persona routing,
payment-status mapping, delay threshold, retention) is **versioned configuration**
draft → approve → publish → rollback in the Administration screen — unsafe values
are rejected before save (FR-39).

## Tests

`npm test` runs 77 tests in 6 suites (Node's built-in runner):

- **engine** — intent parsing across all 12 languages, code-switching, ordinals,
  PS/claim-ID capture, fact-validation blocking, money formatting.
- **conversation** — BDD-mapped flows: greeting/notice, masked confirmation,
  keypad entry, wrong-OTP lockout, zero/one/many claims, batches, every payment
  group, unmapped status, disputes, refusals, language switch, recognition
  failures, cap, busy, hang-ups, portal/Finance outages.
- **security** — SEC-01..07: impostor beneficiary denied, scoped grants, revoked
  grant, SMS-incapable numbers, OTP hashing/replay/redaction, webhook signature +
  replay, RBAC on transcripts/queues, unsafe policy rejection, rate limiting.
- **postcall** — exactly-once logs/history/alerts, duplicate-webhook idempotency,
  worker crash recovery, analytics reconciliation, retention purge, policy
  versioning.
- **api** — auth, masking, stage scoping, search/tags, reports.
- **live-mode** — separate process proving demo tools are impossible in live mode
  and readiness fails closed without configuration.

Actual results are recorded in [docs/TEST_REPORT.md](docs/TEST_REPORT.md), including
what remains **externally unvalidated** (real audio recognition, carrier behaviour,
native-speaker language sign-off, load).

## Repository layout

```
server/            engine, adapters, services, routes (Node 22 ESM, express, node:sqlite)
public/            no-build SPA (vanilla ES modules + hand-rolled SVG charts)
languages/packs/   12 versioned language packs with review status
contracts/         proposed OpenAPI 3.1 definition
tests/             6 test suites (node:test)
docs/              project context, traceability, architecture, workflows,
                   security decisions, integrations, demo guide, test report,
                   deployment, open decisions, team overview
```

## Limitations (read before presenting)

- Real speech quality (ASR/TTS per language), carrier/toll-free behaviour and
  production identity/Finance APIs are **not** validated here — the demo uses
  browser speech engines and a deterministic no-key intent adapter.
- The trusted-beneficiary binding/grant model is a **proposed security correction**,
  not a source-confirmed FRS field; it requires LTET review before live use.
- 11 of 12 language packs are generated drafts awaiting native-speaker approval;
  readiness can be phased per language (FR-37).
- Audio recording is off by default; recording consent/retention needs legal review.

See [docs/OPEN_DECISIONS.md](docs/OPEN_DECISIONS.md) for the full decision register.
