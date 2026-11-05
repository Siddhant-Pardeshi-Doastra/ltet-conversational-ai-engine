// Staff auth routes.
import { Router } from 'express';
import { login, logout, attachSession, requireAuth, demoSwitchRole, SESSION_COOKIE } from '../auth/sessions.js';
import { audit } from '../services/audit.js';
import { isDemoMode, APP } from '../config.js';
import { parseCookies } from '../util.js';

const r = Router();

r.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  const result = login(username, password);
  if (!result) {
    audit({ actorType: 'anonymous', actorId: username || null, action: 'auth.login_failed' });
    return res.status(401).json({ error: 'invalid_credentials' });
  }
  res.setHeader('Set-Cookie', `ltet_staff=${encodeURIComponent(result.token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${8 * 3600}`);
  audit({ actorType: 'staff', actorId: result.user.id, action: 'auth.login' });
  res.json({ user: result.user, mode: APP.mode });
});

r.post('/logout', (req, res) => {
  const cookies = parseCookies(req.headers.cookie || '');
  logout(cookies[SESSION_COOKIE]);
  res.setHeader('Set-Cookie', 'ltet_staff=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
  res.json({ ok: true });
});

r.get('/me', attachSession, (req, res) => {
  if (!req.staff) return res.status(401).json({ error: 'authentication_required' });
  res.json({ user: req.staff.user, mode: APP.mode, demo_mode: isDemoMode() });
});

// SEC-05: demo-only role switcher (403 in live mode, audited).
r.post('/switch-role', attachSession, requireAuth, (req, res) => {
  audit({ actorType: 'staff', actorId: req.staff.user.id, action: 'auth.role_switch_attempt', detail: { role: req.body?.role } });
  demoSwitchRole(req, res);
});

export default r;
