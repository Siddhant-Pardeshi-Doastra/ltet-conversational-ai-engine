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
  constructor({ lang = 'en', locale = 'en-IN', onFinal, onInterim, onState } = {}) {
    this.SR = window.SpeechRecognition || window.webkitSpeechRecognition || null;
    this.lang = lang;
    this.locale = locale;
    this.onFinal = onFinal || (() => {});
    this.onInterim = onInterim || (() => {});
    this.onState = onState || (() => {});
    this.active = false;
    this.paused = false;
    this.rec = null;
    this.buffer = '';
    this.endpointTimer = null;
    this.restartTimer = null;
  }

  get supported() { return !!this.SR; }

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
    this.onState('idle');
  }

  pause() {
    if (!this.active) return;
    this.paused = true;
    clearTimeout(this.endpointTimer);
    try { this.rec && this.rec.stop(); } catch { /* ignore */ }
    this.onState('paused');
  }

  resume() {
    if (!this.active || !this.paused) return;
    this.paused = false;
    this._spin();
  }

  _spin() {
    if (!this.active || this.paused) return;
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
