// Test harness: isolated DB + app instance per test process.
import { randomUUID } from 'node:crypto';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

process.env.LTET_MODE = process.env.LTET_TEST_MODE || 'demo';
process.env.LTET_DB_FILE = join(tmpdir(), `ltet-test-${randomUUID()}.db`);
process.env.SESSION_SECRET = 'test-secret-not-for-production';
process.env.TELEPHONY_WEBHOOK_SECRET = 'test-webhook-secret';

const here = dirname(fileURLToPath(import.meta.url));

export async function startApp() {
  const { createApp } = await import('../server/app.js');
  const { seed } = await import('../server/seed.js');
  const { seedDefaultPolicy } = await import('../server/services/policy.js');
  const { recoverStaleJobs } = await import('../server/services/postcall.js');
  const { getDb } = await import('../server/db.js');
  getDb();
  seed({ force: true });
  seedDefaultPolicy();
  recoverStaleJobs();
  const app = createApp();
  const server = app.listen(0, '127.0.0.1');
  await new Promise((res) => server.once('listening', res));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  const staffCookies = new Map();
  async function loginStaff(username) {
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password: 'Demo#Pass1' }),
    });
    if (!login.ok) return null;
    const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
    staffCookies.set(username, cookie);
    return cookie;
  }
  // Accepted forms: call(M, P, body, {staff}) | call(M, P, {staff}) | call(M, P, body)
  async function call(method, path, bodyOrOpts, opts) {
    let body = bodyOrOpts;
    let staff;
    if (opts && opts.staff) staff = opts.staff;
    else if (bodyOrOpts && typeof bodyOrOpts === 'object' && !Array.isArray(bodyOrOpts)
      && Object.keys(bodyOrOpts).length === 1 && 'staff' in bodyOrOpts) {
      staff = bodyOrOpts.staff;
      body = undefined;
    }
    const headers = { 'content-type': 'application/json' };
    const doFetch = async () => {
      const h = { ...headers };
      if (staff) {
        if (!staffCookies.has(staff)) {
          const cookie = await loginStaff(staff);
          if (!cookie) return { status: 401, json: { error: 'invalid_credentials' } };
        }
        h.cookie = staffCookies.get(staff);
      }
      return fetch(base + path, { method, headers: h, body: body !== undefined && method !== 'GET' ? JSON.stringify(body) : undefined });
    };
    let res = await doFetch();
    // demo reset wipes staff sessions: transparently re-login once on 401
    if (res.status === 401 && staff) {
      staffCookies.delete(staff);
      const cookie = await loginStaff(staff);
      if (cookie) {
        headers.cookie = cookie;
        res = await fetch(base + path, { method, headers, body: body !== undefined && method !== 'GET' ? JSON.stringify(body) : undefined });
      }
    }
    const json = await res.json().catch(() => ({}));
    return { status: res.status, json };
  }

  /** Drive a call with a list of events; returns the last result. */
  async function driveCall({ caller, events, staff = 'admin1' }) {
    const start = await call('POST', '/api/calls', { caller_number: caller }, { staff });
    if (start.status !== 201) throw new Error(`call start failed: ${JSON.stringify(start.json)}`);
    const sid = start.json.session.id;
    const steps = [start];
    for (const ev of events) {
      const r = await call('POST', `/api/calls/${sid}/events`, ev, { staff });
      steps.push(r);
    }
    return { sid, steps, last: steps[steps.length - 1], start: steps[0] };
  }

  async function otpFromInbox(sid) {
    const r = await call('GET', `/api/demo/inbox?session_id=${sid}`, { staff: 'admin1' });
    const msg = r.json.messages?.[0]?.message || '';
    const m = msg.match(/code is (\d{6})/);
    return m ? m[1] : null;
  }

  /** Fresh per-test state: clear prior challenges (rate limit) and end any
   *  sessions leaked by earlier assertions so the concurrency limit applies
   *  only to genuinely concurrent calls within the test itself. */
  async function clearOtp() {
    const { run } = await import('../server/db.js');
    run(`DELETE FROM otp_challenges`);
    run(`UPDATE call_sessions SET state = 'ended', outcome = COALESCE(outcome, 'abandoned'), ended_at = COALESCE(ended_at, ?) WHERE state != 'ended'`, new Date().toISOString());
  }

  async function waitJobs(tickFn, ms = 1500) {
    await new Promise((r) => setTimeout(r, ms));
  }

  return { app, server, port, base, call, driveCall, otpFromInbox, clearOtp, close: () => new Promise((r) => server.close(r)) };
}

export const text = (t) => ({ type: 'utterance', text: t });
export const keys = (d) => ({ type: 'keypad', digits: d });
export const hangup = (expected = false) => ({ type: 'hangup', expected });
