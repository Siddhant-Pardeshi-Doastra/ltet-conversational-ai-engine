// LTET demo console — SPA shell: api client, router, login, navigation.
import { renderOverview } from './views/overview.js';
import { renderSimulator } from './views/simulator.js';
import { renderCalls } from './views/calls.js';
import { renderQueue } from './views/queue.js';
import { renderClaimContext } from './views/claimcontext.js';
import { renderAnalytics } from './views/analytics.js';
import { renderAdmin } from './views/admin.js';
import { renderScenarios } from './views/scenarios.js';

export const state = { user: null, mode: 'demo', route: 'overview' };

export async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && state.user) {
    state.user = null;
    render();
    throw new Error('session expired');
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(json.error || `HTTP ${res.status}`);
    err.payload = json;
    err.status = res.status;
    throw err;
  }
  return json;
}

const ROUTES = [
  { id: 'overview', label: 'Overview', ico: '▚', render: renderOverview },
  { id: 'simulator', label: 'Call Simulator', ico: '☎', render: renderSimulator },
  { id: 'calls', label: 'Calls', ico: '☰', render: renderCalls },
  { id: 'queue', label: 'Work Queue', ico: '⚑', render: renderQueue },
  { id: 'claimcontext', label: 'Claim Context', ico: '▤', render: renderClaimContext },
  { id: 'analytics', label: 'Analytics', ico: '◠', render: renderAnalytics },
  { id: 'admin', label: 'Administration', ico: '⚙', render: renderAdmin },
  { id: 'scenarios', label: 'Scenarios & Health', ico: '◇', render: renderScenarios },
];

export function navigate(route, params) {
  state.route = route;
  state.routeParams = params || {};
  render();
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

// ---------------------------------------------------------------------------
// Login screen
// ---------------------------------------------------------------------------
function renderLogin() {
  const app = document.getElementById('app');
  app.innerHTML = `
    <div class="login-wrap">
      <form class="login-card" id="login-form">
        <h1>LTET Conversational AI Engine</h1>
        <div class="sub">Release 1 demo console · DOASTRA build · synthetic data only</div>
        <div id="login-error" style="display:none" class="error-msg"></div>
        <label class="field"><span>Username</span><input type="text" name="username" autocomplete="username" required /></label>
        <label class="field"><span>Password</span><input type="password" name="password" autocomplete="current-password" required /></label>
        <button class="btn primary" style="width:100%" type="submit">Sign in</button>
        <div class="demo-creds">
          <b>Demo users</b> (labelled demo credential, password <code class="inline">Demo#Pass1</code>):<br/>
          pms1 · pms2 (PMS queue) · spm1 · apm1 · admin1 · auditor1
        </div>
      </form>
    </div>`;
  app.querySelector('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      const r = await api('POST', '/api/auth/login', { username: f.username.value, password: f.password.value });
      state.user = r.user;
      state.mode = r.mode;
      render();
    } catch (err) {
      const box = app.querySelector('#login-error');
      box.style.display = 'block';
      box.textContent = 'Sign-in failed: invalid credentials.';
    }
  });
}

// ---------------------------------------------------------------------------
// App shell
// ---------------------------------------------------------------------------
function render() {
  const app = document.getElementById('app');
  if (!state.user) return renderLogin();
  const route = ROUTES.find((r) => r.id === state.route) || ROUTES[0];
  app.innerHTML = `
    <div class="shell">
      <nav class="sidebar" aria-label="Main">
        <div class="brand">LTET Conversational AI Engine
          <small>RELEASE 1 · DOASTRA DEMO BUILD</small>
        </div>
        ${ROUTES.map((r) => `<button class="nav-item ${r.id === route.id ? 'active' : ''}" data-route="${r.id}"><span class="ico">${r.ico}</span>${r.label}</button>`).join('')}
        <div class="spacer"></div>
        <div class="mode-chip">${state.mode === 'demo' ? '<b>DEMO MODE</b><br/>synthetic data only' : '<b>LIVE MODE</b><br/>verify readiness'}</div>
      </nav>
      <div class="main">
        <header class="topbar">
          <h1>${route.label}</h1>
          <div class="spacer"></div>
          <span class="badge ${state.mode === 'demo' ? 'demo' : 'live'}">${state.mode.toUpperCase()} MODE</span>
          <div class="user-chip">
            <div class="avatar">${esc((state.user.displayName || '?').slice(0, 1))}</div>
            <div class="meta"><div class="name">${esc(state.user.displayName)}</div><div class="role">${esc(state.user.role)}</div></div>
          </div>
          <button class="btn sm" id="logout-btn">Sign out</button>
        </header>
        <div class="content" id="screen"></div>
      </div>
    </div>`;
  app.querySelectorAll('.nav-item').forEach((b) => b.addEventListener('click', () => navigate(b.dataset.route)));
  app.querySelector('#logout-btn').addEventListener('click', async () => {
    await api('POST', '/api/auth/logout').catch(() => {});
    state.user = null;
    render();
  });
  route.render(app.querySelector('#screen'), state.routeParams || {});
}

(async function boot() {
  try {
    const me = await api('GET', '/api/auth/me');
    state.user = me.user;
    state.mode = me.mode;
  } catch { /* not signed in */ }
  render();
})();
