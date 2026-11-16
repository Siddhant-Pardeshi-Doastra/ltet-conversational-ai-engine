// Manager dial-in matrix: toll-free helpline flow (PS number → full name → DOB)
// with the exact persona/scenario fixtures from the product spec.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startApp, text, keys, hangup } from './helpers.js';

const t = await startApp();
test.after(async () => { await t.close(); });

const repliesOf = (r) => (r.json.replies || []).map((x) => x.text).join(' ');

/** Full knowledge-verification drive for a dial-in persona. */
async function dialIn({ caller, ps, name, dob }) {
  const r = await t.call('POST', '/api/calls', { caller_number: caller }, { staff: 'admin1' });
  const sid = r.json.session.id;
  const steps = [r];
  const ev = async (e) => {
    const res = await t.call('POST', `/api/calls/${sid}/events`, e, { staff: 'admin1' });
    steps.push(res);
    return res;
  };
  await ev(text('I am the employee'));
  await ev(keys(ps));
  await ev(text('yes'));
  await ev(text(name));
  await ev(keys(dob));
  return { sid, steps, last: steps[steps.length - 1], ev };
}

test('dial-in matrix: Ramesh (Hindi) — documents pending + paid', async () => {
  const { sid, last, ev } = await dialIn({ caller: '+91 90051 20001', ps: '20012345', name: 'Ramesh Kumar Sharma', dob: '12041968' });
  assert.equal(last.json.session.verification.verified, true, 'PS+name+DOB verified');
  assert.equal(last.json.session.verification.method, 'ps_dob');
  assert.ok(repliesOf(last).includes('CLM-10201'), 'two claims listed');
  await ev(keys('1')); // latest first: documents-pending claim
  const st = await ev(text('yes')); // selection confirm -> answer
  const all = repliesOf(st);
  assert.ok(all.includes('PMS Processor'), 'stage stated');
  assert.ok(all.includes('Documents pending'), 'open query read aloud');
  await ev(text('yes')); // more help -> restart selection
  await ev(keys('2')); // the paid claim
  const pay = await ev(text('yes')); // confirm -> payment answer (claim is Approved: payment intent default)
  const payText = repliesOf(pay);
  assert.ok(payText.includes('approved'), 'approval stated first');
  assert.ok(payText.includes('credited'), 'paid claim credited');
  assert.ok(payText.includes('21,500'), 'authoritative amount (₹21,500.00)');
  assert.ok(payText.includes('MOCKBANK0072001'), 'bank reference');
  await ev(hangup(true));
});

test('dial-in matrix: Suresh (Marathi) — rejected claim states the recorded reason', async () => {
  const { sid, last, ev } = await dialIn({ caller: '+91 90051 20003', ps: '40055501', name: 'Suresh Patil', dob: '21071979' });
  assert.equal(last.json.session.verification.verified, true);
  await ev(keys('1'));
  const st = await ev(text('yes')); // confirm -> rejection answer
  const all = repliesOf(st);
  assert.ok(all.includes('not approved'), 'rejection stated honestly');
  assert.ok(all.includes('Death Relief'), 'scheme named');
  assert.ok(all.includes('cause of death does not meet'), 'recorded reason read out');
  assert.ok(!all.includes('credited'), 'no payment facts for a rejected claim');
  await ev(hangup(true));
});

test('dial-in matrix: Priya (Tamil) — payment initiated maps to processed; scrutiny query voiced', async () => {
  const { last, ev } = await dialIn({ caller: '+91 90051 20002', ps: '30098765', name: 'Priya Venkatesan', dob: '03111985' });
  assert.equal(last.json.session.verification.verified, true);
  await ev(keys('1')); // latest first = approved, payment initiated (CLM-10203)
  await ev(text('payment status')); // confirm with payment intent
  const pay = await ev(text('yes'));
  assert.ok(repliesOf(pay).includes('processed'), "'Initiated' maps to the processed group");
  await ev(text('yes')); // more help -> restart selection
  await ev(keys('2')); // older = under scrutiny (CLM-10204, Processing)
  const st = await ev(text('yes')); // confirm -> stage+query answer
  assert.ok(repliesOf(st).includes('under scrutiny'), 'scrutiny query voiced');
  await ev(hangup(true));
});

