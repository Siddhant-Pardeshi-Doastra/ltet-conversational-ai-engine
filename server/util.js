// Shared utilities: ids, time, money, crypto, cookies, masking.
import { createHash, createHmac, randomBytes, randomInt, scryptSync, timingSafeEqual } from 'node:crypto';

// ---------------------------------------------------------------------------
// Time: store ISO-8601 UTC strings; display team-facing times in Asia/Kolkata.
// ---------------------------------------------------------------------------
export function nowIso() {
  return new Date().toISOString();
}

export function toIst(iso, { withDate = true } = {}) {
  if (!iso) return '';
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour12: false,
    ...(withDate ? { year: 'numeric', month: 'short', day: '2-digit' } : {}),
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t)?.value ?? '';
  if (withDate) return `${get('day')}-${get('month')}-${get('year')} ${get('hour')}:${get('minute')}:${get('second')} IST`;
  return `${get('hour')}:${get('minute')}:${get('second')} IST`;
}

export function istDateKey(iso = nowIso()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso)); // YYYY-MM-DD
}

export function istWeekKey(iso = nowIso()) {
  const d = new Date(istDateKey(iso) + 'T12:00:00+05:30');
  const day = (d.getUTCDay() + 6) % 7; // Monday=0
  d.setUTCDate(d.getUTCDate() - day);
  return istDateKey(d.toISOString());
}

export function istWeekdayIndex(iso = nowIso()) {
  const d = new Date(iso);
  const label = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Kolkata', weekday: 'short' }).format(d);
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(label);
}

export function istHour(iso = nowIso()) {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour12: false, hour: '2-digit' }).format(new Date(iso)));
}

export function istMinute(iso = nowIso()) {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour12: false, minute: '2-digit' }).format(new Date(iso)));
}

export function daysAgoIso(n, hourOffset = 0) {
  const d = new Date(Date.now() - n * 86400000 - hourOffset * 3600000);
  return d.toISOString();
}

// ---------------------------------------------------------------------------
// Money: integer minor units (paise). Never floating point.
// ---------------------------------------------------------------------------
export function formatInr(minor) {
  if (minor === null || minor === undefined) return 'Unknown';
  const negative = minor < 0;
  const abs = Math.abs(Math.trunc(minor));
  const rupees = Math.floor(abs / 100);
  const paise = abs % 100;
  const rs = String(rupees);
  const last3 = rs.slice(-3);
  const rest = rs.slice(0, -3);
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}` : last3;
  return `${negative ? '-' : ''}₹${grouped}.${paise.toString().padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// IDs
// ---------------------------------------------------------------------------
export function shortId(prefix, n = 8) {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let s = '';
  for (let i = 0; i < n; i++) s += alphabet[randomInt(0, alphabet.length)];
  return `${prefix}-${s}`;
}

export function callSessionId() { return shortId('CS'); }
export function callLogId() { return shortId('CL'); }
export function alertId() { return shortId('AL'); }
export function callbackId() { return shortId('CB'); }
export function jobId() { return shortId('JB'); }
export function randomDigits(n = 6) {
  let s = '';
  for (let i = 0; i < n; i++) s += randomInt(0, 10).toString();
  return s;
}

// ---------------------------------------------------------------------------
// Crypto / secrets
// ---------------------------------------------------------------------------
export function sha256(v) { return createHash('sha256').update(String(v)).digest('hex'); }
export function hmacSha256(secret, v) { return createHmac('sha256', secret).update(String(v)).digest('hex'); }
export function safeEqual(a, b) {
  const ba = Buffer.from(String(a)); const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
export function newToken() { return randomBytes(32).toString('base64url'); }

export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(String(password), salt, 64).toString('hex');
  return `scrypt:${salt}:${hash}`;
}
export function verifyPassword(password, stored) {
  try {
    const [scheme, salt, hash] = String(stored).split(':');
    if (scheme !== 'scrypt') return false;
    const calc = scryptSync(String(password), salt, 64).toString('hex');
    return safeEqual(calc, hash);
  } catch { return false; }
}

// ---------------------------------------------------------------------------
// Cookies (hand-rolled; httpOnly, SameSite=Strict)
// ---------------------------------------------------------------------------
export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
export function serializeCookie(name, value, { maxAge, httpOnly = true, path = '/' } = {}) {
  let c = `${name}=${encodeURIComponent(value)}; Path=${path}; SameSite=Strict`;
  if (httpOnly) c += '; HttpOnly';
  if (maxAge !== undefined) c += `; Max-Age=${maxAge}`;
  return c;
}

// ---------------------------------------------------------------------------
// Masking (SEC-01: never reveal a full identifier from caller ID alone)
// ---------------------------------------------------------------------------
export function maskPhone(phone) {
  const p = String(phone ?? '');
  if (p.length < 4) return '••••';
  return `${p.slice(0, 3)}•••••${p.slice(-3)}`;
}
export function maskPsNo(ps) {
  const p = String(ps ?? '');
  if (p.length < 4) return '••••';
  return `${p.slice(0, 2)}••••${p.slice(-2)}`;
}
export function psEnding(ps) {
  return String(ps ?? '').slice(-4);
}
export function digitsSpaced(v) {
  return String(v ?? '').split('').join(' ');
}

export function jsonSafe(obj) {
  return JSON.parse(JSON.stringify(obj ?? null));
}
