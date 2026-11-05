// Application configuration and policy defaults.
// DEMO vs LIVE: in live mode with missing integration config, readiness FAILS and
// private workflows are disabled. There is never a silent fallback to synthetic data.
import './dotenv-safe-self.js';

const env = (k, d = '') => process.env[k] ?? d;

export const APP = {
  mode: env('LTET_MODE', 'demo').toLowerCase() === 'live' ? 'live' : 'demo',
  port: Number(env('PORT', '8787')),
  host: env('HOST', '127.0.0.1'),
  sessionSecret: env('SESSION_SECRET', 'demo-only-session-secret-not-for-production'),
  telephonyWebhookSecret: env('TELEPHONY_WEBHOOK_SECRET', ''),
  tzDisplay: env('TZ_DISPLAY', 'Asia/Kolkata'),
  enableCallRecordings: env('ENABLE_CALL_RECORDINGS', 'false') === 'true',
  integrations: {
    identityApiUrl: env('IDENTITY_API_URL'),
    portalClaimsApiUrl: env('PORTAL_CLAIMS_API_URL'),
    financeApiUrl: env('FINANCE_API_URL'),
    otpProviderUrl: env('OTP_PROVIDER_URL'),
    asrProviderUrl: env('ASR_PROVIDER_URL'),
    ttsProviderUrl: env('TTS_PROVIDER_URL'),
    llmProviderUrl: env('LLM_PROVIDER_URL'),
  },
  dbFile: env('LTET_DB_FILE', ''), // empty => default path under ./data
};

export function isDemoMode() {
  return APP.mode === 'demo';
}

// ---------------------------------------------------------------------------
// Default policy document (published version 1). Demo values are chosen for
// reproducibility and are labelled synthetic where the FRS gives no default.
// ---------------------------------------------------------------------------
export const DEFAULT_POLICY = {
  helpdesk_hours: { start: '09:00', end: '18:00', days: [1, 2, 3, 4, 5], timezone: 'Asia/Kolkata' },
  claims_per_call_limit: 5, // FR-14 default five
  claims_narrate_batch: 3, // FR-08 latest three first
  max_call_minutes: 12, // NFR-13 demo value; no invented production limit
  otp: { expiry_seconds: 300, max_attempts: 3, max_resends: 2, required: true }, // SEC-01: default OTP on
  identity: {
    allow_unlinked_fallback: true,
    second_factor: 'otp', // if disabled in live mode, another sufficient method must be configured or disclosure is denied
    beneficiary_name_compare: false, // FR-60 optional
  },
  stage_persona_routing: {
    'PMS Processor': 'pms_processor',
    'Sub-panel Review': 'spm',
    'Apex Panel Review': 'apm',
    'Approval': 'apm',
  },
  payment_status_mapping: {
    // FR-45: configurable raw Finance status -> caller-facing state. Unmapped values are unreadable, never guessed.
    'Credited': 'credited',
    'Processed': 'processed',
    'Pending': 'pending',
    'Failed': 'failed',
    'Held': 'held',
  },
  payment_delay_threshold_days: 7, // FR-46: DEMO-ONLY synthetic threshold; FRS specifies no production default
  delayed_payment_alert: true,
  retention: { transcript_days: 90, call_log_days: 3650 },
  busy: { max_concurrent_calls: 3, offer: ['human', 'callback', 'portal'] }, // FR-51
  human_handoff: { on_two_recognition_failures: true, on_distress: true }, // FR-25
  beneficiary: { require_trusted_binding: true }, // SEC-03: least privilege; cannot be disabled in live mode
};

const PERSONA_ROLES = ['pms_processor', 'spm', 'apm', 'admin', 'auditor'];
const STAGES = ['PMS Processor', 'Sub-panel Review', 'Apex Panel Review', 'Approval'];
const PAYMENT_GROUPS = ['credited', 'processed', 'pending', 'failed', 'held'];

const timeRe = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Validate a policy document. Returns { ok, errors: string[] }. Used by admin API and boot. */
export function validatePolicy(doc, { mode = APP.mode } = {}) {
  const errors = [];
  const push = (m) => errors.push(m);
  if (!doc || typeof doc !== 'object') return { ok: false, errors: ['policy document required'] };

  const h = doc.helpdesk_hours || {};
  if (!timeRe.test(h.start || '') || !timeRe.test(h.end || '')) push('helpdesk_hours.start/end must be HH:MM');
  if (!Array.isArray(h.days) || h.days.length === 0 || h.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) push('helpdesk_hours.days must list weekdays 0-6');
  if (h.timezone !== 'Asia/Kolkata') push('helpdesk_hours.timezone must be Asia/Kolkata for Release 1');

  const cpl = doc.claims_per_call_limit;
  if (!Number.isInteger(cpl) || cpl < 1 || cpl > 20) push('claims_per_call_limit must be an integer 1..20');
  const nb = doc.claims_narrate_batch;
  if (!Number.isInteger(nb) || nb < 1 || nb > 10) push('claims_narrate_batch must be an integer 1..10');
  const mcm = doc.max_call_minutes;
  if (!Number.isInteger(mcm) || mcm < 1 || mcm > 120) push('max_call_minutes must be an integer 1..120');

  const o = doc.otp || {};
  if (!Number.isInteger(o.expiry_seconds) || o.expiry_seconds < 60 || o.expiry_seconds > 3600) push('otp.expiry_seconds must be 60..3600');
  if (!Number.isInteger(o.max_attempts) || o.max_attempts < 1 || o.max_attempts > 10) push('otp.max_attempts must be 1..10');
  if (!Number.isInteger(o.max_resends) || o.max_resends < 0 || o.max_resends > 5) push('otp.max_resends must be 0..5');
  if (o.required === false && mode === 'live') {
    const sf = doc.identity?.second_factor;
    if (!sf || sf === 'otp') push('SEC-01: OTP disabled in live mode requires identity.second_factor set to another approved method; otherwise disclosure must be denied');
  }

  const spr = doc.stage_persona_routing || {};
  for (const s of STAGES) {
    if (!PERSONA_ROLES.includes(spr[s])) push(`stage_persona_routing missing/invalid persona for stage "${s}"`);
  }
  const psm = doc.payment_status_mapping || {};
  for (const [k, v] of Object.entries(psm)) {
    if (!PAYMENT_GROUPS.includes(v)) push(`payment_status_mapping "${k}" maps to unknown caller-facing group "${v}"`);
  }
  const dth = doc.payment_delay_threshold_days;
  if (!Number.isInteger(dth) || dth < 1 || dth > 90) push('payment_delay_threshold_days must be 1..90 (demo-labelled synthetic value)');

  const r = doc.retention || {};
  if (!Number.isInteger(r.transcript_days) || r.transcript_days < 1) push('retention.transcript_days must be >= 1');
  if (!Number.isInteger(r.call_log_days) || r.call_log_days < 30) push('retention.call_log_days must be >= 30');

  const b = doc.busy || {};
  if (!Number.isInteger(b.max_concurrent_calls) || b.max_concurrent_calls < 1 || b.max_concurrent_calls > 1000) push('busy.max_concurrent_calls must be 1..1000');
  if (!Array.isArray(b.offer) || b.offer.some((x) => !['human', 'callback', 'portal'].includes(x))) push('busy.offer must be a subset of [human, callback, portal]');

  const ben = doc.beneficiary || {};
  if (mode === 'live' && ben.require_trusted_binding !== true) {
    push('SEC-03: beneficiary.require_trusted_binding cannot be disabled in live mode');
  }
  return { ok: errors.length === 0, errors };
}
