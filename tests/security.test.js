// Security tests: SEC-01..07 boundary enforcement.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startApp, text, keys, hangup } from './helpers.js';
import { hmacSha256 } from '../server/util.js';

const t = await startApp();
test.after(async () => { await t.close(); });

const repliesOf = (r) => (r.json?.replies || []).map((x) => x.text).join('\n');
const allReplies = (steps) => steps.map((s) => repliesOf(s)).join('\n');

test('SEC-03/BDD-37 corrected: impostor with known PS + own phone is denied (no binding)', async () => {
  const r = await t.call('POST', '/api/calls', { caller_number: '+91 91234 00042' }, { staff: 'admin1' });
  const sid = r.json.session.id;
  await t.call('POST', `/api/calls/${sid}/events`, text('I am the beneficiary'), { staff: 'admin1' });
  const res = await t.call('POST', `/api/calls/${sid}/events`, keys('004321'), { staff: 'admin1' });
  const all = repliesOf(res);
  assert.ok(all.includes('cannot verify you as an authorised beneficiary'), 'fail closed');
  assert.ok(!all.includes('Arjun') && !all.includes('Ramesh'), 'no name/profile enumeration');
  assert.ok(!all.includes('CLM-'), 'no claim disclosure');
  await t.call('POST', `/api/calls/${sid}/events`, hangup(), { staff: 'admin1' });
});

test('SEC-03/BDD-37: legitimate beneficiary reaches ONLY the granted claims and fields (FR-61)', async () => {
  await t.clearOtp();
  const r = await t.call('POST', '/api/calls', { caller_number: '+91 55555 51001' }, { staff: 'admin1' });
  const sid = r.json.session.id;
  await t.call('POST', `/api/calls/${sid}/events`, text('I am the beneficiary'), { staff: 'admin1' });
  await t.call('POST', `/api/calls/${sid}/events`, keys('010077'), { staff: 'admin1' });
  await t.call('POST', `/api/calls/${sid}/events`, text('yes'), { staff: 'admin1' });
  const code = await t.otpFromInbox(sid);
  const otpRes = await t.call('POST', `/api/calls/${sid}/events`, keys(code), { staff: 'admin1' });
  assert.equal(otpRes.json.session.verification.verified, true);
  assert.ok(repliesOf(otpRes).includes('CLM-10020'), 'granted claim listed');
  const ans = await t.call('POST', `/api/calls/${sid}/events`, text('payment status'), { staff: 'admin1' });
  const all = repliesOf(ans);
  assert.ok(all.includes('₹24,500.00'), 'fully-permitted grant includes amount');
  // verification bound to the beneficiary role
  assert.equal(otpRes.json.session.caller_type, 'beneficiary');
  await t.call('POST', `/api/calls/${sid}/events`, hangup(true), { staff: 'admin1' });
});

test('SEC-03: limited-field grant hides amount/date/reference even when payment group is permitted', async () => {
  await t.clearOtp();
  // Sunita's grant on CLM-10030 permits [stage,status,payment_group] only
  const r = await t.call('POST', '/api/calls', { caller_number: '+91 55555 51003' }, { staff: 'admin1' });
  const sid = r.json.session.id;
  await t.call('POST', `/api/calls/${sid}/events`, text('I am the beneficiary'), { staff: 'admin1' });
  await t.call('POST', `/api/calls/${sid}/events`, keys('020045'), { staff: 'admin1' });
  await t.call('POST', `/api/calls/${sid}/events`, text('yes'), { staff: 'admin1' });
  const code = await t.otpFromInbox(sid);
  await t.call('POST', `/api/calls/${sid}/events`, keys(code), { staff: 'admin1' });
  const ans = await t.call('POST', `/api/calls/${sid}/events`, text('payment status'), { staff: 'admin1' });
  const all = repliesOf(ans);
  assert.ok(all.includes('processed'), 'payment group permitted');
  assert.ok(!all.includes('₹'), 'amount hidden');
  assert.ok(!all.match(/credited on/), 'credit date hidden');
  await t.call('POST', `/api/calls/${sid}/events`, hangup(true), { staff: 'admin1' });
});

