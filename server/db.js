// SQLite persistence layer (node:sqlite, built into Node >= 22.13). Migrations are
// applied transactionally in order. Foreign keys and WAL are enforced.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP } from './config.js';

const here = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_DB_PATH = join(here, '..', 'data', 'ltet.db');

let db = null;
let dbPathUsed = null;

export function getDb({ path } = {}) {
  if (db && (path ? path === dbPathUsed : true)) return db;
  if (db) return db;
  const target = path ?? (APP.dbFile || DEFAULT_DB_PATH);
  if (target !== ':memory:') mkdirSync(dirname(target), { recursive: true });
  db = new DatabaseSync(target);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  dbPathUsed = target;
  migrate(db);
  return db;
}

export function openIsolated(path) {
  const d = new DatabaseSync(path);
  d.exec('PRAGMA foreign_keys = ON;');
  migrate(d);
  return d;
}

export function closeDb() {
  if (db) { db.close(); db = null; }
}

const MIGRATIONS = [
  {
    version: 1,
    name: 'release-1-schema',
    sql: `
-- ===================== Staff & audit =====================
CREATE TABLE IF NOT EXISTS staff_users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('pms_processor','spm','apm','admin','auditor')),
  password_hash TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS staff_sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES staff_users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  action TEXT NOT NULL,
  object_type TEXT,
  object_id TEXT,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_events(at);
CREATE INDEX IF NOT EXISTS idx_audit_object ON audit_events(object_type, object_id);

-- ===================== Synthetic portal (system of record in demo) =====================
-- Engine never writes claim/payment/employee rows. Only demo fixtures & fault tools may.
CREATE TABLE IF NOT EXISTS portal_employees (
  ps_no TEXT PRIMARY KEY,          -- leading zeros preserved (string)
  name TEXT NOT NULL,
  registered_phone TEXT NOT NULL,  -- authoritative registered contact (SEC-02 target)
  language_pref TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS portal_registered_contacts (
  id TEXT PRIMARY KEY,
  ps_no TEXT NOT NULL REFERENCES portal_employees(ps_no),
  phone TEXT NOT NULL,
  channel TEXT NOT NULL CHECK(channel IN ('sms_capable','landline','hidden')),
  UNIQUE(ps_no, phone)
);
CREATE TABLE IF NOT EXISTS portal_beneficiaries (
  id TEXT PRIMARY KEY,
  ps_no TEXT NOT NULL REFERENCES portal_employees(ps_no),
  name TEXT NOT NULL,
  relationship TEXT NOT NULL,
  phone TEXT,
  sms_capable INTEGER NOT NULL DEFAULT 1
);
-- Proposed extension (SEC-03), not a source-confirmed FRS field:
CREATE TABLE IF NOT EXISTS portal_beneficiary_bindings (
  id TEXT PRIMARY KEY,
  beneficiary_id TEXT UNIQUE NOT NULL REFERENCES portal_beneficiaries(id),
  verified_phone TEXT NOT NULL,
  method TEXT,
  verified_at TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','revoked'))
);
CREATE TABLE IF NOT EXISTS portal_access_grants (
  id TEXT PRIMARY KEY,
  employee_ps_no TEXT NOT NULL REFERENCES portal_employees(ps_no),
  binding_id TEXT NOT NULL REFERENCES portal_beneficiary_bindings(id),
  permitted_claim_ids TEXT NOT NULL,   -- JSON array of claim ids; least privilege
  permitted_fields TEXT NOT NULL,      -- JSON array: stage|status|query|payment_group|amount|credit_date|bank_reference
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','revoked','expired')),
  valid_until TEXT,
  granted_by TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS portal_schemes (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  category TEXT
);
CREATE TABLE IF NOT EXISTS portal_claims (
  id TEXT PRIMARY KEY,
  ps_no TEXT NOT NULL REFERENCES portal_employees(ps_no),
  scheme_id TEXT NOT NULL REFERENCES portal_schemes(id),
  status TEXT NOT NULL CHECK(status IN ('Processing','Approved')),
  stage TEXT CHECK(stage IN ('PMS Processor','Sub-panel Review','Apex Panel Review','Approval')),
  stage_updated_at TEXT,
  amount_minor INTEGER,
  submitted_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_claims_ps ON portal_claims(ps_no, submitted_at DESC);
CREATE TABLE IF NOT EXISTS portal_processor_queries (
  id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL REFERENCES portal_claims(id),
  stage TEXT NOT NULL,
  query_text TEXT NOT NULL,
  raised_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Open' CHECK(status IN ('Open','Closed'))
);
CREATE TABLE IF NOT EXISTS portal_finance_payments (
  claim_id TEXT PRIMARY KEY REFERENCES portal_claims(id),
  approval_status TEXT,
  approval_date TEXT,
  payment_status_raw TEXT,
  amount_minor INTEGER,
  credit_date TEXT,
  bank_reference TEXT,
  failure_reason TEXT,
  held_reason TEXT,
  owner_team TEXT,
  updated_at TEXT NOT NULL
);

-- ===================== Engine / Helpdesk =====================
CREATE TABLE IF NOT EXISTS call_sessions (
  id TEXT PRIMARY KEY,
  ctx TEXT NOT NULL DEFAULT '{}',   -- engine state context (never contains OTPs)
  started_at TEXT NOT NULL,
  ended_at TEXT,
  state TEXT NOT NULL,
  outcome TEXT,
  outcome_detail TEXT,
  caller_number TEXT,
  caller_number_type TEXT CHECK(caller_number_type IN ('linked','unlinked','hidden','none')),
  caller_type TEXT CHECK(caller_type IN ('employee','beneficiary','unknown')),
  claimed_ps_no TEXT,
  verified_ps_no TEXT,
  verification_method TEXT,
  verification_assurance TEXT,
  verified_at TEXT,
  language TEXT,
  mode TEXT NOT NULL,
  transport TEXT NOT NULL DEFAULT 'simulator',
  scenario TEXT,
  talk_time_ms INTEGER DEFAULT 0,
  turn_count INTEGER NOT NULL DEFAULT 0,
  recognition_failures INTEGER NOT NULL DEFAULT 0,
  claims_discussed INTEGER NOT NULL DEFAULT 0,
  consent_recording INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sessions_started ON call_sessions(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_outcome ON call_sessions(outcome);

CREATE TABLE IF NOT EXISTS call_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES call_sessions(id),
  at TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_session ON call_events(session_id, id);

CREATE TABLE IF NOT EXISTS transcript_segments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES call_sessions(id),
  at TEXT NOT NULL,
  speaker TEXT NOT NULL CHECK(speaker IN ('system','caller','caller_keypad')),
  text TEXT NOT NULL,
  language TEXT,
  protected INTEGER NOT NULL DEFAULT 0,
  retention_class TEXT NOT NULL DEFAULT 'standard'
);
CREATE INDEX IF NOT EXISTS idx_transcript_session ON transcript_segments(session_id, id);

CREATE TABLE IF NOT EXISTS verification_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT,
  at TEXT NOT NULL,
  method TEXT,
  subject_kind TEXT CHECK(subject_kind IN ('employee','beneficiary')),
  subject_ps_no TEXT,
  result TEXT NOT NULL CHECK(result IN ('success','failed','expired','locked','no_attempt','skipped_insecure')),
  attempts_used INTEGER,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_vattempts_session ON verification_attempts(session_id);

CREATE TABLE IF NOT EXISTS otp_challenges (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  subject_ps_no TEXT NOT NULL,
  subject_role TEXT NOT NULL CHECK(subject_role IN ('employee','beneficiary')),
  channel TEXT NOT NULL,
  target_phone TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  code_salt TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  attempts_left INTEGER NOT NULL,
  resend_count INTEGER NOT NULL DEFAULT 0,
  consumed_at TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','consumed','expired','exhausted'))
);
CREATE INDEX IF NOT EXISTS idx_otp_subject ON otp_challenges(subject_ps_no, subject_role, status);

-- DEMO ONLY: isolated mock inbox simulating the synthetic user's phone SMS app.
-- Blocked in live mode (SEC-04). Never written in live mode.
CREATE TABLE IF NOT EXISTS mock_otp_inbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  target_phone TEXT,
  subject_ps_no TEXT,
  subject_role TEXT,
  message TEXT,
  challenge_id TEXT,
  session_id TEXT
);

CREATE TABLE IF NOT EXISTS call_claim_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES call_sessions(id),
  claim_id TEXT NOT NULL REFERENCES portal_claims(id),
  first_discussed_at TEXT NOT NULL,
  topics TEXT NOT NULL DEFAULT '[]',
  UNIQUE(session_id, claim_id)
);

CREATE TABLE IF NOT EXISTS answer_evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES call_sessions(id),
  claim_id TEXT,
  at TEXT NOT NULL,
  fact_key TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  source_version TEXT,
  retrieved_at TEXT NOT NULL,
  snapshot TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_evidence_session ON answer_evidence(session_id);

CREATE TABLE IF NOT EXISTS claim_document_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  claim_id TEXT NOT NULL REFERENCES portal_claims(id),
  call_id TEXT NOT NULL,
  at TEXT NOT NULL,
  entry_type TEXT NOT NULL DEFAULT 'call_communication',
  text TEXT NOT NULL,
  created_by TEXT NOT NULL DEFAULT 'AI Engine',
  UNIQUE(claim_id, call_id, entry_type, text)
);
CREATE INDEX IF NOT EXISTS idx_doc_history_claim ON claim_document_history(claim_id, at);

-- Immutable final call log (FR-34): evidence columns cannot be updated by any
-- application role; deletion is only possible via the governed retention purge,
-- which must first set the one-way retention_deleted marker (audited).
CREATE TABLE IF NOT EXISTS call_logs (
  id TEXT PRIMARY KEY,
  retention_deleted TEXT,
  session_id TEXT UNIQUE NOT NULL,
  created_at TEXT NOT NULL,
  locked_at TEXT,
  outcome TEXT,
  outcome_detail TEXT,
  language TEXT,
  started_at TEXT,
  ended_at TEXT,
  duration_ms INTEGER,
  caller_type TEXT,
  claimed_ps_no TEXT,
  verified_ps_no TEXT,
  verification_method TEXT,
  verification_assurance TEXT,
  mode TEXT,
  transport TEXT,
  scenario TEXT,
  summary TEXT,             -- structured English summary JSON (FR-27)
  sentiment_estimate TEXT,  -- labelled estimate only; never grants access
  issue_flags TEXT,
  follow_up TEXT,
  claims_discussed TEXT,
  facts_given TEXT,
  delayed_flag INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_logs_created ON call_logs(created_at DESC);
CREATE TRIGGER IF NOT EXISTS trg_call_logs_no_update
  BEFORE UPDATE OF summary, outcome, outcome_detail, verified_ps_no, claimed_ps_no,
    facts_given, claims_discussed, locked_at, sentiment_estimate, issue_flags, follow_up ON call_logs
BEGIN
  SELECT RAISE(ABORT, 'call_logs are immutable once created');
END;
CREATE TRIGGER IF NOT EXISTS trg_call_logs_no_delete
  BEFORE DELETE ON call_logs
  WHEN OLD.retention_deleted IS NULL
BEGIN
  SELECT RAISE(ABORT, 'call_logs cannot be deleted; use governed retention purge');
END;
CREATE TRIGGER IF NOT EXISTS trg_call_logs_retention_mark
  BEFORE UPDATE OF retention_deleted ON call_logs
  WHEN OLD.retention_deleted IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'retention mark is one-way');
END;

CREATE TABLE IF NOT EXISTS processor_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  call_log_id TEXT REFERENCES call_logs(id),
  claim_id TEXT,
  author_user TEXT NOT NULL,
  at TEXT NOT NULL,
  text TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY,
  dedupe_key TEXT UNIQUE NOT NULL,
  type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'medium',
  stage TEXT,
  persona_role TEXT,
  claim_id TEXT,
  session_id TEXT,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','acknowledged','closed')),
  acknowledged_by TEXT,
  acknowledged_at TEXT,
  closed_by TEXT,
  closed_at TEXT,
  detail TEXT,
  routing_state TEXT NOT NULL DEFAULT 'routed' CHECK(routing_state IN ('routed','unrouted'))
);
CREATE INDEX IF NOT EXISTS idx_alerts_status ON alerts(status, persona_role, created_at DESC);

CREATE TABLE IF NOT EXISTS callback_requests (
  id TEXT PRIMARY KEY,
  session_id TEXT UNIQUE,
  ps_no TEXT,
  verified INTEGER NOT NULL DEFAULT 0,
  callback_number TEXT NOT NULL,
  language TEXT,
  preferred_window TEXT,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','assigned','done','cancelled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Durable outbox / background jobs (post-call work survives restart)
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  idempotency_key TEXT UNIQUE NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','done','dead')),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  run_after TEXT,
  heartbeat_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_error TEXT,
  steps_done TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, run_after);

CREATE TABLE IF NOT EXISTS policy_configs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version INTEGER UNIQUE NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','approved','published','superseded')),
  doc TEXT NOT NULL,
  created_by TEXT,
  approved_by TEXT,
  published_at TEXT,
  created_at TEXT NOT NULL,
  note TEXT
);

CREATE TABLE IF NOT EXISTS language_packs (
  lang TEXT NOT NULL,
  version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('native_approved','draft_translation','retired')),
  strings TEXT NOT NULL,
  voice_provider TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (lang, version)
);

CREATE TABLE IF NOT EXISTS review_tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  call_log_id TEXT NOT NULL REFERENCES call_logs(id),
  created_by TEXT NOT NULL,
  at TEXT NOT NULL,
  tag TEXT NOT NULL,
  note TEXT
);

CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('daily','weekly')),
  period TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  generated_by TEXT,
  data TEXT NOT NULL,
  UNIQUE(kind, period)
);

CREATE TABLE IF NOT EXISTS call_latency (
  session_id TEXT PRIMARY KEY REFERENCES call_sessions(id),
  answer_start_ms INTEGER,
  measured_via TEXT NOT NULL DEFAULT 'simulator'
);

CREATE TABLE IF NOT EXISTS webhook_nonces (
  nonce TEXT PRIMARY KEY,
  at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS counters (
  name TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);

INSERT OR IGNORE INTO counters(name, value) VALUES ('call_seq', 0);
`,
  },
  {
    version: 2,
    name: 'session-verification-result',
    sql: `ALTER TABLE call_sessions ADD COLUMN verification_result TEXT;`,
  },
];

