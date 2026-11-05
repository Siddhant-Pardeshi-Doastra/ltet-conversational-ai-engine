// Conversation flow tests mapped to BDD scenarios (UC-01/02/03 + exceptions).
// Corrected security expectations (SEC-01..03) replace the weak original BDD
// wording — see docs/SECURITY_DECISIONS.md for the register.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startApp, text, keys, hangup } from './helpers.js';

const t = await startApp();

test.after(async () => { await t.close(); });

const repliesOf = (r) => (r.json?.replies || []).map((x) => x.text).join('\n');
const allReplies = (steps) => steps.map((s) => repliesOf(s)).join('\n');

async function verifiedEmployeeCall({ number, ps = null, extra = [] } = {}) {
  await t.clearOtp();
  const events = [];
  if (!ps) {
    events.push(text('yes'), text('yes'));
  } else {
    events.push(text('yes'), text(ps), text('yes'));
  }
  events.push(...extra);
  const { sid, steps } = await t.driveCall({ caller: number, events: events.slice(0, ps ? 3 : 2) });
  const code = await t.otpFromInbox(sid);
  if (!code) throw new Error('OTP missing; steps: ' + JSON.stringify(steps.map((x) => ({ s: x.json?.session?.state, r: (x.json?.replies || []).map((y) => y.text).join(' | ').slice(0, 200) })), null, 1));
  const otpRes = await t.call('POST', `/api/calls/${sid}/events`, keys(code), { staff: 'admin1' });
  return { sid, steps, otpRes };
}

test('BDD-28/FR-47: greeting identifies LTET, the automated assistant, and the recording notice', async () => {
  const r = await t.call('POST', '/api/calls', { caller_number: '+91 55555 50002' }, { staff: 'admin1' });
  const all = r.json.replies.map((x) => x.text).join('\n');
  assert.ok(all.includes('LTET'), 'brand named');
  assert.ok(all.includes('automated assistant'), 'assistant disclosed');
  assert.ok(all.includes('record'), 'recording/record notice present');
  assert.equal(r.json.session.state, 'language');
  await t.call('POST', `/api/calls/${r.json.session.id}/events`, hangup(true), { staff: 'admin1' });
});

test('BDD-01/SEC-01: linked caller gets MASKED candidate confirmation, never the full PS No.', async () => {
  const { steps } = await verifiedEmployeeCall({ number: '+91 55555 50003' });
  const all = allReplies(steps);
  assert.ok(all.includes('ending 0077'), 'masked ending spoken');
  assert.ok(!all.includes('010077'), 'full identifier never spoken');
});

test('BDD-01 corrected/SEC-01: confirming a matched number does NOT grant access — OTP still required', async () => {
  const r = await t.call('POST', '/api/calls', { caller_number: '+91 55555 50003' }, { staff: 'admin1' });
  const sid = r.json.session.id;
  await t.call('POST', `/api/calls/${sid}/events`, text('yes'), { staff: 'admin1' });
  const c = await t.call('POST', `/api/calls/${sid}/events`, text('yes'), { staff: 'admin1' });
  assert.equal(c.json.session.state, 'challenge_pending');
  await t.call('POST', `/api/calls/${sid}/events`, hangup(), { staff: 'admin1' });
});

test('BDD-31/FR-49: keypad PS entry with digit-by-digit read-back confirmation', async () => {
  const r = await t.call('POST', '/api/calls', { caller_number: '+91 91234 00099' }, { staff: 'admin1' });
  const sid = r.json.session.id;
  await t.call('POST', `/api/calls/${sid}/events`, text('I am the employee'), { staff: 'admin1' });
  const kb = await t.call('POST', `/api/calls/${sid}/events`, keys('001234'), { staff: 'admin1' });
  const c = await t.call('POST', `/api/calls/${sid}/events`, text('yes'), { staff: 'admin1' });
  const all = repliesOf(kb) + '\n' + repliesOf(c);
  assert.ok(all.includes('0 0 1 2 3 4'), 'read-back digit by digit');
  assert.equal(c.json.session.state, 'challenge_pending');
  await t.call('POST', `/api/calls/${sid}/events`, hangup(), { staff: 'admin1' });
});

