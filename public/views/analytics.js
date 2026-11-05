// Analytics: drivers, repeat callers, mixes, containment, reports (FR-29/31).
import { api, esc } from '../app.js';
import { barChart, donutChart, legend, PALETTE } from '../charts.js';

export async function renderAnalytics(root) {
  root.innerHTML = `
    <div class="card mb"><div class="card-b flex wrap">
      <label class="field" style="margin:0;width:160px"><span>Window</span>
        <select id="days"><option value="7">7 days</option><option value="14" selected>14 days</option><option value="30">30 days</option></select></label>
      <button class="btn primary" id="apply">Apply</button>
      <span class="grow"></span>
      <button class="btn" id="gen-daily">Generate daily report</button>
      <button class="btn" id="gen-weekly">Generate weekly report</button>
      <button class="btn" id="export">⬇ Export JSON</button>
    </div></div>
    <div id="body"><div class="empty">Loading…</div></div>
    <div class="card mt" id="reports"></div>`;

  await draw(14);
  root.querySelector('#apply').addEventListener('click', () => draw(Number(root.querySelector('#days').value)));
  root.querySelector('#gen-daily').addEventListener('click', () => gen('daily'));
  root.querySelector('#gen-weekly').addEventListener('click', () => gen('weekly'));
  root.querySelector('#export').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(window.__ltet_ov || {}, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'ltet-analytics.json';
    a.click();
  });

  async function gen(kind) {
    const r = await api('POST', '/api/analytics/reports/generate', { kind });
    await drawReports();
    alert(`Report generated: ${r.report.id}`);
  }
  async function drawReports() {
    const r = await api('GET', '/api/analytics/reports');
    root.querySelector('#reports').innerHTML = `
      <div class="card-h"><h3>Generated reports (FR-31)</h3></div><div class="card-b">
      ${r.reports.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>Report</th><th>Kind</th><th>Period</th><th>Generated</th></tr></thead>
      <tbody>${r.reports.map((x) => `<tr><td class="mono">${esc(x.id)}</td><td>${esc(x.kind)}</td><td class="mono">${esc(x.period)}</td><td class="small muted">${esc(x.generated_at)}</td></tr>`).join('')}</tbody></table></div>`
      : '<div class="empty">No reports yet — generate one above.</div>'}</div>`;
  }

  async function draw(days) {
    const ov = await api('GET', `/api/analytics/overview?days=${days}`);
    window.__ltet_ov = ov;
    const drivers = Object.entries(ov.drivers).map(([k, v], i) => ({ label: k, value: v, color: PALETTE[i % PALETTE.length] }));
    const payMix = Object.entries(ov.payment_mix).map(([k, v], i) => ({ label: k, value: v, color: { credited: '#1e7a46', processed: '#14919b', pending: '#e0a437', failed: '#b3372e', held: '#9a6b13', unreadable: '#8a9ba8' }[k] || PALETTE[i % PALETTE.length] }));
    const stageMix = Object.entries(ov.stage_mix).map(([k, v], i) => ({ label: k, value: v, color: PALETTE[(i + 3) % PALETTE.length] }));
    const outcomes = Object.entries(ov.by_outcome).map(([k, v], i) => ({ label: k, value: v, color: { resolved: '#14919b', escalated: '#e0a437', verification_failed: '#b3372e', abandoned: '#8a9ba8' }[k] || PALETTE[i % PALETTE.length] }));

    root.querySelector('#body').innerHTML = `
      <div class="grid cols-4 mb">
        <div class="card kpi"><div class="label">Calls</div><div class="value">${ov.calls_total}</div><div class="sub">${days}-day window</div></div>
        <div class="card kpi"><div class="label">Containment</div><div class="value">${ov.containment_percent}%</div><div class="sub">resolved ÷ ended</div></div>
        <div class="card kpi"><div class="label">Escalation rate</div><div class="value">${ov.escalation_rate_percent}%</div><div class="sub">transfers ÷ ended</div></div>
        <div class="card kpi"><div class="label">Latency (simulator)</div><div class="value">${ov.latency_simulator.avg_ms} ms</div><div class="sub">avg answer-start · max ${ov.latency_simulator.max_ms} ms · not a production telephony metric</div></div>
      </div>
      <div class="grid cols-2 mb">
        <div class="card"><div class="card-h"><h3>Enquiry drivers</h3></div><div class="card-b">${drivers.length ? barChart({ data: drivers }) : '<div class="empty">No data</div>'}</div></div>
        <div class="card"><div class="card-h"><h3>Payment status mix (discussed)</h3></div><div class="card-b" style="display:flex;gap:18px;align-items:center">${donutChart({ data: payMix })}${legend(payMix)}</div></div>
        <div class="card"><div class="card-h"><h3>Processing-stage mix</h3></div><div class="card-b">${stageMix.length ? barChart({ data: stageMix, color: '#1d3f5f' }) : '<div class="empty">No data</div>'}</div></div>
        <div class="card"><div class="card-h"><h3>Outcome mix</h3></div><div class="card-b" style="display:flex;gap:18px;align-items:center">${donutChart({ data: outcomes })}${legend(outcomes)}</div></div>
        <div class="card"><div class="card-h"><h3>Repeat callers per claim</h3></div><div class="card-b">
          ${ov.repeat_callers_by_claim.length ? `<table class="table"><thead><tr><th>Claim</th><th>Sessions</th></tr></thead><tbody>${ov.repeat_callers_by_claim.map((x) => `<tr><td class="mono">${esc(x.claim_id)}</td><td><b>${x.sessions}</b></td></tr>`).join('')}</tbody></table>` : '<div class="empty">No claim was discussed in more than one call.</div>'}
        </div></div>
        <div class="card"><div class="card-h"><h3>Payment issues to watch</h3></div><div class="card-b">
          <dl class="kv">
            <dt>Failed payments</dt><dd><span class="pill bad">${ov.payment_issues.failed}</span></dd>
            <dt>Held payments</dt><dd><span class="pill warn">${ov.payment_issues.held}</span></dd>
            <dt>Delayed (threshold-flagged)</dt><dd><span class="pill warn">${ov.payment_issues.delayed}</span></dd>
            <dt>Unreadable status (unmapped)</dt><dd><span class="pill muted">${ov.payment_issues.unmapped}</span></dd>
            <dt>Open processor queries</dt><dd>${ov.open_processor_queries}</dd>
            <dt>Languages in use</dt><dd>${Object.keys(ov.by_language).sort().map(esc).join(', ')}</dd>
          </dl>
          <div class="note small mt">Definitions & denominators: docs/WORKFLOWS.md §Analytics. All values derive from stored records — none are precomputed or mocked.</div>
        </div></div>
      </div>`;
    await drawReports();
  }
}