function migrate(d) {
  const rows = d.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='_migrations'`).all();
  if (rows.length === 0) {
    d.exec(`CREATE TABLE IF NOT EXISTS _migrations (version INTEGER PRIMARY KEY, name TEXT, applied_at TEXT)`);
  }
  const applied = new Set(d.prepare(`SELECT version FROM _migrations`).all().map((r) => r.version));
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    try {
      d.exec('BEGIN');
      d.exec(m.sql);
      d.prepare(`INSERT INTO _migrations(version, name, applied_at) VALUES (?,?,?)`).run(m.version, m.name, new Date().toISOString());
      d.exec('COMMIT');
    } catch (e) {
      try { d.exec('ROLLBACK'); } catch { /* ignore */ }
      throw new Error(`migration ${m.version} failed: ${e.message}`);
    }
  }
}

// Small statement helpers -----------------------------------------------------
export function run(sql, ...params) { return getDb().prepare(sql).run(...params); }
export function get(sql, ...params) { return getDb().prepare(sql).get(...params); }
export function all(sql, ...params) { return getDb().prepare(sql).all(...params); }

// Governed demo-reset support: the seeder temporarily removes the call_logs
// immutability triggers, wipes rows, and reinstates them. Application roles
// still have no path to call these.
export const CALL_LOG_TRIGGER_SQL = [
  `CREATE TRIGGER IF NOT EXISTS trg_call_logs_no_update
     BEFORE UPDATE OF summary, outcome, outcome_detail, verified_ps_no, claimed_ps_no,
       facts_given, claims_discussed, locked_at, sentiment_estimate, issue_flags, follow_up ON call_logs
   BEGIN
     SELECT RAISE(ABORT, 'call_logs are immutable once created');
   END;`,
  `CREATE TRIGGER IF NOT EXISTS trg_call_logs_no_delete
     BEFORE DELETE ON call_logs
     WHEN OLD.retention_deleted IS NULL
   BEGIN
     SELECT RAISE(ABORT, 'call_logs cannot be deleted; use governed retention purge');
   END;`,
  `CREATE TRIGGER IF NOT EXISTS trg_call_logs_retention_mark
     BEFORE UPDATE OF retention_deleted ON call_logs
     WHEN OLD.retention_deleted IS NOT NULL
   BEGIN
     SELECT RAISE(ABORT, 'retention mark is one-way');
   END;`,
];

export function withCallLogTriggersRemoved(d, fn) {
  d.exec(`DROP TRIGGER IF EXISTS trg_call_logs_no_update;
          DROP TRIGGER IF EXISTS trg_call_logs_no_delete;
          DROP TRIGGER IF EXISTS trg_call_logs_retention_mark;`);
  try {
    return fn();
  } finally {
    for (const sql of CALL_LOG_TRIGGER_SQL) d.exec(sql);
  }
}
