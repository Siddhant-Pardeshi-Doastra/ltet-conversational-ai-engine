// Call Simulator: drives the deterministic voice engine via the same API the
// telephony adapter uses. Includes the isolated verification-message inbox
// (SEC-04) and the human-grade browser speech engine.
import { api, esc, state } from '../app.js';
import { voice, localeFor } from '../voice.js';
import { LiveMic } from '../mic.js';

let sim = { sessionId: null, busy: false, ttsOn: true, rate: 1, lang: 'auto', state: null, style: 'warm' };
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
          <span class="grow"></span>
          <span class="turn-chip" id="turn-chip" style="display:none"></span>
          <span id="phone-lang"></span></div>
        <div class="transcript" id="transcript"><div class="bubble system" style="align-self:center;background:transparent;color:#7c98ad">Conversation will appear here.</div><div class="bubble interim" id="interim-bubble" style="display:none"></div></div>
        <div class="state-line">state: <span class="st" id="state-chip">idle</span> <span id="outcome-chip"></span></div>
        <div class="sim-input">
          <input type="text" id="utter" placeholder="Type what the caller says (e.g. 'haan', 'meri claim ka status', 'payment status', 'agent')…" />
          <button class="btn primary" id="send-btn">Send</button>
        </div>
        <div class="flex wrap mt">
          <button class="btn sm" id="mic-btn" title="Continuous listening — the agent hears you in real time">🎙 Live voice: Off</button>
          <button class="btn sm" id="interrupt-btn" title="Stop current audio (barge-in)">⏹ Interrupt</button>
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
            <label class="field grow" style="margin:0"><span>Language — <span id="lang-count"></span><br/><span class="small muted" id="voice-availability"></span></span>
              <select id="sim-lang">
                <option value="auto">Auto-detect</option>
                <optgroup label="Core catalogue">${coreOpts}</optgroup>
                ${extOpts ? `<optgroup label="Extended catalogue">${extOpts}</optgroup>` : ''}
              </select></label>
            <label class="field" style="margin:0;width:130px"><span>Voice style</span>
              <select id="sim-style"><option value="warm" selected>Warm & soft</option><option value="standard">Standard</option><option value="crisp">Crisp</option></select></label>
            <label class="field" style="margin:0;width:96px"><span>Fine trim</span>
              <select id="sim-rate"><option value="0.9">0.9×</option><option value="1" selected>1×</option><option value="1.1">1.1×</option></select></label>
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
  const speakableCount = () => {
    let n = 0;
    for (const p of [...catalogue.frs_core, ...catalogue.extended]) {
      if (voice.voicesFor(p.lang).length > 0) n += 1;
    }
    return n;
  };
  const refreshVoicePicker = () => {
    const lang = sim.lang === 'auto' ? 'en' : sim.lang;
    const sel = $('#sim-voice');
    const current = sel.value;
    const list = voice.voicesFor(lang);
    sel.innerHTML = '<option value="">Auto — most human available</option>' +
      list.slice(0, 8).map((v) => `<option value="${esc(v.voiceURI)}">${esc(v.name)}</option>`).join('');
    if (current) sel.value = current;
    const grade = $('#voice-grade');
    const countEl = $('#voice-availability');
    if (countEl) countEl.textContent = speakableCount() + ' of ' + (catalogue.frs_core.length + catalogue.extended.length) + ' speak audibly on this device — the rest run in live text';
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
  $('#sim-style').addEventListener('change', (e) => { sim.style = e.target.value; });
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

  // Live voice: continuous listening with endpointing + echo-aware turn-taking.
  let mic = null;
  const setTurn = (mode) => {
    const chip = $('#turn-chip');
    if (!chip) return;
    const map = {
      listening: ['Listening…', 'turn-listen'], thinking: ['Thinking…', 'turn-think'],
      speaking: ['Speaking…', 'turn-speak'], paused: ['Standing by…', 'turn-think'],
      idle: ['', ''], denied: ['Mic blocked — use typed input', 'turn-off'], unsupported: ['Voice input unsupported — typed input', 'turn-off'],
    };
    const [label, cls] = map[mode] || ['', ''];
    chip.textContent = label;
    chip.className = 'turn-chip ' + cls;
    chip.style.display = label ? '' : 'none';
  };
  mic = new LiveMic({
    onFinal: (text) => { sendUtteranceText(text); },
    onInterim: (text) => {
      const b = $('#interim-bubble');
      if (!b) return;
      b.style.display = text ? '' : 'none';
      b.textContent = text ? '🎙 ' + text : '';
      const tr = $('#transcript');
      tr.scrollTop = tr.scrollHeight;
    },
    onState: (s2) => {
      if (s2 === 'listening') setTurn(mic && mic.active ? 'listening' : 'idle');
      else if (s2 === 'denied' || s2 === 'unsupported') {
        setTurn(s2);
        const btn = $('#mic-btn');
        btn.textContent = '🎙 Live voice: Off';
        btn.classList.remove('live-on');
        mic.active = false;
      }
    },
  });
  Object.defineProperty(mic, 'lang', { get() { return sim.lang === 'auto' ? 'en' : sim.lang; } });
  Object.defineProperty(mic, 'locale', { get() { return localeFor(sim.lang === 'auto' ? 'en' : sim.lang); } });
  $('#mic-btn').addEventListener('click', () => {
    const btn = $('#mic-btn');
    if (mic.active) {
      mic.stop();
      btn.textContent = '🎙 Live voice: Off';
      btn.classList.remove('live-on');
      setTurn('');
    } else {
      const ok = mic.start();
      if (ok !== false && mic.supported) {
        btn.textContent = '🎙 Live voice: On';
        btn.classList.add('live-on');
      }
    }
  });

  if (params && params.number) $('#start-btn').click();

  function sendUtterance() {
    const v = $('#utter').value.trim();
    if (!v) return;
    $('#utter').value = '';
    sendUtteranceText(v);
  }

  function sendUtteranceText(v) {
    if (!v || !sim.sessionId) return;
    setTurn('thinking');
    event({ type: 'utterance', text: v });
  }

  function resetTranscript() {
    $('#transcript').innerHTML = '<div class="bubble interim" id="interim-bubble" style="display:none"></div>';
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
    if (!sim.ttsOn) { if (mic.active) setTurn('listening'); return; }
    const eq = root.querySelector('#voice-eq');
    // Echo-aware turn-taking: the mic stands down while the agent speaks.
    if (mic && mic.active) mic.pause();
    voice.speak(text, lang, {
      style: sim.style,
      rateMultiplier: sim.rate,
      onStart: () => { eq && eq.classList.add('on'); setTurn('speaking'); },
      onEnd: () => {
        eq && eq.classList.remove('on');
        if (mic && mic.active) { mic.resume(); setTurn('listening'); }
        else setTurn('');
      },
    });
  }

  async function event(evt) {
    if (!sim.sessionId) { alert('Start a call first.'); return; }
    if (sim.busy) return;
    if (evt.type === 'utterance') addLocal('Caller', evt.text, 'caller');
    if (evt.type === 'keypad') {
      // SEC-04 in the UI too: verification codes never display in the
      // conversation view, even as keypresses. Other keypad entries (PS,
      // claim selection) are shown as pressed.
      const duringChallenge = sim.state === 'challenge_pending';
      addLocal('Keypad', evt.digits === '*' ? '*'
        : duringChallenge ? 'entered code (hidden)' : `pressed ${evt.digits}`, 'keypad');
    }
    sim.busy = true;
    try {
      const r = await api('POST', `/api/calls/${sim.sessionId}/events`, evt);
      applySession(r.session);
      addBubbles(r.replies);
      if (evt.type === 'keypad' && r.session.verification?.challenge_active) refreshInbox();
      else refreshInbox();
      if (!r.replies?.length && mic && mic.active) setTurn('listening');
    } catch (e) {
      if (e.status !== 409) addLocal('Simulator', e.message || 'event failed', 'keypad');
      if (mic && mic.active) setTurn('listening');
    } finally { sim.busy = false; }
  }

  function applySession(s) {
    const chip = $('#state-chip');
    sim.state = s.state;
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
