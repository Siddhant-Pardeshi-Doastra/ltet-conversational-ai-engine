// Staff authentication: scrypt password hashes, server-side sessions in DB,
// httpOnly signed cookie, RBAC helpers. UI hiding is never access control (SEC-05).
import { getDb, run, get } from '../db.js';
import { newToken, hashPassword, verifyPassword, nowIso, parseCookies, serializeCookie } from '../util.js';
import { APP, isDemoMode } from '../config.js';

export const SESSION_COOKIE = 'ltet_staff';
const SESSION_TTL_MS = 8 * 3600 * 1000;

export const ROLE_SCOPES = {
  // Transcript/recording access is role-aware (FR-36); summaries are the processor default.
  pms_processor: { transcripts: false, analytics: true, admin: false, queue_stages: ['PMS Processor'] },
  spm: { transcripts: false, analytics: true, admin: false, queue_stages: ['Sub-panel Review'] },
  apm: { transcripts: false, analytics: true, admin: false, queue_stages: ['Apex Panel Review', 'Approval'] },
  admin: { transcripts: true, analytics: true, admin: true, queue_stages: ['PMS Processor', 'Sub-panel Review', 'Apex Panel Review', 'Approval'] },
  auditor: { transcripts: true, analytics: true, admin: false, queue_stages: [] },
};

export function staffCount() {
  return get(`SELECT COUNT(*) AS c FROM staff_users`).c;
}

export function createStaffUser({ id, username, displayName, role, password }) {
  run(
    `INSERT INTO staff_users(id, username, display_name, role, password_hash, is_active, created_at) VALUES (?,?,?,?,?,1,?)`,
    id, username.toLowerCase(), displayName, role, hashPassword(password), nowIso()
  );
}

export function login(username, password) {
  const user = get(`SELECT * FROM staff_users WHERE username = ? AND is_active = 1`, String(username || '').toLowerCase());
  if (!user || !verifyPassword(password, user.password_hash)) return null;
  const token = newToken();
  const now = Date.now();
  run(`INSERT INTO staff_sessions(token, user_id, created_at, expires_at) VALUES (?,?,?,?)`,
    token, user.id, nowIso(), new Date(now + SESSION_TTL_MS).toISOString());
  return { token, user: publicUser(user) };
}

export function logout(token) {
  if (token) run(`DELETE FROM staff_sessions WHERE token = ?`, token);
}

function publicUser(u) {
  return { id: u.id, username: u.username, displayName: u.display_name, role: u.role, scopes: ROLE_SCOPES[u.role] ?? {} };
}

export function resolveSession(req) {
  const cookies = parseCookies(req.headers.cookie || '');
  const token = cookies[SESSION_COOKIE];
  if (!token) return null;
  const row = get(
    `SELECT s.token, s.expires_at, u.* FROM staff_sessions s JOIN staff_users u ON u.id = s.user_id WHERE s.token = ?`,
    token
  );
  if (!row) return null;
  if (row.expires_at < nowIso()) {
    run(`DELETE FROM staff_sessions WHERE token = ?`, token);
    return null;
  }
  return { token, user: publicUser(row) };
}

export function attachSession(req, _res, next) {
  req.staff = resolveSession(req);
  next();
}

export function requireAuth(req, res, next) {
  if (!req.staff) return res.status(401).json({ error: 'authentication_required' });
  next();
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.staff) return res.status(401).json({ error: 'authentication_required' });
    if (!roles.includes(req.staff.user.role)) return res.status(403).json({ error: 'forbidden', need_role: roles });
    next();
  };
}

export function requireAdmin(req, res, next) {
  return requireRole('admin')(req, res, next);
}

export function canViewTranscripts(user) {
  return ROLE_SCOPES[user?.role]?.transcripts === true;
}

/**
 * Demo role switcher (SEC-05): confined to synthetic demo mode. Switches to the
 * seeded demo user of that role; in live mode this endpoint is impossible to
 * enable (403 + audited attempt).
 */
export function demoSwitchRole(req, res) {
  if (!isDemoMode()) {
    return res.status(403).json({ error: 'demo_role_switch_disabled_in_live_mode' });
  }
  const { role } = req.body || {};
  const roleUser = {
    pms_processor: 'pms1', spm: 'spm1', apm: 'apm1', admin: 'admin1', auditor: 'auditor1',
  }[role];
  if (!roleUser) return res.status(422).json({ error: 'unknown_role' });
  const result = login(roleUser, DEMO_STAFF_PASSWORD);
  if (!result) return res.status(500).json({ error: 'demo user missing; reseed required' });
  res.setHeader('Set-Cookie', serializeCookie(SESSION_COOKIE, result.token, { maxAge: SESSION_TTL_MS / 1000 }));
  res.json({ user: result.user, mode: APP.mode });
}

import { DEMO_STAFF_PASSWORD } from './demo-credentials.js';