test('BDD-30/FR-58/BDD-39: wrong OTP attempts count down then lock out with transfer', async () => {
  const r = await t.call('POST', '/api/calls', { caller_number: '+91 55555 50002' }, { staff: 'admin1' });
  const sid = r.json.session.id;
  await t.call('POST', `/api/calls/${sid}/events`, text('yes'), { staff: 'admin1' });
  const c1 = await t.call('POST', `/api/calls/${sid}/events`, text('yes'), { staff: 'admin1' });
  assert.equal(c1.json.session.state, 'challenge_pending');
  let res;
  for (let i = 0; i < 3; i++) {
    res = await t.call('POST', `/api/calls/${sid}/events`, keys('000000'), { staff: 'admin1' });
  }
  const all = repliesOf(res);
  assert.ok(all.includes('Too many incorrect attempts'), 'lockout message');
  assert.equal(res.json.session.state, 'transfer_pending');
  await t.call('POST', `/api/calls/${sid}/events`, hangup(), { staff: 'admin1' });
  const detail = await t.call('GET', `/api/calls/${sid}`, { staff: 'admin1' });
  assert.equal(detail.json.session.outcome, 'verification_failed');
});

test('SEC-04: spoken OTP is refused and redacted; code never enters any transcript', async () => {
  await t.clearOtp();
  const r = await t.call('POST', '/api/calls', { caller_number: '+91 55555 50003' }, { staff: 'admin1' });
  const sid = r.json.session.id;
  await t.call('POST', `/api/calls/${sid}/events`, text('yes'), { staff: 'admin1' });
  await t.call('POST', `/api/calls/${sid}/events`, text('yes'), { staff: 'admin1' });
  const code = await t.otpFromInbox(sid);
  const res = await t.call('POST', `/api/calls/${sid}/events`, text(`my code is ${code}`), { staff: 'admin1' });
  assert.ok(repliesOf(res).includes('keypad'), 'engine insists on the keypad path');
  assert.equal(res.json.session.state, 'challenge_pending');
  // transcript must not contain the code
  const detail = await t.call('GET', `/api/calls/${sid}`, { staff: 'admin1' });
  const transcriptText = JSON.stringify(detail.json.transcript);
  assert.ok(!transcriptText.includes(code), 'OTP absent from transcript');
  assert.ok(!transcriptText.match(/\d{5,}/), 'no long digit runs stored during challenge');
  // correct keypad entry still works afterwards
  const ok = await t.call('POST', `/api/calls/${sid}/events`, keys(code), { staff: 'admin1' });
  assert.equal(ok.json.session.verification.verified, true);
  await t.call('POST', `/api/calls/${sid}/events`, hangup(true), { staff: 'admin1' });
});

test('BDD-06/FR-08: one claim is confirmed directly; BDD-04/05: many claims narrate latest three then batches', async () => {
  await t.clearOtp();
  // Priya: exactly one claim
  const one = await verifiedEmployeeCall({ number: '+91 55555 50002' });
  assert.ok((allReplies(one.steps) + repliesOf(one.otpRes)).includes('one open claim, CLM-10010'));

  // Arjun: 7 claims -> latest three narrated, 'more' paginates remaining
  const r = await t.call('POST', '/api/calls', { caller_number: '+91 55555 50001' }, { staff: 'admin1' });
  const sid = r.json.session.id;
  await t.call('POST', `/api/calls/${sid}/events`, text('yes'), { staff: 'admin1' });
  await t.call('POST', `/api/calls/${sid}/events`, text('yes'), { staff: 'admin1' });
  const code = await t.otpFromInbox(sid);
  await t.call('POST', `/api/calls/${sid}/events`, keys(code), { staff: 'admin1' });
  const intro = await t.call('POST', `/api/calls/${sid}/events`, text('claim status'), { staff: 'admin1' });
  const introText = repliesOf(intro);
  assert.ok(introText.includes('7 open claims'), 'count stated');
  assert.ok(introText.includes('CLM-10007') && introText.includes('CLM-10006') && introText.includes('CLM-10005'), 'latest three, newest first (FR-08)');
  assert.ok(!introText.includes('CLM-10004'), 'beyond batch not narrated yet');
  const more = await t.call('POST', `/api/calls/${sid}/events`, text('more'), { staff: 'admin1' });
  assert.ok(repliesOf(more).includes('CLM-10004') && repliesOf(more).includes('CLM-10003') && repliesOf(more).includes('CLM-10002'), 'remaining claims in batches (FR-09)');
  await t.call('POST', `/api/calls/${sid}/events`, hangup(true), { staff: 'admin1' });
});