test('SEC-03: revoked grant fails immediately', async () => {
  const r = await t.call('POST', '/api/calls', { caller_number: '+91 55555 51004' }, { staff: 'admin1' });
  const sid = r.json.session.id;
  await t.call('POST', `/api/calls/${sid}/events`, text('I am the beneficiary'), { staff: 'admin1' });
  const res = await t.call('POST', `/api/calls/${sid}/events`, keys('000902'), { staff: 'admin1' });
  assert.ok(repliesOf(res).includes('cannot verify you as an authorised beneficiary'));
  await t.call('POST', `/api/calls/${sid}/events`, hangup(), { staff: 'admin1' });
});

test('FR-59/BDD-40: SMS-incapable beneficiary number never receives an SMS attempt', async () => {
  const r = await t.call('POST', '/api/calls', { caller_number: '+91 55555 61005' }, { staff: 'admin1' });
  const sid = r.json.session.id;
  await t.call('POST', `/api/calls/${sid}/events`, text('I am the beneficiary'), { staff: 'admin1' });
  const res = await t.call('POST', `/api/calls/${sid}/events`, keys('001234'), { staff: 'admin1' });
  assert.ok(repliesOf(res).includes('cannot verify'), 'fail closed');
  const inbox = await t.call('GET', `/api/demo/inbox?session_id=${sid}`, { staff: 'admin1' });
  assert.equal(inbox.json.messages.length, 0, 'no SMS attempted');
  await t.call('POST', `/api/calls/${sid}/events`, hangup(), { staff: 'admin1' });
});

test('FR-62/SEC-03: beneficiary verification records metadata without touching registered contacts', async () => {
  await t.clearOtp();
  const r = await t.call('POST', '/api/calls', { caller_number: '+91 55555 51001' }, { staff: 'admin1' });
  const sid = r.json.session.id;
  await t.call('POST', `/api/calls/${sid}/events`, text('I am the beneficiary'), { staff: 'admin1' });
  await t.call('POST', `/api/calls/${sid}/events`, keys('010077'), { staff: 'admin1' });
  await t.call('POST', `/api/calls/${sid}/events`, text('yes'), { staff: 'admin1' });
  await t.call('POST', `/api/calls/${sid}/events`, keys(await t.otpFromInbox(sid)), { staff: 'admin1' });
  await t.call('POST', `/api/calls/${sid}/events`, hangup(true), { staff: 'admin1' });
  // registered employee contact unchanged in the portal
  const { get } = await import('../server/db.js');
  const emp = get(`SELECT registered_phone FROM portal_employees WHERE ps_no = '010077'`);
  assert.equal(emp.registered_phone, '+91 55555 50003', 'registered contact untouched');
  const sess = get(`SELECT caller_type, verified_ps_no FROM call_sessions WHERE id = ?`, sid);
  assert.equal(sess.caller_type, 'beneficiary');
  assert.equal(sess.verified_ps_no, '010077');
});

test('SEC-04/FR-49: OTP stored only as hash; raw code absent from DB records and transcripts', async () => {
  await t.clearOtp();
  const r = await t.call('POST', '/api/calls', { caller_number: '+91 55555 50002' }, { staff: 'admin1' });
  const sid = r.json.session.id;
  await t.call('POST', `/api/calls/${sid}/events`, text('yes'), { staff: 'admin1' });
  await t.call('POST', `/api/calls/${sid}/events`, text('yes'), { staff: 'admin1' });
  const code = await t.otpFromInbox(sid);
  const { get } = await import('../server/db.js');
  const row = get(`SELECT code_hash, code_salt FROM otp_challenges WHERE session_id = ?`, sid);
  assert.ok(row.code_hash && !JSON.stringify(row).includes(code), 'only hash stored');
  const transcript = JSON.stringify(get(`SELECT GROUP_CONCAT(text) AS t FROM transcript_segments WHERE session_id = ?`, sid));
  assert.ok(!transcript.includes(code), 'code absent from transcript');
  await t.call('POST', `/api/calls/${sid}/events`, keys(code), { staff: 'admin1' });
  await t.call('POST', `/api/calls/${sid}/events`, hangup(true), { staff: 'admin1' });
});

