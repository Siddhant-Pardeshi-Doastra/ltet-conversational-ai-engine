// Live voice session — continuous listening with natural turn-taking.
//
// The agent listens continuously while active (like a human on a call):
//  - interim transcripts stream into the conversation view as you speak
//  - endpointing: a short silence after speech finalises the utterance
//  - echo-aware: the mic PAUSES while the agent speaks, RESUMES when it
//    finishes (browser AEC is not universally available, so turn-taking is
//    explicit rather than risking self-hearing)
//  - auto-restarts when the engine ends a stream (Chrome does periodically)
//  - typed input remains a first-class fallback at all times.

export class LiveMic {
  constructor({ lang = 'en', locale = 'en-IN', onFinal, onInterim, onState, serverStt } = {}) {
    this.SR = window.SpeechRecognition || window.webkitSpeechRecognition || null;
    this.lang = lang;
    this.locale = locale;
    this.onFinal = onFinal || (() => {});
    this.onInterim = onInterim || (() => {});
    this.onState = onState || (() => {});
    // Neural listening: when serverStt() is true, each utterance is captured as
    // PCM, encoded to a 16 kHz WAV in the browser and transcribed server-side.
    this.serverStt = serverStt || null;
    this.active = false;
    this.paused = false;
    this.rec = null;
    this.buffer = '';
    this.endpointTimer = null;
    this.restartTimer = null;
    this.stream = null;      // shared mic stream (neural mode)
    this.captureCtx = null;  // per-utterance AudioContext (neural mode)
    this._serverAbort = false;
  }

  get supported() {
    if (typeof this.serverStt === 'function' && this.serverStt()) {
      return typeof navigator !== 'undefined' && !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
    }
    return !!this.SR;
  }

  setLang(lang, locale) {
    this.lang = lang;
    this.locale = locale || this.locale;
    if (this.rec) this.rec.lang = this.locale;
  }

  start() {
    if (!this.supported) { this.onState('unsupported'); return false; }
    this.active = true;
    this.paused = false;
    this._spin();
    return true;
  }

  stop() {
    this.active = false;
    this.paused = false;
    clearTimeout(this.endpointTimer);
    clearTimeout(this.restartTimer);
    try { this.rec && this.rec.abort(); } catch { /* ignore */ }
    this._teardownServer();
    this.onState('idle');
  }

  pause() {
    if (!this.active) return;
    this.paused = true;
    clearTimeout(this.endpointTimer);
    try { this.rec && this.rec.stop(); } catch { /* ignore */ }
    this._abortServerCapture();
    this.onState('paused');
  }

  resume() {
    if (!this.active || !this.paused) return;
    this.paused = false;
    this._spin();
  }

  /** Ends server-mode capture without dropping the shared mic stream. */
  _abortServerCapture() {
    this._serverAbort = true;
    if (this.captureCtx) { try { this.captureCtx.close(); } catch { /* ignore */ } this.captureCtx = null; }
  }

  _teardownServer() {
    this._serverAbort = false;
    if (this.captureCtx) { try { this.captureCtx.close(); } catch { /* ignore */ } this.captureCtx = null; }
    if (this.stream) {
      try { this.stream.getTracks().forEach((tr) => tr.stop()); } catch { /* ignore */ }
      this.stream = null;
    }
  }

  /** Route: neural server transcription when configured, browser engine otherwise. */
  _spin() {
    if (!this.active || this.paused) return;
    if (typeof this.serverStt === 'function' && this.serverStt()) this._spinServer();
    else this._spinWeb();
  }

  /** Neural listening: one shared mic stream, per-utterance capture, server STT. */
  async _spinServer() {
    clearTimeout(this.restartTimer);
    try {
      if (!this.stream) {
        this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      }
    } catch (err) {
      this.active = false;
      this.stream = null;
      this.onState(err && err.name === 'NotAllowedError' ? 'denied' : 'unsupported');
      return;
    }
    if (!this.active || this.paused) return;
    this.onState('listening');
    await this._captureUtterance();
    if (this.active && !this.paused) this.restartTimer = setTimeout(() => this._spin(), 300);
  }