test('dial-in matrix: Venkat (Telugu) — approved with payment not yet issued + paid', async () => {
  const { last, ev } = await dialIn({ caller: '+91 90051 20006', ps: '50033344', name: 'Venkat Reddy', dob: '05121960' });
  assert.equal(last.json.session.verification.verified, true);
  await ev(keys('1')); // latest first = approved, no payment row (CLM-10209)
  await ev(text('payment status')); // confirm with payment intent
  const pay = await ev(text('yes'));
  const all = repliesOf(pay);
  assert.ok(all.includes('approved'), 'approval stated first');
  assert.ok(all.includes('no payment has been issued'), 'not-issued stated honestly, no invented date');
  await ev(text('yes')); // more help -> restart selection
  await ev(keys('2'));
  await ev(text('payment status'));
  const pay2 = await ev(text('yes'));
  assert.ok(repliesOf(pay2).includes('credited'), 'second claim is paid');
  await ev(hangup(true));
});

test('dial-in matrix: Kiran (Gujarati) — on hold with recorded reason', async () => {
  const { last, ev } = await dialIn({ caller: '+91 90051 20005', ps: '50022233', name: 'Kiran Desai', dob: '30091990' });
  assert.equal(last.json.session.verification.verified, true);
  await ev(keys('1'));
  await ev(text('payment status'));
  const pay = await ev(text('yes'));
  const all = repliesOf(pay);
  assert.ok(all.includes('on hold'), 'held stated');
  assert.ok(all.includes('cancelled-cheque'), 'recorded reason read out');
});

test('dial-in matrix: wrong DOB twice fails closed to the human path', async () => {
  const { last, ev } = await dialIn({ caller: '+91 90051 20008', ps: '50055566', name: 'Meera Nair', dob: '01011990' });
  assert.equal(last.json.session.state, 'ident_knowledge_name', 'first mismatch asks again');
  assert.ok(repliesOf(last).includes('do not match'), 'generic mismatch line');
  const r2 = await t.call('POST', '/api/calls/' + last.json.session.id + '/events', text('Meera Nair'), { staff: 'admin1' });
  const r3 = await t.call('POST', `/api/calls/${last.json.session.id}/events`, keys('01011990'), { staff: 'admin1' });
  assert.equal(r3.json.session.state, 'transfer_pending', 'second mismatch transfers out');
  await ev(hangup());
  await new Promise((r) => setTimeout(r, 1300));
  const log = await t.call('GET', `/api/calls/${last.json.session.id}/log`, { staff: 'admin1' });
  assert.equal(log.json.log.outcome, 'verification_failed');
});

test('dial-in matrix: Meera rejected scholarship reason is voiced after re-verified entry', async () => {
  const { last, ev } = await dialIn({ caller: '+91 90051 20008', ps: '50055566', name: 'Meera Nair', dob: '27031975' });
  assert.equal(last.json.session.verification.verified, true);
  await ev(keys('1'));
  const st = await ev(text('yes')); // selection confirm -> rejection answer
  const all = repliesOf(st);
  assert.ok(all.includes('not approved'));
  assert.ok(all.includes('marks are below the minimum'), 'scholarship reason voiced');
  await ev(hangup(true));
});

test('dial-in matrix: spoken DOB (12 April 1968 style) also verifies', async () => {
  const r = await t.call('POST', '/api/calls', { caller_number: '+91 90051 20001' }, { staff: 'admin1' });
  const sid = r.json.session.id;
  const ev = async (e) => t.call('POST', `/api/calls/${sid}/events`, e, { staff: 'admin1' });
  await ev(text('I am the employee'));
  await ev(keys('20012345'));
  await ev(text('yes'));
  await ev(text('Ramesh Kumar Sharma'));
  const res = await ev(text('12 April 1968'));
  assert.equal(res.json.session.verification.verified, true, 'spoken English DOB parsed and verified');
  await ev(hangup(true));
});
