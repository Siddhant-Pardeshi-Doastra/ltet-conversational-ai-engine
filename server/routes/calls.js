// Call + verification routes (simulator & telephony adapter boundary).
import { Router } from 'express';
import { attachSession, requireAuth, canViewTranscripts } from '../auth/sessions.js';
import { createCallSession, dispatch, hangup, getSession, activeCallCount } from '../services/calls.js';
import { getPublishedPolicy } from '../services/policy.js';
import { run, get, all } from '../db.js';
import { nowIso, maskPsNo, maskPhone, toIst } from '../util.js';
import { audit } from '../services/audit.js';
import { isDemoMode } from '../config.js';
import { hasActiveChallenge } from '../adapters/otp.js';
import { tick as tickJobs } from '../services/postcall.js';

const r = Router();
r.use(attachSession, requireAuth);

function sessionView(s, { includeCtx = false } = {}) {
  const policy = getPublishedPolicy();
  return {
    id: s.id,
    state: s.state,
    outcome: s.outcome,
    outcome_detail: s.outcome_detail,
    started_at: s.started_at,
    started_at_ist: toIst(s.started_at),
    ended_at: s.ended_at,
    language: s.language,
    mode: s.mode,
    transport: s.transport,
    scenario: s.scenario,
    caller_number_masked: s.caller_number ? maskPhone(s.caller_number) : null,
    caller_number_type: s.caller_number_type,
    caller_type: s.caller_type,
    claimed_ps_no_masked: s.claimed_ps_no ? maskPsNo(s.claimed_ps_no) : null,
    verified_ps_no_masked: s.verified_ps_no ? maskPsNo(s.verified_ps_no) : null,
    verification: s.verified_ps_no
      ? { verified: true, method: s.verification_method, assurance: s.verification_assurance, at: s.verified_at, subject_masked: maskPsNo(s.verified_ps_no) }
      : { verified: false, challenge_active: hasActiveChallenge(s.claimed_ps_no || '', s.caller_type === 'beneficiary' ? 'beneficiary' : 'employee') },
    talk_time_ms: s.talk_time_ms,
    turn_count: s.turn_count,
    claims_discussed: s.claims_discussed,
    // full PS numbers/phones are NEVER sent to the client (SEC-05)
    ...(includeCtx ? { ctx: safeCtx(s.ctx) } : {}),
  };
}

function safeCtx(ctxJson) {
  try {
    const c = JSON.parse(ctxJson || '{}');
    delete c.grant; // grant details are server-side only
    if (c.identity?.psNo) c.identity.psNo = maskPsNo(c.identity.psNo);
    if (c.claimedPsNo) c.claimedPsNo = maskPsNo(c.claimedPsNo);
    if (c.verification?.subjectPsNo) c.verification.subjectPsNo = maskPsNo(c.verification.subjectPsNo);
    return c;
  } catch { return {}; }
}

/** Start a call (simulator). Trusted caller number comes from the request body. */
r.post('/calls', (req, res) => {
  const { caller_number, force_busy, scenario } = req.body || {};
  const { session, result } = createCallSession({ callerNumber: caller_number || null, scenario: scenario || null, forceBusy: !!force_busy });
  res.status(201).json({
    session: sessionView(session, { includeCtx: true }),
    replies: result.replies,
    state: result.state,
  });
});

