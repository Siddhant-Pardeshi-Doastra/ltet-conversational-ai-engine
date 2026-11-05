// Processor work queue: persona-scoped alerts + callback requests (FR-30/35).
import { api, esc, state } from '../app.js';

export async function renderQueue(root) {
  root.innerHTML = '<div class="empty">Loading queue…</div>';
  await draw();

  async function draw() {
    const [alerts, callbacks] = await Promise.all([
      api('GET', '/api/queue/alerts'),
      api('GET', '/api/callbacks'),
    ]);
    const myScope = alerts.scope;
    root.innerHTML = `
      <div class="note info mb">Queue scoped to <b>${esc(myScope.role)}</b> — stages: ${esc((myScope.stages || []).join(', ') || 'none (read-only role)')}. Unrouted alerts are admin-visible only; nothing is silently lost.</div>
      <div class="grid cols-2">
        <div class="card"><div class="card-h"><h3>Alerts</h3><div class="right"><button class="btn sm" id="refresh">↻</button></div></div><div class="card-b" id="alerts"></div></div>
        <div class="card"><div class="card-h"><h3>Callback requests</h3></div><div class="card-b" id="cbs"></div></div>
      </div>`;

    const groups = {};
    for (const a of alerts.alerts) (groups[a.status] = groups[a.status] || []).push(a);
    const order = ['pending', 'acknowledged', 'closed'];
    root.querySelector('#alerts').innerHTML = order.filter((k) => groups[k]?.length).map((k) => `
      <h4 class="small" style="margin:8px 0 6px;text-transform:uppercase;color:var(--ink-faint)">${k} (${groups[k].length})</h4>
      ${groups[k].map((a) => `
        <div class="card mb" style="box-shadow:none">
          <div class="card-b" style="padding:11px 14px">
            <div class="flex wrap">
              <span class="pill ${a.type.includes('payment') ? 'warn' : a.type.includes('denied') || a.type.includes('failure') ? 'bad' : 'info'}">${esc(a.type)}</span>
              <b class="mono">${esc(a.claim_id || '—')}</b>
              <span class="pill muted">${esc(a.persona_role || (a.routing_state === 'unrouted' ? 'UNROUTED (admin)' : a.routing_state))}</span>
              <span class="grow"></span><span class="small muted">${esc(a.created_at_ist)}</span>
            </div>
            ${Object.keys(a.detail || {}).length ? `<div class="small muted mt">${esc(JSON.stringify(a.detail))}</div>` : ''}
            ${a.status !== 'closed' ? `<div class="btn-row mt">
              ${a.status === 'pending' ? `<button class="btn sm primary" data-ack="${esc(a.id)}">Acknowledge</button>` : ''}
              <button class="btn sm" data-close="${esc(a.id)}">Close</button>
            </div>` : ''}
          </div>
        </div>`).join('')}`).join('') || '<div class="empty">Queue is empty.</div>';

    root.querySelector('#cbs').innerHTML = callbacks.callbacks.length ? `
      <table class="table"><thead><tr><th>Ref</th><th>Verified</th><th>Number</th><th>Status</th><th>Actions</th></tr></thead><tbody>
      ${callbacks.callbacks.map((c) => `<tr>
        <td class="mono">${esc(c.id)}</td>
        <td>${c.verified ? '<span class="pill ok">verified caller</span>' : '<span class="pill warn">unverified</span>'}</td>
        <td class="mono small">${esc(c.callback_number)}</td>
        <td><span class="pill ${c.status === 'open' ? 'warn' : 'muted'}">${esc(c.status)}</span></td>
        <td><div class="btn-row">
          ${c.status === 'open' ? `<button class="btn sm" data-cb="${esc(c.id)}" data-st="assigned">Assign</button>` : ''}
          ${c.status === 'assigned' ? `<button class="btn sm primary" data-cb="${esc(c.id)}" data-st="done">Done</button>` : ''}
        </div></td></tr>`).join('')}</tbody></table>` : '<div class="empty">No callback requests.</div>';

    root.querySelector('#refresh').addEventListener('click', draw);
    root.querySelectorAll('[data-ack]').forEach((b) => b.addEventListener('click', async () => { await api('POST', `/api/alerts/${b.dataset.ack}/ack`); draw(); }));
    root.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', async () => { await api('POST', `/api/alerts/${b.dataset.close}/close`); draw(); }));
    root.querySelectorAll('[data-cb]').forEach((b) => b.addEventListener('click', async () => { await api('POST', `/api/callbacks/${b.dataset.cb}/status`, { status: b.dataset.st }); draw(); }));
  }
}