test('BDD-08/10/FR-10/FR-12: processing stage + open PMS query alongside stage', async () => {
  const { sid, otpRes } = await verifiedEmployeeCall({ number: '+91 55555 50002' });
  const ans = await t.call('POST', `/api/calls/${sid}/events`, text('claim status'), { staff: 'admin1' });
  const all = repliesOf(ans);
  assert.ok(all.includes('PMS Processor'), 'stage spoken');
  assert.ok(all.includes('open query'), 'query flagged');
  assert.ok(all.includes('hotel stay'), 'query text conveyed');
  assert.ok(all.includes('portal'), 'directed to portal');
  await t.call('POST', `/api/calls/${sid}/events`, hangup(true), { staff: 'admin1' });
});

test('BDD-09/12/FR-44/FR-16: credited payment — approval FIRST, then amount/date/reference from source', async () => {
  const { sid } = await verifiedEmployeeCall({ number: '+91 55555 50003' });
  const ans = await t.call('POST', `/api/calls/${sid}/events`, text('payment status'), { staff: 'admin1' });
  const segs = ans.json.replies.map((x) => x.text);
  const approvalIdx = segs.findIndex((s) => s.includes('approved by Finance'));
  const creditedIdx = segs.findIndex((s) => s.includes('credited'));
  assert.ok(approvalIdx !== -1 && creditedIdx !== -1 && approvalIdx < creditedIdx, 'approval stated before payment status');
  assert.ok(segs.join('\n').includes('₹24,500.00'), 'authoritative amount');
  assert.ok(segs.join('\n').includes('MOCKBANK0045678'), 'bank reference');
  await t.call('POST', `/api/calls/${sid}/events`, hangup(true), { staff: 'admin1' });
});

test('BDD-13/FR-17: pending payment states owner, invents no date', async () => {
  const { sid } = await verifiedEmployeeCall({ number: '+91 55555 50005' });
  const ans = await t.call('POST', `/api/calls/${sid}/events`, text('payment status'), { staff: 'admin1' });
  const all = repliesOf(ans);
  assert.ok(all.includes('pending'), 'pending group');
  assert.ok(all.includes('Finance'), 'owner named');
  assert.ok(all.includes('No payment date is available'), 'explicit no-date disclaimer');
  assert.ok(!all.match(/will be credited|expected (on|by)|payment date is d/i), 'no invented promise');
  await t.call('POST', `/api/calls/${sid}/events`, hangup(true), { staff: 'admin1' });
});

test('BDD-14/FR-18/FR-30: failed payment gives recorded reason and raises a routed PMS alert', async () => {
  await t.clearOtp();
  const { sid } = await verifiedEmployeeCall({ number: '+91 55555 50006' });
  const ans = await t.call('POST', `/api/calls/${sid}/events`, text('payment status'), { staff: 'admin1' });
  const all = repliesOf(ans);
  assert.ok(all.includes('could not be completed'), 'failed group');
  assert.ok(all.includes('Bank account name mismatch'), 'recorded reason');
  const queue = await t.call('GET', '/api/queue/alerts', { staff: 'pms1' });
  assert.ok(queue.json.alerts.some((a) => a.type === 'payment_failed' && a.claim_id === 'CLM-10050'), 'alert in PMS queue');
  await t.call('POST', `/api/calls/${sid}/events`, hangup(true), { staff: 'admin1' });
});

