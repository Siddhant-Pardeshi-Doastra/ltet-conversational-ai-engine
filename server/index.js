// Entrypoint: migrate (auto), seed if empty, start worker + HTTP server.
process.on('warning', () => { /* suppress node:sqlite experimental notice for clean demo logs */ });
import { createApp } from './app.js';
import { APP } from './config.js';
import { getDb } from './db.js';
import { seed } from './seed.js';
import { startWorker, recoverStaleJobs } from './services/postcall.js';
import { getPublishedPolicy, seedDefaultPolicy } from './services/policy.js';
import { validatePolicy } from './config.js';

getDb(); // ensure migrations applied
const seeded = seed({ force: false });
seedDefaultPolicy();

// boot-time policy validation (fail fast on unsafe published config)
const policy = getPublishedPolicy();
const v = validatePolicy(policy);
if (!v.ok) {
  console.error('[boot] published policy failed validation:', v.errors);
  process.exit(1);
}

recoverStaleJobs();
startWorker(2000);

const app = createApp();
app.listen(APP.port, APP.host, () => {
  console.log(`LTET Conversational AI Engine (Release 1 demo build)`);
  console.log(`  mode:     ${APP.mode.toUpperCase()}${APP.mode === 'demo' ? '  — synthetic data only' : '  — verify readiness before enabling private workflows'}`);
  if (seeded && !seeded.skipped) console.log(`  database: seeded synthetic fixtures (17 schemes, ${seeded.employees} employees, ${seeded.claims} claims)`);
  console.log(`  url:      http://${APP.host}:${APP.port}`);
  console.log(`  demo logins: pms1 / spm1 / apm1 / admin1 / auditor1  (password Demo#Pass1 — labelled demo credential)`);
});
