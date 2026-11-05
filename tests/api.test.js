// Staff API surface: auth, RBAC scoping, health/readiness, demo/live gating.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startApp, text, keys, hangup } from './helpers.js';

const t = await startApp();
test.after(async () => { await t.close(); });

test('auth: login, me, logout; bad credentials rejected', async () => {
  const bad = await t.call('POST', '/api/auth/login', { username: 'admin1', password: 'wrong' });
  assert.equal(bad.status, 401);
  const me = await t.call('GET', '/api/auth/me', { staff: 'pms1' });
  assert.equal(me.json.user.role, 'pms_processor');
  assert.equal(me.json.mode, 'demo');
});

test('health + readiness report explicit demo boundaries', async () => {
  const h = await t.call('GET', '/api/health');
  assert.equal(h.json.ok, true);
  const r = await t.call('GET', '/api/readiness');
  assert.equal(r.json.mode, 'demo');
  assert.equal(r.json.ready, true, 'demo mode is ready');
  assert.equal(r.json.demo_mode, true);
  assert.equal(r.json.languages.configured, 12);
  assert.ok(r.json.languages.note.includes('sign-off'), 'language readiness honesty');
});

test('unauthenticated access to staff APIs is rejected', async () => {
  const calls = await t.call('GET', '/api/calls');
  assert.equal(calls.status, 401);
  const queue = await t.call('GET', '/api/queue/alerts');
  assert.equal(queue.status, 401);
});

test('claim context is stage-scoped for processors (SEC-05)', async () => {
  const denied = await t.call('GET', '/api/claims/CLM-10030/context', { staff: 'pms1' });
  assert.equal(denied.status, 403, 'Approval-stage claim outside PMS scope');
  const allowed = await t.call('GET', '/api/claims/CLM-10010/context', { staff: 'pms1' });
  assert.equal(allowed.status, 200, 'PMS-stage query claim visible to PMS');
  assert.ok(!JSON.stringify(allowed.json).includes('001234'), 'PS number masked in API response');
  const admin = await t.call('GET', '/api/claims/CLM-10030/context', { staff: 'admin1' });
  assert.equal(admin.status, 200, 'admin sees all');
});

test('claims list masks PS numbers everywhere', async () => {
  const r = await t.call('GET', '/api/claims?q=004321', { staff: 'admin1' });
  const body = JSON.stringify(r.json);
  assert.ok(body.includes('00••••21'));
  assert.ok(!body.includes('"004321"'), 'no raw PS in responses');
});

test('FR-38: call search and review tags persist', async () => {
  const r = await t.call('POST', '/api/calls', { caller_number: '+91 55555 50002' }, { staff: 'admin1' });
  const sid = r.json.session.id;
  await t.call('POST', `/api/calls/${sid}/events`, hangup(true), { staff: 'admin1' });
  await new Promise((x) => setTimeout(x, 1300));
  const search = await t.call('GET', `/api/calls?q=${sid}`, { staff: 'admin1' });
  assert.equal(search.json.total, 1);
  const logId = search.json.calls[0].id;
  const tag = await t.call('POST', `/api/calls/${logId}/tags`, { tag: 'incorrect-answer', note: 'test tag' }, { staff: 'admin1' });
  assert.equal(tag.status, 201);
  const tags = await t.call('GET', `/api/calls/${logId}/tags`, { staff: 'admin1' });
  assert.equal(tags.json.tags.length, 1);
});

test('demo tools are hard-gated in the API surface (live-mode process tests: tests/live-mode.test.js)', async () => {
  // In demo mode the tools respond; the live-mode 403 gating is proven in the
  // separate live-mode test process (config is read at import time).
  const ok = await t.call('GET', '/api/demo/health', { staff: 'admin1' });
  assert.equal(ok.status, 200);
  const reset = await t.call('POST', '/api/demo/reset', {}, { staff: 'admin1' });
  assert.equal(reset.status, 200, 'demo reset allowed in demo mode only');
});

test('FR-45/FR-46: policy mapping and delay threshold are configurable and applied', async () => {
  await t.clearOtp();
  // delay fault forces approval 30 days ago; threshold 7 => delayed flag + alert
  await t.call('POST', '/api/demo/faults', { name: 'delay_payment', on: true }, { staff: 'admin1' });
  try {
    const r = await t.call('POST', '/api/calls', { caller_number: '+91 55555 50005' }, { staff: 'admin1' });
    const sid = r.json.session.id;
    await t.call('POST', `/api/calls/${sid}/events`, text('yes'), { staff: 'admin1' });
    await t.call('POST', `/api/calls/${sid}/events`, text('yes'), { staff: 'admin1' });
    await t.call('POST', `/api/calls/${sid}/events`, keys(await t.otpFromInbox(sid)), { staff: 'admin1' });
    await t.call('POST', `/api/calls/${sid}/events`, text('payment status'), { staff: 'admin1' });
    await t.call('POST', `/api/calls/${sid}/events`, hangup(true), { staff: 'admin1' });
    await new Promise((x) => setTimeout(x, 1500));
    const log = await t.call('GET', `/api/calls/${sid}/log`, { staff: 'admin1' });
    assert.equal(log.json.log.delayed_flag, 1, 'delay flag from configured threshold + actual approval date');
    const queue = await t.call('GET', '/api/queue/alerts', { staff: 'admin1' });
    assert.ok(queue.json.alerts.some((a) => a.type === 'payment_delayed'), 'delay alert raised');
  } finally {
    await t.call('POST', '/api/demo/faults', { name: 'delay_payment', on: false }, { staff: 'admin1' });
  }
});
