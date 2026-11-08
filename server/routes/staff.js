// Processor work queue, callbacks, notes, claim context, analytics (staff RBAC).
import { Router } from 'express';
import { attachSession, requireAuth, ROLE_SCOPES } from '../auth/sessions.js';
import { run, get, all } from '../db.js';
import { nowIso, toIst, formatInr } from '../util.js';
import { audit } from '../services/audit.js';
import { overview, generateReport, listReports, getReport } from '../services/analytics.js';
import { getPublishedPolicy } from '../services/policy.js';

const r = Router();
r.use(attachSession, requireAuth);

// ---------------------------------------------------------------------------
// Processor alert queue (FR-35): persona-scoped, acknowledge/close, persisted.
// ---------------------------------------------------------------------------
r.get('/queue/alerts', (req, res) => {
  const user = req.staff.user;
  const scopes = ROLE_SCOPES[user.role] || {};
  const stages = scopes.queue_stages || [];
  let rows;
  if (user.role === 'admin' || user.role === 'auditor') {
    rows = all(`SELECT * FROM alerts ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, created_at DESC LIMIT 200`);
  } else {
    // persona-scoped queue (FR-30): map the role's stages to persona role ids.
    // Unrouted alerts stay admin-visible only (never silently lost).
    const policy = getPublishedPolicy();
    const personas = [...new Set(stages.map((s) => policy.stage_persona_routing[s]).filter(Boolean))];
    rows = personas.length
      ? all(
        `SELECT * FROM alerts WHERE persona_role IN (${personas.map(() => '?').join(',')})
         ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, created_at DESC LIMIT 200`,
        ...personas
      )
      : [];
  }
  res.json({
    alerts: rows.map((a) => ({ ...a, detail: JSON.parse(a.detail || '{}'), created_at_ist: toIst(a.created_at) })),
    scope: { role: user.role, stages },
  });
});

function alertAction(req, res, action) {
  const a = get(`SELECT * FROM alerts WHERE id = ?`, req.params.id);
  if (!a) return res.status(404).json({ error: 'alert_not_found' });
  const user = req.staff.user;
  const scopes = ROLE_SCOPES[user.role] || {};
  const allowed = user.role === 'admin' || user.role === 'auditor' || (a.persona_role && a.persona_role === user.role);
  if (!allowed) return res.status(403).json({ error: 'not_your_queue' });
  if (action === 'ack') {
    run(`UPDATE alerts SET status = 'acknowledged', acknowledged_by = ?, acknowledged_at = ? WHERE id = ? AND status = 'pending'`, user.id, nowIso(), a.id);
  } else {
    run(`UPDATE alerts SET status = 'closed', closed_by = ?, closed_at = ? WHERE id = ? AND status IN ('pending','acknowledged')`, user.id, nowIso(), a.id);
  }
  audit({ actorType: 'staff', actorId: user.id, action: `alert.${action}`, objectType: 'alert', objectId: a.id });
  res.json({ ok: true, alert: get(`SELECT * FROM alerts WHERE id = ?`, a.id) });
}
r.post('/alerts/:id/ack', (req, res) => alertAction(req, res, 'ack'));
r.post('/alerts/:id/close', (req, res) => alertAction(req, res, 'close'));

