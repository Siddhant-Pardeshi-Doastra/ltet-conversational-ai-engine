# Workflows — use cases, alternates, handoff, post-call, roles, dialogues

## Common flow (all UCs)

```
trusted call event → create session → greeting + AI/recording notice (FR-47)
→ language (detect/choose) → minimum identification (masked confirm | keypad PS)
→ authentication (isolated OTP to the registered/verified channel, keypad entry)
→ authorisation (verified session; beneficiaries: grant-scoped)
→ claim selection (zero/one/many, batches, confirm spoken IDs)
→ live permitted fetch → validated answer plan → speak
→ more help loop (cap at 5) → close / transfer / callback
→ durable post-call work (log, history, summary, alerts)
```

## Agent mode — free-form problem solving (roadmap addition)

When a VERIFIED caller describes a reimbursement problem in free form ("I have
been waiting for my money and still nothing has arrived"), the agent:
1. acknowledges with empathy/urgency lines (deterministic templates),
2. runs the EXHAUSTIVE resolution search over live data — credited →
   delayed(+threshold, proactive flag) → failed/held(+recorded reason) →
   pending-timeline → open query → stage guidance,
3. speaks the first path that passes fact validation,
4. only when every path is exhausted: transfers WITH FULL CONTEXT (reason +
   attempted paths as an alert) so the client never repeats themselves.
Unverified callers never reach the resolution engine. Simple keyword queries
("payment status") keep the deterministic fast path.

## UC-01 — Claim status (employee)

1. Greeting/notice → language.
2. Linked number → masked candidate confirmation ("…ending 4321. Is this you?").
   One rejection retry, then employee-vs-beneficiary question (FR-02).
   Unlinked → employee path: keypad PS entry with digit-by-digit read-back confirm.
3. OTP to the **registered** channel (never a number supplied in-call — SEC-02).
   Wrong code: attempts countdown; exhausted → transfer; outcome verification_failed.
4. Authenticated → live open-claims fetch (FR-06). Zero → explain + human offer.
   One → confirm directly. Many → latest three newest first (FR-08), "more" pages
   the remainder (FR-09). Claim ID spoken → digit read-back + confirm (FR-22).
5. Processing claim → permitted stage + open PMS query alongside, directed to the
   portal (FR-10/12). Approved → UC-02 answer. Another-claim loop (FR-13);
   five-claims cap (FR-14).

*Alternate paths:* portal outage → truthful message + transfer/callback + failure
alert (BDD-21); recognition failures ×2 → human (FR-25); out-of-scope request →
scope explanation + portal route (FR-24/26); dispute → immediate handoff (FR-43).

## UC-02 — Payment information

Entry: from an approved claim selection, or a direct payment intent (still runs
verification + selection — FR-40). Non-approved claim → stage/query answer plus the
explicit "no payment information to share" sentence (FR-41). Approved claim:
**Finance approval first (FR-44)**, then the mapped group (FR-45):

| Group | Said | Effects |
|---|---|---|
| credited | amount, credit date, bank reference (authorised fields only) | — |
| processed | approval date, owner team, **no payment date** | delayed flag if approval older than threshold (FR-46) |
| pending | approval date, owner team, **no payment date** | delayed flag likewise |
| failed | approval date, recorded reason | payment_failed alert (routed), escalation offer |
| held | approval date, recorded reason | payment_held alert, escalation offer |
| unmapped/missing | "cannot be read out safely" / unknown stays unknown | nothing invented (FR-19/45) |

Finance service down → truthful explanation, human/callback, failure alert, **no
cached answer** (FR-42). Amount dispute → transfer immediately with authorised
context; never debated or corrected (FR-43).

## UC-03 — Listed beneficiary

1. Employee-vs-beneficiary question when the number doesn't establish the path
   (FR-54); a stated role in the first utterance skips the re-ask.
2. Employee PS No. captured digit by digit (FR-55). Unknown record → generic
   cannot-verify, one retry, then human (FR-56) — no profile enumeration.
3. **SEC-03 (corrected):** the caller's phone must match a previously **verified
   binding** on the beneficiary record AND an **active, unexpired grant** naming
   permitted claims and fields. No binding/revoked/expired → fail closed with the
   generic response + denial alert. Existence of a beneficiary, a known
   name/relationship, or an OTP to the calling number is **never** sufficient.
4. Challenge to the beneficiary's calling number (FR-57) — a phone-control step
   only. Optional name comparison when configured (FR-60; a name match alone
   never authenticates). Landline/hidden → no SMS attempt; human/portal (FR-59).
5. Verified → only granted claims in selection, only permitted fields in answers
   (FR-61). Metadata recorded: caller type, protected number, method/assurance
   (FR-62). Registered employee contacts are never modified.

## Human handoff and recovery

- Triggers: explicit request, distress words, two consecutive recognition failures
  (FR-25), verification lockout, transfer-failure.
- Handoff never waives verification (SEC-06): no verified session → the human path
  starts unverified; no scoped verification reference is forwarded across calls.
  OTP codes are never forwarded.
- Connected (in helpdesk hours) → outcome escalated. Unavailable → configured
  hours stated + callback offered; acceptance creates a callback task (FR-53).
- Busy (concurrency cap) → callback / human / portal offer (FR-51).

## Terminal outcome precedence (FR-28)

1. `verification_failed` — verification failed/locked and the call ends.
2. `escalated` — transfer connected or transfer requested.
3. `abandoned` — unexpected hang-up mid-flow (normal hang-up in `ending` → resolved).
4. `resolved` — completed normally.
Documented rationale: an unverified call that reached a human still ends
escalated for queue accounting; abandonment is only for silent caller drop.

## Post-call lifecycle

hangup → outbox `finalize:{session}` → worker: one immutable log (locked at birth)
→ deduplicated claim entries (written in-call) → document history per discussed
claim (only if verified owner matches — SEC-06) → structured English summary
(FR-27) → defensive alert re-raise (dedupe) → latency samples. Retries with
backoff → dead-letter + admin replay. Analytics and reports derive from these
records with these definitions:

- **Containment** = resolved ÷ ended calls in window.
- **Escalation rate** = escalated ÷ ended.
- **Drivers** = summary intent counts. **Repeat caller** = claim discussed in >1 session.
- **Payment mix** = payment groups among facts actually given.
- Latency metrics are simulator-labelled, never presented as production voice metrics.

## Role / access matrix (SEC-05)

| Capability | pms_processor | spm | apm | admin | auditor |
|---|---|---|---|---|---|
| Work-queue alerts (own persona) | ✅ PMS | ✅ SPM | ✅ APM+Approval | ✅ all | ✅ view |
| Acknowledge/close alerts | ✅ own | ✅ own | ✅ own | ✅ | view |
| Claim context | stage-scoped | stage-scoped | stage-scoped | all | all |
| Call summaries | ✅ | ✅ | ✅ | ✅ | ✅ |
| Full transcripts | ❌ (FR-36 default) | ❌ | ❌ | ✅ audited | ✅ audited |
| Policy draft/approve/publish/rollback | ❌ | ❌ | ❌ | ✅ | ❌ |
| Demo tools (reset/faults/inbox/role switch) | ❌ | ❌ | ❌ | ✅ demo mode only | ❌ |
| Retention purge | ❌ | ❌ | ❌ | ✅ audited | ❌ |

## Sample dialogues

**Credited (en):**
> System: "…I found an employee record linked to this number, ending 0077. Is this you?"
> Caller: "yes" → "I have sent a verification code to your registered contact ending •003…"
> Caller: [keypad 448062] → "Thank you. Your identity is verified." → "You have one open claim, CLM-10020…"
> Caller: "what is my payment status" → "Your claim CLM-10020 has been approved by Finance. The payment has been credited. An amount of ₹24,500.00 was credited on 1 November 2026. The bank reference is MOCKBANK0045678."

**Hindi-English code-switch (hi):**
> Caller: "mera CLM-10020 ka payment status kya hai" → detected hi, claim ID captured →
> "आपका दावा CLM-10020 वित्त विभाग द्वारा स्वीकृत हो गया है…" (claims terminology accepted in English per FR-21).

**Impostor (SEC-03):**
> Caller (unknown number): "I am the beneficiary" → "…please enter the employee's PS number…" → [004321]
> "I am sorry, I cannot verify you as an authorised beneficiary on this call. This has been noted…" — no names, no claims, denial alert raised.
