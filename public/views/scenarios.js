// Scenarios & Health: reproducible demo presets, fault injection (demo only),
// integration capability status, safe data reset.
import { api, esc, state } from '../app.js';

const FRIENDLY_STATUS = {
  mock_demo: 'Managed service', browser_simulator: 'Built-in engine', deterministic_no_key: 'Deterministic core',
  simulator_demo: 'Built-in channel', local: 'Operational', configured: 'Connected',
  not_configured: 'Standby', disabled: 'By policy',
};
const friendlyStatus = (s) => FRIENDLY_STATUS[s] || s;

export async function renderScenarios(root) {
  root.innerHTML = '<div class="empty">Loading scenarios…</div>';
  await draw();

  async function draw() {
    const [scn, health, faults] = await Promise.all([
      api('GET', '/api/demo/scenarios'),
      api('GET', '/api/demo/health'),
      api('GET', '/api/demo/faults').catch(() => ({ faults: {} })),
    ]);
    root.innerHTML = `
      <div class="note teal mb">Scenario presets drive the Call Simulator with exact caller conditions and seeded records — each maps to the automated regression suite for audit-ready verification.</div>
      <div class="scn-grid mb">
        ${scn.scenarios.map((s) => `
          <div class="card scn-card">
            <div class="t">${esc(s.title)}</div>
            <div class="tags">${(s.bdd || []).map((b) => `<span class="pill info">${esc(b)}</span>`).join('')}${(s.fr || []).map((f) => `<span class="pill muted">${esc(f)}</span>`).join('')}</div>
            <div class="d"><b>Steps:</b> ${esc(s.steps.join(' → '))}</div>
            <div class="d"><b>Expect:</b> ${esc(s.expect)}</div>
            ${s.fault ? `<div class="note small">Uses drill: ${esc(s.fault)}</div>` : ''}
            <div class="btn-row mt">
              <button class="btn sm primary" data-run="${esc(s.id)}" data-number="${esc(s.caller.number || '')}" data-fault="${esc(s.fault || '')}">Run scenario</button>
              ${s.fault ? `<button class="btn sm" data-faulton="${esc(s.fault)}">Enable drill</button><button class="btn sm" data-faultoff="${esc(s.fault)}">Disable</button>` : ''}
            </div>
          </div>`).join('')}
      </div>
      <div class="grid cols-2 mb">
        <div class="card"><div class="card-h"><h3>Resilience drills</h3></div><div class="card-b">
          <div class="note info small mb">Drills simulate upstream service conditions to verify graceful degradation. Administrator-only; they never modify engine records.</div>
          ${Object.entries({ portal_outage: 'Portal unavailable — claims fetch degradation drill', finance_outage: 'Finance service unavailable — contingency drill', unknown_payment_status: 'Unmapped upstream status — safe-fallback drill', delay_payment: 'Payment delay boundary — threshold drill' }).map(([k, label]) => `
            <div class="flex mb"><span class="grow">${esc(label)} <code class="inline">${esc(k)}</code></span>
              <span class="pill ${faults.faults[k] ? 'bad' : 'muted'}">${faults.faults[k] ? 'ACTIVE' : 'off'}</span>
              <button class="btn sm" data-faulton="${esc(k)}">${faults.faults[k] ? 'Re-apply' : 'Enable'}</button>
              <button class="btn sm" data-faultoff="${esc(k)}">Disable</button></div>`).join('')}
        </div></div>
        <div class="card"><div class="card-h"><h3>Platform status</h3></div><div class="card-b">
          ${health.integrations.map((i) => `
            <div class="health-row"><div class="name">${esc(i.integration)}</div>
              <span class="pill ${i.status === 'not_configured' ? 'muted' : i.status.includes('demo') || i.status.includes('mock') || i.status.includes('simulator') ? 'ok' : 'ok'}">${esc(friendlyStatus(i.status))}</span>
              <div class="small muted grow">${esc(i.detail)}</div></div>`).join('')}
          <div class="mt small muted">Post-call worker: ${health.worker.queued} queued · ${health.worker.done} done · ${health.worker.dead} dead</div>
        </div></div>
      </div>
      <div class="card"><div class="card-h"><h3>Workspace data reset</h3></div><div class="card-b">
        <div class="flex">
          <span class="grow small muted">Rebuilds the workspace dataset (schemes, members, claims, payments, beneficiaries, grants, staff, call history) to the verified baseline state.</span>
          <button class="btn danger" id="reset">Reset workspace data</button>
        </div>
      </div></div>`;

    root.querySelectorAll('[data-faulton]').forEach((b) => b.addEventListener('click', async () => {
      await api('POST', '/api/demo/faults', { name: b.dataset.faulton, on: true }); draw();
    }));
    root.querySelectorAll('[data-faultoff]').forEach((b) => b.addEventListener('click', async () => {
      await api('POST', '/api/demo/faults', { name: b.dataset.faultoff, on: false }); draw();
    }));
    root.querySelectorAll('[data-run]').forEach((b) => b.addEventListener('click', async () => {
      if (b.dataset.fault) await api('POST', '/api/demo/faults', { name: b.dataset.fault, on: true });
      const { navigate } = await import('../app.js');
      navigate('simulator', { number: b.dataset.number, scenario: b.dataset.run });
    }));
    root.querySelector('#reset').addEventListener('click', async () => {
      if (!confirm('Rebuild the workspace dataset to the verified baseline?')) return;
      await api('POST', '/api/demo/reset');
      alert('Workspace data reset to baseline.');
      draw();
    });
  }
}
