// Deterministic workspace fixtures: 17 trust schemes, 12 language packs,
// employees with zero/one/many claims, all four processing stages, all payment
// groups, delayed/missing/unmapped payment data, linked/unlinked/hidden callers,
// legitimate and illegitimate beneficiary cases with the proposed trusted
// binding/grant extension (SEC-03), PMS/SPM/APM/admin/auditor staff, and a
// history of past calls for analytics. ALL data is a locally managed workspace dataset.
//
// Usage: node server/seed.js [--force]
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { closeDb, getDb, run, get, withCallLogTriggersRemoved } from './db.js';
import { hashPassword, nowIso, daysAgoIso } from './util.js';
import { APP } from './config.js';
import { seedLanguagePacks } from './engine/languages.js';
import { seedDefaultPolicy } from './services/policy.js';
import { createStaffUser, staffCount } from './auth/sessions.js';
import { DEMO_STAFF_PASSWORD } from './auth/demo-credentials.js';

const here = dirname(fileURLToPath(import.meta.url));

const SCHEMES = Array.from({ length: 17 }, (_, i) => ({
  id: `S${String(i + 1).padStart(2, '0')}`,
  label: `Trust Scheme ${String(i + 1).padStart(2, '0')}`,
  category: ['Medical', 'Travel', 'Education', 'Housing', 'Welfare'][i % 5],
}));

const E = (ps, name, phone, pref) => ({ ps, name, phone, pref });

const EMPLOYEES = [
  E('004321', 'Arjun Mehta', '+91 55555 50001', 'hi'),   // 7 claims (cap tests), linked caller
  E('001234', 'Priya Sharma', '+91 55555 50002', 'en'),  // 1 claim with open PMS query
  E('010077', 'Vikram Rao', '+91 55555 50003', 'en'),    // approved + credited
  E('020045', 'Neha Joshi', '+91 55555 50004', 'en'),    // approved + processed (delayed)
  E('000902', 'Rohit Banerjee', '+91 55555 50005', 'bn'),// approved + pending
  E('005555', 'Ananya Iyer', '+91 55555 50006', 'ta'),   // approved + failed
  E('007801', 'Karan Singh', '+91 55555 50007', 'pa'),   // approved + held
  E('002210', 'Divya Nair', '+91 55555 50008', 'ml'),    // 3 claims mixed stages
  E('003001', 'Suman Das', '+91 55555 50009', 'bn'),     // zero claims
  E('009876', 'Anita Kulkarni', '+91 55555 50010', 'mr'),// approved + unmapped raw status
  E('001111', 'Manoj Verma', '+91 55555 50011', 'hi'),   // approved + credited with missing fields
  E('006789', 'Lakshmi Subramani', '+91 55555 50012', 'kn'), // landline-only registered contact
  E('004444', 'Imran Sheikh', '+91 55555 50013', 'ur'),  // 5 claims (cap boundary) — pref falls back to English
  E('000007', 'Geeta Patel', '+91 55555 50014', 'gu'),   // 1 claim, approved credited (odia speaker profile for language test)
];

const C = (id, ps, scheme, status, stage, days, amount, extra = {}) => ({
  id, ps, scheme, status, stage, days, amount, ...extra,
});

