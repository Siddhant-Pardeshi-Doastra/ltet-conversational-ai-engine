# Test Report — actual commands and results

Environment: Windows 10 (win32), Node.js v22.22.0, npm 10.9.4. Date of last run:
2026-11-08. No paid-provider keys used; all fixtures synthetic.

## Commands and results

```
> npm run lint
checked 42 files, 0 failures

> npm test   (node --test tests/engine.test.js tests/conversation.test.js
              tests/security.test.js tests/postcall.test.js tests/api.test.js
              tests/live-mode.test.js)
# tests 85
# pass 85
# fail 0
```

CI: `.github/workflows/ci.yml` repeats lint + tests + a seed reproducibility check
on push/PR (Node 22, `npm ci`). CI status must be read from the GitHub Actions run
for the pushed commit — the workflow file alone is not evidence of a pass.

## Coverage by area (85 tests)

| Suite | Focus | Highlights |
|---|---|---|
| engine (17) | intent parsing, languages, fact validation, money | all 12 script detections; Hindi-English code-switch with CLM capture; leading-zero digit groups; Devanagari ordinals/numbers; tampered-slot validation blocked; ₹ Indian grouping |
| conversation (25) | BDD-mapped flows | greeting/notice; masked confirmation; OTP still required after confirm; keypad PS + read-back; OTP lockout; spoken-OTP refusal + redaction; one/many claims + batches; stage+query; credited (approval first); pending (no date); failed (+PMS alert); held; unmapped; missing fields; non-approved; dispute; refusal; language switch; recognition failures; cap; zero claims; abandoned; busy+callback; portal outage; Finance outage |
| security (12) | SEC-01..07 | impostor denied; scoped grant; limited-field grant; revoked grant; landline no-SMS; metadata without contact changes; hash-only OTP; replay rejected; failed verification never attaches history; webhook sig/stale/replay; transcript RBAC + audit; role switcher gating; cross-queue 403; unsafe policy 422; OTP rate limit |
| postcall (8) | durability | exactly-once log/history; duplicate webhook + job replay; crash recovery; alert dedupe across calls; analytics reconciliation; daily/weekly reports; governed retention; policy draft→approve→publish→rollback |
| api (7) | surface | auth; health/readiness honesty; 401s; stage-scoped claim context; PS masking everywhere; search+tags; demo tools demo-only |
| live-mode (4) | separate process | demo tools 403; readiness fails with blockers; verification fails closed without OTP provider; identity returns none |
| language packs (in engine) | FR-37 | 12 packs present; only English native_approved; 11 draft_translation with English fallback |

## Defects found and fixed during the run (evidence of testing, not hidden)

1. Fact-validation compared source-to-closure instead of source-to-plan-slots —
   tampered slot values could have been spoken. Fixed in `answers.js`; blocked path
   now asserted.
2. OTP challenge row was written before the live-mode provider check — half-created
   challenges possible. Fixed: fail closed before any write.
3. Tokenizer split Devanagari words on combining vowel signs (`\p{M}` missing) —
   Hindi number/ordinal words unrecognized. Fixed.
4. Simulator keypad submitted each digit as a complete code (burned OTP attempts) —
   replaced with an IVR-style buffer + Enter key.
5. Work-queue persona scoping compared stage names to role ids — PMS queue empty.
   Fixed with policy stage→persona mapping.
6. Cap counter (`ctx.discussed`) never incremented — FR-14 was unenforceable. Fixed.
7. Non-approved payment question lacked the stage sentence (FR-41). Fixed.
8. Out-of-scope mutation requests ("approve my claim") were routed to selection —
   now answered with the scope explanation (FR-24).
9. Document-history text lacked the claim id. Fixed.
10. Agent-mode interception initially captured simple keyword queries ("payment status");
    the gate now triggers only on free-form problem descriptions. Unverified callers
    were verified to never reach the resolution engine (dedicated test).
11. Various test-harness defects (call signature, session leakage, OTP rate-limit
    isolation) that had been masking the real behaviour above.

## Not validated here — external acceptance pending

- Real telephony: carrier signalling, warm-transfer behaviour, DTMF reliability,
  toll-free failover (IR-01/18).
- Real ASR/TTS quality per language; first-attempt recognition ≥95% (NFR-03);
  native-speaker script approval (FR-37).
- Production identity/claims/Finance API contracts and credentials (IR-02/04/05/06).
- Load/concurrency beyond local simulation (NFR-04/05); availability monitoring.
- Security penetration test and legal review of recording/retention (NFR-07/08).

These are listed as pending; no pass is claimed for any of them.
