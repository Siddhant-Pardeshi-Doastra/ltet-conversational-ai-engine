# Project Context, Source Precedence and Scope Boundary

## Source documents

| Doc | Role in this build |
|---|---|
| A — "LTET Abhra 3rd — Functional Requirements Specification 1" (30 pp) | Primary Release 1 baseline |
| B — "LTET Abhra 2nd — Functional Requirements Specification" (27 pp) | Supporting context; substantive requirements match A |
| C — "LTET AI Voice Abhra 1st" (12 pp business proposal) | Business background only where consistent with A |

**Important implementation note:** the PDFs were present in the workspace but could
not be rendered in the build environment (no PDF tooling available). The build was
therefore implemented from the **supplied requirements digest** of A/B/C included in
the build instruction. The digest is self-contained (62 FRs, 18 IRs, 13 NFRs,
42 BDDs, 3 UCs). Before live deployment, DOASTRA must reconcile this build against
the exact wording and diagrams of document A; any discrepancy is a review item, not
a silent assumption.

## Business context carried into the build

- LTET Employee Trust Portal serves L&T employees; DOASTRA builds the portal and
  its integration APIs.
- The earlier proposal's figures (~3,00,000 users; ~500 monthly helpdesk calls) are
  treated as **proposal figures**, not measurements; they appear nowhere in sizing,
  capacity or analytics defaults.
- Processors are interrupted by claim-status/payment enquiries; the engine answers
  verified enquiries from current portal data and preserves an auditable record.
- **17 schemes** exist in the FRS but names are not supplied → configurable records
  labelled `Demo Scheme 01`…`Demo Scheme 17`. No official scheme names were invented.
- **PS No.** is the employee identifier and is stored as a string (leading zeros
  preserved everywhere: seeds `004321`, `000902`, `000007`, …).
- No "policy number" field exists in LTET; no insurance sales/administration
  features were added.
- Processing stages are exactly: PMS Processor, Sub-panel Review, Apex Panel
  Review, Approval. Stage "Approval" ≠ claim status "Approved" (modelled as
  separate fields: `stage` vs `status`).
- PMS owns stage 1; exact SPM/APM ownership is unresolved → demo persona mapping
  `PMS Processor→pms_processor, Sub-panel Review→spm, Apex Panel Review→apm,
  Approval→apm`, configurable per policy (FR-30/39).
- Finance status comes through the LTET portal/Finance integration (IR-06) — no
  separate direct-Finance connection was invented.
- The FRS assumes an identity/database integration already exists. No code,
  contracts or credentials were supplied → treated as an external integration to
  validate (IR-02/15), with an explicit readiness status instead of a claimed
  connection.

## Release 1 scope implemented

Inbound calls to an India toll-free helpline; UC-01/02/03 as authenticated
enquiries; vernacular conversation with code-switching, claim selection, human
escalation and callback requests; English post-call summaries; original-language
transcripts where permitted; call logs; document-history entries; processor work
queues; analytics; administration.

## Explicitly excluded (and not built)

- Outbound/proactive AI calls (present in the older proposal C — dropped).
- Voice claim submission, claim edits, document upload, resolving processor
  queries by voice, claim approval/rejection, payment execution, bank-account
  changes, amount corrections.
- International toll-free coverage; production WhatsApp/chat channels.
- Claim/payment facts outside the authoritative LTET portal.

The browser call simulator and text controls are demonstration/testing interfaces
for the voice engine — **not** a second production chat channel. Callback requests
are tasks for the approved human service; no proactive AI callback campaigns exist.

## Allowed vs forbidden writes

Allowed (engine-owned operational records): helpdesk call logs, claim-linked
history of what was communicated, notes, alerts, callback tasks, configuration,
audit. Forbidden: any claim or payment mutation — the engine has **no code path**
that writes portal claim/payment/employee tables, and the test suite asserts the
fixture set is unchanged after the full run.

When presenting a processor query, the engine reads/translates it and directs the
employee to the existing portal. The older workflow prompt's outbound
response-write-back is deliberately not implemented.

## Differences from the old outbound proposal (C)

| Proposal C | Release 1 build |
|---|---|
| Outbound proactive AI calls | Excluded by FRS Release 1 |
| Response write-back to processors via outbound messaging | Work-queue alerts + tasks only |
| Broad beneficiary access assumption (FRS A-24) | Least-privilege trusted binding + explicit grant (SEC-03 correction) |
| Savings estimates / 8-week pilot plan | Background only; no deployment or savings claims made |
