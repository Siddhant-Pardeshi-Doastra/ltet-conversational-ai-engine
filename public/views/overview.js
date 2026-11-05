// Overview screen: mode banner, KPIs, trend, pending work.
import { api, esc } from '../app.js';
import { lineChart, donutChart, legend, PALETTE } from '../charts.js';

export async function renderOverview(root) {
  root.innerHTML = '<div class="empty">Loading overview…</div>';
  const [ov, readiness, queue, callbacks] = await Promise.all([
    api('GET', '/api/analytics/overview?days=14'),
    api('GET', '/api/readiness'),
    api('GET', '/api/queue/alerts'),
    api('GET', '/api/callbacks'),
  ]);
  const openAlerts = queue.alerts.filter((a) => a.status === 'pending');
  const openCallbacks = callbacks.callbacks.filter((c) => c.status === 'open');

  const byDay = ov.by_day.slice(-14);
  const outcomeColors = { resolved: '#14919b', escalated: '#e0a437', verification_failed: '#b3372e', abandoned: '#8a9ba8' };
  const series = ['resolved', 'escalated', 'verification_failed', 'abandoned'].map((k, i) => ({
    name: k, color: outcomeColors[k],
    points: byDay.map((d) => ({ x: d.day, y: d[k] || 0 })),
  })).filter((s) => s.points.some((p) => p.y > 0));

  const langData = Object.entries(ov.by_language).map(([k, v], i) => ({ label: k, value: v, color: PALETTE[i % PALETTE.length] }));

  root.innerHTML = `
    <div class="note ${readiness.mode === 'demo' ? 'teal' : 'danger'} mb">
      <b>${readiness.mode === 'demo' ? 'DEMO MODE' : 'LIVE MODE'}:</b>
      ${readiness.mode === 'demo'
        ? 'All data is synthetic. The mock LTET portal is the system of record; no real employees, calls or payments exist here.'
        : (readiness.ready ? 'Integration config present — complete external acceptance before production use.' : `Not ready: ${readiness.blocking.join('; ')}`)}
    </div>
    <div class="grid cols-4 mb">
      <div class="card kpi"><div class="label">Calls (14 days)</div><div class="value">${ov.calls_total}</div><div class="sub">${Object.entries(ov.by_outcome).map(([k, v]) => `${k}: ${v}`).join(' · ') || '—'}</div></div>
      <div class="card kpi"><div class="label">Containment</div><div class="value">${ov.containment_percent}%</div><div class="sub">resolved ÷ ended (definition in docs)</div></div>
      <div class="card kpi"><div class="label">Pending alerts</div><div class="value">${openAlerts.length}</div><div class="sub">${ov.payment_issues.failed} failed · ${ov.payment_issues.held} held · ${ov.payment_issues.delayed} delayed payments</div></div>
      <div class="card kpi"><div class="label">Open callbacks</div><div class="value">${openCallbacks.length}</div><div class="sub">${ov.open_processor_queries} open processor queries</div></div>
    </div>
    <div class="grid cols-2 mb">
      <div class="card"><div class="card-h"><h3>Call outcomes — 14-day trend</h3></div>
        <div class="card-b">${byDay.length ? lineChart({ series, labels: byDay.map((d) => d.day) }) : '<div class="empty">No calls in window</div>'}
          <div class="legend mt">${Object.entries(outcomeColors).filter(([k]) => series.some((s) => s.name === k)).map(([k, c]) => `<span><span class="sw" style="background:${c}"></span>${k}</span>`).join('')}</div>
        </div>
      </div>
      <div class="card"><div class="card-h"><h3>Languages (14 days)</h3><div class="right"><a href="#" data-nav="analytics" class="btn sm ghost">Analytics →</a></div></div>
        <div class="card-b" style="display:flex;gap:18px;align-items:center">
          ${donutChart({ data: langData })}
          ${legend(langData)}
        </div>
      </div>
    </div>
    <div class="grid cols-2">
      <div class="card"><div class="card-h"><h3>Pending processor alerts</h3><div class="right"><a href="#" data-nav="queue" class="btn sm ghost">Work queue →</a></div></div>
        <div class="card-b">
          ${openAlerts.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>Type</th><th>Claim</th><th>Queue</th><th>When</th></tr></thead><tbody>
            ${openAlerts.slice(0, 6).map((a) => `<tr><td><span class="pill ${a.type.includes('payment') ? 'warn' : 'info'}">${esc(a.type)}</span></td><td class="mono">${esc(a.claim_id || '—')}</td><td>${esc(a.persona_role || 'unrouted')}</td><td class="muted small">${esc(a.created_at_ist)}</td></tr>`).join('')}
          </tbody></table></div>` : '<div class="empty">No pending alerts 🎉</div>'}
        </div>
      </div>
      <div class="card"><div class="card-h"><h3>Integration readiness</h3><div class="right"><a href="#" data-nav="scenarios" class="btn sm ghost">Details →</a></div></div>
        <div class="card-b">
          ${(readiness.integrations || []).slice(0, 6).map((i) => `
            <div class="health-row"><div class="name">${esc(i.integration)}</div>
              <span class="pill ${i.status === 'not_configured' ? 'bad' : i.status.includes('demo') || i.status.includes('mock') ? 'info' : 'ok'}">${esc(i.status)}</span>
              <div class="small muted grow">${esc(i.detail)}</div></div>`).join('')}
        </div>
      </div>
    </div>`;

  root.querySelectorAll('[data-nav]').forEach((a) => a.addEventListener('click', (e) => {
    e.preventDefault();
    const { navigate } = window.__ltet || {};
    document.querySelectorAll('.nav-item').forEach((b) => { if (b.dataset.route === a.dataset.nav) b.click(); });
  }));
}