const CLAIMS = [
  C('CLM-10001', '004321', 'S03', 'Processing', 'PMS Processor', 20, 1450000),
  C('CLM-10002', '004321', 'S07', 'Processing', 'Sub-panel Review', 15, 830000),
  C('CLM-10003', '004321', 'S01', 'Processing', 'Apex Panel Review', 12, 2200000),
  C('CLM-10004', '004321', 'S11', 'Processing', 'Approval', 9, 610000),
  C('CLM-10005', '004321', 'S05', 'Approved', null, 8, 3400000, { pay: 'Credited' }),
  C('CLM-10006', '004321', 'S02', 'Processing', 'PMS Processor', 6, 990000),
  C('CLM-10007', '004321', 'S09', 'Processing', 'PMS Processor', 2, 175000),
  C('CLM-10010', '001234', 'S04', 'Processing', 'PMS Processor', 5, 1120000, { query: 'Original bills for the hotel stay are not attached. Please upload them on the LTET portal.' }),
  C('CLM-10020', '010077', 'S06', 'Approved', null, 6, 2450000, { pay: 'Credited', creditDaysAgo: 4, bankRef: 'MOCKBANK0045678' }),
  C('CLM-10030', '020045', 'S08', 'Approved', null, 10, 1875000, { pay: 'Processed', approvalDaysAgo: 10 }), // delayed vs 7-day demo threshold
  C('CLM-10040', '000902', 'S10', 'Approved', null, 3, 950000, { pay: 'Pending', approvalDaysAgo: 2 }),
  C('CLM-10050', '005555', 'S12', 'Approved', null, 5, 1320000, { pay: 'Failed', approvalDaysAgo: 5, failure: 'Bank account name mismatch (recorded by Finance) [synthetic]' }),
  C('CLM-10060', '007801', 'S13', 'Approved', null, 7, 760000, { pay: 'Held', approvalDaysAgo: 7, held: 'Pending beneficiary bank verification (recorded by Finance) [synthetic]' }),
  C('CLM-10070', '002210', 'S14', 'Processing', 'Sub-panel Review', 4, 540000),
  C('CLM-10071', '002210', 'S15', 'Processing', 'PMS Processor', 3, 480000, { query: 'Submit revised boarding pass for the return leg.' }),
  C('CLM-10072', '002210', 'S16', 'Approved', null, 2, 1560000, { pay: 'Credited', creditDaysAgo: 1, bankRef: 'MOCKBANK0090123' }),
  C('CLM-10080', '009876', 'S17', 'Approved', null, 4, 890000, { pay: 'Sent-to-Bank-X', approvalDaysAgo: 3 }), // unmapped raw status
  C('CLM-10090', '001111', 'S02', 'Approved', null, 5, 1230000, { pay: 'Credited', creditDaysAgo: 2, bankRef: null, creditDate: null }), // missing fields
  C('CLM-10100', '004444', 'S01', 'Processing', 'PMS Processor', 9, 300000),
  C('CLM-10101', '004444', 'S05', 'Processing', 'Sub-panel Review', 8, 275000),
  C('CLM-10102', '004444', 'S08', 'Processing', 'Apex Panel Review', 6, 410000),
  C('CLM-10103', '004444', 'S12', 'Processing', 'Approval', 4, 350000),
  C('CLM-10104', '004444', 'S15', 'Approved', null, 3, 620000, { pay: 'Credited', creditDaysAgo: 2, bankRef: 'MOCKBANK0077889' }),
  C('CLM-10110', '000007', 'S06', 'Approved', null, 6, 980000, { pay: 'Credited', creditDaysAgo: 5, bankRef: 'MOCKBANK0022334' }),
];

const BENEFICIARIES = [
  { id: 'BEN-001', ps: '010077', name: 'Meera Rao', relationship: 'Spouse', phone: '+91 55555 51001', sms: 1,
    binding: { verifiedPhone: '+91 55555 51001', method: 'portal_enrolment (proposed SEC-03 extension)' },
    grant: { claims: ['CLM-10020'], fields: ['stage', 'status', 'query', 'payment_group', 'amount', 'credit_date', 'bank_reference'] } },
  { id: 'BEN-002', ps: '004321', name: 'Ramesh Mehta', relationship: 'Father', phone: '+91 55555 51002', sms: 1,
    binding: null, grant: null }, // impostor case: known PS/name but NO trusted binding (SEC-03)
  { id: 'BEN-003', ps: '020045', name: 'Sunita Joshi', relationship: 'Spouse', phone: '+91 55555 51003', sms: 1,
    binding: { verifiedPhone: '+91 55555 51003', method: 'portal_enrolment (proposed SEC-03 extension)' },
    grant: { claims: ['CLM-10030'], fields: ['stage', 'status', 'payment_group'] } }, // limited fields
  { id: 'BEN-004', ps: '000902', name: 'Amit Banerjee', relationship: 'Brother', phone: '+91 55555 51004', sms: 1,
    binding: { verifiedPhone: '+91 55555 51004', method: 'portal_enrolment (proposed SEC-03 extension)', status: 'revoked' },
    grant: { claims: ['CLM-10040'], fields: ['stage', 'status', 'payment_group'] } }, // revoked grant
  { id: 'BEN-005', ps: '001234', name: 'Kavita Sharma', relationship: 'Mother', phone: '+91 55555 61005', sms: 0,
    binding: { verifiedPhone: '+91 55555 61005', method: 'portal_enrolment (proposed SEC-03 extension)' },
    grant: { claims: ['CLM-10010'], fields: ['stage', 'status', 'query', 'payment_group'] } }, // SMS-incapable (FR-59)
];

