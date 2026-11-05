// Durable post-call worker (FR-28/FR-27/FR-32/FR-33/FR-35, NFR-06).
//
// Call end persists an outbox job; a worker (survives restart, never an
// in-memory timer alone) finalises: one immutable call log -> claim-level
// document-history entries -> structured English summary -> processor alerts ->
// analytics samples. Every step is idempotent (unique constraints + step
// tracking) so duplicate hang-up webhooks and retried jobs cannot duplicate
// history or alerts. A worker crash halfway through recovers without losing
// the call.
import { run, get, all, getDb } from '../db.js';
import { nowIso, callLogId, maskPsNo, toIst } from '../util.js';
import { getPublishedPolicy } from './policy.js';
import { raiseAlert } from './alerts.js';
import { audit } from './audit.js';

const LATENCY_SAMPLES = new Map(); // sessionId -> [ms, ...] (simulator-labelled)

export function noteLatency(sessionId, ms) {
  if (!LATENCY_SAMPLES.has(sessionId)) LATENCY_SAMPLES.set(sessionId, []);
  LATENCY_SAMPLES.get(sessionId).push(ms);
}

export function enqueueJob({ type, idempotencyKey, payload, maxAttempts = 5, runAfter = null }) {
  const res = run(
    `INSERT OR IGNORE INTO jobs(type, idempotency_key, payload, status, attempts, max_attempts, run_after, created_at, updated_at)
     VALUES (?,?,?,?,0,?,?,?,?)`,
    type, idempotencyKey, JSON.stringify(payload), 'queued', maxAttempts, runAfter || nowIso(), nowIso(), nowIso()
  );
  return { created: res.changes === 1, idempotencyKey };
}

/** Startup recovery: jobs stuck in 'running' (crash) are re-queued. */
export function recoverStaleJobs(staleMs = 60000) {
  const cutoff = new Date(Date.now() - staleMs).toISOString();
  const res = run(
    `UPDATE jobs SET status = 'queued', updated_at = ?, last_error = COALESCE(last_error, 'recovered from stale run') WHERE status = 'running' AND (heartbeat_at IS NULL OR heartbeat_at < ?)`,
    nowIso(), cutoff
  );
  return res.changes;
}

function claimNextJob() {
  const candidate = get(
    `SELECT id FROM jobs WHERE status = 'queued' AND run_after <= ? ORDER BY id LIMIT 1`,
    nowIso()
  );
  if (!candidate) return null;
  const claimed = run(
    `UPDATE jobs SET status = 'running', heartbeat_at = ?, attempts = attempts + 1, updated_at = ? WHERE id = ? AND status = 'queued'`,
    nowIso(), nowIso(), candidate.id
  );
  if (claimed.changes !== 1) return null;
  return get(`SELECT * FROM jobs WHERE id = ?`, candidate.id);
}

function completeJob(job, steps) {
  run(`UPDATE jobs SET status = 'done', steps_done = ?, updated_at = ?, last_error = NULL WHERE id = ?`,
    JSON.stringify(steps), nowIso(), job.id);
}

function failJob(job, error) {
  const attempts = job.attempts; // already incremented on claim
  if (attempts >= job.max_attempts) {
    run(`UPDATE jobs SET status = 'dead', last_error = ?, updated_at = ? WHERE id = ?`, String(error).slice(0, 500), nowIso(), job.id);
    audit({ actorType: 'system', actorId: 'worker', action: 'job.dead', objectType: 'job', objectId: String(job.id), detail: { type: job.type, error: String(error).slice(0, 200) } });
  } else {
    const backoffMs = Math.min(5 * 2 ** attempts, 5 * 60 * 1000);
    run(`UPDATE jobs SET status = 'queued', run_after = ?, last_error = ?, updated_at = ? WHERE id = ?`,
      new Date(Date.now() + backoffMs).toISOString(), String(error).slice(0, 500), nowIso(), job.id);
  }
}

