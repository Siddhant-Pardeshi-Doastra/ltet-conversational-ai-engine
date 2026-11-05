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
  console.log(`LTET Conversational AI Engine v1.0.0 — Trust Portal Console`);
  console.log(`  mode:     ${APP.mode === 'demo' ? 'WORKSPACE' : 'PRODUCTION'}${APP.mode === 'demo' ? '  — workspace dataset' : '  — verify readiness before enabling private workflows'}`);
  if (seeded && !seeded.skipped) console.log(`  database: workspace fixtures ready (17 schemes, ${seeded.employees} members, ${seeded.claims} claims)`);
  console.log(`  url:      http://${APP.host}:${APP.port}`);
  console.log(`  workspace accounts: pms1 / spm1 / apm1 / admin1 / auditor1 (access code Demo#Pass1)`);
});