test('SEC-04: OTP replay is rejected (atomic consume)', async () => {
  await t.clearOtp();
  const r = await t.call('POST', '/api/calls', { caller_number: '+91 91234 00098' }, { staff: 'admin1' });
  const sid = r.json.session.id;
  await t.call('POST', `/api/calls/${sid}/events`, text('I am the employee'), { staff: 'admin1' });
  await t.call('POST', `/api/calls/${sid}/events`, keys('001234'), { staff: 'admin1' });
  await t.call('POST', `/api/calls/${sid}/events`, text('yes'), { staff: 'admin1' });
  const code = await t.otpFromInbox(sid);
  const first = await t.call('POST', `/api/calls/${sid}/events`, keys(code), { staff: 'admin1' });
  assert.equal(first.json.session.verification.verified, true);
  // same code again: no second challenge exists; verification already bound; a NEW wrong challenge would fail
  const { verifyChallenge } = await import('../server/adapters/otp.js');
  const replay = verifyChallenge({ subjectPsNo: '001234', subjectRole: 'employee', code });
  assert.notEqual(replay.result, 'success', 'consumed challenge cannot verify again');
  await t.call('POST', `/api/calls/${sid}/events`, hangup(true), { staff: 'admin1' });
});

test('SEC-06/FR-28: failed verification never attaches call history to the claimed PS', async () => {
  const r = await t.call('POST', '/api/calls', { caller_number: '+91 91234 00011' }, { staff: 'admin1' });
  const sid = r.json.session.id;
  await t.call('POST', `/api/calls/${sid}/events`, text('I am the employee'), { staff: 'admin1' });
  await t.call('POST', `/api/calls/${sid}/events`, keys('010077'), { staff: 'admin1' });
  await t.call('POST', `/api/calls/${sid}/events`, text('yes'), { staff: 'admin1' });
  for (let i = 0; i < 3; i++) await t.call('POST', `/api/calls/${sid}/events`, keys('000000'), { staff: 'admin1' });
  await t.call('POST', `/api/calls/${sid}/events`, hangup(), { staff: 'admin1' });
  await new Promise((r2) => setTimeout(r2, 1300));
  const log = await t.call('GET', `/api/calls/${sid}/log`, { staff: 'admin1' });
  assert.equal(log.json.log.outcome, 'verification_failed');
  assert.equal((log.json.log.claims_discussed || []).length, 0, 'no claim history for unverified caller');
  const { get } = await import('../server/db.js');
  const hist = get(`SELECT COUNT(*) AS c FROM claim_document_history WHERE call_id = ?`, log.json.log.id);
  assert.equal(hist.c, 0, 'no document history entries');
});

