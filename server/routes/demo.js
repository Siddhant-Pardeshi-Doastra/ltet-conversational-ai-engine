// Demo-only tools: reset, scenario presets, fault injection, isolated mock OTP
// inbox, integration health. EVERY route here is hard-blocked in live mode.
import { Router } from 'express';
import { attachSession, requireAuth } from '../auth/sessions.js';
import { isDemoMode } from '../config.js';
import { seed } from '../seed.js';
import { SCENARIOS } from '../services/scenarios.js';
import { setFault, readiness as portalReadiness } from '../adapters/portal.js';
import { speechReadiness } from '../adapters/speech.js';
import { all, get } from '../db.js';
import { toIst } from '../util.js';
import { audit } from '../services/audit.js';
import { queueStats } from '../services/postcall.js';

const r = Router();
r.use(attachSession, requireAuth);

function demoGate(req, res) {
  if (!isDemoMode()) {
    res.status(403).json({ error: 'demo_tools_blocked_in_live_mode' });
    return false;
  }
  return true;
}

r.post('/demo/reset', (req, res) => {
  if (!demoGate(req, res)) return;
  audit({ actorType: 'staff', actorId: req.staff.user.id, action: 'demo.reset' });
  const result = seed({ force: true });
  res.json({ ok: true, result });
});

r.get('/demo/scenarios', (_req, res) => {
  res.json({ scenarios: SCENARIOS });
});

r.post('/demo/faults', (req, res) => {
  if (!demoGate(req, res)) return;
  const { name, on } = req.body || {};
  try {
    const result = setFault(name, !!on, req.staff.user.id);
    audit({ actorType: 'staff', actorId: req.staff.user.id, action: 'demo.fault', objectType: 'fault', objectId: name, detail: { on: !!on } });
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(422).json({ error: e.message });
  }
});

r.get('/demo/faults', (req, res) => {
  if (!demoGate(req, res)) return;
  const rows = all(`SELECT name, value FROM counters WHERE name LIKE 'fault:%'`);
  res.json({ faults: Object.fromEntries(rows.map((f) => [f.name.replace('fault:', ''), Number(f.value) === 1])) });
});

/**
 * Isolated mock SMS inbox (SEC-04): simulates the synthetic user's phone.
 * DEMO ONLY — this endpoint does not exist in live mode and codes never appear
 * in transcripts, logs, analytics or the conversation.
 */
r.get('/demo/inbox', (req, res) => {
  if (!demoGate(req, res)) return;
  const { session_id } = req.query;
  const rows = session_id
    ? all(`SELECT * FROM mock_otp_inbox WHERE session_id = ? ORDER BY id DESC LIMIT 20`, session_id)
    : all(`SELECT * FROM mock_otp_inbox ORDER BY id DESC LIMIT 20`);
  res.json({
    inbox_label: 'Secure message inbox — isolated verification channel for the verified user\'s device. Kept separate from all engine records.',
    messages: rows.map((m) => ({ ...m, at_ist: toIst(m.at) })),
  });
});

// Integration health & readiness (explicit real-vs-mock boundaries).
r.get('/demo/health', (_req, res) => {
  res.json({
    integrations: [
      ...portalReadiness(),
      ...speechReadiness(),
      { integration: 'IR-01 telephony', status: 'simulator_demo', detail: 'built-in call channel implements the audio/keypad/event contract; carrier connectivity is operator-managed' },
      { integration: 'IR-07 helpdesk writes', status: 'local', detail: 'call logs, history, alerts and notes persisted in the platform data service; LTET Helpdesk API contract pending' },
      { integration: 'IR-18 carrier routing', status: 'not_configured', detail: 'toll-free carrier routing and failover are external operator configuration' },
      { integration: 'IR-17 recordings', status: 'disabled', detail: 'audio storage disabled by policy pending approved consent/storage policy (SEC-07)' },
    ],
    worker: queueStats(),
  });
});

export default r;
