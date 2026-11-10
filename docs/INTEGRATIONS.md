# Integrations — contracts, adapters, real-vs-mock boundaries

Machine-readable contract: [`contracts/openapi.yaml`](../contracts/openapi.yaml)
(**proposed** — not supplied production APIs; endpoint names and schemas are
DOASTRA proposals until LTET approves them).

## Adapter map (IR-01..IR-18)

| IR | Adapter / boundary | Demo behaviour | Live behaviour | Not-configured handling |
|---|---|---|---|---|
| IR-01 telephony | `services/calls.js` event model + `routes/telephony.js` | call simulator drives the same event API | carrier posts signed events to `/api/telephony/webhook` | webhook 503 without `TELEPHONY_WEBHOOK_SECRET` |
| IR-02 identity | `adapters/portal.js: lookupByPhone, findEmployee, registeredChallengeTarget` | synthetic tables | implement the same functions against `IDENTITY_API_URL` | readiness blocker `IR-02 identity lookup` |
| IR-03 OTP | `adapters/otp.js` | hashed challenges + isolated mock inbox | POST to `OTP_PROVIDER_URL` (server-side credentials) | **fail closed**: challenge cannot be created; call routes to human |
| IR-04/05 claims | `adapters/portal.js: listOpenClaims, getClaimSummary` | synthetic tables, live fetch per call | `PORTAL_CLAIMS_API_URL` | `PortalUnavailableError` → truthful message + transfer + alert |
| IR-06 finance | `adapters/portal.js: getFinancePayment` | synthetic rows incl. unmapped raw values | `FINANCE_API_URL` | `FinanceUnavailableError` → FR-42 path, failure alert |
| IR-07 helpdesk writes | engine-owned records only | local | LTET Helpdesk API (contract pending) | local records remain authoritative for the demo |
| IR-08 change events | not in Release 1 scope | analytics derive from engine records | future feed | — |
| IR-09 call/summary/history/alert API | local records + routes | local | LTET contract pending | — |
| IR-10 processor notifications | work queues (+optional email/SMS later) | queues | provider config required | queues remain the delivery mechanism |
| IR-11 ASR | `adapters/speech.js` + simulator | browser SpeechRecognition / typed text; **neural: `adapters/sarvam.js` (Saaras) when `SARVAM_API_KEY` is set** | `SARVAM_API_KEY` (or `ASR_PROVIDER_URL`) | typed-input fallback labelled in UI; unconfigured status is explicit |
| IR-12 TTS | simulator | browser SpeechSynthesis (soft channel); **neural: `adapters/sarvam.js` (Bulbul) via metered `/api/voice/tts`** | `SARVAM_API_KEY` (or `TTS_PROVIDER_URL`) | device-voice fallback seamless; coverage per language shown in UI; key never leaves the server |
| IR-13 structured LLM | `adapters/speech.js` (classifier contract) | deterministic no-key parser | `LLM_PROVIDER_URL` (classify/phrase only) | deterministic templates always usable |
| IR-14 analytics store | `services/analytics.js` | SQLite-derived | export/BI sync later | — |
| IR-15 portal roles/credentials | `auth/sessions.js` | seeded demo users | SSO adapter (documented, not built) | staff auth required |
| IR-16 metrics/audit | `audit_events`, `call_latency` | local | export to LTET monitoring later | — |
| IR-17 recordings | OFF by default (`ENABLE_CALL_RECORDINGS`) | off | consent/storage policy required | never silently enabled |
| IR-18 carrier failover | external operator configuration | — | toll-free carrier setup | documented in DEPLOYMENT.md |

## Webhook handling (live)

```
POST /api/telephony/webhook
Headers:
  x-ltet-signature: sha256=HMAC_SHA256(TELEPHONY_WEBHOOK_SECRET, "{timestamp}.{rawBody}")
  x-ltet-timestamp: epoch ms (±5 min)
  x-ltet-nonce:     unique per event (replay table)
Body: { event: call.started|utterance|keypad|hangup, call_id, from, text, digits, expected }
```
Failures: `missing_signature_headers` / `stale_timestamp` / `invalid_signature` /
`replayed_nonce` → 401. `call.started` creates the session; subsequent events map
to the same machine events the simulator uses. Keypad digits during a challenge
are processed but never stored.

## External setup checklist before live mode

1. Provision and vault the secrets: `SESSION_SECRET`, `TELEPHONY_WEBHOOK_SECRET`,
   provider credentials (never in the repo; `.env` is gitignored).
2. LTET approves the proposed contracts (openapi.yaml) and supplies the identity /
   claims / Finance / OTP endpoint contracts (IR-02/04/05/06/03).
3. Implement the four live adapter functions behind the existing interfaces
   (`adapters/portal.js`, `adapters/otp.js`); unit-test against LTET staging.
4. Carrier: toll-free number, routing, failover (IR-18) — operator configuration.
5. Security review sign-off: SEC-01..03 corrections, recording policy (IR-17),
   retention values, SSO (IR-15).
6. Set `LTET_MODE=live`; `/api/readiness` must report `ready: true` (all blockers
   cleared) before private workflows are enabled. Missing config keeps them
   disabled — there is no synthetic fallback in live mode.
7. Per-language ASR/TTS evaluation and native-speaker sign-off; phase launch by
   language (FR-37/NFR-03).

## Real-vs-mock honesty rules baked into the code

- Every readiness endpoint reports explicit statuses (`mock_demo`,
  `browser_simulator`, `configured`, `not_configured`) — the Scenarios & Health
  screen renders them verbatim.
- No demo path can silently appear live: mode is stamped on every session and log
  row; demo tools 403 in live mode; OTP delivery fails closed without a provider.
