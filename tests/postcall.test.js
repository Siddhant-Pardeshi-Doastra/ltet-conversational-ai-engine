// Post-call durability: idempotency, crash recovery, exactly-once records.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startApp, text, keys, hangup } from './helpers.js';

const t = await startApp();
test.after(async () => { await t.close(); });

async function resolvedCall() {
  await t.clearOtp();
  const r = await t.call('POST', '/api/calls', { caller_number: '+91 55555 50003' }, { staff: 'admin1' });
  const sid = r.json.session.id;
  await t.call('POST', `/api/calls/${sid}/events`, text('yes'), { staff: 'admin1' });
  await t.call('POST', `/api/calls/${sid}/events`, text('yes'), { staff: 'admin1' });
  await t.call('POST', `/api/calls/${sid}/events`, keys(await t.otpFromInbox(sid)), { staff: 'admin1' });
  await t.call('POST', `/api/calls/${sid}/events`, text('payment status'), { staff: 'admin1' });
  await t.call('POST', `/api/calls/${sid}/events`, text('no'), { staff: 'admin1' });
  await t.call('POST', `/api/calls/${sid}/events`, hangup(true), { staff: 'admin1' });
  return sid;
}

test('BDD-20/FR-32/33/34: one log, deduplicated claim entries, doc history, immutable', async () => {
  const sid = await resolvedCall();
  await new Promise((r) => setTimeout(r, 1600));
  const { get, all } = await import('../server/db.js');
  const logs = all(`SELECT * FROM call_logs WHERE session_id = ?`, sid);
  assert.equal(logs.length, 1, 'exactly one call log');
  const log = logs[0];
  assert.ok(log.locked_at, 'log locked at creation');
  assert.equal(log.outcome, 'resolved');
  const summary = JSON.parse(log.summary);
  assert.equal(summary.verified_ps_no_masked, '01••••77');
  assert.equal(summary.intent, 'payment_information');
  assert.ok(summary.facts_given.some((f) => f.payment_group === 'credited'), 'facts actually given recorded');
  const entries = all(`SELECT * FROM call_claim_entries WHERE session_id = ?`, sid);
  assert.equal(entries.length, 1, 'one deduplicated entry per discussed claim');
  const hist = all(`SELECT * FROM claim_document_history WHERE call_id = ?`, log.id);
  assert.equal(hist.length, 1, 'document history entry created');
  assert.ok(hist[0].text.includes('CLM-10020'), 'history describes the discussion');

  // immutability: UPDATE/DELETE rejected by triggers
  const db = (await import('../server/db.js')).getDb();
  assert.throws(() => db.exec(`UPDATE call_logs SET outcome = 'x' WHERE id = '${log.id}'`), /immutable/, 'update blocked');
  assert.throws(() => db.exec(`DELETE FROM call_logs WHERE id = '${log.id}'`), /retention purge/, 'delete blocked');
});

test('duplicate hang-up webhooks and retried jobs cannot duplicate records (idempotency)', async () => {
  const sid = await resolvedCall();
  await new Promise((r) => setTimeout(r, 1600));
  // replay finalize job multiple times
  const { enqueueJob, tick } = await import('../server/services/postcall.js');
  for (let i = 0; i < 3; i++) enqueueJob({ type: 'finalize_call', idempotencyKey: `finalize:${sid}`, payload: { sessionId: sid } });
  tick({ max: 10 });
  const { all } = await import('../server/db.js');
  assert.equal(all(`SELECT * FROM call_logs WHERE session_id = ?`, sid).length, 1, 'still one log');
  const logId = all(`SELECT id FROM call_logs WHERE session_id = ?`, sid)[0].id;
  const before = all(`SELECT COUNT(*) AS c FROM claim_document_history WHERE call_id = ?`, logId)[0].c;
  tick({ max: 10 });
  const after = all(`SELECT COUNT(*) AS c FROM claim_document_history WHERE call_id = ?`, logId)[0].c;
  assert.equal(before, after, 'history stable across replays');
});

test('worker crash halfway recovers without losing the call', async () => {
  const sid = await resolvedCall();
  await new Promise((r) => setTimeout(r, 1600));
  const { get, all } = await import('../server/db.js');
  const job = get(`SELECT * FROM jobs WHERE idempotency_key = ?`, `finalize:${sid}`);
  assert.equal(job.status, 'done');
  // simulate a crashed run: new finalize job stuck in 'running' with stale heartbeat
  const { run } = await import('../server/db.js');
  run(
    `INSERT INTO jobs(type, idempotency_key, payload, status, attempts, max_attempts, run_after, heartbeat_at, created_at, updated_at, steps_done)
     VALUES ('finalize_call', ?, ?, 'running', 1, 5, ?, ?, ?, ?, '[]')`,
    `finalize:${sid}:crash`, JSON.stringify({ sessionId: sid }), new Date().toISOString(),
    new Date(Date.now() - 10 * 60 * 1000).toISOString(), new Date().toISOString(), new Date().toISOString()
  );
  const { recoverStaleJobs, tick } = await import('../server/services/postcall.js');
  const recovered = recoverStaleJobs(60000);
  assert.ok(recovered >= 1, 'stale running job re-queued');
  tick({ max: 5 });
  const job2 = get(`SELECT * FROM jobs WHERE idempotency_key = ?`, `finalize:${sid}:crash`);
  assert.equal(job2.status, 'done', 'recovered job completes');
  const logs = all(`SELECT * FROM call_logs WHERE session_id = ?`, sid);
  assert.equal(logs.length, 1, 'still exactly one log after recovery');
});

