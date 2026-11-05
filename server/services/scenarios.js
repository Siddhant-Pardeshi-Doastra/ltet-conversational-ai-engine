// Demo scenario catalogue (FR/BDD-mapped, reproducible). Each scenario lists
// seed IDs and expected outcomes; presets drive the Call Simulator.
export const SCENARIOS = [
  {
    id: 'sc-01-linked-employee', title: 'Verified employee enquiry (linked number)', bdd: ['BDD-01', 'BDD-31'], fr: ['FR-01', 'FR-02', 'FR-06', 'FR-08'],
    caller: { number: '+91 55555 50001' }, steps: ['Confirm masked PS (yes)', 'Enter OTP from mock inbox', 'Select claim 1'],
    expect: 'Claims narrated newest-first; stage answer validated against portal; post-call log + history created.',
  },
  {
    id: 'sc-02-zero-claims', title: 'No open claims', bdd: ['BDD-07'], fr: ['FR-07'],
    caller: { number: '+91 55555 50009', ps: '003001' }, steps: ['Enter PS 003001', 'Enter OTP'],
    expect: '"No open claims" explanation + human offer.',
  },
  {
    id: 'sc-03-stage-query', title: 'Processing stage + open PMS query', bdd: ['BDD-08', 'BDD-10'], fr: ['FR-10', 'FR-12'],
    caller: { number: '+91 55555 50002' }, steps: ['Confirm', 'OTP', 'Select claim'], expect: 'Stage "PMS Processor" + open query read out; directed to the portal.',
  },
  {
    id: 'sc-04-credited', title: 'Approved claim — credited payment', bdd: ['BDD-09', 'BDD-12'], fr: ['FR-11', 'FR-16', 'FR-44'],
    caller: { number: '+91 55555 50003' }, steps: ['Confirm', 'OTP', 'Ask payment'], expect: 'Approval stated FIRST, then amount/date/bank reference from source.',
  },
  {
    id: 'sc-05-delayed', title: 'Delayed processed payment', bdd: ['BDD-26'], fr: ['FR-46', 'FR-30'],
    caller: { number: '+91 55555 50004' }, steps: ['Confirm', 'OTP', 'Ask payment'], expect: 'Processed status + owner; delay flag in summary; alert raised (demo threshold 7 days, synthetic).',
  },
  {
    id: 'sc-06-pending', title: 'Pending payment — no date invented', bdd: ['BDD-13'], fr: ['FR-17'],
    caller: { number: '+91 55555 50005' }, steps: ['Confirm', 'OTP', 'Ask payment'], expect: 'Pending with owner team; no payment date spoken.',
  },
  {
    id: 'sc-07-failed', title: 'Failed payment + alert + escalation', bdd: ['BDD-14'], fr: ['FR-18', 'FR-30'],
    caller: { number: '+91 55555 50006' }, steps: ['Confirm', 'OTP', 'Ask payment'], expect: 'Recorded reason; PMS alert; escalation offered.',
  },
  {
    id: 'sc-08-held', title: 'Held payment', bdd: ['BDD-14'], fr: ['FR-15', 'FR-18'],
    caller: { number: '+91 55555 50007' }, steps: ['Confirm', 'OTP', 'Ask payment'], expect: 'Held kept distinct from failed; recorded reason; alert.',
  },
  {
    id: 'sc-09-unmapped', title: 'Unmapped Finance status is unreadable, not guessed', bdd: ['BDD-27'], fr: ['FR-45'],
    caller: { number: '+91 55555 50010' }, steps: ['Confirm', 'OTP', 'Ask payment'], expect: 'Safe template; no invented semantics.',
  },
  {
    id: 'sc-10-missing-fields', title: 'Credited with missing bank reference/date', bdd: [], fr: ['FR-19'],
    caller: { number: '+91 55555 50011' }, steps: ['Confirm', 'OTP', 'Ask payment'], expect: 'Missing data stays unknown; no invented values.',
  },
  {
    id: 'sc-11-language-mix', title: 'Hindi-English code-switching', bdd: ['BDD-15', 'BDD-16'], fr: ['FR-20', 'FR-21'],
    caller: { number: '+91 55555 50001' }, steps: ['Say "meri claim ka status batao"', 'Switch: "switch to English"'], expect: 'Language detected/switched; claims terminology in English accepted.',
  },
  {
    id: 'sc-12-recognition-failures', title: 'Two consecutive recognition failures', bdd: ['BDD-17'], fr: ['FR-25'],
    caller: { number: '+91 55555 50002' }, steps: ['Confirm', 'OTP', 'Say gibberish twice'], expect: 'Automatic human handoff.',
  },
  {
    id: 'sc-13-refusal', title: 'Out-of-scope request refused', bdd: ['BDD-18'], fr: ['FR-24', 'FR-26'],
    caller: { number: '+91 55555 50002' }, steps: ['Verify', 'Say "approve my claim"'], expect: 'Scope explanation; portal route; human offer.',
  },
  {
    id: 'sc-14-finance-outage', title: 'Finance unavailable — truthful + callback', bdd: ['BDD-24'], fr: ['FR-42'],
    caller: { number: '+91 55555 50003' }, fault: 'finance_outage', steps: ['Verify', 'Ask payment'], expect: 'No cached answer; failure log; human/callback offered.',
  },
  {
    id: 'sc-15-portal-outage', title: 'Portal outage during claims fetch', bdd: ['BDD-21'], fr: ['FR-06'],
    caller: { number: '+91 55555 50002' }, fault: 'portal_outage', steps: ['Verify'], expect: 'Truthful explanation; transfer/callback; failure alert.',
  },
  {
    id: 'sc-16-dispute', title: 'Amount dispute → immediate handoff', bdd: ['BDD-25'], fr: ['FR-43'],
    caller: { number: '+91 55555 50003' }, steps: ['Verify', 'Ask payment', 'Say "amount is wrong"'], expect: 'No debate/correction; immediate transfer with context; dispute alert.',
  },
  {
    id: 'sc-17-unlinked-otp', title: 'Unlinked employee — PS entry + OTP to registered channel', bdd: ['BDD-29', 'BDD-31'], fr: ['FR-48', 'FR-49'],
    caller: { number: '+91 91234 00099', ps: '001234' }, steps: ['Choose employee', 'Enter PS 001234', 'OTP'], expect: 'Challenge sent ONLY to registered contact; keypad path; no spoken codes.',
  },
  {
    id: 'sc-18-wrong-otp', title: 'Wrong OTP then lockout', bdd: ['BDD-30', 'BDD-39'], fr: ['FR-58'],
    caller: { number: '+91 55555 50002' }, steps: ['Confirm', 'Enter 000000 x3'], expect: 'Attempt countdown; lockout; transfer to human; verification_failed outcome.',
  },
  {
    id: 'sc-19-busy', title: 'All lines busy fallback', bdd: ['BDD-32'], fr: ['FR-51'],
    caller: { number: '+91 55555 50002', forceBusy: true }, steps: ['Observe busy fallback', 'Say "callback"'], expect: 'Callback request created; busy alert for admin.',
  },
  {
    id: 'sc-20-midcall-hangup', title: 'Unexpected hang-up mid-call', bdd: ['BDD-33'], fr: ['FR-52'],
    caller: { number: '+91 55555 50002' }, steps: ['Start call', 'Hang up without completing'], expect: 'Outcome abandoned; post-call processing still runs.',
  },
  {
    id: 'sc-21-beneficiary-legit', title: 'Legitimate scoped beneficiary', bdd: ['BDD-36', 'BDD-37', 'BDD-42'], fr: ['FR-54', 'FR-55', 'FR-57', 'FR-61', 'FR-62'],
    caller: { number: '+91 55555 51001', ps: '010077' }, steps: ['Choose beneficiary', 'Enter employee PS 010077', 'OTP'], expect: 'Only granted claim (CLM-10020) visible; metadata recorded; registered employee contacts untouched.',
  },
  {
    id: 'sc-22-impostor', title: 'Impostor denied despite knowing PS No.', bdd: ['BDD-37'], fr: ['SEC-03'],
    caller: { number: '+91 91234 00042', ps: '004321' }, steps: ['Choose beneficiary', 'Enter PS 004321'], expect: 'Fail-closed generic response; no enumeration; denial alert.',
  },
  {
    id: 'sc-23-revoked-grant', title: 'Revoked beneficiary grant fails immediately', bdd: [], fr: ['SEC-03'],
    caller: { number: '+91 55555 51004', ps: '000902' }, steps: ['Choose beneficiary', 'Enter PS 000902'], expect: 'Immediate denial; no claims disclosed.',
  },
  {
    id: 'sc-24-landline-beneficiary', title: 'SMS-incapable beneficiary number', bdd: ['BDD-40'], fr: ['FR-59'],
    caller: { number: '+91 55555 61005', ps: '001234' }, steps: ['Choose beneficiary', 'Enter PS 001234'], expect: 'No SMS attempted; human/portal path.',
  },
  {
    id: 'sc-25-profile-fail', title: 'Generic profile lookup failure', bdd: ['BDD-38'], fr: ['FR-56'],
    caller: { number: '+91 91234 00077' }, steps: ['Choose beneficiary', 'Enter PS 999999'], expect: 'Generic cannot-verify; one retry; then human.',
  },
  {
    id: 'sc-26-direct-payment', title: 'Direct payment intent entry', bdd: ['BDD-22'], fr: ['FR-40'],
    caller: { number: '+91 55555 50003' }, steps: ['Verify', 'Say "payment status"'], expect: 'Verification + claim selection still enforced; payment answer via UC-02.',
  },
  {
    id: 'sc-27-nonapproved-payment', title: 'Payment question on non-approved claim', bdd: ['BDD-23'], fr: ['FR-41'],
    caller: { number: '+91 55555 50002' }, steps: ['Verify', 'Ask payment'], expect: 'Stage answer only; explicitly no payment information.',
  },
  {
    id: 'sc-28-cap', title: 'Claims-per-call cap (5)', bdd: ['BDD-11'], fr: ['FR-14', 'FR-13'],
    caller: { number: '+91 55555 50001' }, steps: ['Verify', 'Discuss 5 claims one by one'], expect: 'Cap message + human offer at the sixth request.',
  },
  {
    id: 'sc-29-ps-reject', title: 'PS rejection twice → employee/beneficiary question', bdd: ['BDD-02'], fr: ['FR-02'],
    caller: { number: '+91 55555 50001' }, steps: ['Answer "no" twice to masked confirmation'], expect: 'Falls to caller-type question (never reveals the identifier).',
  },
  {
    id: 'sc-30-after-hours', title: 'Human unavailable → hours + callback', bdd: ['BDD-34'], fr: ['FR-53'],
    caller: { number: '+91 55555 50002' }, steps: ['Verify', 'Say "agent" outside helpdesk hours'], expect: 'Configured hours stated; callback offered and created on acceptance.',
  },
  {
    id: 'sc-31-greeting-notice', title: 'Toll-free greeting + recording notice', bdd: ['BDD-28'], fr: ['FR-47'],
    caller: { number: '+91 55555 50002' }, steps: ['Start call'], expect: 'LTET identity + automated assistant + recording/AI notice before any detail.',
  },
];