  /** One utterance: capture PCM, endpoint on silence, transcribe via the
   *  server (interim text shows a listening placeholder until streaming ASR
   *  arrives in a later phase). */
  async _captureUtterance() {
    let ctx;
    try {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
    } catch {
      this.onState('unsupported');
      return;
    }
    this.captureCtx = ctx;
    const src = ctx.createMediaStreamSource(this.stream);
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    const sink = ctx.createGain();
    sink.gain.value = 0; // ScriptProcessor needs a destination; muted so nothing echoes
    src.connect(proc);
    proc.connect(sink);
    sink.connect(ctx.destination);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    src.connect(analyser);
    const level = new Float32Array(analyser.fftSize);
    const parts = [];
    let speaking = false;
    let speechChunks = 0;
    let silenceMs = 0;
    let elapsedMs = 0;
    const stepMs = (4096 / ctx.sampleRate) * 1000;
    const MAX_MS = 12000;      // hard cap per utterance
    const STOP_SILENCE_MS = 700; // silence that ends a spoken utterance
    const OPEN_WAIT_MS = 3000; // open-floor wait before re-arming
    this._serverAbort = false;
    this.onInterim('');

    const finish = async () => {
      try { proc.disconnect(); src.disconnect(); } catch { /* ignore */ }
      try { await ctx.close(); } catch { /* ignore */ }
      if (this.captureCtx === ctx) this.captureCtx = null;
      if (!this.active || this.paused || this._serverAbort) return;
      const wav = encodeWav(parts, ctx.sampleRate);
      if (wav && wav.length > 2000) {
        this.onState('transcribing');
        try {
          const r = await fetch('/api/voice/stt', {
            method: 'POST',
            headers: { 'Content-Type': 'audio/wav' },
            body: wav,
          });
          if (!r.ok) throw new Error('stt http ' + r.status);
          const out = await r.json();
          if (this.active && !this.paused && out.transcript) {
            this.onInterim('');
            this.onFinal(out.transcript);
          }
        } catch {
          this.onState('stt_failed');
        }
      }
    };

    return new Promise((resolve) => {
      proc.onaudioprocess = (e) => {
        if (!this.active || this.paused || this._serverAbort) { finish(); resolve(); return; }
        const input = e.inputBuffer.getChannelData(0);
        analyser.getFloatTimeDomainData(level);
        let sum = 0;
        for (let i = 0; i < level.length; i++) sum += level[i] * level[i];
        const rms = Math.sqrt(sum / level.length);
        elapsedMs += stepMs;
        if (rms > 0.02) {
          speechChunks += 1;
          silenceMs = 0;
          if (!speaking) { speaking = true; this.onInterim('listening…'); }
          if (parts.length < 320) parts.push(new Float32Array(input));
        } else if (speaking) {
          silenceMs += stepMs;
        }
        if ((speaking && silenceMs >= STOP_SILENCE_MS) || elapsedMs >= MAX_MS
          || (!speaking && elapsedMs >= OPEN_WAIT_MS && speechChunks === 0)) {
          finish();
          resolve();
        }
      };
    });
  }

  _spinWeb() {
    clearTimeout(this.restartTimer);
    const rec = new this.SR();
    this.rec = rec;
    rec.lang = this.locale;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    rec.onstart = () => this.onState('listening');
    rec.onaudiostart = () => this.onState('listening');

    rec.onresult = (e) => {
      if (this.paused) return;
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) this.buffer += (this.buffer ? ' ' : '') + r[0].transcript.trim();
        else interim += r[0].transcript;
      }
      if (this.buffer) this.onInterim(this.buffer + (interim ? ' ' + interim : ''));
      else if (interim) this.onInterim(interim);
      // Endpointing: finalise shortly after the last result settles.
      clearTimeout(this.endpointTimer);
      this.endpointTimer = setTimeout(() => {
        const text = (this.buffer || interim || '').trim();
        this.buffer = '';
        this.onInterim('');
        if (text) this.onFinal(text);
      }, this.buffer ? 500 : 900);
    };

    rec.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        this.active = false;
        this.onState('denied');
      } else if (e.error === 'no-speech') {
        this.onState('listening'); // keep the floor open
      }
      // 'network', 'audio-capture' etc: stream will end; onend restarts.
    };

    rec.onend = () => {
      if (this.active && !this.paused) {
        this.restartTimer = setTimeout(() => this._spin(), 250);
      }
    };

    try { rec.start(); } catch { /* start() throws if already started; onend will retry */ }
  }
}

/** Downsample captured PCM chunks to 16 kHz mono 16-bit WAV (no dependencies,
 *  works everywhere ScriptProcessor works; small enough for a single utterance). */
function encodeWav(parts, srcRate, targetRate = 16000) {
  if (!parts.length) return null;
  let total = 0;
  for (const p of parts) total += p.length;
  const flat = new Float32Array(total);
  let o = 0;
  for (const p of parts) { flat.set(p, o); o += p.length; }
  const step = srcRate / targetRate;
  const n = Math.max(1, Math.floor(total / step));
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const pos = i * step;
    const i0 = Math.floor(pos);
    const frac = pos - i0;
    const v = i0 + 1 < total ? flat[i0] * (1 - frac) + flat[i0 + 1] * frac : flat[i0];
    pcm[i] = (Math.max(-1, Math.min(1, v)) * 32767) | 0;
  }
  const buf = new ArrayBuffer(44 + n * 2);
  const dv = new DataView(buf);
  const tag = (off, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)); };
  tag(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); tag(8, 'WAVE');
  tag(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, targetRate, true); dv.setUint32(28, targetRate * 2, true);
  dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  tag(36, 'data'); dv.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) dv.setInt16(44 + i * 2, pcm[i], true);
  return new Uint8Array(buf);
}
