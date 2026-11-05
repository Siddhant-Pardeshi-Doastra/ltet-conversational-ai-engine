// Health + readiness (explicit demo/live boundaries; live with missing config FAILS).
import { Router } from 'express';
import { APP, isDemoMode, validatePolicy } from '../config.js';
import { get } from '../db.js';
import { readiness as portalReadiness } from '../adapters/portal.js';
import { speechReadiness } from '../adapters/speech.js';
import { queueStats } from '../services/postcall.js';
import { packMeta } from '../engine/languages.js';

const r = Router();

r.get('/health', (_req, res) => {
  res.json({ ok: true, mode: APP.mode, at: new Date().toISOString() });
});

r.get('/readiness', (_req, res) => {
  const integrations = [...portalReadiness(), ...speechReadiness()];
  const blocking = [];
  if (APP.mode === 'live') {
    for (const i of integrations) if (i.status === 'not_configured') blocking.push(i.integration);
    if (!APP.sessionSecret || APP.sessionSecret.startsWith('demo-only')) blocking.push('SESSION_SECRET');
    if (!APP.telephonyWebhookSecret) blocking.push('TELEPHONY_WEBHOOK_SECRET');
  }
  const seeded = get(`SELECT COUNT(*) AS c FROM portal_employees`).c > 0;
  if (!seeded) blocking.push('database_not_seeded');
  const policy = get(`SELECT doc FROM policy_configs WHERE status = 'published' ORDER BY version DESC LIMIT 1`);
  if (policy) {
    const v = validatePolicy(JSON.parse(policy.doc));
    if (!v.ok) blocking.push(...v.errors.map((e) => `policy: ${e}`));
  }
  const packs = packMeta();
  res.json({
    mode: APP.mode,
    ready: blocking.length === 0,
    blocking,
    demo_mode: isDemoMode(),
    note: APP.mode === 'live'
      ? 'Production mode: private workflows stay disabled until every blocker is resolved. No dataset fallback exists.'
      : 'Workspace mode: locally managed dataset with full platform capability; readiness checks enforced.',
    integrations,
    languages: {
      configured: packs.length,
      native_approved: packs.filter((p) => p.launch_ready).length,
      draft: packs.filter((p) => !p.launch_ready).map((p) => p.lang),
      note: 'dropdowns + translated strings exist; per-language audio evaluation and native-speaker sign-off still pending (FR-37)',
    },
    worker: queueStats(),
    recordings_enabled: APP.enableCallRecordings,
  });
});

export default r;
