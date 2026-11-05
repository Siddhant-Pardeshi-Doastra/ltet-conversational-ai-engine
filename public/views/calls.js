// Calls list + immutable call-log detail (FR-32/33/34/36/38).
import { api, esc } from '../app.js';

export async function renderCalls(root) {
  root.innerHTML = `
    <div class="card mb"><div class="card-b flex wrap">
      <input type="search" id="q" placeholder="Search id / session / PS / summary…" style="max-width:300px" />
      <select id="f-outcome" style="max-width:180px"><option value="">Any outcome</option><option>resolved</option><option>escalated</option><option>verification_failed</option><option>abandoned</option></select>
      <select id="f-lang" style="max-width:140px"><option value="">Any language</option>${['en','hi','bn','mr','ta','te','gu','pa','ml','kn','or','as'].map((l) => `<option>${l}</option>`).join('')}</select>
      <button class="btn primary" id="apply">Apply</button>
      <span class="grow"></span><span class="muted small" id="count"></span>
    </div></div>
    <div class="card"><div class="table-wrap"><table class="table" id="calls-table">
      <thead><tr><th>Log</th><th>When (IST)</th><th>Outcome</th><th>Lang</th><th>Caller type</th><th>Verified PS</th><th>Verification</th><th>Delay flag</th><th>Mode</th></tr></thead>
      <tbody id="rows"></tbody></table></div></div>
    <div id="drawer"></div>`;
  load();

  root.querySelector('#apply').addEventListener('click', load);
  root.querySelector('#q').addEventListener('keydown', (e) => { if (e.key === 'Enter') load(); });

  async function load() {
    const q = root.querySelector('#q').value.trim();
    const outcome = root.querySelector('#f-outcome').value;
    const language = root.querySelector('#f-lang').value;
    const r = await api('GET', `/api/calls?limit=100&q=${encodeURIComponent(q)}&outcome=${encodeURIComponent(outcome)}&language=${encodeURIComponent(language)}`);
    root.querySelector('#count').textContent = `${r.total} call log(s)`;
    root.querySelector('#rows').innerHTML = r.calls.map((c) => `
      <tr class="clickable" data-id="${esc(c.id)}" data-session="${esc(c.session_id)}">
        <td class="mono">${esc(c.id)}</td>
        <td class="small">${esc(c.created_at_ist)}</td>
        <td><span class="pill ${c.outcome === 'resolved' ? 'ok' : c.outcome === 'escalated' ? 'warn' : 'bad'}">${esc(c.outcome)}</span></td>
        <td>${esc(c.language)}</td>
        <td>${esc(c.caller_type || '—')}</td>
        <td class="mono">${esc(c.verified_ps_no_masked || '—')}</td>
        <td>${c.verification_method ? `<span class="pill info">${esc(c.verification_method)}</span>` : '<span class="pill bad">none</span>'}</td>
        <td>${c.delayed_flag ? '<span class="pill warn">delayed</span>' : '—'}</td>
        <td><span class="pill muted">${esc(c.mode)}</span></td>
      </tr>`).join('') || '<tr><td colspan="9" class="empty">No calls found.</td></tr>';
    root.querySelectorAll('tr.clickable').forEach((tr) => tr.addEventListener('click', () => openDetail(tr.dataset.session)));
  }

  async function openDetail(sessionId) {
    const d = await api('GET', `/api/calls/${sessionId}`);
    const [logRes, notesRes] = await Promise.all([
      api('GET', `/api/calls/${sessionId}/log`).catch(() => null),
      api('GET', `/api/notes?call_log_id=${(d.log || {}).id || ''}`).catch(() => ({ notes: [] })),
    ]);
    let transcript = null;
    let transcriptDenied = false;
    try { transcript = await api('GET', `/api/calls/${sessionId}/transcript`); } catch { transcriptDenied = true; }

    const drawer = root.querySelector('#drawer');
    const s = d.session;
    drawer.innerHTML = `
      <div class="drawer-bg"><div class="drawer">
        <div class="drawer-head">
          <h2>Call ${esc(s.id)}</h2>
          <span class="pill ${s.outcome === 'resolved' ? 'ok' : s.outcome === 'escalated' ? 'warn' : 'bad'}">${esc(s.outcome || s.state)}</span>
          <span class="grow"></span>
          <button class="btn sm" id="close-drawer">✕ Close</button>
        </div>
        <div class="tabs" id="dtabs">
          <button data-tab="summary" class="active">Summary</button>
          <button data-tab="transcript">Transcript</button>
          <button data-tab="history">Claim history & notes</button>
          <button data-tab="evidence">Answer evidence</button>
        </div>
        <div id="tab-body"></div>
      </div></div>`;
    drawer.querySelector('#close-drawer').addEventListener('click', () => { drawer.innerHTML = ''; });

    const tabs = drawer.querySelectorAll('#dtabs button');
    tabs.forEach((b) => b.addEventListener('click', () => {
      tabs.forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      show(b.dataset.tab);
    }));
    show('summary');

    function show(tab) {
      const body = drawer.querySelector('#tab-body');
      if (tab === 'summary') {
        const log = logRes?.log;
        const sum = log?.summary || {};
        body.innerHTML = `
          <div class="summary-block mb">
            <h4>Structured English summary (immutable final log ${esc(log?.id || 'pending')})</h4>
            <dl class="kv">
              <dt>Outcome</dt><dd>${esc(log?.outcome || s.outcome || '—')}</dd>
              <dt>Verified identity</dt><dd>${log?.verified_ps_no_masked ? `PS ${esc(log.verified_ps_no_masked)} (${esc(log.verification_method || '')})` : '<b>None — identity NOT verified</b>'}</dd>
              <dt>Claimed PS</dt><dd>${esc(log?.claimed_ps_no_masked || '—')} <span class="muted small">(claimed ≠ verified; unverified calls never attach to claim history)</span></dd>
              <dt>Intent</dt><dd>${esc(sum.intent || '—')}</dd>
              <dt>Language</dt><dd>${esc(log?.language || '—')}</dd>
              <dt>Caller type</dt><dd>${esc(log?.caller_type || '—')}</dd>
              <dt>Delay flag</dt><dd>${log?.delayed_flag ? '<span class="pill warn">delayed payment</span>' : 'No'}</dd>
              <dt>Sentiment</dt><dd>${esc(sum.sentiment_estimate || '—')} <span class="muted small">(labelled estimate; never grants access)</span></dd>
              <dt>Issue flags</dt><dd><div class="chips">${(log?.issue_flags || []).map((f) => `<span class="pill muted">${esc(f)}</span>`).join('') || '—'}</div></dd>
              <dt>Follow-up</dt><dd>${(log?.follow_up || []).map((f) => esc(f)).join('; ') || '—'}</dd>
              <dt>Facts given</dt><dd>${(log?.facts_given || []).map((f) => `
                <div class="small mb"><b class="mono">${esc(f.claim_id)}</b> — topics: ${esc((f.topics || []).join(', ') || '—')}
                ${f.stage ? ` · stage: ${esc(f.stage)}` : ''}${f.payment_group ? ` · payment: ${esc(f.payment_group)}` : ''}
                ${f.amount_display || f.amount_minor !== undefined && f.amount_minor !== null ? ` · amount: ${esc(f.amount_display || fmtMinor(f.amount_minor))}` : ''}
                ${f.reason ? ` · reason: ${esc(f.reason)}` : ''}</div>`).join('') || '—'}</dd>
            </dl>
          </div>
          <div class="note info small">Immutable log (FR-34): created once, locked; application roles cannot edit or delete it. Processor notes are separate records below.</div>`;
      } else if (tab === 'transcript') {
        if (transcriptDenied) {
          body.innerHTML = `<div class="note danger">Transcript access is not permitted for your role (FR-36). Summaries are the processor default. Auditors/admins may access full transcripts; every access is audited.</div>`;
        } else {
          body.innerHTML = `<div class="card"><div class="card-b" style="display:flex;flex-direction:column;gap:8px">
            ${(transcript.transcript || []).map((t) => `<div class="bubble ${t.speaker === 'system' ? 'system' : t.speaker === 'caller' ? 'caller' : 'keypad'}" style="max-width:90%"><span class="tag">${esc(t.speaker)} · ${esc(t.at_ist || '')}${t.protected ? ' · protected' : ''}</span>${esc(t.text)}</div>`).join('')}
          </div></div>`;
        }
      } else if (tab === 'history') {
        const dh = logRes?.document_history || [];
        const ce = logRes?.claim_entries || [];
        body.innerHTML = `
          <div class="card mb"><div class="card-h"><h3>Claim-level entries (deduplicated)</h3></div><div class="card-b">
            ${ce.length ? `<table class="table"><thead><tr><th>Claim</th><th>Topics</th><th>First discussed</th></tr></thead><tbody>${ce.map((e) => `<tr><td class="mono">${esc(e.claim_id)}</td><td>${esc(JSON.parse(e.topics || '[]').join(', '))}</td><td class="small muted">${esc(e.first_discussed_at)}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">No claims discussed.</div>'}
          </div></div>
          <div class="card mb"><div class="card-h"><h3>Document history entries (call history — not uploads)</h3></div><div class="card-b">
            ${dh.length ? `<div class="timeline">${dh.map((h) => `<div class="t-item"><b class="mono small">${esc(h.claim_id)}</b><div class="small">${esc(h.text)}</div><div class="small muted">${esc(h.created_by)} · ${esc(h.at)}</div></div>`).join('')}</div>` : '<div class="empty">No history entries (unverified calls never create claim history).</div>'}
          </div></div>
          <div class="card"><div class="card-h"><h3>Processor notes (append-only)</h3></div><div class="card-b">
            <div class="flex mb"><input type="text" id="note-text" placeholder="Add a note…" /><button class="btn primary sm" id="note-add">Add</button></div>
            ${(notesRes.notes || []).map((n) => `<div class="small mb"><b>${esc(n.author_user)}</b> · <span class="muted">${esc(n.at)}</span><br/>${esc(n.text)}</div>`).join('') || '<div class="empty">No notes.</div>'}
          </div></div>`;
        body.querySelector('#note-add').addEventListener('click', async () => {
          const txt = body.querySelector('#note-text').value.trim();
          if (!txt) return;
          await api('POST', '/api/notes', { call_log_id: logRes?.log?.id, text: txt });
          openDetail(sessionId);
        });
      } else if (tab === 'evidence') {
        const ev = logRes?.answer_evidence || [];
        body.innerHTML = ev.length ? `
          <div class="card"><div class="table-wrap"><table class="table"><thead><tr><th>Fact</th><th>Source</th><th>Source version</th><th>Retrieved</th></tr></thead><tbody>
          ${ev.map((e) => `<tr><td class="mono">${esc(e.fact_key)}</td><td class="mono small">${esc(e.source_ref)}</td><td class="mono small">${esc(e.source_version)}</td><td class="small muted">${esc(e.retrieved_at)}</td></tr>`).join('')}
          </tbody></table></div></div>
          <div class="note info mt small">NFR-09 provenance: every spoken protected fact binds to the verified session, the selected claim, the source response/version and the retrieval time.</div>`
          : '<div class="empty">No answer evidence recorded (no facts were spoken).</div>';
      }
    }

    function fmtMinor(m) {
      if (m === null || m === undefined) return '';
      const rupees = Math.floor(Math.abs(m) / 100);
      const paise = Math.abs(m) % 100;
      const rs = String(rupees);
      const last3 = rs.slice(-3); const rest = rs.slice(0, -3);
      return `${m < 0 ? '-' : ''}₹${rest ? rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' : ''}${last3}.${String(paise).padStart(2, '0')}`;
    }
  }
}
