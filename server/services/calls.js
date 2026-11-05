// Call session lifecycle service: trusted call events -> session -> machine ->
// durable post-call work. Owns transcript persistence (with SEC-04 redaction),
// effect application, and outcome computation.
import { run, get } from '../db.js';
import { callSessionId, nowIso, istWeekdayIndex, istHour, istMinute } from '../util.js';
import { handleEvent, loadCtx } from '../engine/machine.js';
import { getPublishedPolicy } from './policy.js';
import { raiseAlert } from './alerts.js';
import { recordAttempt } from './verification.js';
import { lookupByPhone } from '../adapters/portal.js';
import { isDemoMode } from '../config.js';
import { enqueueJob, noteLatency } from './postcall.js';
import { audit } from './audit.js';

function istWithinHelpdeskHours(policy, atIso = nowIso()) {
  const day = istWeekdayIndex(atIso);
  if (!(policy.helpdesk_hours.days || []).includes(day)) return false;
  const hour = istHour(atIso);
  const [sh, sm] = policy.helpdesk_hours.start.split(':').map(Number);
  const [eh, em] = policy.helpdesk_hours.end.split(':').map(Number);
  const mins = hour * 60 + istMinute(atIso);
  return mins >= sh * 60 + sm && mins < eh * 60 + em;
}

export function activeCallCount() {
  // Concurrency counts only recent non-ended sessions; stale sessions (older
  // than 2x the max call duration with no events) do not hold lines forever.
  const staleBefore = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  return get(`SELECT COUNT(*) AS c FROM call_sessions WHERE state != 'ended' AND started_at > ?`, staleBefore).c;
}

/**
 * Create a call session from a trusted call-started event (simulator or signed
 * telephony webhook). Busy handling (FR-51) is applied here.
 */
export function createCallSession({ callerNumber, transport = 'simulator', scenario = null, forceBusy = false }) {
  const policy = getPublishedPolicy();
  const busy = forceBusy || activeCallCount() >= (policy.busy?.max_concurrent_calls ?? 3);
  const identity = lookupByPhone(callerNumber);
  const id = callSessionId();
  const callerNumberType = !callerNumber ? 'none' : identity.matched ? (identity.channelType === 'sms_capable' ? 'linked' : identity.channelType === 'landline' ? 'unlinked' : 'hidden') : 'unlinked';
  run(
    `INSERT INTO call_sessions(id, ctx, started_at, state, caller_number, caller_number_type, language, mode, transport, scenario)
     VALUES (?, '{}', ?, 'greeting', ?, ?, 'en', ?, ?, ?)`,
    id, nowIso(), callerNumber || null, callerNumberType, isDemoMode() ? 'demo' : 'live', transport, scenario
  );
  const session = get(`SELECT * FROM call_sessions WHERE id = ?`, id);
  const result = dispatch(session, {
    type: 'call.started',
    busy,
    identity: identity.matched ? { matched: true, channelType: identity.channelType, psNo: identity.psNo } : { matched: false, channelType: 'none', psNo: null },
  });
  return { session: get(`SELECT * FROM call_sessions WHERE id = ?`, id), result };
}

/** Redact digit runs in caller speech during verification contexts (SEC-04). */
function redactSensitive(text, state) {
  if (!text) return text;
  if (state === 'challenge_pending') return String(text).replace(/\d{3,}/g, '••••••');
  return text;
}

/**
 * Dispatch an event through the machine and apply effects.
 * Only trusted internal callers (routes + webhooks) may invoke this.
 */
