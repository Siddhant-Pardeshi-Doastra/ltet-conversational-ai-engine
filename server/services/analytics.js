// Analytics over stored records (FR-29, FR-31). All numbers derive from
// call_logs/call_claim_entries/alerts/events with documented definitions and
// denominators (docs/WORKFLOWS.md § Analytics definitions). No invented data.
import { all, get, run } from '../db.js';
import { nowIso, istDateKey, istWeekKey } from '../util.js';
import { audit } from './audit.js';

export function overview({ days = 14 } = {}) {
  const since = new Date(Date.now() - days * 86400000).toISOString();

  const logs = all(
    `SELECT * FROM call_logs WHERE created_at >= ? AND retention_deleted IS NULL ORDER BY created_at`,
    since
  );

  const byOutcome = {}; const byLanguage = {}; const byDay = {};
  for (const l of logs) {
    byOutcome[l.outcome] = (byOutcome[l.outcome] || 0) + 1;
    byLanguage[l.language] = (byLanguage[l.language] || 0) + 1;
    const day = istDateKey(l.created_at);
    byDay[day] = byDay[day] || { day, total: 0, resolved: 0, escalated: 0, verification_failed: 0, abandoned: 0 };
    byDay[day].total += 1;
    if (byDay[day][l.outcome] !== undefined) byDay[day][l.outcome] += 1;
  }

  const drivers = {};
  for (const l of logs) {
    try {
      const s = JSON.parse(l.summary || '{}');
      const key = s.intent || 'other';
      drivers[key] = (drivers[key] || 0) + 1;
    } catch { /* summary always JSON; defensive */ }
  }

  // Repeat callers per claim (FR-29): sessions discussing the same claim.
  const repeatRows = all(
    `SELECT e.claim_id, COUNT(DISTINCT e.session_id) AS sessions
     FROM call_claim_entries e JOIN call_logs l ON l.session_id = e.session_id
     WHERE l.created_at >= ? AND l.retention_deleted IS NULL
     GROUP BY e.claim_id HAVING sessions > 1 ORDER BY sessions DESC LIMIT 10`,
    since
  );

  // Stage & payment mix from logged facts.
  const stageMix = {}; const paymentMix = {}; const issues = { failed: 0, held: 0, delayed: 0, unmapped: 0 };
  for (const l of logs) {
    let facts = [];
    try { facts = JSON.parse(l.facts_given || '[]'); } catch { facts = []; }
    for (const f of facts) {
      for (const t of f.topics || []) {
        if (t === 'claim_stage_answer') stageMix[f.stage || 'unknown'] = (stageMix[f.stage || 'unknown'] || 0) + 1;
      }
      if (f.payment_group) paymentMix[f.payment_group] = (paymentMix[f.payment_group] || 0) + 1;
      if (f.payment_group === 'failed') issues.failed += 1;
      if (f.payment_group === 'held') issues.held += 1;
      if (f.delayed) issues.delayed += 1;
      if (f.payment_group === 'unreadable') issues.unmapped += 1;
    }
  }

  const ended = logs.length;
  const resolved = byOutcome.resolved || 0;
  const escalated = byOutcome.escalated || 0;
  const containment = ended ? +(resolved / ended * 100).toFixed(1) : 0;
  const escalationRate = ended ? +(escalated / ended * 100).toFixed(1) : 0;

  const lat = get(`SELECT AVG(answer_start_ms) AS avg, MAX(answer_start_ms) AS max FROM call_latency WHERE session_id IN (SELECT session_id FROM call_logs WHERE created_at >= ?)`, since);
  const alertsOpen = get(`SELECT COUNT(*) AS c FROM alerts WHERE status = 'pending'`).c;
  const callbacksOpen = get(`SELECT COUNT(*) AS c FROM callback_requests WHERE status = 'open'`).c;
  const openQueries = get(`SELECT COUNT(*) AS c FROM portal_processor_queries WHERE status = 'Open'`).c;

  return {
    window_days: days,
    calls_total: ended,
    by_outcome: byOutcome,
    by_language: byLanguage,
    by_day: Object.values(byDay).sort((a, b) => a.day.localeCompare(b.day)),
    drivers,
    repeat_callers_by_claim: repeatRows,
    stage_mix: stageMix,
    payment_mix: paymentMix,
    payment_issues: issues,
    containment_percent: containment, // definition: resolved / ended calls in window
    escalation_rate_percent: escalationRate,
    latency_simulator: { avg_ms: Math.round(lat?.avg || 0), max_ms: lat?.max || 0, note: 'local simulator measurement; not a production telephony metric' },
    alerts_open: alertsOpen,
    callbacks_open: callbacksOpen,
    open_processor_queries: openQueries,
  };
}

export function generateReport(kind, actor) {
  const period = kind === 'weekly' ? istWeekKey() : istDateKey();
  const data = overview({ days: kind === 'weekly' ? 7 : 1 });
  const id = `RPT-${kind}-${period}`;
  run(
    `INSERT OR IGNORE INTO reports(id, kind, period, generated_at, generated_by, data) VALUES (?,?,?,?,?,?)`,
    id, kind, period, nowIso(), actor, JSON.stringify(data)
  );
  audit({ actorType: 'staff', actorId: actor, action: 'report.generated', objectType: 'report', objectId: id, detail: { kind, period } });
  const row = get(`SELECT * FROM reports WHERE id = ?`, id);
  return row ? { ...row, data: JSON.parse(row.data) } : null;
}

export function listReports() {
  return all(`SELECT id, kind, period, generated_at, generated_by FROM reports ORDER BY generated_at DESC LIMIT 50`);
}

export function getReport(id) {
  const row = get(`SELECT * FROM reports WHERE id = ?`, id);
  return row ? { ...row, data: JSON.parse(row.data) } : null;
}
