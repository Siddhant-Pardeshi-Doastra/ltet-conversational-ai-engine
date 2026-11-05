// Versioned policy configuration service (FR-39, FR-37).
// Draft -> approved -> published lifecycle with rollback. Unsafe/inconsistent
// production configuration is rejected by validatePolicy before save.
import { run, get, all } from '../db.js';
import { DEFAULT_POLICY, validatePolicy } from '../config.js';
import { nowIso } from '../util.js';
import { audit } from './audit.js';

export function getPublishedPolicy() {
  const row = get(`SELECT * FROM policy_configs WHERE status = 'published' ORDER BY version DESC LIMIT 1`);
  if (!row) return { ...DEFAULT_POLICY, _version: 0, _mode_fallback: true };
  return { ...JSON.parse(row.doc), _version: row.version };
}

export function getDraft() {
  return get(`SELECT * FROM policy_configs WHERE status = 'draft' ORDER BY version DESC LIMIT 1`) || null;
}

export function listVersions() {
  return all(`SELECT id, version, status, created_by, approved_by, published_at, created_at, note FROM policy_configs ORDER BY version DESC`);
}

export function getVersionDoc(version) {
  const row = get(`SELECT * FROM policy_configs WHERE version = ?`, version);
  return row ? { ...JSON.parse(row.doc), _version: row.version, _status: row.status } : null;
}

export function createDraft(doc, actor) {
  const v = (get(`SELECT MAX(version) AS v FROM policy_configs`)?.v || 0) + 1;
  const { ok, errors } = validatePolicy(doc);
  if (!ok) return { ok: false, errors };
  run(
    `INSERT INTO policy_configs(version, status, doc, created_by, created_at, note) VALUES (?, 'draft', ?, ?, ?, ?)`,
    v, JSON.stringify(doc), actor, nowIso(), 'draft via admin API'
  );
  audit({ actorType: 'staff', actorId: actor, action: 'policy.draft_created', objectType: 'policy_config', objectId: String(v), detail: { version: v } });
  return { ok: true, version: v };
}

export function approveDraft(version, actor) {
  const row = get(`SELECT * FROM policy_configs WHERE version = ? AND status = 'draft'`, version);
  if (!row) return { ok: false, errors: ['no draft with that version'] };
  run(`UPDATE policy_configs SET status = 'approved', approved_by = ? WHERE version = ?`, actor, version);
  audit({ actorType: 'staff', actorId: actor, action: 'policy.approved', objectType: 'policy_config', objectId: String(version) });
  return { ok: true };
}

export function publishApproved(version, actor) {
  const row = get(`SELECT * FROM policy_configs WHERE version = ? AND status = 'approved'`, version);
  if (!row) return { ok: false, errors: ['no approved version to publish'] };
  const { ok, errors } = validatePolicy(JSON.parse(row.doc));
  if (!ok) return { ok: false, errors };
  const txSafe = getDbSafe();
  txSafe.exec('BEGIN');
  try {
    run(`UPDATE policy_configs SET status = 'superseded' WHERE status = 'published'`);
    run(`UPDATE policy_configs SET status = 'published', published_at = ? WHERE version = ?`, nowIso(), version);
    txSafe.exec('COMMIT');
  } catch (e) {
    txSafe.exec('ROLLBACK');
    return { ok: false, errors: [e.message] };
  }
  audit({ actorType: 'staff', actorId: actor, action: 'policy.published', objectType: 'policy_config', objectId: String(version) });
  return { ok: true };
}

export function rollbackToVersion(version, actor) {
  const target = get(`SELECT * FROM policy_configs WHERE version = ?`, version);
  if (!target) return { ok: false, errors: ['version not found'] };
  const doc = JSON.parse(target.doc);
  const { ok, errors } = validatePolicy(doc);
  if (!ok) return { ok: false, errors };
  const v = (get(`SELECT MAX(version) AS v FROM policy_configs`)?.v || 0) + 1;
  run(
    `INSERT INTO policy_configs(version, status, doc, created_by, approved_by, published_at, created_at, note)
     VALUES (?, 'published', ?, ?, ?, ?, ?, ?)`,
    v, JSON.stringify(doc), actor, actor, nowIso(), nowIso(), `rollback to version ${version}`
  );
  run(`UPDATE policy_configs SET status = 'superseded' WHERE status = 'published' AND version != ?`, v);
  audit({ actorType: 'staff', actorId: actor, action: 'policy.rollback', objectType: 'policy_config', objectId: String(v), detail: { rolled_back_to: version } });
  return { ok: true, version: v };
}

import { getDb } from '../db.js';
function getDbSafe() { return getDb(); }

export function seedDefaultPolicy() {
  const any = get(`SELECT COUNT(*) AS c FROM policy_configs`).c;
  if (any > 0) return;
  const { ok } = validatePolicy(DEFAULT_POLICY);
  if (!ok) throw new Error('default policy failed validation');
  run(
    `INSERT INTO policy_configs(version, status, doc, created_by, approved_by, published_at, created_at, note)
     VALUES (1, 'published', ?, 'system', 'system', ?, ?, 'initial demo policy (synthetic values, labelled)')`,
    JSON.stringify(DEFAULT_POLICY), nowIso(), nowIso()
  );
}