test('FR-15: held payment is distinct from failed', async () => {
  await t.clearOtp();
  const { sid } = await verifiedEmployeeCall({ number: '+91 55555 50007' });
  const ans = await t.call('POST', `/api/calls/${sid}/events`, text('payment status'), { staff: 'admin1' });
  assert.ok(repliesOf(ans).includes('on hold'));
  await t.call('POST', `/api/calls/${sid}/events`, hangup(true), { staff: 'admin1' });
});

test('BDD-27/FR-45: unmapped Finance status is unreadable, never guessed', async () => {
  await t.clearOtp();
  const { sid } = await verifiedEmployeeCall({ number: '+91 55555 50010' });
  const ans = await t.call('POST', `/api/calls/${sid}/events`, text('payment status'), { staff: 'admin1' });
  const all = repliesOf(ans);
  assert.ok(all.includes('cannot be read out safely'), 'safe template');
  assert.ok(!all.includes('Sent-to-Bank-X'), 'raw internal status not exposed as meaning');
  await t.call('POST', `/api/calls/${sid}/events`, hangup(true), { staff: 'admin1' });
});

test('FR-19: missing bank reference/date stays unknown, nothing invented', async () => {
  await t.clearOtp();
  const { sid } = await verifiedEmployeeCall({ number: '+91 55555 50011' });
  const ans = await t.call('POST', `/api/calls/${sid}/events`, text('payment status'), { staff: 'admin1' });
  const all = repliesOf(ans);
  assert.ok(all.includes('credited'), 'credit group spoken');
  assert.ok(!all.includes('The bank reference is {'), 'no unsubstituted slots');
  await t.call('POST', `/api/calls/${sid}/events`, hangup(true), { staff: 'admin1' });
});

test('BDD-23/FR-41: payment question on a non-approved claim yields stage answer only', async () => {
  await t.clearOtp();
  const { sid } = await verifiedEmployeeCall({ number: '+91 55555 50002' });
  const ans = await t.call('POST', `/api/calls/${sid}/events`, text('payment status'), { staff: 'admin1' });
  const all = repliesOf(ans);
  assert.ok(all.includes('not approved yet'), 'no payment info');
  assert.ok(all.includes('PMS Processor'), 'stage answer instead');
  await t.call('POST', `/api/calls/${sid}/events`, hangup(true), { staff: 'admin1' });
});

test('BDD-25/FR-43: amount dispute hands off immediately with a dispute alert; no debate', async () => {
  await t.clearOtp();
  const { sid } = await verifiedEmployeeCall({ number: '+91 55555 50003' });
  await t.call('POST', `/api/calls/${sid}/events`, text('payment status'), { staff: 'admin1' });
  const res = await t.call('POST', `/api/calls/${sid}/events`, text('the amount is wrong, galat hai'), { staff: 'admin1' });
  const all = repliesOf(res);
  assert.ok(all.includes('not able to change or correct'), 'no debate/correction');
  assert.equal(res.json.session.state, 'transfer_pending');
  const queue = await t.call('GET', '/api/queue/alerts', { staff: 'admin1' });
  assert.ok(queue.json.alerts.some((a) => a.type === 'payment_dispute'), 'dispute alert raised');
  await t.call('POST', `/api/calls/${sid}/events`, hangup(), { staff: 'admin1' });
});

test('BDD-18/FR-24/FR-26: out-of-scope request refused; no mutation promised', async () => {
  await t.clearOtp();
  const { sid } = await verifiedEmployeeCall({ number: '+91 55555 50002' });
  const res = await t.call('POST', `/api/calls/${sid}/events`, text('approve my claim and expedite payment'), { staff: 'admin1' });
  const all = repliesOf(res);
  assert.ok(all.includes('For submitting documents or changing claims'), 'scope explained');
  assert.ok(all.includes('portal'), 'portal route');
  await t.call('POST', `/api/calls/${sid}/events`, hangup(true), { staff: 'admin1' });
});