const STAFF = [
  { id: 'USR-PMS1', username: 'pms1', displayName: 'PMS Processor 1', role: 'pms_processor' },
  { id: 'USR-PMS2', username: 'pms2', displayName: 'PMS Processor 2', role: 'pms_processor' },
  { id: 'USR-SPM1', username: 'spm1', displayName: 'SPM 1', role: 'spm' },
  { id: 'USR-APM1', username: 'apm1', displayName: 'APM 1', role: 'apm' },
  { id: 'USR-ADM1', username: 'admin1', displayName: 'Administrator', role: 'admin' },
  { id: 'USR-AUD1', username: 'auditor1', displayName: 'Auditor', role: 'auditor' },
];

export function seed({ force = false } = {}) {
  const db = getDb();
  if (force) {
    withCallLogTriggersRemoved(db, () => {
      db.exec(`
        DELETE FROM call_latency; DELETE FROM webhook_nonces; DELETE FROM reports;
        DELETE FROM review_tags; DELETE FROM language_packs; DELETE FROM policy_configs;
        DELETE FROM jobs; DELETE FROM callback_requests; DELETE FROM alerts; DELETE FROM processor_notes;
        DELETE FROM call_logs; DELETE FROM claim_document_history; DELETE FROM answer_evidence;
        DELETE FROM call_claim_entries; DELETE FROM mock_otp_inbox; DELETE FROM otp_challenges;
        DELETE FROM verification_attempts; DELETE FROM transcript_segments; DELETE FROM call_events;
        DELETE FROM call_sessions; DELETE FROM audit_events; DELETE FROM staff_sessions; DELETE FROM staff_users;
        DELETE FROM portal_finance_payments; DELETE FROM portal_processor_queries; DELETE FROM portal_claims;
        DELETE FROM portal_schemes; DELETE FROM portal_access_grants; DELETE FROM portal_beneficiary_bindings;
        DELETE FROM portal_beneficiaries; DELETE FROM portal_registered_contacts; DELETE FROM portal_employees;
        DELETE FROM counters;
      `);
    });
  } else if (get(`SELECT COUNT(*) AS c FROM portal_employees`).c > 0) {
    return { skipped: true };
  }

  const now = nowIso();
  // Schemes
  for (const s of SCHEMES) {
    run(`INSERT INTO portal_schemes(id, label, category) VALUES (?,?,?)`, s.id, s.label, s.category);
  }
  // Employees + contacts
  for (const e of EMPLOYEES) {
    run(`INSERT INTO portal_employees(ps_no, name, registered_phone, language_pref, created_at) VALUES (?,?,?,?,?)`,
      e.ps, e.name, e.phone, e.pref, now);
    run(`INSERT INTO portal_registered_contacts(id, ps_no, phone, channel) VALUES (?,?,?,?)`,
      `RC-${e.ps}-1`, e.ps, e.phone, e.ps === '006789' ? 'landline' : 'sms_capable');
  }
  // Claims + queries + payments
  for (const c of CLAIMS) {
    run(
      `INSERT INTO portal_claims(id, ps_no, scheme_id, status, stage, stage_updated_at, amount_minor, submitted_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      c.id, c.ps, c.scheme, c.status, c.status === 'Approved' ? 'Approval' : c.stage,
      daysAgoIso(c.days - 1), c.amount, daysAgoIso(c.days)
    );
    if (c.query) {
      run(`INSERT INTO portal_processor_queries(id, claim_id, stage, query_text, raised_at, status)
           VALUES (?,?,?,?,?, 'Open')`,
        `Q-${c.id}`, c.id, 'PMS Processor', c.query, daysAgoIso(c.days - 2));
    }
    if (c.pay) {
      run(
        `INSERT INTO portal_finance_payments(claim_id, approval_status, approval_date, payment_status_raw, amount_minor,
           credit_date, bank_reference, failure_reason, held_reason, owner_team, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        c.id, 'Approved', daysAgoIso(c.approvalDaysAgo ?? c.creditDaysAgo ?? c.days), c.pay, c.amount,
        c.creditDaysAgo !== undefined && c.creditDate !== null ? daysAgoIso(c.creditDaysAgo) : (c.creditDate === null ? null : (c.creditDaysAgo !== undefined ? daysAgoIso(c.creditDaysAgo) : null)),
        c.bankRef ?? null, c.failure ?? null, c.held ?? null,
        ['Processed', 'Pending'].includes(c.pay) ? 'Finance Disbursement' : 'Finance Operations', now
      );
    }
  }
  // Beneficiaries + proposed bindings + grants (SEC-03 extension, labelled)
  for (const b of BENEFICIARIES) {
    run(`INSERT INTO portal_beneficiaries(id, ps_no, name, relationship, phone, sms_capable) VALUES (?,?,?,?,?,?)`,
      b.id, b.ps, b.name, b.relationship, b.phone, b.sms);
    if (b.binding) {
      run(`INSERT INTO portal_beneficiary_bindings(id, beneficiary_id, verified_phone, method, verified_at, status)
           VALUES (?,?,?,?,?,?)`,
        `BIND-${b.id}`, b.id, b.binding.verifiedPhone, b.binding.method, daysAgoIso(30), b.binding.status || 'active');
      if (b.grant) {
        run(`INSERT INTO portal_access_grants(id, employee_ps_no, binding_id, permitted_claim_ids, permitted_fields, status, valid_until, granted_by, created_at)
             VALUES (?,?,?,?,?,?,?,?,?)`,
          `GRANT-${b.id}`, b.ps, `BIND-${b.id}`, JSON.stringify(b.grant.claims), JSON.stringify(b.grant.fields),
          'active', daysAgoIso(-365), 'LTET Admin (synthetic)', daysAgoIso(30));
      }
    }
  }
  // Staff
  for (const s of STAFF) {
    createStaffUser({ id: s.id, username: s.username, displayName: s.displayName, role: s.role, password: DEMO_STAFF_PASSWORD });
  }
  // Language packs + policy
  seedLanguagePacks();
  seedDefaultPolicy();

  // Historical calls for analytics (synthetic, deterministic mix over 14 days)
  seedHistoricalCalls();

  return { skipped: false, employees: EMPLOYEES.length, claims: CLAIMS.length, schemes: SCHEMES.length };
}