/** Trusted call events: utterance, keypad (protected path), hangup. */
r.post('/calls/:id/events', (req, res) => {
  const s = getSession(req.params.id);
  if (!s) return res.status(404).json({ error: 'session_not_found' });
  if (s.state === 'ended') return res.status(409).json({ error: 'session_ended' });
  const { type, text, digits, expected } = req.body || {};
  if (!['utterance', 'keypad', 'hangup'].includes(type)) return res.status(422).json({ error: 'unknown_event_type' });
  if (type === 'utterance' && (typeof text !== 'string' || text.length > 2000)) return res.status(422).json({ error: 'invalid_text' });
  if (type === 'keypad' && !/^[\d*#]{1,20}$/.test(String(digits || ''))) return res.status(422).json({ error: 'invalid_digits' });

  let result;
  if (type === 'hangup') {
    result = hangup(s.id, { expected: !!expected });
  } else {
    result = dispatch(s, { type, text, digits, expected });
  }
  // Small grace tick so post-call work begins promptly after finalization.
  if (type === 'hangup') setImmediate(() => { try { tickJobs({ max: 3 }); } catch { /* worker also ticks */ } });
  res.json({
    session: sessionView(result.session, { includeCtx: true }),
    replies: result.replies,
    state: result.state,
  });
});

/** Session detail: state timeline, transcript, verification status (masked). */
r.get('/calls/:id', (req, res) => {
  const s = getSession(req.params.id);
  if (!s) return res.status(404).json({ error: 'session_not_found' });
  const segments = all(`SELECT id, at, speaker, text, language, protected FROM transcript_segments WHERE session_id = ? ORDER BY id`, s.id)
    .map((x) => ({ ...x, at_ist: toIst(x.at) }));
  const events = all(`SELECT id, at, type, payload FROM call_events WHERE session_id = ? ORDER BY id`, s.id)
    .map((e) => ({ ...e, payload: safeEventPayload(e.payload) }));
  const log = get(`SELECT id, outcome, summary FROM call_logs WHERE session_id = ?`, s.id);
  res.json({
    session: sessionView(s, { includeCtx: true }),
    transcript: segments,
    events,
    log: log ? { id: log.id, outcome: log.outcome, summary: JSON.parse(log.summary || 'null') } : null,
  });
});

function safeEventPayload(payloadJson) {
  try {
    const p = JSON.parse(payloadJson || '{}');
    if (p.identity?.psNo) p.identity.psNo = maskPsNo(p.identity.psNo);
    return p;
  } catch { return {}; }
}

/** Call log (immutable final record). */
r.get('/calls/:id/log', (req, res) => {
  const log = get(`SELECT * FROM call_logs WHERE session_id = ?`, req.params.id);
  if (!log) return res.status(404).json({ error: 'log_not_found' });
  const claimEntries = all(`SELECT * FROM call_claim_entries WHERE session_id = ?`, log.session_id);
  const history = all(`SELECT * FROM claim_document_history WHERE call_id = ? ORDER BY id`, log.id);
  const evidence = all(`SELECT id, claim_id, fact_key, source_ref, source_version, retrieved_at FROM answer_evidence WHERE session_id = ?`, log.session_id);
  res.json({
    log: {
      ...log,
      summary: JSON.parse(log.summary || 'null'),
      issue_flags: JSON.parse(log.issue_flags || '[]'),
      follow_up: JSON.parse(log.follow_up || '[]'),
      claims_discussed: JSON.parse(log.claims_discussed || '[]'),
      facts_given: JSON.parse(log.facts_given || '[]'),
    },
    claim_entries: claimEntries,
    document_history: history,
    answer_evidence: evidence,
  });
});

/** Transcript access is role-aware (FR-36); summaries are the processor default. */
r.get('/calls/:id/transcript', (req, res) => {
  if (!canViewTranscripts(req.staff.user)) {
    audit({ actorType: 'staff', actorId: req.staff.user.id, action: 'transcript.access_denied', objectType: 'call_session', objectId: req.params.id });
    return res.status(403).json({ error: 'transcript_access_not_permitted_for_role', note: 'summaries are the processor default (FR-36)' });
  }
  audit({ actorType: 'staff', actorId: req.staff.user.id, action: 'transcript.accessed', objectType: 'call_session', objectId: req.params.id });
  const segments = all(`SELECT * FROM transcript_segments WHERE session_id = ? ORDER BY id`, req.params.id);
  res.json({ transcript: segments });
});

/** Searchable/filterable call list (FR-38). */
r.get('/calls', (req, res) => {
  const { q, outcome, language, limit = 50, offset = 0 } = req.query;
  const where = [`retention_deleted IS NULL`];
  const vals = [];
  if (outcome) { where.push(`outcome = ?`); vals.push(outcome); }
  if (language) { where.push(`language = ?`); vals.push(language); }
  if (q) {
    where.push(`(id LIKE ? OR session_id LIKE ? OR IFNULL(verified_ps_no,'') LIKE ? OR IFNULL(claimed_ps_no,'') LIKE ? OR summary LIKE ?)`);
    const like = `%${q}%`;
    vals.push(like, like, like, like, like);
  }
  const logs = all(
    `SELECT id, session_id, created_at, outcome, outcome_detail, language, started_at, ended_at, duration_ms,
            caller_type, claimed_ps_no, verified_ps_no, verification_method, mode, transport, scenario, delayed_flag
     FROM call_logs WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    ...vals, Number(limit), Number(offset)
  );
  const total = get(`SELECT COUNT(*) AS c FROM call_logs WHERE ${where.join(' AND ')}`, ...vals).c;
  res.json({
    calls: logs.map((l) => ({
      ...l,
      claimed_ps_no_masked: l.claimed_ps_no ? maskPsNo(l.claimed_ps_no) : null,
      verified_ps_no_masked: l.verified_ps_no ? maskPsNo(l.verified_ps_no) : null,
      claimed_ps_no: undefined, verified_ps_no: undefined,
      created_at_ist: toIst(l.created_at),
    })),
    total,
  });
});

/** Claim-linked document history for a claim (FR-33) — read-only, authorised view. */
r.get('/claims/:id/history', (req, res) => {
  const history = all(`SELECT * FROM claim_document_history WHERE claim_id = ? ORDER BY at DESC`, req.params.id);
  res.json({ history });
});

export default r;
