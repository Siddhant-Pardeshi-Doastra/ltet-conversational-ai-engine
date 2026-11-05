// Mock LTET portal adapter (IR-02 identity, IR-04/05 claims, IR-06 Finance).
//
// In DEMO mode this is the synthetic system of record. In LIVE mode the same
// functions are implemented against the configured API URLs; readiness then
// depends on configuration and missing configuration FAILS rather than
// falling back to synthetic data.
//
// The conversation engine must never write claim/payment/employee rows through
// this module: only read functions are exported to the engine. Demo fixture and
// fault tools use the explicit write section at the bottom and are blocked in
// live mode.
import { getDb, run, get, all } from '../db.js';
import { APP, isDemoMode } from '../config.js';
import { PortalUnavailableError, FinanceUnavailableError, NotConfiguredError } from './errors.js';
import { nowIso, daysAgoIso } from '../util.js';

export function readiness() {
  const live = APP.mode === 'live';
  const cfg = APP.integrations;
  const check = (name, url) => ({
    integration: name,
    status: live ? (url ? 'configured' : 'not_configured') : 'mock_demo',
    detail: live ? (url ? `endpoint configured` : 'no endpoint configured; private workflows disabled') : 'running against the synthetic mock portal (demo only)',
  });
  return [
    check('IR-02 identity lookup', cfg.identityApiUrl),
    check('IR-04/05 claims', cfg.portalClaimsApiUrl),
    check('IR-06 finance', cfg.financeApiUrl),
    check('IR-03 OTP provider', cfg.otpProviderUrl),
  ];
}

function fault(name) {
  if (!isDemoMode()) return false;
  const row = get(`SELECT value FROM counters WHERE name = ?`, `fault:${name}`);
  return !!row && Number(row.value) === 1;
}

export function setFault(name, on, actor = 'demo-tool') {
  if (!isDemoMode()) throw new NotConfiguredError('demo fault injection');
  if (!['portal_outage', 'finance_outage', 'unknown_payment_status', 'delay_payment'].includes(name)) {
    throw new Error(`unknown fault ${name}`);
  }
  run(
    `INSERT INTO counters(name, value) VALUES(?,?) ON CONFLICT(name) DO UPDATE SET value = excluded.value`,
    `fault:${name}`, on ? 1 : 0
  );
  bumpPortalVersion();
  return { name, on };
}

function bumpPortalVersion() {
  run(
    `INSERT INTO counters(name, value) VALUES('portal_version', 1)
     ON CONFLICT(name) DO UPDATE SET value = value + 1`
  );
}

export function portalVersion() {
  const row = get(`SELECT value FROM counters WHERE name = 'portal_version'`);
  return `mock-portal@v${row ? row.value : 0}`;
}

// ---------------------------------------------------------------------------
// Identity (IR-02)
// ---------------------------------------------------------------------------

/**
 * Resolve an incoming caller number to a candidate PS No.
 * Returns { matched, psNo, channelType } — a lookup/confirmation signal ONLY
 * (SEC-01: never proof of identity).
 */
export function lookupByPhone(phone) {
  const p = String(phone || '').trim();
  if (!p) return { matched: false, psNo: null, channelType: 'none' };
  const emp = get(`SELECT * FROM portal_employees WHERE registered_phone = ?`, p);
  if (emp) return { matched: true, psNo: emp.ps_no, channelType: 'sms_capable' };
  const rc = get(
    `SELECT * FROM portal_registered_contacts WHERE phone = ? ORDER BY CASE channel WHEN 'sms_capable' THEN 0 WHEN 'landline' THEN 1 ELSE 2 END LIMIT 1`,
    p
  );
  if (rc) return { matched: true, psNo: rc.ps_no, channelType: rc.channel };
  return { matched: false, psNo: null, channelType: 'none' };
}

export function findEmployee(psNo) {
  return get(`SELECT * FROM portal_employees WHERE ps_no = ?`, String(psNo || '')) || null;
}

export function registeredContacts(psNo) {
  return all(`SELECT * FROM portal_registered_contacts WHERE ps_no = ?`, String(psNo));
}

/** The authoritative registered SMS-capable contact for challenges (SEC-02). */
export function registeredChallengeTarget(psNo) {
  const contacts = registeredContacts(psNo);
  const emp = findEmployee(psNo);
  const sms = contacts.find((c) => c.channel === 'sms_capable');
  if (sms) return { channel: 'sms', phone: sms.phone, smsCapable: true };
  if (emp && emp.registered_phone) return { channel: 'sms', phone: emp.registered_phone, smsCapable: true };
  const landline = contacts.find((c) => c.channel === 'landline');
  if (landline) return { channel: 'landline', phone: landline.phone, smsCapable: false };
  const hidden = contacts.find((c) => c.channel === 'hidden');
  if (hidden) return { channel: 'hidden', phone: hidden.phone, smsCapable: false };
  return { channel: 'none', phone: null, smsCapable: false };
}

// ---------------------------------------------------------------------------
// Beneficiaries + proposed trusted binding / grants (SEC-03)
// ---------------------------------------------------------------------------