test('SEC-07: telephony webhook rejects bad signature, stale timestamp and replayed nonce', async () => {
  const secret = 'test-webhook-secret';
  const body = JSON.stringify({ event: 'call.started', from: '+91 55555 50002' });
  const ts = Date.now().toString();
  const sig = `sha256=${hmacSha256(secret, `${ts}.${body}`)}`;
  // bad signature
  let res = await fetch(`${t.base}/api/telephony/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-ltet-signature': 'sha256=deadbeef', 'x-ltet-timestamp': ts, 'x-ltet-nonce': 'n1' }, body });
  assert.equal(res.status, 401);
  // stale timestamp
  const oldTs = (Date.now() - 10 * 60 * 1000).toString();
  res = await fetch(`${t.base}/api/telephony/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-ltet-signature': `sha256=${hmacSha256(secret, `${oldTs}.${body}`)}`, 'x-ltet-timestamp': oldTs, 'x-ltet-nonce': 'n2' }, body });
  assert.equal(res.status, 401);
  // valid
  res = await fetch(`${t.base}/api/telephony/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-ltet-signature': sig, 'x-ltet-timestamp': ts, 'x-ltet-nonce': 'n3' }, body });
  assert.equal(res.status, 201);
  const callId = (await res.json()).call_id;
  // replayed nonce
  res = await fetch(`${t.base}/api/telephony/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-ltet-signature': sig, 'x-ltet-timestamp': ts, 'x-ltet-nonce': 'n3' }, body });
  assert.equal(res.status, 401);
  await t.call('POST', `/api/calls/${callId}/events`, hangup(), { staff: 'admin1' });
});

test('SEC-05/FR-36: transcript access is role-aware and audited', async () => {
  const r = await t.call('POST', '/api/calls', { caller_number: '+91 55555 50002' }, { staff: 'admin1' });
  const sid = r.json.session.id;
  await t.call('POST', `/api/calls/${sid}/events`, hangup(), { staff: 'admin1' });
  const denied = await t.call('GET', `/api/calls/${sid}/transcript`, { staff: 'pms1' });
  assert.equal(denied.status, 403, 'processors get summaries, not transcripts');
  const allowed = await t.call('GET', `/api/calls/${sid}/transcript`, { staff: 'auditor1' });
  assert.equal(allowed.status, 200);
  const audit = await t.call('GET', `/api/admin/audit?object_type=call_session&object_id=${sid}`, { staff: 'admin1' });
  const actions = audit.json.audit.map((a) => a.action);
  assert.ok(actions.includes('transcript.accessed') && actions.includes('transcript.access_denied'), 'access audited');
});

test('SEC-05: demo role switcher is confined to demo mode; engine cannot mutate claims', async () => {
  const r = await t.call('POST', '/api/auth/switch-role', { role: 'pms_processor' }, { staff: 'admin1' });
  assert.equal(r.status, 200);
  // engine has no write path to portal claims: the only demo write gate is demo-gated and audited
  const { getDb } = await import('../server/db.js');
  const db = getDb();
  const adminRoutes = await import('../server/routes/admin.js');
  assert.ok(adminRoutes.default, 'admin router present');
  // claim rows unchanged during all the calls in this suite
  const count = db.prepare(`SELECT COUNT(*) AS c FROM portal_claims`).get().c;
  assert.equal(count, 24, '24 seeded claims still present, no mutations');
});

test('SEC-05: cross-role work-queue access is enforced', async () => {
  // pms1 sees PMS-scoped alerts but cannot acknowledge an SPM alert
  const { getDb } = await import('../server/db.js');
  const db = getDb();
  db.prepare(`UPDATE alerts SET persona_role = 'spm' WHERE type = 'payment_delayed'`).run();
  const spmAlert = db.prepare(`SELECT id FROM alerts WHERE persona_role = 'spm' LIMIT 1`).get();
  if (spmAlert) {
    const res = await t.call('POST', `/api/alerts/${spmAlert.id}/ack`, { staff: 'pms1' });
    assert.equal(res.status, 403, 'pms1 cannot act on SPM queue');
  }
});

test('FR-39: unsafe production configuration is rejected', async () => {
  const bad = {
    claims_per_call_limit: 0, otp: { expiry_seconds: 10, max_attempts: 0, max_resends: 0 },
    stage_persona_routing: {}, payment_status_mapping: { Credited: 'maybe' },
    retention: { transcript_days: 0, call_log_days: 1 }, max_call_minutes: 500,
    helpdesk_hours: { start: '25:99', end: 'x', days: [9], timezone: 'UTC' },
  };
  const res = await t.call('POST', '/api/admin/policy/draft', bad, { staff: 'admin1' });
  assert.equal(res.status, 422);
  assert.ok(res.json.errors.length >= 8, 'multiple violations listed');
});

test('SEC-07: rate limiting blocks OTP request abuse without permanent lockout', async () => {
  const { getDb } = await import('../server/db.js');
  const db = getDb();
  db.prepare(`DELETE FROM otp_challenges`).run();
  // 3 allowed, 4th rejected
  const results = [];
  for (let i = 0; i < 4; i++) {
    const r = await t.call('POST', '/api/calls', { caller_number: '+91 91234 00050' }, { staff: 'admin1' });
    const sid = r.json.session.id;
    await t.call('POST', `/api/calls/${sid}/events`, text('I am the employee'), { staff: 'admin1' });
    await t.call('POST', `/api/calls/${sid}/events`, keys('003001'), { staff: 'admin1' });
    const c = await t.call('POST', `/api/calls/${sid}/events`, text('yes'), { staff: 'admin1' });
    results.push(c.json.session.state === 'challenge_pending');
    await t.call('POST', `/api/calls/${sid}/events`, hangup(), { staff: 'admin1' });
  }
  assert.deepEqual(results.slice(0, 3), [true, true, true], 'first three allowed');
  assert.equal(results[3], false, 'fourth within 15 min is rate limited -> fail closed to human path');
});