export function tick({ max = 10 } = {}) {
  let processed = 0;
  for (let i = 0; i < max; i++) {
    const job = claimNextJob();
    if (!job) break;
    try {
      const steps = JSON.parse(job.steps_done || '[]');
      if (job.type === 'finalize_call') {
        runFinalizeCall(JSON.parse(job.payload), steps, job);
      } else {
        throw new Error(`unknown job type ${job.type}`);
      }
      completeJob(job, steps);
      processed += 1;
    } catch (e) {
      failJob(job, e.message || e);
      processed += 1;
    }
  }
  return processed;
}

let workerTimer = null;
export function startWorker(intervalMs = 2000) {
  if (workerTimer) return;
  workerTimer = setInterval(() => {
    try { tick(); } catch { /* logged by failJob */ }
  }, intervalMs);
  workerTimer.unref?.();
}
export function stopWorker() {
  if (workerTimer) { clearInterval(workerTimer); workerTimer = null; }
}

// ---------------------------------------------------------------------------
// finalize_call
// ---------------------------------------------------------------------------
function runFinalizeCall({ sessionId }, steps, job) {
  const session = get(`SELECT * FROM call_sessions WHERE id = ?`, sessionId);
  if (!session) throw new Error(`session ${sessionId} missing`);

  // Step 1: one immutable call log per call (FR-32, FR-34).
  if (!steps.includes('log')) {
    const existing = get(`SELECT id FROM call_logs WHERE session_id = ?`, sessionId);
    if (!existing) {
      const summary = buildSummary(session);
      run(
        `INSERT OR IGNORE INTO call_logs(id, session_id, created_at, locked_at, outcome, outcome_detail, language,
           started_at, ended_at, duration_ms, caller_type, claimed_ps_no, verified_ps_no, verification_method,
           verification_assurance, mode, transport, scenario, summary, sentiment_estimate, issue_flags, follow_up,
           claims_discussed, facts_given, delayed_flag)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        callLogId(), sessionId, nowIso(), nowIso(), // locked at birth
        session.outcome || 'resolved', session.outcome_detail || null, session.language || 'en',
        session.started_at, session.ended_at || nowIso(),
        (new Date(session.ended_at || nowIso()).getTime() - new Date(session.started_at).getTime()),
        session.caller_type || 'unknown', session.claimed_ps_no || null, session.verified_ps_no || null,
        session.verification_method || null, session.verification_assurance || null,
        session.mode, session.transport, session.scenario || null,
        JSON.stringify(summary.summary), summary.sentiment_estimate, JSON.stringify(summary.issue_flags),
        JSON.stringify(summary.follow_up), JSON.stringify(summary.claims), JSON.stringify(summary.facts_given),
        summary.delayed_flag ? 1 : 0
      );
    }
    steps.push('log');
  }

  // Step 2: claim-linked document-history (FR-33) — call history, not uploads.
  // SEC-06: an unverified caller's session can never attach history to a victim's claim.
  if (!steps.includes('history')) {
    const log = get(`SELECT * FROM call_logs WHERE session_id = ?`, sessionId);
    const entries = all(
      `SELECT e.*, c.ps_no FROM call_claim_entries e JOIN portal_claims c ON c.id = e.claim_id WHERE e.session_id = ?`,
      sessionId
    );
    for (const e of entries) {
      if (!session.verified_ps_no || e.ps_no !== session.verified_ps_no) continue;
      const topics = JSON.parse(e.topics || '[]');
      const text = `AI call ${log.id} (${toIst(log.started_at)}): discussed claim ${e.claim_id}; topics [${topics.join(', ') || 'status'}] with verified ${session.caller_type === 'beneficiary' ? 'listed beneficiary' : 'employee'} (PS ${maskPsNo(session.verified_ps_no)}). Language: ${log.language}.`;
      run(
        `INSERT OR IGNORE INTO claim_document_history(claim_id, call_id, at, entry_type, text, created_by)
         VALUES (?,?,?, 'call_communication', ?, 'AI Engine')`,
        e.claim_id, log.id, nowIso(), text
      );
    }
    steps.push('history');
  }

  // Step 3: derived alerts for failed/held/delayed payments discussed on this call
  // (defensive: alerts are normally raised in-call; dedupe keeps this safe).
  if (!steps.includes('alerts')) {
    const log = get(`SELECT * FROM call_logs WHERE session_id = ?`, sessionId);
    if (log) {
      const facts = JSON.parse(log.facts_given || '[]');
      for (const f of facts) {
        if (f.payment_group === 'failed') raiseAlert({ type: 'payment_failed', claimId: f.claim_id, stage: 'PMS Processor', sessionId, detail: { source: 'post-call', reason: f.reason } });
        if (f.payment_group === 'held') raiseAlert({ type: 'payment_held', claimId: f.claim_id, stage: 'PMS Processor', sessionId, detail: { source: 'post-call', reason: f.reason } });
        if (f.delayed) raiseAlert({ type: 'payment_delayed', claimId: f.claim_id, stage: 'Approval', sessionId, detail: { source: 'post-call' } });
      }
      if (log.outcome === 'verification_failed') {
        raiseAlert({ type: 'verification_failed', claimId: null, stage: 'PMS Processor', sessionId, severity: 'low', detail: { claimed_masked: log.claimed_ps_no ? maskPsNo(log.claimed_ps_no) : null } });
      }
    }
    steps.push('alerts');
  }

  // Step 4: latency + analytics samples (NFR-02/NFR-11, simulator-labelled).
  if (!steps.includes('latency')) {
    const samples = LATENCY_SAMPLES.get(sessionId) || [];
    if (samples.length) {
      const sorted = [...samples].sort((a, b) => a - b);
      const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
      run(`INSERT OR IGNORE INTO call_latency(session_id, answer_start_ms, measured_via) VALUES (?,?, 'simulator')`, sessionId, p95);
      LATENCY_SAMPLES.delete(sessionId);
    }
    steps.push('latency');
  }
}

// ---------------------------------------------------------------------------
// Structured English summary (FR-27)
// ---------------------------------------------------------------------------
const NEGATIVE_WORDS = ['frustrated', 'angry', 'gussa', 'परेशान', 'गुस्सा', 'upset', 'worst', 'terrible', 'बहुत खराब', 'galat', 'गलत'];
const POSITIVE_WORDS = ['thank', 'thanks', 'धन्यवाद', 'shukriya', 'good', 'helpful', 'badhiya', 'accha', 'अच्छा'];

export function buildSummary(session) {
  const segments = all(`SELECT * FROM transcript_segments WHERE session_id = ? ORDER BY id`, session.id);
  const claimEntries = all(`SELECT * FROM call_claim_entries WHERE session_id = ?`, session.id);
  const evidence = all(`SELECT * FROM answer_evidence WHERE session_id = ?`, session.id);
  const alerts = all(`SELECT * FROM alerts WHERE session_id = ?`, session.id);
  const callback = get(`SELECT id, status FROM callback_requests WHERE session_id = ?`, session.id);
  const policy = getPublishedPolicy();

  const issueFlags = [];
  const followUp = [];
  if (session.outcome === 'verification_failed') issueFlags.push('verification_failed');
  if (session.recognition_failures >= 2) issueFlags.push('recognition_failures');
  if (session.caller_number_type === 'hidden') issueFlags.push('hidden_number');
  if (session.verification_method) issueFlags.push('verified');
  for (const a of alerts) issueFlags.push(`alert:${a.type}`);

  const factsGiven = [];
  for (const ce of claimEntries) {
    const evs = evidence.filter((e) => e.claim_id === ce.claim_id);
    const fact = { claim_id: ce.claim_id, topics: JSON.parse(ce.topics || '[]') };
    for (const ev of evs) {
      let snap = null;
      try { snap = JSON.parse(ev.snapshot); } catch { snap = null; }
      if (!snap) continue;
      if (ev.fact_key === 'claim.stage') fact.stage = snap.stage;
      if (ev.fact_key === 'claim.query') fact.open_query = true;
      if (ev.fact_key === 'finance.payment') {
        fact.payment_group = policy.payment_status_mapping[snap.payment_status_raw] ?? 'unreadable';
        if (fact.payment_group === 'credited') {
          fact.amount_minor = snap.amount_minor ?? null;
          fact.credit_date = snap.credit_date ?? null;
          fact.bank_reference = snap.bank_reference ?? null;
        }
        if (fact.payment_group === 'failed') fact.reason = snap.failure_reason ?? null;
        if (fact.payment_group === 'held') fact.reason = snap.held_reason ?? null;
      }
      if (ev.fact_key === 'finance.delayed') fact.delayed = true;
    }
    factsGiven.push(fact);
  }

  const delayedFlag = factsGiven.some((f) => f.delayed);
  if (delayedFlag) followUp.push('delayed payment flagged to processor');
  if (callback && callback.status === 'open') followUp.push(`callback request ${callback.id} open`);
  if (session.outcome === 'verification_failed') followUp.push('caller not verified; no claim history attached');

  const callerText = segments.filter((s) => s.speaker === 'caller').map((s) => s.text).join(' ').toLowerCase();
  const sentiment = NEGATIVE_WORDS.some((w) => callerText.includes(w)) ? 'negative (estimate)'
    : POSITIVE_WORDS.some((w) => callerText.includes(w)) ? 'positive (estimate)' : 'neutral (estimate)';

  const intent = factsGiven.some((f) => f.topics.some((tp) => tp.startsWith('pay_'))) ? 'payment_information'
    : factsGiven.length ? 'claim_status' : 'other';

  const summary = {
    generated_at: nowIso(),
    verified_ps_no_masked: session.verified_ps_no ? maskPsNo(session.verified_ps_no) : null,
    claimed_ps_no_masked: session.claimed_ps_no ? maskPsNo(session.claimed_ps_no) : null,
    claimed_vs_verified_note: session.verified_ps_no
      ? 'claimed and verified identity match'
      : 'identity NOT verified; no verified identity asserted',
    caller_type: session.caller_type || 'unknown',
    language: session.language || 'en',
    intent,
    claims: factsGiven.map((f) => ({ claim_id: f.claim_id, topics: f.topics })),
    facts_given: factsGiven,
    delay_flag: delayedFlag,
    outcome: session.outcome || 'pending',
    outcome_detail: session.outcome_detail || null,
    sentiment_estimate: sentiment,
    issue_flags: [...new Set(issueFlags)],
    follow_up: followUp,
    transport: session.transport,
    mode: session.mode,
  };
  return { summary, sentiment_estimate: sentiment, issue_flags: summary.issue_flags, follow_up: followUp, claims: summary.claims, facts_given: factsGiven, delayed_flag: delayedFlag };
}

export function queueStats() {
  return {
    queued: get(`SELECT COUNT(*) AS c FROM jobs WHERE status = 'queued'`).c,
    running: get(`SELECT COUNT(*) AS c FROM jobs WHERE status = 'running'`).c,
    done: get(`SELECT COUNT(*) AS c FROM jobs WHERE status = 'done'`).c,
    dead: get(`SELECT COUNT(*) AS c FROM jobs WHERE status = 'dead'`).c,
  };
}

/** Admin replay of a dead job (bounded, audited by caller). */
export function replayDeadJob(jobId) {
  const job = get(`SELECT * FROM jobs WHERE id = ? AND status = 'dead'`, jobId);
  if (!job) return false;
  run(`UPDATE jobs SET status = 'queued', attempts = 0, run_after = ?, updated_at = ? WHERE id = ?`, nowIso(), nowIso(), jobId);
  return true;
}

export function _db() { return getDb(); }