// ---------------------------------------------------------------------------
// Callback requests (human service tasks; no proactive AI campaigns).
// ---------------------------------------------------------------------------
r.get('/callbacks', (_req, res) => {
  const rows = all(`SELECT * FROM callback_requests ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END, created_at DESC LIMIT 200`);
  res.json({ callbacks: rows.map((c) => ({ ...c, callback_number: c.callback_number === 'withheld' ? 'withheld' : `${String(c.callback_number).slice(0, 3)}••••${String(c.callback_number).slice(-3)}` })) });
});
r.post('/callbacks/:id/status', (req, res) => {
  const { status } = req.body || {};
  if (!['open', 'assigned', 'done', 'cancelled'].includes(status)) return res.status(422).json({ error: 'bad_status' });
  run(`UPDATE callback_requests SET status = ?, updated_at = ? WHERE id = ?`, status, nowIso(), req.params.id);
  audit({ actorType: 'staff', actorId: req.staff.user.id, action: 'callback.status', objectType: 'callback_request', objectId: req.params.id, detail: { status } });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Processor notes (append-only, separate from immutable logs — FR-34).
// ---------------------------------------------------------------------------
r.post('/notes', (req, res) => {
  const { call_log_id, claim_id, text } = req.body || {};
  if (!text || !call_log_id) return res.status(422).json({ error: 'call_log_id_and_text_required' });
  const log = get(`SELECT id FROM call_logs WHERE id = ?`, call_log_id);
  if (!log) return res.status(404).json({ error: 'call_log_not_found' });
  run(`INSERT INTO processor_notes(call_log_id, claim_id, author_user, at, text) VALUES (?,?,?,?,?)`,
    call_log_id, claim_id || null, req.staff.user.id, nowIso(), String(text).slice(0, 4000));
  audit({ actorType: 'staff', actorId: req.staff.user.id, action: 'note.added', objectType: 'call_log', objectId: call_log_id });
  res.status(201).json({ ok: true });
});
r.get('/notes', (req, res) => {
  const { call_log_id } = req.query;
  const rows = call_log_id
    ? all(`SELECT * FROM processor_notes WHERE call_log_id = ? ORDER BY id DESC`, call_log_id)
    : all(`SELECT * FROM processor_notes ORDER BY id DESC LIMIT 100`);
  res.json({ notes: rows });
});

// ---------------------------------------------------------------------------
// Claim Context (read-only; no claim edit/approve/payment controls — FR/§5.5).
// ---------------------------------------------------------------------------
r.get('/claims/:id/context', (req, res) => {
  const claim = get(
    `SELECT c.*, s.label AS scheme_label, s.category AS scheme_category
     FROM portal_claims c JOIN portal_schemes s ON s.id = c.scheme_id WHERE c.id = ?`,
    req.params.id
  );
  if (!claim) return res.status(404).json({ error: 'claim_not_found' });
  const user = req.staff.user;
  const scopes = ROLE_SCOPES[user.role] || {};
  if (user.role !== 'admin' && user.role !== 'auditor') {
    // processors see claims relevant to their stage queues or with open queries on their stage
    const q = get(`SELECT * FROM portal_processor_queries WHERE claim_id = ? AND status = 'Open'`, claim.id);
    const stageOk = claim.stage && (scopes.queue_stages || []).includes(claim.stage);
    const queryStageOk = q && (scopes.queue_stages || []).includes(q.stage);
    if (!stageOk && !queryStageOk) return res.status(403).json({ error: 'claim_outside_your_stage_scope' });
  }
  const query = get(`SELECT * FROM portal_processor_queries WHERE claim_id = ? AND status = 'Open' ORDER BY raised_at DESC`, claim.id);
  const payment = get(`SELECT * FROM portal_finance_payments WHERE claim_id = ?`, claim.id);
  const history = all(`SELECT * FROM claim_document_history WHERE claim_id = ? ORDER BY at DESC LIMIT 50`, claim.id);
  const callEntries = all(
    `SELECT e.*, l.outcome, l.language, l.created_at AS log_created FROM call_claim_entries e
     JOIN call_logs l ON l.session_id = e.session_id WHERE e.claim_id = ? ORDER BY e.first_discussed_at DESC LIMIT 20`,
    claim.id
  );
  res.json({
    claim: {
      ...claim,
      amount_display: formatInr(claim.amount_minor),
      ps_no_masked: `${claim.ps_no.slice(0, 2)}••••${claim.ps_no.slice(-2)}`,
      ps_no: undefined,
    },
    open_query: query || null,
    payment: payment || null,
    document_history: history,
    call_entries: callEntries,
    source_note: 'platform data service; freshness = record updated_at',
    payment_freshness: payment?.updated_at || null,
  });
});

r.get('/claims', (req, res) => {
  const { q, limit = 50 } = req.query;
  const user = req.staff.user;
  const rows = all(
    `SELECT c.id, c.ps_no, c.status, c.stage, c.submitted_at, c.amount_minor, s.label AS scheme_label
     FROM portal_claims c JOIN portal_schemes s ON s.id = c.scheme_id
     WHERE c.id LIKE ? OR c.ps_no LIKE ? ORDER BY c.submitted_at DESC LIMIT ?`,
    `%${q || ''}%`, `%${q || ''}%`, Number(limit)
  );
  const scopes = ROLE_SCOPES[user.role] || {};
  res.json({
    claims: rows.map((c) => ({
      ...c,
      amount_display: formatInr(c.amount_minor),
      ps_no_masked: `${c.ps_no.slice(0, 2)}••••${c.ps_no.slice(-2)}`,
      ps_no: undefined,
      in_your_scope: user.role === 'admin' || user.role === 'auditor' || (scopes.queue_stages || []).includes(c.stage),
    })),
  });
});

// ---------------------------------------------------------------------------
// Analytics (FR-29) + reports (FR-31).
// ---------------------------------------------------------------------------
r.get('/analytics/overview', (req, res) => {
  res.json(overview({ days: Number(req.query.days || 14) }));
});
r.get('/analytics/reports', (_req, res) => res.json({ reports: listReports() }));
r.post('/analytics/reports/generate', (req, res) => {
  const { kind } = req.body || {};
  if (!['daily', 'weekly'].includes(kind)) return res.status(422).json({ error: 'kind_must_be_daily_or_weekly' });
  const rep = generateReport(kind, req.staff.user.id);
  res.status(201).json({ report: rep });
});
r.get('/analytics/reports/:id', (req, res) => {
  const rep = getReport(req.params.id);
  if (!rep) return res.status(404).json({ error: 'report_not_found' });
  res.json({ report: rep });
});

export default r;
