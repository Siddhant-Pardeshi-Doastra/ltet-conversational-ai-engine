// Live-mode gating tests — runs in its own process with LTET_MODE=live set
// BEFORE any server import (config is read at import time).
process.env.LTET_MODE = 'live';
process.env.LTET_DB_FILE = (await import('node:path')).join((await import('node:os')).tmpdir(), `ltet-live-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
process.env.SESSION_SECRET = 'live-test-secret-not-production';

import test from 'node:test';
import assert from 'node:assert/strict';

const { createApp } = await import('../server/app.js');
const { getDb, get } = await import('../server/db.js');
const { seedDefaultPolicy } = await import('../server/services/policy.js');
const { createStaffUser, staffCount } = await import('../server/auth/sessions.js');

getDb();
seedDefaultPolicy();
// a minimal live-mode staff identity (no synthetic portal data is seeded in live)
createStaffUser({ id: 'USR-LIVE-ADMIN', username: 'admin1', displayName: 'Live Admin', role: 'admin', password: 'Demo#Pass1' });

const app = createApp();
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;

async function call(method, path, { body, staff = 'admin1' } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (staff) {
    const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin1', password: 'Demo#Pass1' }) });
    const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
    if (cookie) headers.cookie = cookie;
  }
  const res = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

test.after(async () => new Promise((r) => server.close(r)));

test('live mode: demo reset/faults/inbox/role-switch are hard-blocked', async () => {
  assert.equal((await call('POST', '/api/demo/reset', { body: {} })).status, 403);
  assert.equal((await call('POST', '/api/demo/faults', { body: { name: 'portal_outage', on: true } })).status, 403);
  assert.equal((await call('GET', '/api/demo/inbox')).status, 403);
  assert.equal((await call('POST', '/api/auth/switch-role', { body: { role: 'admin' } })).status, 403);
});

test('live mode: readiness FAILS with missing integration config (no silent synthetic fallback)', async () => {
  const r = await call('GET', '/api/readiness');
  assert.equal(r.json.mode, 'live');
  assert.equal(r.json.ready, false);
  assert.ok(r.json.blocking.length >= 3, `blockers listed (${r.json.blocking.join('; ')})`);
});

test('live mode: unlinked employee verification fails closed without an OTP provider', async () => {
  const r = await call('POST', '/api/calls', { body: { caller_number: '+91 91234 00011' } });
  assert.equal(r.status, 201);
  const sid = r.json.session.id;
  await call('POST', `/api/calls/${sid}/events`, { body: { type: 'utterance', text: 'I am the employee' } });
  await call('POST', `/api/calls/${sid}/events`, { body: { type: 'keypad', digits: '001234' } });
  const c = await call('POST', `/api/calls/${sid}/events`, { body: { type: 'utterance', text: 'yes' } });
  // no portal rows exist in live mode and no OTP provider is configured:
  // the session must NEVER reach a challenge or an authenticated state.
  assert.notEqual(c.json.session.state, 'challenge_pending');
  assert.equal(c.json.session.verification?.verified, false);
  await call('POST', `/api/calls/${sid}/events`, { body: { type: 'hangup' } });
  const { get } = await import('../server/db.js');
  assert.equal(get(`SELECT COUNT(*) AS c FROM mock_otp_inbox`).c, 0, 'no mock inbox rows in live mode');
});

test('live mode: identity lookup returns none for unknown numbers (no portal rows exist)', async () => {
  const r = await call('POST', '/api/calls', { body: { caller_number: '+91 55555 50001' } });
  assert.equal(r.json.session.caller_number_type, 'unlinked');
  await call('POST', `/api/calls/${r.json.session.id}/events`, { body: { type: 'hangup' } });
});