test('alerts deduplicate per call but preserve distinct genuine issues', async () => {
  const { all } = await import('../server/db.js');
  // failed payment call + dispute on a different call => two distinct alerts
  const r1 = await t.call('POST', '/api/calls', { caller_number: '+91 55555 50006' }, { staff: 'admin1' });
  const s1 = r1.json.session.id;
  await t.call('POST', `/api/calls/${s1}/events`, text('yes'), { staff: 'admin1' });
  await t.call('POST', `/api/calls/${s1}/events`, text('yes'), { staff: 'admin1' });
  await t.call('POST', `/api/calls/${s1}/events`, keys(await t.otpFromInbox(s1)), { staff: 'admin1' });
  await t.call('POST', `/api/calls/${s1}/events`, text('payment status'), { staff: 'admin1' });
  await t.call('POST', `/api/calls/${s1}/events`, hangup(true), { staff: 'admin1' });
  await new Promise((r) => setTimeout(r, 1500));
  const failedAlerts = all(`SELECT * FROM alerts WHERE type = 'payment_failed'`);
  assert.ok(failedAlerts.length >= 1);
  assert.equal(new Set(failedAlerts.map((a) => a.session_id)).size, failedAlerts.length, 'no collapse across different calls');
});

test('FR-06 analytics reconcile with stored records', async () => {
  const ov = await t.call('GET', '/api/analytics/overview?days=30', { staff: 'admin1' });
  const { get } = await import('../server/db.js');
  const dbCount = get(`SELECT COUNT(*) AS c FROM call_logs WHERE retention_deleted IS NULL AND created_at >= ?`, new Date(Date.now() - 30 * 86400000).toISOString()).c;
  assert.equal(ov.json.calls_total, dbCount, 'analytics total equals stored logs');
  const sum = Object.values(ov.json.by_outcome).reduce((a, b) => a + b, 0);
  assert.equal(sum, dbCount, 'outcome breakdown sums to total');
});

test('FR-31: daily and weekly reports generate with definitions', async () => {
  const d = await t.call('POST', '/api/analytics/reports/generate', { kind: 'daily' }, { staff: 'admin1' });
  const w = await t.call('POST', '/api/analytics/reports/generate', { kind: 'weekly' }, { staff: 'admin1' });
  assert.equal(d.status, 201);
  assert.equal(w.status, 201);
  const list = await t.call('GET', '/api/analytics/reports', { staff: 'admin1' });
  assert.ok(list.json.reports.some((r) => r.kind === 'daily') && list.json.reports.some((r) => r.kind === 'weekly'));
});

test('FR-34: governed retention purges transcripts with audit; immutability markers stay one-way', async () => {
  const res = await t.call('POST', '/api/admin/retention/run', {}, { staff: 'admin1' });
  assert.equal(res.status, 200);
  const audit = await t.call('GET', '/api/admin/audit?object_type=retention', { staff: 'admin1' });
  assert.ok(audit.json.audit.some((a) => a.action === 'retention.purged'), 'purge audited');
});

test('policy versioning: draft -> approve -> publish -> rollback all persist (FR-37/39)', async () => {
  const current = await t.call('GET', '/api/admin/policy', { staff: 'admin1' });
  const doc = { ...current.json.published, claims_per_call_limit: 4 };
  delete doc._version;
  const draft = await t.call('POST', '/api/admin/policy/draft', doc, { staff: 'admin1' });
  assert.equal(draft.status, 201);
  const v = draft.json.version;
  const ap = await t.call('POST', `/api/admin/policy/${v}/approve`, {}, { staff: 'admin1' });
  assert.equal(ap.status, 200);
  const pub = await t.call('POST', `/api/admin/policy/${v}/publish`, {}, { staff: 'admin1' });
  assert.equal(pub.status, 200);
  const now = await t.call('GET', '/api/admin/policy', { staff: 'admin1' });
  assert.equal(now.json.published.claims_per_call_limit, 4);
  const rb = await t.call('POST', `/api/admin/policy/1/rollback`, {}, { staff: 'admin1' });
  assert.equal(rb.status, 200);
  const after = await t.call('GET', '/api/admin/policy', { staff: 'admin1' });
  assert.equal(after.json.published.claims_per_call_limit, 5, 'rollback restored published v1');
});