export function dispatch(sessionRow, event) {
  const policy = getPublishedPolicy();
  const t0 = Date.now();
  const result = handleEvent(sessionRow, event, { policy });
  noteLatency(sessionRow.id, Date.now() - t0); // NFR-02 (simulator-labelled)
  const { replies, state, ctx, patch, effects } = result;

  // Persist session patch + ctx
  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(patch)) {
    sets.push(`${k} = ?`);
    vals.push(typeof v === 'boolean' ? (v ? 1 : 0) : v);
  }
  sets.push(`state = ?`); vals.push(state);
  sets.push(`ctx = ?`); vals.push(JSON.stringify(ctx));
  sets.push(`turn_count = ?`); vals.push((sessionRow.turn_count || 0) + (event.type === 'utterance' ? 1 : 0));
  if (event.type === 'utterance') {
    const unclear = parseUnclear(event.text);
    sets.push(`recognition_failures = ?`);
    vals.push(unclear ? (sessionRow.recognition_failures || 0) + 1 : 0);
  }
  run(`UPDATE call_sessions SET ${sets.join(', ')} WHERE id = ?`, ...vals, sessionRow.id);

  // Persist transcript segments
  if (event.type === 'utterance') {
    run(
      `INSERT INTO transcript_segments(session_id, at, speaker, text, language, protected, retention_class)
       VALUES (?,?,?,?,?,0,'standard')`,
      sessionRow.id, nowIso(), 'caller', redactSensitive(event.text, state), event.lang || sessionRow.language || 'en'
    );
  }
  if (event.type === 'keypad' && state !== 'challenge_pending') {
    // Protected keypad for OTP is NEVER stored (SEC-04). Other keypad entries
    // (PS number, claim selection) are stored as keypad markers.
    run(
      `INSERT INTO transcript_segments(session_id, at, speaker, text, language, protected, retention_class)
       VALUES (?,?,?,?,?,1,'standard')`,
      sessionRow.id, nowIso(), 'caller_keypad', `[keypad] ${String(event.digits || '').replace(/\d/g, (d, i) => d)}`, sessionRow.language || 'en'
    );
  } else if (event.type === 'keypad') {
    run(
      `INSERT INTO transcript_segments(session_id, at, speaker, text, language, protected, retention_class)
       VALUES (?,?,?,?,?,1,'standard')`,
      sessionRow.id, nowIso(), 'caller_keypad', '[protected keypad] code entered (content never stored)', sessionRow.language || 'en'
    );
  }
  for (const r of replies) {
    run(
      `INSERT INTO transcript_segments(session_id, at, speaker, text, language, protected, retention_class)
       VALUES (?,?,?,?,?,0,'standard')`,
      sessionRow.id, nowIso(), 'system', r.text, r.lang || 'en'
    );
  }

  // Persist call event
  const evtPayload = { ...event };
  delete evtPayload.text; // raw caller speech lives in transcript_segments only
  run(`INSERT INTO call_events(session_id, at, type, payload) VALUES (?,?,?,?)`,
    sessionRow.id, nowIso(), event.type, JSON.stringify(safePayload(evtPayload)));

  // Apply effects
  const applied = [];
  for (const eff of effects || []) {
    applied.push(applyEffect(sessionRow.id, eff, ctx, policy));
  }

  // claim count
  if (ctx.discussed?.length) {
    run(`UPDATE call_sessions SET claims_discussed = ? WHERE id = ?`, ctx.discussed.length, sessionRow.id);
  }

  const fresh = get(`SELECT * FROM call_sessions WHERE id = ?`, sessionRow.id);
  return { replies, state, ctx, patch, effects: applied, session: fresh };
}

function parseUnclear(text) {
  // mirrors engine/intents actionability minimally for failure counting
  return !String(text || '').trim() ? true : false;
}

function safePayload(p) {
  const clone = { ...p };
  // never persist verification codes or full phone numbers in event payloads
  if (clone.identity?.psNo) clone.identity.psNo = `${String(clone.identity.psNo).slice(0, 2)}••••`;
  return clone;
}

