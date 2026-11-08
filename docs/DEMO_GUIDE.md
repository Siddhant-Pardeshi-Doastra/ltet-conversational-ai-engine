# Team Walkthrough — 10–15 minute guided tour

Setup: `npm install && npm run demo` → open `http://127.0.0.1:8787` → sign in as
**admin1 / Demo#Pass1**. The workspace runs on its own managed dataset. If anything looks stale, use
**Scenarios & Health → Reset workspace data**.

| # | Scenario | Steps | Expected |
|---|---|---|---|
| 1 | Verified employee enquiry (2 min) | Call Simulator → preset **Credited payment (Vikram)** → Start call → type "yes" → "yes" → read OTP from **DEMO MOCK SMS INBOX** → keypad digits → ✓ → "what is my payment status" | Masked PS confirmation; OTP only in the labelled inbox; approval stated FIRST; ₹24,500.00 + date + bank reference; more-help loop |
| 1b | AGENT MODE: free-form speech (2 min) | Still verified as Vikram: toggle **🎙 Live voice: On** and speak naturally — *"I have been waiting for my money and still nothing has arrived, this is really frustrating"* | Empathetic acknowledgment → **exhaustive resolution search** over live data → authoritative credited answer. With the delay drill on: threshold explained + payments team flagged + human offered. With the portal drill on: search exhausts → transfer **with full context** |
| 2 | Claim stage + open query (1 min) | End call; preset **Linked employee (Priya…)**; verify; "claim status" | "PMS Processor" stage + open query read out + directed to the portal |
| 3 | Direct payment enquiry on approved claim | Preset **Credited payment (Vikram)** again; verify; "payment status" | Same facts; no re-verification required within the session |
| 4 | Failed/delayed payment → alert (2 min) | Scenarios → enable fault **delay_payment** → preset **Credited payment (Vikram)** …; or verify **Linked employee (Arjun…)**-style flows for failed via **Ananya** seed (+91 55555 50006 via caller-number box) | Recorded reason; escalation offered; **Work Queue** shows payment_failed / payment_delayed alert in PMS queue |
| 5 | Legitimate scoped beneficiary (2 min) | Preset **Legit beneficiary (Meera, granted)** → "I am calling as a beneficiary" → keypad employee PS **010077** → "yes" → OTP → "payment status" | Only granted claim CLM-10020; scoped fields; metadata recorded |
| 6 | Impostor denied (1 min) | Preset **Impostor beneficiary (no binding)** → "I am the beneficiary" → keypad **004321** | Generic fail-closed message; no names/claims; denial alert |
| 7 | Outage → human callback (1 min) | Enable fault **finance_outage** → verify Vikram → "payment status" → "callback" | Truthful outage message; callback request created; disable the fault after |
| 8 | Durable records (2 min) | Open **Calls** → click the latest log | Immutable summary, claimed vs verified identity, claim-level entries, document history, answer evidence |
| 9 | Processor acknowledges (1 min) | Role-chip / sign in as **pms1** → Work Queue → Acknowledge + Close | Persona-scoped queue; actions persist across refresh; audited |
| 10 | Analytics + config audit (2 min) | **Analytics** → generate daily report; **Administration** → policy version history, create draft changing claims cap → Save → Approve → Publish → Rollback | Analytics reconcile with stored records; versioned governance with validation; rollback restores |
| 11 | Wrap-up | **Scenarios & Health** → integration health table | Explicit mock/not-configured statuses; explain the external checklist before live use |

## Reset instructions

- UI: Scenarios & Health → **Reset workspace data** (admin1).
- CLI: `node server/seed.js --force` then restart.

## Talking points for the close

- Deterministic state machine — no free-form model in the answer path; facts are
  validated against a fresh source snapshot before anything is spoken.
- Security corrections (SEC-01..07) are deliberate and documented — the original
  FRS identity flow is **not** implemented as written, on purpose.
- What remains before live: LTET API contracts + credentials, carrier, SSO,
  native-speaker language sign-off, recording/retention legal review
  (docs/OPEN_DECISIONS.md).

## Optional 60-second impostor proof for managers

"Someone knows my ID": from any unknown number choose beneficiary, enter a real
employee PS No. (e.g. 004321) — the engine cannot verify them, discloses nothing,
and raises a denial record. Then show that even the *employee* path sends the OTP
to the registered phone, not the caller's.
