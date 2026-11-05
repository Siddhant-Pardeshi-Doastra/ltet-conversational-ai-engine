// Administration: versioned policy lifecycle, language packs, retention, audit.
import { api, esc, state } from '../app.js';

export async function renderAdmin(root) {
  root.innerHTML = '<div class="empty">Loading administration…</div>';
  await draw();

  async function draw() {
    const [policy, langs, audit] = await Promise.all([
      api('GET', '/api/admin/policy'),
      api('GET', '/api/admin/languages'),
      api('GET', '/api/admin/audit?limit=60'),
    ]);
    root.innerHTML = `
      ${state.mode !== 'demo' ? '<div class="note danger mb">Production policy: changes follow the approved change-management process. Unsafe values are rejected before save.</div>' : '<div class="note info mb">Workspace policy: values are version-controlled with approval, publish and rollback. Unsafe or inconsistent values are rejected before save.</div>'}
      <div class="grid cols-2 mb">
        <div class="card"><div class="card-h"><h3>Published policy (v${policy.published._version ?? '—'})</h3>
          <div class="right"><button class="btn sm" id="edit-policy">Create draft from published</button></div></div>
          <div class="card-b"><textarea id="policy-doc" spellcheck="false" style="min-height:300px">${esc(JSON.stringify(stripPrivate(policy.published), null, 2))}</textarea>
          <div id="policy-msg" class="mt"></div>
          <div class="btn-row mt">
            <button class="btn primary" id="save-draft">Save as draft</button>
            <button class="btn" id="validate">Validate only</button>
          </div></div>
        </div>
        <div>
          <div class="card mb"><div class="card-h"><h3>Config versions</h3></div><div class="card-b">
            <table class="table"><thead><tr><th>v</th><th>Status</th><th>By</th><th>Approved</th><th>Actions</th></tr></thead><tbody>
            ${policy.versions.map((v) => `<tr>
              <td class="mono">${v.version}</td>
              <td><span class="pill ${v.status === 'published' ? 'ok' : v.status === 'draft' ? 'warn' : 'muted'}">${esc(v.status)}</span></td>
              <td class="small">${esc(v.created_by || '')}</td>
              <td class="small">${esc(v.approved_by || '—')}</td>
              <td><div class="btn-row">
                ${v.status === 'draft' ? `<button class="btn sm primary" data-approve="${v.version}">Approve</button>` : ''}
                ${v.status === 'approved' ? `<button class="btn sm primary" data-publish="${v.version}">Publish</button>` : ''}
                ${v.status !== 'draft' ? `<button class="btn sm" data-rollback="${v.version}">Rollback here</button>` : ''}
              </div></td></tr>`).join('')}
            </tbody></table></div></div>
          <div class="card mb"><div class="card-h"><h3>Language packs (FR-37)</h3></div><div class="card-b" style="max-height:260px;overflow-y:auto">
            <table class="table"><thead><tr><th>Lang</th><th>Status</th><th>Coverage</th><th>Launch-ready</th><th></th></tr></thead><tbody>
            ${langs.packs.map((p) => `<tr><td><b>${esc(p.lang)}</b> <span class="muted small">${esc(p.name)}</span></td>
              <td><span class="pill ${p.status === 'native_approved' ? 'ok' : 'warn'}">${esc(p.status)}</span></td>
              <td class="small">${p.coverage_keys}/${p.coverage_total} keys</td>
              <td>${p.launch_ready ? '✅' : '⏳ native sign-off pending'}</td>
              <td>${!p.launch_ready && state.user.role === 'admin' ? `<button class="btn sm" data-lang-approve="${esc(p.lang)}">Mark native-approved</button>` : ''}</td></tr>`).join('')}
            </tbody></table>
            <div class="note small mt">All 12 FRS languages are configured. Per-language audio evaluation and native-speaker sign-off are tracked to release readiness phase-by-phase (FR-37/NFR-12).</div>
          </div></div>
          <div class="card"><div class="card-h"><h3>Retention</h3></div><div class="card-b">
            <div class="small muted mb">Transcripts: ${policy.published.retention?.transcript_days} days · call logs: ${policy.published.retention?.call_log_days} days (governed purge, audited — FR-34).</div>
            <button class="btn" id="run-retention">Run retention purge now</button>
          </div></div>
        </div>
      </div>
      <div class="card"><div class="card-h"><h3>Audit trail (latest 60)</h3></div><div class="card-b">
        <div class="table-wrap"><table class="table"><thead><tr><th>When (IST)</th><th>Actor</th><th>Action</th><th>Object</th></tr></thead>
        <tbody>${audit.audit.map((a) => `<tr><td class="small muted">${esc(a.at_ist)}</td><td class="small">${esc(a.actor_type)}${a.actor_id ? `/${esc(a.actor_id)}` : ''}</td><td class="mono small">${esc(a.action)}</td><td class="small">${esc(a.object_type || '')} ${esc(a.object_id || '')}</td></tr>`).join('')}</tbody></table></div>
      </div></div>`;

    const $ = (s) => root.querySelector(s);
    $('#edit-policy').addEventListener('click', () => { /* textarea already holds published doc */ });
    $('#validate').addEventListener('click', async () => {
      try {
        const doc = JSON.parse($('#policy-doc').value);
        const res = await api('POST', '/api/admin/policy/draft', doc).catch((e) => e.payload || { error: e.message });
        $('#policy-msg').innerHTML = res.ok
          ? '<div class="note ok">Valid. Draft created — approve + publish to apply.</div>'
          : `<div class="note danger">Rejected (unsafe/inconsistent configuration):<br/>${(res.errors || [res.error]).map(esc).join('<br/>')}</div>`;
      } catch (e) { $('#policy-msg').innerHTML = `<div class="note danger">Invalid JSON: ${esc(e.message)}</div>`; }
    });
    $('#save-draft').addEventListener('click', async () => {
      try {
        const doc = JSON.parse($('#policy-doc').value);
        const res = await api('POST', '/api/admin/policy/draft', doc);
        $('#policy-msg').innerHTML = res.ok ? `<div class="note ok">Draft v${res.version} saved. Approve, then publish.</div>` : '';
        if (res.ok) draw();
      } catch (e) { $('#policy-msg').innerHTML = `<div class="note danger">${esc(e.message)}</div>`; }
    });
    root.querySelectorAll('[data-approve]').forEach((b) => b.addEventListener('click', async () => { await api('POST', `/api/admin/policy/${b.dataset.approve}/approve`); draw(); }));
    root.querySelectorAll('[data-publish]').forEach((b) => b.addEventListener('click', async () => { await api('POST', `/api/admin/policy/${b.dataset.publish}/publish`); draw(); }));
    root.querySelectorAll('[data-rollback]').forEach((b) => b.addEventListener('click', async () => { await api('POST', `/api/admin/policy/${b.dataset.rollback}/rollback`); draw(); }));
    root.querySelectorAll('[data-lang-approve]').forEach((b) => b.addEventListener('click', async () => { await api('POST', `/api/admin/languages/${b.dataset.langApprove}/approve`); draw(); }));
    $('#run-retention').addEventListener('click', async () => {
      const r = await api('POST', '/api/admin/retention/run');
      alert(`Purged: ${JSON.stringify(r.purged)}`);
    });
  }

  function stripPrivate(doc) {
    const c = { ...doc };
    delete c._version; delete c._mode_fallback; delete c._status;
    return c;
  }
}
