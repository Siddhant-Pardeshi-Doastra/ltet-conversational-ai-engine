// Isolated OTP challenge adapter (IR-03, SEC-02/SEC-04).
//
// - Codes are random, expire, and only a salted hash is stored.
// - Codes are NEVER returned by any API, never logged, never placed in
//   transcripts, model inputs, analytics, URLs or error messages.
// - Entry is via the protected keypad path (FR-49); the ordinary ASR/LLM
//   pipeline never sees a code.
// - Demo delivery uses the isolated mock inbox (simulates the synthetic user's
//   phone). Live delivery requires OTP_PROVIDER_URL; without it we fail closed.
import { run, get } from '../db.js';
import { isDemoMode, APP } from '../config.js';
import { nowIso, randomDigits, sha256 } from '../util.js';
import { NotConfiguredError, VerificationError } from './errors.js';

const POLICY_FALLBACK = { expiry_seconds: 300, max_attempts: 3, max_resends: 2 };

function otpPolicy(policy) {
  return { ...POLICY_FALLBACK, ...(policy?.otp || {}) };
}

function rateLimitKey(psNo, role) { return `otp_rate:${role}:${psNo}`; }

/** Max 3 challenges per subject per 15 minutes (rate-limit abuse without lockout, SEC-07). */
export function checkRateLimit(psNo, role) {
  const row = get(`SELECT COUNT(*) AS c FROM otp_challenges WHERE subject_ps_no = ? AND subject_role = ? AND created_at > ?`,
    String(psNo), role, new Date(Date.now() - 15 * 60 * 1000).toISOString());
  if (row.c >= 3) throw new VerificationError('otp_rate_limited', 'too many challenges requested; try later', { status: 429 });
}

export function createChallenge({ sessionId, subjectPsNo, subjectRole, target, policy }) {
  if (!target || !target.phone || !target.smsCapable) {
    // FR-59 / hidden and landline numbers: never attempt an SMS challenge.
    throw new VerificationError('channel_not_sms_capable', 'registered channel cannot receive the challenge');
  }
  // Fail closed BEFORE writing anything: without a delivery provider in live
  // mode no challenge row may exist (nothing verifiable, nothing half-sent).
  if (!isDemoMode() && !APP.integrations.otpProviderUrl) {
    throw new NotConfiguredError('IR-03 OTP provider');
  }
  checkRateLimit(subjectPsNo, subjectRole);
  const p = otpPolicy(policy);
  const code = randomDigits(6);
  const id = `OTC-${randomDigits(10)}`;
  const now = Date.now();
  run(
    `INSERT INTO otp_challenges(id, session_id, subject_ps_no, subject_role, channel, target_phone,
       code_hash, code_salt, created_at, expires_at, attempts_left, resend_count, status)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,0,'active')`,
    id, sessionId, String(subjectPsNo), subjectRole, target.channel, target.phone,
    sha256(`${id}:${code}`), sessionId || 'n/a', // salt: session id is unique per call and not secret-bearing
    nowIso(), new Date(now + p.expiry_seconds * 1000).toISOString(), p.max_attempts
  );
  deliver({ challengeId: id, sessionId, subjectPsNo, subjectRole, target, code });
  return { challengeId: id, expiresAt: new Date(now + p.expiry_seconds * 1000).toISOString(), attemptsLeft: p.max_attempts, channel: target.channel, sentToMasked: maskForLog(target.phone) };
}

function maskForLog(phone) {
  const p = String(phone);
  return `${p.slice(0, 3)}••••${p.slice(-3)}`;
}

function deliver({ challengeId, sessionId, subjectPsNo, subjectRole, target, code }) {
  if (isDemoMode()) {
    // DEMO ONLY: isolated mock inbox simulating the synthetic user's phone SMS app.
    // Accessible only from the demo simulator UI; never exposed in live mode.
    run(
      `INSERT INTO mock_otp_inbox(at, target_phone, subject_ps_no, subject_role, message, challenge_id, session_id)
       VALUES (?,?,?,?,?,?,?)`,
      nowIso(), target.phone, String(subjectPsNo), subjectRole,
      `[DEMO MOCK SMS to ${target.phone}] Your LTET portal verification code is ${code}. It expires soon. Do not share it.`,
      challengeId, sessionId
    );
    return;
  }
  if (!APP.integrations.otpProviderUrl) {
    // Fail closed in live mode: no provider configured => no challenge can be sent.
    throw new NotConfiguredError('IR-03 OTP provider');
  }
  // LIVE path (implemented when LTET supplies the contract): POST to the provider
  // with server-side credentials. Deliberately left unimplemented — see docs/INTEGRATIONS.md.
  throw new NotConfiguredError('IR-03 OTP provider send is not implemented for live mode');
}