function seedHistoricalCalls() {
  const langs = ['en', 'hi', 'bn', 'mr', 'ta', 'te', 'gu', 'pa', 'ml', 'kn', 'or', 'as'];
  const outcomes = ['resolved', 'resolved', 'resolved', 'escalated', 'verification_failed', 'abandoned', 'resolved'];
  const intents = ['claim_status', 'claim_status', 'payment_information', 'claim_status', 'other'];
  const claimsByPs = {};
  for (const c of CLAIMS) (claimsByPs[c.ps] = claimsByPs[c.ps] || []).push(c.id);

  let n = 0;
  for (let d = 13; d >= 0; d--) {
    const callsToday = 2 + ((d * 7) % 4); // 2..5 deterministic
    for (let k = 0; k < callsToday; k++) {
      const emp = EMPLOYEES[(d * 3 + k * 5) % EMPLOYEES.length];
      const lang = langs[(d + k) % langs.length];
      const outcome = outcomes[(d * 3 + k) % outcomes.length];
      const intent = intents[(d + k * 2) % intents.length];
      const id = `CS-H${String(n).padStart(4, '0')}`;
      const logId = `CL-H${String(n).padStart(4, '0')}`;
      const started = daysAgoIso(d, k + 1);
      const durMs = (4 + ((d + k) % 6)) * 60000;
      const ended = new Date(new Date(started).getTime() + durMs).toISOString();
      const verified = outcome !== 'verification_failed';
      const claimList = verified ? (claimsByPs[emp.ps] || []).slice(0, 1 + ((d + k) % 2)) : [];
      run(
        `INSERT INTO call_sessions(id, ctx, started_at, ended_at, state, outcome, caller_number, caller_number_type,
           caller_type, claimed_ps_no, verified_ps_no, verification_method, verification_assurance, language, mode, transport, talk_time_ms, turn_count)
         VALUES (?, '{}', ?, ?, 'ended', ?, ?, 'linked', 'employee', ?, ?, 'otp', 'otp_registered_channel', ?, 'demo', 'simulator', ?, ?)`,
        id, started, ended, outcome, emp.phone, emp.ps, verified ? emp.ps : null, lang, durMs, 4 + k
      );
      run(
        `INSERT INTO call_logs(id, session_id, created_at, locked_at, outcome, language, started_at, ended_at, duration_ms,
           caller_type, claimed_ps_no, verified_ps_no, verification_method, verification_assurance, mode, transport,
           summary, sentiment_estimate, issue_flags, follow_up, claims_discussed, facts_given, delayed_flag)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)`,
        logId, id, ended, ended, outcome, lang, started, ended, durMs, 'employee', emp.ps, verified ? emp.ps : null,
        verified ? 'otp' : null, verified ? 'otp_registered_channel' : null, 'demo', 'simulator',
        JSON.stringify({ intent, generated_at: ended, note: 'synthetic historical call' }),
        'neutral (estimate)', JSON.stringify(verified ? ['verified'] : ['verification_failed']), '[]',
        JSON.stringify(claimList.map((c) => ({ claim_id: c, topics: [intent === 'payment_information' ? 'pay_credited' : 'claim_stage_answer'] }))),
        JSON.stringify(claimList.map((c) => ({ claim_id: c, topics: ['claim_stage_answer'], payment_group: intent === 'payment_information' ? 'credited' : undefined })))
      );
      for (const c of claimList) {
        run(`INSERT OR IGNORE INTO call_claim_entries(session_id, claim_id, first_discussed_at, topics) VALUES (?,?,?,?)`,
          id, c, started, JSON.stringify([intent === 'payment_information' ? 'pay_credited' : 'claim_stage_answer']));
        if (verified) {
          run(`INSERT OR IGNORE INTO claim_document_history(claim_id, call_id, at, entry_type, text, created_by)
               VALUES (?,?,?,?,?, 'AI Engine')`,
            c, logId, ended, 'call_communication', `AI call ${logId}: historical synthetic interaction (${intent}).`);
        }
      }
      run(`INSERT OR IGNORE INTO call_latency(session_id, answer_start_ms, measured_via) VALUES (?,?, 'simulator')`,
        id, 600 + ((d * 137 + k * 419) % 1400));
      n += 1;
    }
  }
}

// CLI
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const force = process.argv.includes('--force');
  const res = seed({ force });
  if (res.skipped) {
    console.log('Seed skipped: data already present (use --force to reset).');
  } else {
    console.log(`Workspace dataset ready: ${res.employees} employees, ${res.claims} claims, ${res.schemes} schemes, staff users: ${STAFF.map((s) => s.username).join(', ')}`);
    console.log(`Demo staff password (labelled demo credential): ${DEMO_STAFF_PASSWORD}`);
  }
  closeDb();
}
