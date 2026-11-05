// Governed administration (FR-37/FR-38/FR-39): versioned policy, language packs,
// review tags, retention, audit trail. No secret values are ever displayed.
import { Router } from 'express';
import { attachSession, requireAdmin, requireRole, canViewTranscripts } from '../auth/sessions.js';
import { getPublishedPolicy, listVersions, getVersionDoc, createDraft, approveDraft, publishApproved, rollbackToVersion } from '../services/policy.js';
import { runRetention } from '../services/retention.js';
import { packMeta, seedLanguagePacks } from '../engine/languages.js';
import { run, get, all } from '../db.js';
import { nowIso, toIst } from '../util.js';
import { audit } from '../services/audit.js';

const r = Router();
r.use(attachSession, requireRole('admin', 'auditor'));

// ---- versioned policy (draft -> approved -> published, rollback) ----
r.get('/admin/policy', (_req, res) => {
  res.json({ published: getPublishedPolicy(), versions: listVersions() });
});
r.get('/admin/policy/:version', (req, res) => {
  const doc = getVersionDoc(Number(req.params.version));
  if (!doc) return res.status(404).json({ error: 'version_not_found' });
  res.json({ version: doc });
});
r.post('/admin/policy/draft', requireAdmin, (req, res) => {
  const result = createDraft(req.body, req.staff.user.id);
  if (!result.ok) return res.status(422).json({ error: 'policy_validation_failed', errors: result.errors });
  res.status(201).json(result);
});
r.post('/admin/policy/:version/approve', requireAdmin, (req, res) => {
  const result = approveDraft(Number(req.params.version), req.staff.user.id);
  if (!result.ok) return res.status(409).json({ error: 'approve_failed', errors: result.errors });
  res.json(result);
});
r.post('/admin/policy/:version/publish', requireAdmin, (req, res) => {
  const result = publishApproved(Number(req.params.version), req.staff.user.id);
  if (!result.ok) return res.status(409).json({ error: 'publish_failed', errors: result.errors });
  res.json(result);
});
r.post('/admin/policy/:version/rollback', requireAdmin, (req, res) => {
  const result = rollbackToVersion(Number(req.params.version), req.staff.user.id);
  if (!result.ok) return res.status(409).json({ error: 'rollback_failed', errors: result.errors });
  res.json(result);
});

// ---- language packs (FR-37): read + draft updates with review status ----
r.get('/admin/languages', (_req, res) => res.json({ packs: packMeta() }));
r.put('/admin/languages/:lang', requireAdmin, (req, res) => {
  const { strings, note } = req.body || {};
  if (!strings || typeof strings !== 'object') return res.status(422).json({ error: 'strings_required' });
  const lang = req.params.lang;
  const current = all(`SELECT * FROM language_packs WHERE lang = ? ORDER BY version DESC LIMIT 1`, lang)[0];
  if (!current) return res.status(404).json({ error: 'language_not_found' });
  const version = current.version + 1;
  const merged = { ...JSON.parse(current.strings), ...strings };
  run(
    `INSERT INTO language_packs(lang, version, status, strings, voice_provider, updated_at) VALUES (?,?,?,?,?,?)`,
    lang, version, 'draft_translation', JSON.stringify(merged), current.voice_provider, nowIso()
  );
  audit({ actorType: 'staff', actorId: req.staff.user.id, action: 'language.updated', objectType: 'language_pack', objectId: lang, detail: { version, note: note || null, keys: Object.keys(strings) } });
  res.status(201).json({ ok: true, lang, version, status: 'draft_translation', note: 'draft; native-speaker approval required before launch (FR-37)' });
});
r.post('/admin/languages/:lang/approve', requireAdmin, (req, res) => {
  const current = all(`SELECT * FROM language_packs WHERE lang = ? ORDER BY version DESC LIMIT 1`, req.params.lang)[0];
  if (!current) return res.status(404).json({ error: 'language_not_found' });
  run(`UPDATE language_packs SET status = 'native_approved', updated_at = ? WHERE lang = ? AND version = ?`, nowIso(), current.lang, current.version);
  audit({ actorType: 'staff', actorId: req.staff.user.id, action: 'language.native_approved', objectType: 'language_pack', objectId: current.lang, detail: { version: current.version } });
  res.json({ ok: true, lang: current.lang, version: current.version, status: 'native_approved' });
});

// ---- review tags on calls (FR-38) ----
r.post('/calls/:id/tags', (req, res) => {
  const { tag, note } = req.body || {};
  const log = get(`SELECT id FROM call_logs WHERE id = ?`, req.params.id);
  if (!log) return res.status(404).json({ error: 'call_log_not_found' });
  if (!tag) return res.status(422).json({ error: 'tag_required' });
  run(`INSERT INTO review_tags(call_log_id, created_by, at, tag, note) VALUES (?,?,?,?,?)`,
    log.id, req.staff.user.id, nowIso(), String(tag).slice(0, 64), note ? String(note).slice(0, 1000) : null);
  audit({ actorType: 'staff', actorId: req.staff.user.id, action: 'call.tagged', objectType: 'call_log', objectId: log.id, detail: { tag } });
  res.status(201).json({ ok: true });
});
r.get('/calls/:id/tags', (req, res) => {
  res.json({ tags: all(`SELECT * FROM review_tags WHERE call_log_id = ? ORDER BY id DESC`, req.params.id) });
});

// ---- controlled retention (FR-34) ----
r.post('/admin/retention/run', requireAdmin, (req, res) => {
  const result = runRetention(req.staff.user.id);
  res.json({ ok: true, purged: result });
});

// ---- audit trail (NFR-09) ----
r.get('/admin/audit', (req, res) => {
  const { object_type, object_id, limit = 100 } = req.query;
  const rows = all(
    `SELECT * FROM audit_events
     WHERE (? IS NULL OR object_type = ?) AND (? IS NULL OR object_id = ?)
     ORDER BY id DESC LIMIT ?`,
    object_type || null, object_type || null, object_id || null, object_id || null, Number(limit)
  );
  res.json({ audit: rows.map((a) => ({ ...a, detail: a.detail ? JSON.parse(a.detail) : null, at_ist: toIst(a.at) })) });
});

export default r;
