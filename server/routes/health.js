// Health + readiness (explicit demo/live boundaries; live with missing config FAILS).
// Also carries the metered neural-voice endpoints (/api/voice/*): availability
// reporting and the audio bridges to the optional Sarvam provider. The provider
// API key stays server-side only.
import express, { Router } from 'express';
import { APP, isDemoMode, validatePolicy } from '../config.js';
import { packMeta } from '../engine/languages.js';
import { get } from '../db.js';
import { readiness as portalReadiness } from '../adapters/portal.js';
import { speechReadiness } from '../adapters/speech.js';
import { queueStats } from '../services/postcall.js';
import { sarvamConfigured, tts as sarvamTts, stt as sarvamStt, SARVAM_SPEAKERS, ttsLangs, sttLangs } from '../adapters/sarvam.js';

const r = Router();

// Metered limiter for the neural-voice audio bridges: they proxy a paid
// provider, so each path gets a bounded per-minute budget per client.
function voiceMeter(maxPerMinute) {
  const buckets = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const b = buckets.get(req.ip) || { count: 0, reset: now + 60000 };
    if (now > b.reset) { b.count = 0; b.reset = now + 60000; }
    b.count += 1;
    buckets.set(req.ip, b);
    if (buckets.size > 2000) buckets.clear();
    if (b.count > maxPerMinute) return res.status(429).json({ error: 'rate_limited', message: 'voice budget exhausted for this minute' });
    next();
  };
}

/** Neural availability without secrets — the console shows coverage honestly. */
r.get('/voice/status', (_req, res) => {
  const on = sarvamConfigured();
  res.json({
    neural_tts: on,
    neural_stt: on,
    engine: on ? 'sarvam-ai' : 'device',
    tts_langs: on ? ttsLangs() : [],
    stt_langs: on ? sttLangs() : [],
    speakers: SARVAM_SPEAKERS,
    note: on
      ? 'neural voice replies active (Sarvam Bulbul); languages outside tts_langs use device voices'
      : 'no SARVAM_API_KEY configured — browser device voices with typed-input fallback',
  });
});

/** Render engine-validated reply text to neural audio (base64 JSON keeps the
 *  boundary simple and lets the browser decode without special handling). */
r.post('/voice/tts', voiceMeter(40), async (req, res, next) => {
  try {
    const body = req.body || {};
    const audio = await sarvamTts(body.text, body.lang, { speaker: body.speaker });
    res.json({ audio_base64: audio.bytes.toString('base64'), mime: audio.mime });
  } catch (e) { next(e); }
});

/** Transcribe a caller utterance (client-encoded 16 kHz mono WAV). The body is
 *  collected with an explicit size cap; language detection is automatic. */
r.post('/voice/stt', voiceMeter(40), (req, res, next) => {
  const chunks = [];
  let total = 0;
  let tooLarge = false;
  req.on('data', (chunk) => {
    total += chunk.length;
    if (total > 12582912) { tooLarge = true; chunks.length = 0; req.destroy(); return; }
    chunks.push(chunk);
  });
  req.on('end', () => {
    if (tooLarge) return res.status(413).json({ error: 'stt_audio_too_large', message: 'audio exceeds 12 MB' });
    if (!chunks.length) return res.status(415).json({ error: 'stt_audio_invalid', message: 'send audio bytes (16 kHz mono wav recommended)' });
    sarvamStt(Buffer.concat(chunks), 'audio/wav', undefined)
      .then((out) => res.json(out))
      .catch(next);
  });
  req.on('error', next);
});

r.get('/health', (_req, res) => {
  res.json({ ok: true, mode: APP.mode, version: APP.version, at: new Date().toISOString() });
});

/** Language catalogue (metadata only — safe for the console to consume). */
r.get('/languages', (_req, res) => {
  const packs = packMeta();
  res.json({
    total: packs.length,
    frs_core: packs.filter((p) => p.catalogue === 'frs-core').map((p) => ({ ...p })),
    extended: packs.filter((p) => p.catalogue === 'extended').map((p) => ({ ...p })),
  });
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