test('BDD-15/16/FR-20: language switch on request mid-call', async () => {
  await t.clearOtp();
  const { sid } = await verifiedEmployeeCall({ number: '+91 55555 50003' });
  const res = await t.call('POST', `/api/calls/${sid}/events`, text('hindi me baat karo'), { staff: 'admin1' });
  assert.equal(res.json.session.language, 'hi');
  assert.ok(repliesOf(res).includes('Hindi') || repliesOf(res).includes('हिन्दी'));
  await t.call('POST', `/api/calls/${sid}/events`, hangup(true), { staff: 'admin1' });
});

test('BDD-17/FR-25: two consecutive recognition failures route to human', async () => {
  await t.clearOtp();
  const { sid } = await verifiedEmployeeCall({ number: '+91 55555 50002' });
  await t.call('POST', `/api/calls/${sid}/events`, text('asdfgh'), { staff: 'admin1' });
  const res = await t.call('POST', `/api/calls/${sid}/events`, text('qwerty uiop'), { staff: 'admin1' });
  assert.ok(repliesOf(res).includes('transferring you to our human helpdesk'));
  assert.equal(res.json.session.state, 'transfer_pending');
  await t.call('POST', `/api/calls/${sid}/events`, hangup(), { staff: 'admin1' });
});

test('BDD-11/FR-13/FR-14: another-claim loop and five-claim cap', async () => {
  await t.clearOtp();
  const r = await t.call('POST', '/api/calls', { caller_number: '+91 55555 50001' }, { staff: 'admin1' });
  const sid = r.json.session.id;
  await t.call('POST', `/api/calls/${sid}/events`, text('yes'), { staff: 'admin1' });
  await t.call('POST', `/api/calls/${sid}/events`, text('yes'), { staff: 'admin1' });
  const code = await t.otpFromInbox(sid);
  await t.call('POST', `/api/calls/${sid}/events`, keys(code), { staff: 'admin1' });
  // FR-13: each "claim status" restarts selection; select claim 1 and confirm it.
  let last = null;
  for (let i = 0; i < 5; i++) {
    await t.call('POST', `/api/calls/${sid}/events`, text('claim status'), { staff: 'admin1' });
    await t.call('POST', `/api/calls/${sid}/events`, keys('1'), { staff: 'admin1' });
    last = await t.call('POST', `/api/calls/${sid}/events`, text('yes'), { staff: 'admin1' });
    assert.equal(last.json.session.state, 'more_help', `claim ${i + 1} answered`);
  }
  // 6th discussion attempt hits the FR-14 cap (default five)
  await t.call('POST', `/api/calls/${sid}/events`, text('claim status'), { staff: 'admin1' });
  await t.call('POST', `/api/calls/${sid}/events`, keys('1'), { staff: 'admin1' });
  const sixth = await t.call('POST', `/api/calls/${sid}/events`, text('yes'), { staff: 'admin1' });
  const all = repliesOf(sixth);
  assert.ok(all.includes('maximum for one call'), 'cap message (FR-14)');
  assert.ok(all.includes('human'), 'human offered');
  assert.equal(sixth.json.session.state, 'claim_cap');
  await t.call('POST', `/api/calls/${sid}/events`, hangup(), { staff: 'admin1' });
});

test('BDD-07/FR-07: zero claims explained after verification with human offer', async () => {
  await t.clearOtp();
  const r = await t.call('POST', '/api/calls', { caller_number: '+91 91234 00077' }, { staff: 'admin1' });
  const sid = r.json.session.id;
  await t.call('POST', `/api/calls/${sid}/events`, text('I am the employee'), { staff: 'admin1' });
  await t.call('POST', `/api/calls/${sid}/events`, keys('003001'), { staff: 'admin1' });
  await t.call('POST', `/api/calls/${sid}/events`, text('yes'), { staff: 'admin1' });
  const code = await t.otpFromInbox(sid);
  const res = await t.call('POST', `/api/calls/${sid}/events`, keys(code), { staff: 'admin1' });
  assert.ok(repliesOf(res).includes('no open claims'));
  await t.call('POST', `/api/calls/${sid}/events`, hangup(true), { staff: 'admin1' });
});

