// Telephony webhook (IR-01) — the live-mode boundary for carrier events.
// SEC-07: HMAC-SHA256 signature, timestamp freshness and nonce replay
// protection are all REQUIRED. The demo simulator does not use this endpoint.
import { Router } from 'express';
import { APP } from '../config.js';
import { hmacSha256, safeEqual, nowIso } from '../util.js';
import { run, get } from '../db.js';
import { createCallSession, dispatch, hangup, getSession } from '../services/calls.js';

const r = Router();
const REPLAY_WINDOW_MS = 5 * 60 * 1000;

r.post('/telephony/webhook', (req, res) => {
  if (!APP.telephonyWebhookSecret) {
    return res.status(503).json({ error: 'webhook_not_configured', detail: 'TELEPHONY_WEBHOOK_SECRET is required for live telephony events' });
  }
  const sig = req.header('x-ltet-signature') || '';
  const ts = req.header('x-ltet-timestamp') || '';
  const nonce = req.header('x-ltet-nonce') || '';
  if (!sig.startsWith('sha256=') || !ts || !nonce) {
    return res.status(401).json({ error: 'missing_signature_headers' });
  }
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum) || Math.abs(Date.now() - tsNum) > REPLAY_WINDOW_MS) {
    return res.status(401).json({ error: 'stale_timestamp' });
  }
  const expected = hmacSha256(APP.telephonyWebhookSecret, `${ts}.${req.rawBody}`);
  if (!safeEqual(`sha256=${expected}`, sig)) {
    return res.status(401).json({ error: 'invalid_signature' });
  }
  const seen = get(`SELECT nonce FROM webhook_nonces WHERE nonce = ?`, nonce);
  if (seen) return res.status(401).json({ error: 'replayed_nonce' });
  run(`INSERT INTO webhook_nonces(nonce, at) VALUES (?,?)`, nonce, nowIso());

  const { event, call_id, from, text, digits, expected: expectedHangup } = req.body || {};
  try {
    if (event === 'call.started') {
      const { session, result } = createCallSession({ callerNumber: from || null, transport: 'telephony' });
      return res.status(201).json({ call_id: session.id, state: result.state, replies: result.replies });
    }
    const s = call_id ? getSession(call_id) : null;
    if (!s) return res.status(404).json({ error: 'call_not_found' });
    if (event === 'hangup') {
      const result = hangup(s.id, { expected: !!expectedHangup });
      return res.json({ state: result?.state ?? 'ended' });
    }
    if (event === 'utterance') {
      const result = dispatch(s, { type: 'utterance', text: String(text || '') });
      return res.json({ state: result.state, replies: result.replies });
    }
    if (event === 'keypad') {
      const result = dispatch(s, { type: 'keypad', digits: String(digits || '') });
      return res.json({ state: result.state, replies: result.replies });
    }
    return res.status(422).json({ error: 'unknown_event' });
  } catch (e) {
    return res.status(500).json({ error: 'event_processing_failed' });
  }
});

export default r;
