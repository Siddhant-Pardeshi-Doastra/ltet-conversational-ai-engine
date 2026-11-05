# Security Decisions — original FRS ambiguities and implemented corrections

The Release 1 FRS contains material authentication ambiguities. This register
preserves the original intent, documents the **safer implemented behaviour** as a
proposed security correction requiring LTET review, and lists residual risks.
Nothing here claims exact compliance with contradictory acceptance criteria; the
uncorrected design is not advertised as secure.

## Decision register

### SEC-01 — Identifier and caller-ID weakness
- **Original FRS intent (FR-02/BDD-01):** resolve the caller's number, confirm the
  PS No., and proceed on a verbal yes.
- **Why unsafe:** knowing a PS No./name/DOB/claim ID or possessing the employee's
  phone is not identity. A matched incoming number + "yes" is a lookup signal only.
- **Implemented:** masked candidate confirmation ("record ending 4321") — the full
  identifier is never revealed from caller ID alone; a matched number + verbal yes
  never unlocks claims; OTP to the registered channel is ON by default. If OTP is
  disabled in a live configuration, `identity.second_factor` must name another
  approved method or disclosure is denied (enforced by `validatePolicy`).
- **Tests:** conversation "confirming a matched number does NOT grant access";
  security "masked candidate confirmation, never the full PS No."

### SEC-02 — Employee OTP routing
- **Original ambiguity:** where challenges go when the calling number differs.
- **Implemented:** employee challenges go **only** to the authoritative previously
  registered channel; a number supplied during the call is never used. The backend
  verifies the code and binds method/assurance/expiry to this call session. Claim
  and payment reads re-derive scope from the server-side session on every request;
  a frontend boolean, transcript statement or model output can never grant access.
- **Residual:** OTP proves channel control; shared phones, theft and SIM swap
  remain step-up/recovery concerns (registered-contact change is an approved
  external process, not an in-call assertion).

### SEC-03 — Beneficiary authentication gap (FR-57/BDD-37, FRS A-24)
- **Original FRS intent:** OTP to the beneficiary's calling number unlocks the
  employee's claims; A-24 assumes broad beneficiary access pending a decision.
- **Why unsafe:** someone who knows a PS No. and possesses *any* phone passes that
  flow. Existence of a beneficiary, a known name/relationship, and an OTP to an
  arbitrary calling number do not prove the caller is that beneficiary.
- **Implemented (proposed extension, labelled in seed data):** trusted
  `beneficiary_bindings` (previously verified contact) + explicit
  `access_grants` (permitted claims + permitted fields, expiry, grantor).
  Fail-closed when absent/revoked/expired; generic denial (no enumeration);
  denial alerts; least-privilege claim/field filtering. The OTP is retained as a
  phone-control step only. In live mode without an authoritative equivalent,
  approved human/portal verification is required before any grant exists.
- **Tests:** impostor denied despite knowing PS No.; legitimate scoped grant;
  limited-field grant; revoked grant; SMS-incapable; registered contacts untouched.

### SEC-04 — Authentication-secret isolation
- **Implemented:** random expiring codes; salted hashes only; per-subject rate
  limit (3 / 15 min) without permanent lockout; atomic single-UPDATE consume
  (replay-safe); resend limits; keypad-only entry; spoken codes refused and
  redacted; codes absent from transcripts, logs, analytics, URLs, errors and model
  inputs (asserted by tests). Demo delivery uses the isolated, clearly labelled
  mock inbox; **no fixed universal OTP and no production bypass endpoint exist**;
  the inbox endpoint is hard-blocked in live mode.

### SEC-05 — Trust and authorisation
- **Implemented:** backend RBAC + stage/claim scoping on queue, claim context,
  transcripts, exports and analytics; UI hiding is never the control. Verified
  identity is bound server-side per session and expires with it. The LLM/intent
  layer classifies only — it never decides access or creates facts. Processor
  sessions are authenticated (scrypt + httpOnly SameSite cookies). The demo role
  switcher exists only in demo mode and 403s (audited) in live mode.
- **Residual:** production SSO (IR-15) is an external adapter; no real SSO is
  claimed.

### SEC-06 — Handoff and recovery
- **Implemented:** human handoff never waives verification; nothing secret is
  forwarded; logs distinguish claimed vs verified PS No.; an unverified caller's
  session cannot attach history to a victim's claim (finalize only writes history
  when verified PS == claim owner — tested). Registered-contact recovery uses an
  approved external process; no in-call changes (FR-62 asserts contacts unchanged).

### SEC-07 — Other controls
- Telephony webhook: HMAC-SHA256 over `timestamp.body`, ±5 min window, nonce
  replay table (all three paths tested); requires `TELEPHONY_WEBHOOK_SECRET`.
- Rate limiting at the edge (generous) + strict per-subject OTP limits — abuse is
  throttled without attacker-triggered permanent lockout.
- Caller speech and processor-query text are untrusted data; prompt-injection
  cannot invoke operations or expose other records (deterministic machine).
- Provider credentials stay server-side; parameterised SQL everywhere; sessions
  httpOnly/SameSite=Strict; PS numbers and phones are masked in every API response
  (tested); role-aware retention purge is the only deletion path; audio recording
  defaults OFF pending consent/storage policy; no legal-compliance claims are made
  without review.

## The manager's question: "someone knows my ID"

If someone obtains an employee's PS No. (e.g. from a payslip) and calls:
- They are asked to identify as employee/beneficiary. Entering the PS No. only
  reaches the **challenge** step — the OTP goes to the employee's registered
  phone, not the caller's.
- Claiming to be a beneficiary fails closed without a previously verified binding
  and an explicit grant for that employee.
- Guessing OTPs locks the attempt after the configured tries and raises a
  verification-failed record; no claim history is attached to the attempt.
**What this design cannot prevent:** an attacker who *also controls the
employee's registered phone* (SIM swap, theft, family phone). That requires
step-up authentication/recovery controls owned by LTET identity — documented as a
residual risk with the compromised-phone limitation stated explicitly.

## Residual risks / items for LTET review before live use

1. Approve or replace the SEC-01/SEC-03 corrections (masked confirmation;
   binding+grant model) against the FRS acceptance criteria.
2. Confirm the authoritative beneficiary-identity source and grant administration
   process (who may mark a caller verified, with audit).
3. Choose the second-factor method(s) if OTP is ever disabled; policy validation
   blocks unsafe combinations in live mode.
4. Recording consent, storage and retention need legal review (NFR-08) — recording
   stays off until then.
5. Per-language audio evaluation and native-speaker sign-off (NFR-03/FR-37).
6. SSO/service credentials (IR-15) and vault-based secret management (NFR-07).
