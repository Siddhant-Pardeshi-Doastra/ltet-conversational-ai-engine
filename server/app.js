// Express app assembly (exported for tests; index.js starts it).
import express from 'express';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP, isDemoMode } from './config.js';
import { attachSession } from './auth/sessions.js';
import authRoutes from './routes/auth.js';
import callRoutes from './routes/calls.js';
import staffRoutes from './routes/staff.js';
import adminRoutes from './routes/admin.js';
import demoRoutes from './routes/demo.js';
import telephonyRoutes from './routes/telephony.js';
import healthRoutes from './routes/health.js';

const here = dirname(fileURLToPath(import.meta.url));

// capture raw body for webhook signature verification (SEC-07)
function rawBodyCapture(req, res, buf) {
  req.rawBody = buf.toString('utf8');
}

// Tiny in-memory abuse limiter (SEC-07: rate-limit without permanent lockout).
// Generous default for staff consoles; sensitive paths (OTP challenges) have
// their own stricter per-subject limits.
const buckets = new Map();
function limiter({ windowMs = 60000, max = Number(process.env.LTET_RATE_LIMIT_MAX || 600) } = {}) {
  return (req, res, next) => {
    const key = `${req.ip}:${req.path}`;
    const now = Date.now();
    const b = buckets.get(key) || { count: 0, reset: now + windowMs };
    if (now > b.reset) { b.count = 0; b.reset = now + windowMs; }
    b.count += 1;
    buckets.set(key, b);
    if (buckets.size > 5000) buckets.clear();
    if (b.count > max) return res.status(429).json({ error: 'rate_limited' });
    next();
  };
}

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });
  app.use(express.json({ limit: '256kb', verify: rawBodyCapture }));
  app.use(limiter());

  // public boundaries first (health/readiness, signed telephony webhook)
  app.use('/api', healthRoutes);
  app.use('/api', telephonyRoutes);
  // staff-authenticated routers (router-level guards)
  app.use('/api/auth', authRoutes);
  app.use('/api', callRoutes);
  app.use('/api', staffRoutes);
  app.use('/api', adminRoutes);
  app.use('/api', demoRoutes);

  // static SPA
  app.use(express.static(join(here, '..', 'public'), { index: 'index.html' }));

  // errors (masked diagnostics; no internals leaked)
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || 500;
    if (status >= 500) console.error(`[error] ${req.method} ${req.path}:`, err.message);
    res.status(status).json({ error: err.code || 'internal_error', message: status >= 500 ? 'unexpected server error' : err.message });
  });

  return app;
}
