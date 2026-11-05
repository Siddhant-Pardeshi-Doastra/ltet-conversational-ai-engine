// Audit event service (NFR-09: answer provenance and immutable audit records).
import { run, all } from '../db.js';
import { nowIso } from '../util.js';

export function audit({ actorType, actorId, action, objectType, objectId, detail }) {
  run(
    `INSERT INTO audit_events(at, actor_type, actor_id, action, object_type, object_id, detail)
     VALUES (?,?,?,?,?,?,?)`,
    nowIso(),
    actorType ?? 'system',
    actorId ?? null,
    action,
    objectType ?? null,
    objectId ?? null,
    detail ? JSON.stringify(detail) : null
  );
}

export function listAudit({ objectType, objectId, limit = 100 } = {}) {
  return all(
    `SELECT * FROM audit_events WHERE (? IS NULL OR object_type = ?) AND (? IS NULL OR object_id = ?)
     ORDER BY id DESC LIMIT ?`,
    objectType, objectType, objectId, objectId, limit
  ).map((r) => ({ ...r, detail: r.detail ? JSON.parse(r.detail) : null }));
}
