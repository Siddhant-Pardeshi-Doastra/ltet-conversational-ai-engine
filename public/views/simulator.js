// Call Simulator: drives the deterministic voice engine via the same API the
// telephony adapter uses. Includes the isolated verification-message inbox
// (SEC-04) and the human-grade browser speech engine.
import { api, esc, state } from '../app.js';
import { voice, localeFor } from '../voice.js';

let sim = { sessionId: null, busy: false, ttsOn: true, rate: 1, lang: 'auto' };
let presets = [
  { label: 'Linked employee (Arjun, 7 claims)', number: '+91 55555 50001' },
  { label: 'Linked employee (Priya, query claim)', number: '+91 55555 50002' },
  { label: 'Credited payment (Vikram)', number: '+91 55555 50003' },
  { label: 'Zero claims (Suman)', number: '+91 55555 50009' },
  { label: 'Unlinked number (type PS)', number: '+91 91234 00099' },
  { label: 'Legit beneficiary (Meera, granted)', number: '+91 55555 51001' },
  { label: 'Impostor beneficiary (no binding)', number: '+91 91234 00042' },
  { label: 'Revoked grant (Amit)', number: '+91 55555 51004' },
  { label: 'Landline beneficiary (no SMS)', number: '+91 55555 61005' },
];

export async function renderSimulator(root, params = {}) {
  // Language catalogue from the platform (FRS core + extended), grouped.
  let catalogue = { frs_core: [], extended: [] };
  try {
    catalogue = await api('GET', '/api/languages');
  } catch { /* fallback below keeps the console usable */ }
  const langName = (p) => `${p.name} (${p.lang.toUpperCase()})`;
  const coreOpts = catalogue.frs_core.map((p) => `<option value="${esc(p.lang)}">${esc(langName(p))}${p.launch_ready ? '' : ' ·'}</option>`).join('');
  const extOpts = catalogue.extended.map((p) => `<option value="${esc(p.lang)}">${esc(langName(p))} ·</option>`).join('');

  root.innerHTML = `
    <div class="sim-grid">
      <div class="phone" id="phone">
        <div class="phone-statusbar"><span id="sb-time"></span><span class="sb-right">LTET LINE <span class="sb-bar"></span></span></div>
        <div class="phone-top"><span class="dot"></span><span id="phone-status">Ready — start a call</span>
          <span class="eq" id="voice-eq" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
          <span class="grow"></span><span id="phone-lang"></span></div>
        <div class="transcript" id="transcript"><div class="bubble system" style="align-self:center;background:transparent;color:#7c98ad">Conversation will appear here. All data is synthetic.</div></div>
        <div class="state-line">state: <span class="st" id="state-chip">idle</span> <span id="outcome-chip"></span></div>
        <div class="sim-input">
          <input type="text" id="utter" placeholder="Type what the caller says (e.g. 'haan', 'meri claim ka status', 'payment status', 'agent')…" />
          <button class="btn primary" id="send-btn">Send</button>
        </div>
        <div class="flex wrap mt">
          <button class="btn sm" id="mic-btn" title="Browser speech recognition (where supported)">🎤 Speak</button>
          <button class="btn sm" id="interrupt-btn" title="Stop current audio (simulated barge-in)">⏹ Interrupt</button>
          <button class="btn sm" id="repeat-btn">🔁 Repeat</button>
          <button class="btn sm" id="slow-btn">🐢 Slower</button>
          <span class="grow"></span>
          <button class="btn danger sm" id="hangup-btn">End call</button>
        </div>
        <div class="state-line"><span id="key-buffer" style="letter-spacing:2px"></span><span class="grow"></span><span class="small">IVR keypad — digits buffer, ✓ submits, * resends code</span></div>
        <div class="keypad" id="keypad">
          ${['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'].map((k) => `<button data-key="${k}">${k}</button>`).join('')}
          <button data-key="ENTER" style="grid-column: span 3">✓ Enter</button>
        </div>
        <div class="small mt" style="color:#7c98ad">Keypad entries during verification are protected: code digits are never stored in the transcript or any record (SEC-04/FR-49).</div>
      </div>

      <div style="display:flex;flex-direction:column;gap:14px">
        <div class="card"><div class="card-h"><h3>Caller condition</h3></div><div class="card-b">
          <label class="field"><span>Calling number (test line)</span><input type="text" id="caller-number" value="+91 55555 50001" /></label>
          <div class="btn-row">${presets.map((p, i) => `<button class="btn sm" data-preset="${i}">${esc(p.label)}</button>`).join('')}</div>
          <div class="mt flex">
            <label class="field grow" style="margin:0"><span>Language — <span id="lang-count"></span></span>
              <select id="sim-lang">
                <option value="auto">Auto-detect</option>
                <optgroup label="Core catalogue">${coreOpts}</optgroup>
                ${extOpts ? `<optgroup label="Extended catalogue">${extOpts}</optgroup>` : ''}
              </select></label>
            <label class="field" style="margin:0;width:110px"><span>Voice rate</span>
              <select id="sim-rate"><option value="0.85">0.85×</option><option value="1" selected>1×</option><option value="1.15">1.15×</option></select></label>
          </div>
          <div class="mt flex">
            <label class="field grow" style="margin:0"><span>Assistant voice <span class="pill ok" id="voice-grade" style="margin-left:6px">—</span></span>
              <select id="sim-voice"><option value="">Auto — most human available</option></select></label>
          </div>
          <div class="mt">
            <label style="display:flex;gap:8px;align-items:center;font-size:13px"><input type="checkbox" id="tts-on" checked /> Speak replies (browser TTS)</label>
            <label style="display:flex;gap:8px;align-items:center;font-size:13px"><input type="checkbox" id="force-busy" /> Simulate all-lines-busy (FR-51)</label>
          </div>
          <div class="mt btn-row">
            <button class="btn primary" id="start-btn">▶ Start call</button>
          </div>
        </div></div>

        <div class="card" id="verify-card" style="display:none"><div class="card-h"><h3>Verification status</h3></div><div class="card-b" id="verify-body"></div></div>

        <div class="inbox-card">
          <h4>📱 Secure Message Inbox — verification device (isolated channel)</h4>
          <div class="small" style="color:var(--ink-soft)">Delivers verification codes to the verified user's device. This panel is the only place a code is displayed; codes never appear in the conversation, transcripts, logs or analytics.</div>
          <div id="inbox-body"><div class="small muted">No messages.</div></div>
        </div>
      </div>
    </div>`;

  const $ = (s) => root.querySelector(s);
  $('#sb-time').textContent = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
  if (params && params.number) $('#caller-number').value = params.number;
  $('#lang-count').textContent = `${catalogue.frs_core.length + catalogue.extended.length} languages configured`;

  // Voice engine: load device voices, populate the picker for the current language.
  const refreshVoicePicker = () => {
    const lang = sim.lang === 'auto' ? 'en' : sim.lang;
    const sel = $('#sim-voice');
    const current = sel.value;
    const list = voice.voicesFor(lang);
    sel.innerHTML = '<option value="">Auto — most human available</option>' +
      list.slice(0, 8).map((v) => `<option value="${esc(v.voiceURI)}">${esc(v.name)}</option>`).join('');
    if (current) sel.value = current;
    const grade = $('#voice-grade');
    if (!voice.supported) { grade.textContent = 'text mode'; grade.className = 'pill muted'; }
    else if (voice.isHumanGrade(lang)) { grade.textContent = 'human-grade'; grade.className = 'pill ok'; }
    else { grade.textContent = 'device voice'; grade.className = 'pill info'; }
  };
  voice.init().then(() => { refreshVoicePicker(); refreshVoicePicker(); /* second pass after voiceschanged */ });
  if (typeof window.speechSynthesis !== 'undefined') {
    window.speechSynthesis.onvoiceschanged = () => refreshVoicePicker();
  }
  $('#sim-lang').addEventListener('change', (e) => { sim.lang = e.target.value; refreshVoicePicker(); });
  $('#sim-voice').addEventListener('change', (e) => { voice.prefer(sim.lang === 'auto' ? 'en' : sim.lang, e.target.value || null); });
  $('#sim-rate').addEventListener('change', (e) => { sim.rate = Number(e.target.value); });
  $('#tts-on').addEventListener('change', (e) => { sim.ttsOn = e.target.checked; });

  root.querySelectorAll('[data-preset]').forEach((b) => b.addEventListener('click', () => {
    $('#caller-number').value = presets[Number(b.dataset.preset)].number;
  }));

  $('#start-btn').addEventListener('click', async () => {
    try {
      const r = await api('POST', '/api/calls', {
        caller_number: $('#caller-number').value.trim(),
        force_busy: $('#force-busy').checked,
        scenario: params && params.scenario,
      });
      sim.sessionId = r.session.id;
      resetTranscript();
      applySession(r.session);
      addBubbles(r.replies);
      refreshInbox();
    } catch (e) { alert(e.message); }
  });

  $('#hangup-btn').addEventListener('click', () => event({ type: 'hangup', expected: true }));
  $('#send-btn').addEventListener('click', sendUtterance);
  $('#utter').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendUtterance(); });
  let keyBuffer = '';
  const keyBuf = () => root.querySelector('#key-buffer');
  root.querySelectorAll('[data-key]').forEach((b) => b.addEventListener('click', () => {
    const k = b.dataset.key;
    if (k === 'ENTER') {
      const digits = keyBuffer || '#';
      keyBuffer = '';
      keyBuf().textContent = '';
      event({ type: 'keypad', digits });
    } else if (k === '*') {
      keyBuffer = '';
      keyBuf().textContent = '';
      event({ type: 'keypad', digits: '*' }); // resend code
    } else {
      keyBuffer = (keyBuffer + k).slice(0, 20);
      keyBuf().textContent = '•'.repeat(keyBuffer.length);
    }
  }));
  $('#repeat-btn').addEventListener('click', () => event({ type: 'utterance', text: 'repeat' }));
  $('#slow-btn').addEventListener('click', () => event({ type: 'utterance', text: 'slower please' }));
  $('#interrupt-btn').addEventListener('click', () => voice.cancel());

  $('#mic-btn').addEventListener('click', () => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      $('#phone-status').textContent = 'Browser speech recognition unavailable in this environment — use typed utterances (labelled fallback).';
      return;
    }
    const rec = new SR();
    rec.lang = localeFor(sim.lang === 'auto' ? 'en' : sim.lang);
    rec.interimResults = false;
    rec.onresult = (e) => { const t = e.results[0][0].transcript; $('#utter').value = t; sendUtterance(); };
    rec.onerror = () => { $('#phone-status').textContent = 'Speech recognition error — use typed utterances.'; };
    rec.start();
    $('#phone-status').textContent = 'Listening…';
  });

  if (params && params.number) $('#start-btn').click();

  function sendUtterance() {
    const v = $('#utter').value.trim();
    if (!v || !sim.sessionId) return;
    $('#utter').value = '';
    event({ type: 'utterance', text: v });
  }

  function resetTranscript() {
    $('#transcript').innerHTML = '';
    $('#outcome-chip').innerHTML = '';
  }

  function addBubbles(replies) {
    const t = $('#transcript');
    for (const r of replies || []) {
      const b = document.createElement('div');
      b.className = `bubble ${r.speaker || 'system'}`;
      b.innerHTML = `${r.speakerLabel ? `<span class="tag">${esc(r.speakerLabel)}</span>` : ''}${esc(r.text)}`;
      t.appendChild(b);
      speak(r.text, r.lang);
    }
    t.scrollTop = t.scrollHeight;
  }

  function addLocal(speaker, text, cls) {
    const t = $('#transcript');
    const b = document.createElement('div');
    b.className = `bubble ${cls}`;
    b.innerHTML = `<span class="tag">${esc(speaker)}</span>${esc(text)}`;
    t.appendChild(b);
    t.scrollTop = t.scrollHeight;
  }

  function speak(text, lang) {
    if (!sim.ttsOn) return;
    const eq = root.querySelector('#voice-eq');
    voice.speak(text, lang, {
      rateMultiplier: sim.rate,
      onStart: () => eq && eq.classList.add('on'),
      onEnd: () => eq && eq.classList.remove('on'),
    });
  }

  async function event(evt) {
    if (!sim.sessionId) { alert('Start a call first.'); return; }
    if (sim.busy) return;
    if (evt.type === 'utterance') addLocal('Caller', evt.text, 'caller');
    if (evt.type === 'keypad') addLocal('Keypad', evt.digits === '*' ? '*' : `pressed ${evt.digits}`, 'keypad');
    sim.busy = true;
    try {
      const r = await api('POST', `/api/calls/${sim.sessionId}/events`, evt);
      applySession(r.session);
      addBubbles(r.replies);
      if (evt.type === 'keypad' && r.session.verification?.challenge_active) refreshInbox();
      else refreshInbox();
    } catch (e) {
      if (e.status !== 409) addLocal('Simulator', e.message || 'event failed', 'keypad');
    } finally { sim.busy = false; }
  }

  function applySession(s) {
    const chip = $('#state-chip');
    chip.textContent = s.state;
    $('#phone-lang').textContent = `lang: ${s.language || 'en'}`;
    $('#phone-status').innerHTML = s.state === 'ended'
      ? `Call ended — outcome: <b>${esc(s.outcome || '—')}</b>`
      : `In call ${esc(s.id)}`;
    $('.dot').parentElement.classList.toggle('ended', s.state === 'ended');
    const oc = $('#outcome-chip');
    oc.innerHTML = s.outcome ? `<span class="pill ${s.outcome === 'resolved' ? 'ok' : s.outcome === 'escalated' ? 'warn' : 'bad'}">${esc(s.outcome)}</span>` : '';
    const vc = $('#verify-card');
    vc.style.display = 'block';
    const v = s.verification || {};
    $('#verify-body').innerHTML = `
      <div class="verify-card">
        <span class="pill ${v.verified ? 'ok' : 'muted'}">${v.verified ? 'VERIFIED' : 'NOT VERIFIED'}</span>
        <div class="grow">
          <div class="big">${v.verified ? `Identity verified via ${esc(v.method || 'otp')} (${esc(v.assurance || '')})` : 'No verified identity yet'}</div>
          <div class="small muted">
            ${s.verified_ps_no_masked ? `Verified PS: <b>${esc(s.verified_ps_no_masked)}</b>` : ''}
            ${s.claimed_ps_no_masked ? ` · Claimed PS: ${esc(s.claimed_ps_no_masked)}` : ''}
            ${!v.verified && v.challenge_active ? ' · challenge pending (enter code on keypad)' : ''}
          </div>
          <div class="small muted">Caller type: ${esc(s.caller_type || 'unknown')} · caller number: ${esc(s.caller_number_masked || 'withheld')} (${esc(s.caller_number_type || '')})</div>
        </div>
      </div>`;
    if (s.state === 'ended') { sim.sessionId = null; }
  }

  async function refreshInbox() {
    if (!sim.sessionId) return;
    try {
      const r = await api('GET', `/api/demo/inbox?session_id=${sim.sessionId}`);
      $('#inbox-body').innerHTML = r.messages.length
        ? r.messages.map((m) => `<div class="inbox-msg"><div class="to">to ${esc(m.target_phone)} · ${esc(m.at_ist)}</div>${esc(m.message)}</div>`).join('')
        : '<div class="small muted">No messages for this call.</div>';
    } catch { /* live mode blocks this endpoint */ }
  }
}