export function beneficiariesForEmployee(psNo) {
  return all(`SELECT * FROM portal_beneficiaries WHERE ps_no = ?`, String(psNo));
}

/**
 * Trusted beneficiary binding check (SEC-03). The caller's phone must equal a
 * previously verified contact recorded on the beneficiary binding.
 */
export function findTrustedGrant(employeePsNo, callerPhone) {
  return get(
    `SELECT g.*, b.verified_phone AS binding_phone, b.status AS binding_status, ben.name AS beneficiary_name,
            ben.relationship AS beneficiary_relationship, ben.sms_capable AS beneficiary_sms_capable
     FROM portal_access_grants g
     JOIN portal_beneficiary_bindings b ON b.id = g.binding_id
     JOIN portal_beneficiaries ben ON ben.id = b.beneficiary_id
     WHERE g.employee_ps_no = ? AND b.verified_phone = ?`,
    String(employeePsNo), String(callerPhone)
  );
}

export function grantIsUsable(grant, atIso = nowIso()) {
  if (!grant) return { ok: false, reason: 'no_grant' };
  if (grant.status !== 'active') return { ok: false, reason: `grant_${grant.status}` };
  if (grant.binding_status !== 'active') return { ok: false, reason: `binding_${grant.binding_status}` };
  if (grant.valid_until && grant.valid_until < atIso) return { ok: false, reason: 'grant_expired' };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Claims (IR-04/05)
// ---------------------------------------------------------------------------

/**
 * Live open-claims fetch at call time (FR-06). Sorted newest first.
 * Scope of "open claims" is configurable (open decision with the API owner):
 *  - processing_only           : strictly Processing claims
 *  - processing_and_approved   : Processing + Approved (demo default so UC-02
 *                                entry from an approved selection is demonstrable)
 */
export function listOpenClaims(psNo, { scope = 'processing_and_approved' } = {}) {
  if (fault('portal_outage')) throw new PortalUnavailableError('demo fault injection: portal_outage');
  const where = scope === 'processing_only' ? `status = 'Processing'` : `status IN ('Processing','Approved')`;
  const rows = all(
    `SELECT c.*, s.label AS scheme_label, s.category AS scheme_category
     FROM portal_claims c JOIN portal_schemes s ON s.id = c.scheme_id
     WHERE c.ps_no = ? AND ${where}
     ORDER BY c.submitted_at DESC, c.id DESC`,
    String(psNo)
  );
  return rows.map(toClaimSummary);
}

export function toClaimSummary(c) {
  const q = get(
    `SELECT * FROM portal_processor_queries WHERE claim_id = ? AND status = 'Open' ORDER BY raised_at DESC LIMIT 1`,
    c.id
  );
  return {
    claim_id: c.id,
    ps_no: c.ps_no,
    scheme_id: c.scheme_id,
    scheme_label: c.scheme_label ?? null,
    scheme_category: c.scheme_category ?? null,
    status: c.status, // 'Processing' | 'Approved'
    stage: c.stage ?? null,
    stage_updated_at: c.stage_updated_at ?? null,
    amount_minor: c.amount_minor ?? null,
    submitted_at: c.submitted_at,
    has_open_query: !!q,
    open_query: q ? { id: q.id, stage: q.stage, query_text: q.query_text, raised_at: q.raised_at } : null,
  };
}

export function getClaimSummary(claimId) {
  const c = get(
    `SELECT c.*, s.label AS scheme_label, s.category AS scheme_category
     FROM portal_claims c JOIN portal_schemes s ON s.id = c.scheme_id WHERE c.id = ?`,
    String(claimId)
  );
  return c ? toClaimSummary(c) : null;
}

export function assertClaimBelongsTo(claimId, psNo) {
  const c = get(`SELECT * FROM portal_claims WHERE id = ? AND ps_no = ?`, String(claimId), String(psNo));
  if (!c) throw new PortalUnavailableError('claim not in verified scope'); // mapped to safe fallback by callers
  return c;
}

// ---------------------------------------------------------------------------
// Finance (IR-06)
// ---------------------------------------------------------------------------

/** Raw finance payment record for a claim, or null when none exists. */
export function getFinancePayment(claimId) {
  if (fault('finance_outage')) throw new FinanceUnavailableError('demo fault injection: finance_outage');
  let row = get(`SELECT * FROM portal_finance_payments WHERE claim_id = ?`, String(claimId));
  if (row && fault('unknown_payment_status')) {
    row = { ...row, payment_status_raw: 'Sent-to-Bank-X' }; // unmapped raw status (FR-45/BDD-27)
  }
  if (row && fault('delay_payment') && ['Processed', 'Pending'].includes(row.payment_status_raw)) {
    row = { ...row, approval_date: daysAgoIso(30) }; // force delay-flag boundary test (FR-46/BDD-26)
  }
  return row || null;
}

// ---------------------------------------------------------------------------
// Demo fixture & fault writes (explicit; blocked in live mode; audited by caller)
// ---------------------------------------------------------------------------

export function demoWrite(sql, ...params) {
  if (!isDemoMode()) throw new NotConfiguredError('demo fixture writes');
  run(sql, ...params);
  bumpPortalVersion();
}