function applyEffect(sessionId, eff, ctx, policy) {
  switch (eff.type) {
    case 'finalize': {
      enqueueJob({
        type: 'finalize_call',
        idempotencyKey: `finalize:${sessionId}`,
        payload: { sessionId },
      });
      // outcome precedence (FR-28): verification_failed > escalated > abandoned/resolved
      const session = get(`SELECT * FROM call_sessions WHERE id = ?`, sessionId);
      const outcome = session.outcome
        || (ctx.outcomeHint === 'verification_failed' ? 'verification_failed'
          : ctx.transferRequested || ctx.transferOutcome === 'connected' ? 'escalated'
            : 'resolved');
      run(`UPDATE call_sessions SET outcome = COALESCE(outcome, ?) WHERE id = ?`, outcome, sessionId);
      return { type: 'finalize', outcome };
    }
    case 'transfer': {
      // Simulated warm transfer (IR-01). Connected during helpdesk hours; after
      // hours the engine offers hours + callback (FR-53/BDD-34).
      const connected = istWithinHelpdeskHours(policy);
      setTimeout(() => {
        const s = get(`SELECT * FROM call_sessions WHERE id = ? AND state != 'ended'`, sessionId);
        if (s) dispatch(s, { type: 'transfer.result', connected });
      }, 250);
      return { type: 'transfer', connected };
    }
    case 'callback_create': {
      const session = get(`SELECT * FROM call_sessions WHERE id = ?`, sessionId);
      const id = `CB-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
      run(
        `INSERT OR IGNORE INTO callback_requests(id, session_id, ps_no, verified, callback_number, language, preferred_window, reason, status, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?, 'open', ?, ?)`,
        id, sessionId, ctx.verification?.subjectPsNo || ctx.claimedPsNo || null,
        ctx.verification ? 1 : 0, session.caller_number || 'withheld', session.language || 'en',
        'next helpdesk hours', 'requested during call', nowIso(), nowIso()
      );
      run(`UPDATE call_sessions SET ctx = ? WHERE id = ?`, JSON.stringify({ ...ctx, callbackId: id }), sessionId);
      return { type: 'callback_created', callbackId: id };
    }
    case 'alert': {
      const r = raiseAlert({ type: eff.alertType, claimId: eff.claimId, stage: eff.stage, sessionId, detail: eff.detail || {} });
      return { type: 'alert', ...r };
    }
    case 'claim_discussed': {
      run(
        `INSERT OR IGNORE INTO call_claim_entries(session_id, claim_id, first_discussed_at, topics) VALUES (?,?,?,?)`,
        sessionId, eff.claimId, nowIso(), JSON.stringify(eff.topics || [])
      );
      run(`UPDATE call_claim_entries SET topics = ? WHERE session_id = ? AND claim_id = ?`,
        JSON.stringify([...new Set([...(eff.topics || [])])]), sessionId, eff.claimId);
      // Engine-owned operational record only; NEVER a claim mutation.
      return { type: 'claim_discussed', claimId: eff.claimId };
    }
    case 'evidence': {
      run(
        `INSERT INTO answer_evidence(session_id, claim_id, at, fact_key, source_ref, source_version, retrieved_at, snapshot)
         VALUES (?,?,?,?,?,?,?,?)`,
        sessionId, eff.evidence.claim_id, eff.evidence.at, eff.evidence.fact_key, eff.evidence.source_ref,
        eff.evidence.source_version, eff.evidence.retrieved_at, eff.evidence.snapshot
      );
      return { type: 'evidence', factKey: eff.evidence.fact_key };
    }
    case 'verification_attempt': {
      recordAttempt({
        sessionId, method: 'otp',
        subjectKind: eff.subjectRole, subjectPsNo: eff.subjectPsNo,
        result: eff.result === 'success' ? 'success' : eff.result === 'locked' ? 'locked' : 'failed',
        attemptsUsed: eff.attemptsUsed,
      });
      if (eff.result === 'success') {
        run(
          `UPDATE call_sessions SET verified_ps_no = ?, verification_method = 'otp', verification_assurance = 'otp_registered_channel', verified_at = ?
           WHERE id = ?`,
          eff.subjectPsNo, nowIso(), sessionId
        );
      }
      return { type: 'verification_attempt', result: eff.result };
    }
    case 'otp_sent':
    case 'anomaly':
    case 'escalation_offer':
      return { type: eff.type };
    default:
      return { type: 'unknown', eff };
  }
}

/** Unexpected caller hang-up ends the session (FR-52). */
export function hangup(sessionId, { expected = false } = {}) {
  const session = get(`SELECT * FROM call_sessions WHERE id = ?`, sessionId);
  if (!session || session.state === 'ended') return null;
  const result = dispatch(session, { type: 'hangup', expected });
  const talkMs = Date.now() - new Date(session.started_at).getTime();
  run(`UPDATE call_sessions SET talk_time_ms = ? WHERE id = ?`, talkMs, sessionId);
  return result;
}

export function getSession(id) {
  return get(`SELECT * FROM call_sessions WHERE id = ?`, id);
}
