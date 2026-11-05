// Claim Context: read-only authorised claim view (no edit/approve/payment controls).
import { api, esc } from '../app.js';

export async function renderClaimContext(root) {
  root.innerHTML = `
    <div class="card mb"><div class="card-b flex">
      <input type="search" id="q" placeholder="Search claim id or PS…" style="max-width:320px" />
      <button class="btn primary" id="go">Search</button>
      <span class="note info grow" style="margin:0">Read-only context. Release 1 has no claim edit, approval, payment or document-upload controls (§5.5).</span>
    </div></div>
    <div id="results"></div>`;
  load('');
  root.querySelector('#go').addEventListener('click', () => load(root.querySelector('#q').value.trim()));
  root.querySelector('#q').addEventListener('keydown', (e) => { if (e.key === 'Enter') load(root.querySelector('#q').value.trim()); });

  async function load(q) {
    const r = await api('GET', `/api/claims?q=${encodeURIComponent(q)}`);
    root.querySelector('#results').innerHTML = `
      <div class="card"><div class="table-wrap"><table class="table">
        <thead><tr><th>Claim</th><th>Scheme</th><th>PS</th><th>Status</th><th>Stage</th><th>Amount</th><th>Submitted</th><th></th></tr></thead>
        <tbody>${r.claims.map((c) => `
          <tr><td class="mono">${esc(c.id)}</td><td>${esc(c.scheme_label)}</td><td class="mono">${esc(c.ps_no_masked)}</td>
          <td><span class="pill ${c.status === 'Approved' ? 'ok' : 'info'}">${esc(c.status)}</span></td>
          <td>${esc(c.stage || '—')}</td><td>${esc(c.amount_display)}</td><td class="small muted">${esc(c.submitted_at.slice(0, 10))}</td>
          <td><button class="btn sm" data-id="${esc(c.id)}">Open</button></td></tr>`).join('')}</tbody></table></div></div>`;
    root.querySelectorAll('[data-id]').forEach((b) => b.addEventListener('click', () => open(b.dataset.id)));
  }

  async function open(id) {
    let c;
    try {
      c = await api('GET', `/api/claims/${id}/context`);
    } catch (e) {
      alert(e.payload?.error === 'claim_outside_your_stage_scope' ? 'This claim is outside your stage scope.' : e.message);
      return;
    }
    const w = window.open('', '_blank');
    const d = document.createElement('div');
    d.innerHTML = detailHtml(c);
    document.body.appendChild(d);
    d.querySelector('.drawer-bg').addEventListener('click', (e) => { if (e.target.classList.contains('drawer-bg')) d.remove(); });
    d.querySelector('#close-drawer').addEventListener('click', () => d.remove());

    function detailHtml(c) {
      const pay = c.payment;
      return `
      <div class="drawer-bg"><div class="drawer">
        <div class="drawer-head"><h2>Claim ${esc(c.claim.id)}</h2>
          <span class="pill ${c.claim.status === 'Approved' ? 'ok' : 'info'}">${esc(c.claim.status)}</span>
          <span class="grow"></span><button class="btn sm" id="close-drawer">✕ Close</button></div>
        <div class="grid cols-2">
          <div class="card"><div class="card-h"><h3>Claim facts (source: ${esc(c.source_note)})</h3></div><div class="card-b"><dl class="kv">
            <dt>Scheme</dt><dd>${esc(c.claim.scheme_label)} (${esc(c.claim.scheme_category || '')})</dd>
            <dt>Employee PS</dt><dd class="mono">${esc(c.claim.ps_no_masked)}</dd>
            <dt>Processing stage</dt><dd>${esc(c.claim.stage || '— (approved)')}</dd>
            <dt>Stage updated</dt><dd>${esc(c.claim.stage_updated_at || '—')}</dd>
            <dt>Amount claimed</dt><dd>${esc(c.claim.amount_display)}</dd>
            <dt>Submitted</dt><dd>${esc(c.claim.submitted_at.slice(0, 10))}</dd>
          </dl></div></div>
          <div class="card"><div class="card-h"><h3>Finance approval & payment</h3></div><div class="card-b">
            ${pay ? `<dl class="kv">
              <dt>Approval status</dt><dd>${esc(pay.approval_status || '—')}</dd>
              <dt>Approval date</dt><dd>${esc(pay.approval_date ? pay.approval_date.slice(0, 10) : '—')}</dd>
              <dt>Raw payment status</dt><dd><span class="mono">${esc(pay.payment_status_raw || '—')}</span></dd>
              <dt>Payment amount</dt><dd>${pay.amount_minor != null ? esc(pay.amount_minor.toLocaleString('en-IN')) : '—'}</dd>
              <dt>Credit date</dt><dd>${esc(pay.credit_date ? pay.credit_date.slice(0, 10) : '— (not available)')}</dd>
              <dt>Bank reference</dt><dd class="mono">${esc(pay.bank_reference || '— (not available)')}</dd>
              <dt>Failure / hold reason</dt><dd>${esc(pay.failure_reason || pay.held_reason || '—')}</dd>
              <dt>Owner team</dt><dd>${esc(pay.owner_team || '—')}</dd>
              <dt>Freshness</dt><dd class="small muted">source updated ${esc(pay.updated_at || '—')}</dd>
            </dl>` : '<div class="empty">No Finance payment record.</div>'}
            <div class="note small mt">${c.open_query ? `<b>Open ${esc(c.open_query.stage)} query:</b> ${esc(c.open_query.query_text)}` : 'No open processor query.'}</div>
          </div></div>
        </div>
        <div class="card mt"><div class="card-h"><h3>Call-history timeline (document history)</h3></div><div class="card-b">
          ${c.document_history.length ? `<div class="timeline">${c.document_history.map((h) => `<div class="t-item"><div class="small">${esc(h.text)}</div><div class="small muted">${esc(h.created_by)} · ${esc(h.at)}</div></div>`).join('')}</div>` : '<div class="empty">No call history for this claim.</div>'}
        </div></div>
      </div></div>`;
    }
  }
}
