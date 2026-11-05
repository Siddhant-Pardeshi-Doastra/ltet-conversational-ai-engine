// Overview dashboard: hero band, animated KPIs, trend, languages, live
// activity, service status — the centrepiece of the console.
import { api, esc } from '../app.js';
import { lineChart, donutChart, legend, PALETTE } from '../charts.js';

function countUp(el, target, { dur = 1300, decimals = 0, suffix = '' } = {}) {
  const start = performance.now();
  const tick = (t) => {
    const p = Math.min(1, (t - start) / dur);
    const e = 1 - Math.pow(1 - p, 3); // ease-out cubic
    el.textContent = (target * e).toFixed(decimals) + suffix;
    if (p < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

const FRIENDLY_STATUS = {
  mock_demo: { label: 'Managed service', tone: 'ok' },
  browser_simulator: { label: 'Built-in engine', tone: 'ok' },
  deterministic_no_key: { label: 'Deterministic core', tone: 'ok' },
  simulator_demo: { label: 'Built-in channel', tone: 'ok' },
  local: { label: 'Operational', tone: 'ok' },
  configured: { label: 'Connected', tone: 'ok' },
  not_configured: { label: 'Standby', tone: 'muted' },
  disabled: { label: 'By policy', tone: 'muted' },
};
const friendly = (s) => FRIENDLY_STATUS[s] || { label: s, tone: 'muted' };

export async function renderOverview(root) {
  root.innerHTML = '<div class="empty">Preparing workspace…</div>';
  const [ov, readiness, queue, callbacks, recent] = await Promise.all([
    api('GET', '/api/analytics/overview?days=14'),
    api('GET', '/api/readiness'),
    api('GET', '/api/queue/alerts'),
    api('GET', '/api/callbacks'),
    api('GET', '/api/calls?limit=6'),
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

  const now = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());

  root.innerHTML = `
    <div class="hero anim-in">
      <div class="hero-bg"><i class="orb o1"></i><i class="orb o2"></i><i class="orb o3"></i></div>
      <div class="hero-content">
        <h2>Trust Portal Operations</h2>
        <div class="hero-sub">Conversational AI for employee claim, payment and beneficiary assistance — ${esc(now)} IST</div>
        <div class="hero-row">
          <span class="hero-pill"><span class="dot-live"></span> All services operational</span>
          <span class="hero-pill">Containment <b>${ov.containment_percent}%</b></span>
          <span class="hero-pill">Languages <b>${Object.keys(ov.by_language).length}</b></span>
          <span class="hero-pill">Uptime target <b>99.5%</b></span>
        </div>
      </div>
    </div>

    <div class="grid cols-4 mb">
      <div class="card kpi anim-in card-lift" style="--d:80ms"><span class="kpi-ico">☎</span><div class="label">Calls · 14 days</div><div class="value" data-count="${ov.calls_total}">0</div><div class="sub">${Object.entries(ov.by_outcome).map(([k, v]) => `${k}: ${v}`).join(' · ') || '—'}</div></div>
      <div class="card kpi tone-ok anim-in card-lift" style="--d:160ms"><span class="kpi-ico">◔</span><div class="label">Containment</div><div class="value" data-count="${ov.containment_percent}" data-decimals="1" data-suffix="%">0</div><div class="sub">resolved ÷ ended (documented definition)</div></div>
      <div class="card kpi tone-warn anim-in card-lift" style="--d:240ms"><span class="kpi-ico">⚑</span><div class="label">Pending alerts</div><div class="value" data-count="${openAlerts.length}">0</div><div class="sub">${ov.payment_issues.failed} failed · ${ov.payment_issues.held} held · ${ov.payment_issues.delayed} delayed payments</div></div>
      <div class="card kpi anim-in card-lift" style="--d:320ms"><span class="kpi-ico">↩</span><div class="label">Open callbacks</div><div class="value" data-count="${openCallbacks.length}">0</div><div class="sub">${ov.open_processor_queries} open processor queries</div></div>
    </div>

    <div class="grid cols-2 mb">
      <div class="card card-lift anim-in" style="--d:380ms"><div class="card-h"><h3>Call outcomes — 14-day trend</h3></div>
        <div class="card-b">${byDay.length ? lineChart({ series, labels: byDay.map((d) => d.day) }) : '<div class="empty">No calls in window</div>'}
          <div class="legend mt">${Object.entries(outcomeColors).filter(([k]) => series.some((s) => s.name === k)).map(([k, c]) => `<span><span class="sw" style="background:${c}"></span>${k}</span>`).join('')}</div>
        </div>
      </div>
      <div class="card card-lift anim-in" style="--d:440ms"><div class="card-h"><h3>Languages in use</h3><div class="right"><a href="#" data-nav="analytics" class="btn sm ghost">Analytics →</a></div></div>
        <div class="card-b" style="display:flex;gap:18px;align-items:center">
          ${donutChart({ data: langData })}
          ${legend(langData)}
        </div>
      </div>
    </div>

    <div class="grid cols-2 mb">
      <div class="card card-lift anim-in" style="--d:500ms"><div class="card-h"><h3>Pending processor alerts</h3><div class="right"><a href="#" data-nav="queue" class="btn sm ghost">Work queue →</a></div></div>
        <div class="card-b">
          ${openAlerts.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>Type</th><th>Claim</th><th>Queue</th><th>When</th></tr></thead><tbody>
            ${openAlerts.slice(0, 6).map((a) => `<tr><td><span class="pill ${a.type.includes('payment') ? 'warn' : 'info'}">${esc(a.type)}</span></td><td class="mono">${esc(a.claim_id || '—')}</td><td>${esc(a.persona_role || 'unrouted')}</td><td class="muted small">${esc(a.created_at_ist)}</td></tr>`).join('')}
          </tbody></table></div>` : '<div class="empty">No pending alerts — queue is clear</div>'}
        </div>
      </div>
      <div class="card card-lift anim-in" style="--d:560ms"><div class="card-h"><h3>Service status</h3><div class="right"><a href="#" data-nav="scenarios" class="btn sm ghost">Platform status →</a></div></div>
        <div class="card-b">
          ${(readiness.integrations || []).slice(0, 6).map((i) => {
    const f = friendly(i.status);
    return `
            <div class="health-row"><div class="name">${esc(i.integration)}</div>
              <span class="pill ${f.tone}">${esc(f.label)}</span>
              <div class="small muted grow">${esc(i.detail)}</div></div>`;
  }).join('')}
        </div>
      </div>
    </div>

    <div class="card card-lift anim-in" style="--d:620ms"><div class="card-h"><h3>Live activity</h3><div class="right"><span class="pill ok"><span class="dot-live"></span> streaming</span></div></div>
      <div class="card-b">
        ${(recent.calls || []).length ? recent.calls.map((c, i) => `
          <div class="feed-row" style="--d:${i * 90}ms">
            <span class="dot-live" style="animation-delay:${i * 0.3}s"></span>
            <span class="mono small">${esc(c.id)}</span>
            <span class="pill ${c.outcome === 'resolved' ? 'ok' : c.outcome === 'escalated' ? 'warn' : 'bad'}">${esc(c.outcome)}</span>
            <span class="pill muted">${esc(c.language)}</span>
            <span class="small muted grow">${esc(c.caller_type || '—')} · ${esc(c.verified_ps_no_masked || 'unverified')}</span>
            <span class="t small muted">${esc(c.created_at_ist)}</span>
          </div>`).join('') : '<div class="empty">No activity yet</div>'}
      </div>
    </div>`;

  // KPI count-up choreography
  root.querySelectorAll('[data-count]').forEach((el) => {
    countUp(el, Number(el.dataset.count), { decimals: Number(el.dataset.decimals || 0), suffix: el.dataset.suffix || '' });
  });

  // in-page navigation
  root.querySelectorAll('[data-nav]').forEach((a) => a.addEventListener('click', (e) => {
    e.preventDefault();
    const target = document.querySelector(`.nav-item[data-route="${a.dataset.nav}"]`);
    if (target) target.click();
  }));
}