test('BDD-33/FR-52: unexpected mid-call hang-up records abandoned + still finalises', async () => {
  const r = await t.call('POST', '/api/calls', { caller_number: '+91 55555 50002' }, { staff: 'admin1' });
  const sid = r.json.session.id;
  await t.call('POST', `/api/calls/${sid}/events`, text('yes'), { staff: 'admin1' });
  const res = await t.call('POST', `/api/calls/${sid}/events`, hangup(false), { staff: 'admin1' });
  assert.equal(res.json.session.outcome, 'abandoned');
  await new Promise((r2) => setTimeout(r2, 1500));
  const log = await t.call('GET', `/api/calls/${sid}/log`, { staff: 'admin1' });
  assert.equal(log.status, 200, 'post-call processing completed even for abandoned call');
  assert.equal(log.json.log.outcome, 'abandoned');
  assert.equal((log.json.log.claims_discussed || []).length, 0, 'no claims attached');
});

test('BDD-32/FR-51: all-lines-busy fallback offers callback and creates it', async () => {
  await t.clearOtp();
  const r = await t.call('POST', '/api/calls', { caller_number: '+91 55555 50002', force_busy: true }, { staff: 'admin1' });
  const sid = r.json.session.id;
  assert.equal(r.json.session.state, 'busy_fallback');
  const res = await t.call('POST', `/api/calls/${sid}/events`, text('callback please'), { staff: 'admin1' });
  assert.ok(res.json.session.ctx?.callbackId, 'callback effect applied to session context');
  await t.call('POST', `/api/calls/${sid}/events`, hangup(true), { staff: 'admin1' });
  const cbs = await t.call('GET', '/api/callbacks', { staff: 'admin1' });
  assert.ok(cbs.json.callbacks.some((c) => c.session_id === sid), 'callback persisted');
});

test('BDD-21: portal outage -> truthful explanation, transfer, failure alert (no cached answers)', async () => {
  await t.clearOtp();
  await t.call('POST', '/api/demo/faults', { name: 'portal_outage', on: true }, { staff: 'admin1' });
  try {
    const r = await t.call('POST', '/api/calls', { caller_number: '+91 55555 50002' }, { staff: 'admin1' });
    const sid = r.json.session.id;
    await t.call('POST', `/api/calls/${sid}/events`, text('yes'), { staff: 'admin1' });
    await t.call('POST', `/api/calls/${sid}/events`, text('yes'), { staff: 'admin1' });
  const code = await t.otpFromInbox(sid);
    const res = await t.call('POST', `/api/calls/${sid}/events`, keys(code), { staff: 'admin1' });
    assert.ok(repliesOf(res).includes('not responding'), 'truthful outage message');
    assert.ok(repliesOf(res).includes('human') || repliesOf(res).includes('callback'), 'help offered');
    await t.call('POST', `/api/calls/${sid}/events`, hangup(), { staff: 'admin1' });
  } finally {
    await t.call('POST', '/api/demo/faults', { name: 'portal_outage', on: false }, { staff: 'admin1' });
  }
});

test('BDD-24/FR-42: Finance unavailable -> no cached answer, failure log, human/callback', async () => {
  await t.call('POST', '/api/demo/faults', { name: 'finance_outage', on: true }, { staff: 'admin1' });
  try {
    const { sid } = await verifiedEmployeeCall({ number: '+91 55555 50003' });
    const ans = await t.call('POST', `/api/calls/${sid}/events`, text('payment status'), { staff: 'admin1' });
    const all = repliesOf(ans);
    assert.ok(all.includes('not responding'), 'truthful');
    assert.ok(all.includes('callback') || all.includes('human'), 'human/callback offered');
    assert.ok(!all.includes('₹24,500.00'), 'no cached/stale amount');
    const queue = await t.call('GET', '/api/queue/alerts', { staff: 'admin1' });
    assert.ok(queue.json.alerts.some((a) => a.type === 'finance_failure'), 'failure logged');
    await t.call('POST', `/api/calls/${sid}/events`, hangup(), { staff: 'admin1' });
  } finally {
    await t.call('POST', '/api/demo/faults', { name: 'finance_outage', on: false }, { staff: 'admin1' });
  }
});
