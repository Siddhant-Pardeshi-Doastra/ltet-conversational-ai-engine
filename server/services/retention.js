// Controlled retention (FR-34): evidence is never edited by users; deletion
// happens only through this governed, audited purge. Application roles have no
// update/delete path to call_logs (DB triggers enforce immutability; only the
// one-way retention_deleted marker unlocks deletion).
import { run, get, all } from '../db.js';
import { nowIso } from '../util.js';
import { getPublishedPolicy } from './policy.js';
import { audit } from './audit.js';

export function runRetention(actor) {
  const policy = getPublishedPolicy();
  const tCutoff = new Date(Date.now() - policy.retention.transcript_days * 86400000).toISOString();
  const lCutoff = new Date(Date.now() - policy.retention.call_log_days * 86400000).toISOString();

  const transcripts = run(`DELETE FROM transcript_segments WHERE at < ?`, tCutoff).changes;
  // Mock inbox is demo-only and purged aggressively.
  const inbox = run(`DELETE FROM mock_otp_inbox WHERE at < ?`, new Date(Date.now() - 86400000).toISOString()).changes;
  const otps = run(`DELETE FROM otp_challenges WHERE expires_at < ?`, new Date(Date.now() - 3600000).toISOString()).changes;

  let logs = 0;
  const expiredLogs = all(`SELECT id FROM call_logs WHERE created_at < ? AND retention_deleted IS NULL`, lCutoff);
  for (const l of expiredLogs) {
    run(`UPDATE call_logs SET retention_deleted = ? WHERE id = ? AND retention_deleted IS NULL`, nowIso(), l.id);
    run(`DELETE FROM call_logs WHERE id = ? AND retention_deleted IS NOT NULL`, l.id);
    logs += 1;
  }
  audit({
    actorType: 'staff', actorId: actor, action: 'retention.purged', objectType: 'retention', objectId: null,
    detail: { transcript_segments: transcripts, call_logs: logs, mock_inbox: inbox, otp_challenges: otps },
  });
  return { transcript_segments: transcripts, call_logs: logs, mock_inbox: inbox, otp_challenges: otps };
}