/**
 * Atomic verification. Consumes the challenge in a single UPDATE guarded on
 * status/expiry/attempts (prevents replay and double-spend of an attempt).
 */
export function verifyChallenge({ subjectPsNo, subjectRole, code }) {
  const row = get(
    `SELECT * FROM otp_challenges WHERE subject_ps_no = ? AND subject_role = ? AND status = 'active'
     ORDER BY created_at DESC LIMIT 1`,
    String(subjectPsNo), subjectRole
  );
  if (!row) return { result: 'failed', reason: 'no_active_challenge', attemptsLeft: 0 };
  if (row.expires_at <= nowIso()) {
    run(`UPDATE otp_challenges SET status = 'expired' WHERE id = ? AND status = 'active'`, row.id);
    return { result: 'expired', reason: 'challenge_expired', attemptsLeft: 0 };
  }
  if (row.attempts_left <= 0) {
    run(`UPDATE otp_challenges SET status = 'exhausted' WHERE id = ? AND status = 'active'`, row.id);
    return { result: 'locked', reason: 'attempts_exhausted', attemptsLeft: 0 };
  }
  const hash = sha256(`${row.id}:${String(code).trim()}`);
  const consumed = run(
    `UPDATE otp_challenges SET status = 'consumed', consumed_at = ?
     WHERE id = ? AND status = 'active' AND expires_at > ? AND attempts_left > 0 AND code_hash = ?`,
    nowIso(), row.id, nowIso(), hash
  );
  if (consumed.changes === 1) {
    return { result: 'success', attemptsLeft: row.attempts_left - 1, challengeId: row.id };
  }
  const left = run(
    `UPDATE otp_challenges SET attempts_left = attempts_left - 1,
       status = CASE WHEN attempts_left - 1 <= 0 THEN 'exhausted' ELSE status END
     WHERE id = ? AND status = 'active'`,
    row.id
  );
  const updated = get(`SELECT attempts_left, status FROM otp_challenges WHERE id = ?`, row.id);
  const reason = updated?.status === 'exhausted' ? 'attempts_exhausted' : 'code_mismatch';
  void left;
  return { result: updated?.status === 'exhausted' ? 'locked' : 'failed', reason, attemptsLeft: updated?.attempts_left ?? 0 };
}

export function resendChallenge({ sessionId, subjectPsNo, subjectRole, target, policy }) {
  const last = get(
    `SELECT * FROM otp_challenges WHERE session_id = ? AND subject_ps_no = ? AND subject_role = ?
     ORDER BY created_at DESC LIMIT 1`,
    sessionId, String(subjectPsNo), subjectRole
  );
  if (!last) return createChallenge({ sessionId, subjectPsNo, subjectRole, target, policy });
  const p = otpPolicy(policy);
  if (last.resend_count >= p.max_resends) {
    throw new VerificationError('resend_limit_reached', 'resend limit reached; human/recovery path required', { status: 429 });
  }
  // Mark the old challenge dead, issue a fresh one, keeping the resend count.
  run(`UPDATE otp_challenges SET status = 'expired' WHERE id = ? AND status = 'active'`, last.id);
  const created = createChallenge({ sessionId, subjectPsNo, subjectRole, target, policy });
  run(`UPDATE otp_challenges SET resend_count = ? WHERE id = ?`, last.resend_count + 1, created.challengeId);
  return { ...created, resendsLeft: p.max_resends - last.resend_count - 1 };
}

export function hasActiveChallenge(psNo, role) {
  const row = get(
    `SELECT id, expires_at FROM otp_challenges WHERE subject_ps_no = ? AND subject_role = ? AND status = 'active'
     ORDER BY created_at DESC LIMIT 1`,
    String(psNo), role
  );
  return !!row && row.expires_at > nowIso();
}
