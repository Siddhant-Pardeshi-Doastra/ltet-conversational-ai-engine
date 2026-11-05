// Verification service: wraps the isolated OTP adapter and records
// VerificationAttempt metadata (SEC-02). The backend verifies the code and binds
// the result to this call, identity, method, assurance and expiry. A frontend
// boolean, transcript statement or LLM value can never grant access.
import { run } from '../db.js';
import { nowIso } from '../util.js';
import * as otp from '../adapters/otp.js';
import { audit } from './audit.js';

export function startChallenge({ session, subjectPsNo, subjectRole, target, policy }) {
  return otp.createChallenge({ sessionId: session.id, subjectPsNo, subjectRole, target, policy });
}

export function recordAttempt({ sessionId, method, subjectKind, subjectPsNo, result, attemptsUsed, detail }) {
  run(
    `INSERT INTO verification_attempts(session_id, at, method, subject_kind, subject_ps_no, result, attempts_used, detail)
     VALUES (?,?,?,?,?,?,?,?)`,
    sessionId, nowIso(), method || 'otp', subjectKind || 'employee', subjectPsNo || null, result, attemptsUsed ?? null,
    detail ? JSON.stringify(detail) : null
  );
}

export function recordSuccessBinding(session, { subjectPsNo, subjectRole, assurance }) {
  // Bind verification to THIS call only. Expiry is call-scoped: the binding dies
  // with the session (SEC-02/SEC-06: never carried across calls).
  run(
    `UPDATE call_sessions SET verified_ps_no = ?, verification_method = 'otp', verification_assurance = ?, verified_at = ?
     WHERE id = ?`,
    subjectPsNo, assurance, nowIso(), session.id
  );
  audit({
    actorType: 'system', actorId: 'ai-engine', action: 'verification.success',
    objectType: 'call_session', objectId: session.id,
    detail: { subjectRole, assurance, method: 'otp' }, // no codes, no full numbers
  });
}
