// Processor alert service (FR-30, FR-35).
// - Deduplication preserves different genuine calls/issues: the dedupe key
//   includes the session, so two real calls never collapse into one alert.
// - Routing uses the configured stage->persona mapping (FR-30). Missing routing
//   creates an administrator-visible UNROUTED task, never silent loss.
import { run, get } from '../db.js';
import { nowIso, alertId } from '../util.js';
import { getPublishedPolicy } from './policy.js';

export function raiseAlert({ type, claimId = null, stage = null, sessionId = null, severity = 'medium', detail = {}, extraDedupe = '' }) {
  const policy = getPublishedPolicy();
  const persona = stage ? policy.stage_persona_routing[stage] : null;
  const routed = !!persona || ['payment_dispute', 'unrouted_admin'].includes(type);
  const dedupeKey = `${type}:${sessionId || 'sys'}:${claimId || 'noclaim'}:${extraDedupe}`;
  // INSERT OR IGNORE => duplicate webhook/retry of the same call+issue cannot
  // duplicate the alert, while a different session/claim always creates its own.
  const res = run(
    `INSERT OR IGNORE INTO alerts(id, dedupe_key, type, severity, stage, persona_role, claim_id, session_id, created_at, status, detail, routing_state)
     VALUES (?,?,?,?,?,?,?,?,?,'pending',?,?)`,
    alertId(), dedupeKey, type, severity, stage, persona, claimId, sessionId, nowIso(), JSON.stringify(detail), routed ? 'routed' : 'unrouted'
  );
  return { created: res.changes === 1, dedupeKey };
}

export function routePersonaForStage(stage) {
  const policy = getPublishedPolicy();
  return stage ? policy.stage_persona_routing[stage] || null : null;
}

export function alertCount() {
  return get(`SELECT COUNT(*) AS c FROM alerts WHERE status = 'pending'`).c;
}
