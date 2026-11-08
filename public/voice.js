// Human-grade browser speech engine.
//
// What makes it sound more like a real person:
//  1. BEST-VOICE SELECTION — device voices are ranked per language: exact locale
//     match first, then neural/natural voices ("Natural", "Neural", "Online")
//     which are the human-sounding ones shipped in Edge/Chrome, then Google /
//     Microsoft network voices, falling back gracefully to any voice.
//  2. SENTENCE-CADENCE CHUNKING — replies are split into sentences and queued as
//     separate utterances with a short breath between them, matching how people
//     actually talk, instead of one flat robotic stream.
//  3. PER-LANGUAGE PROSODY — base rate/pitch tuned per language so Indic and
//     CJK speech doesn't sound rushed or flat.
//  4. USER CONTROL — the simulator exposes a voice picker (most human voices
//     listed first) and a rate control.

const LANG_LOCALES = {
  en: 'en-IN', hi: 'hi-IN', bn: 'bn-IN', mr: 'mr-IN', ta: 'ta-IN', te: 'te-IN',
  gu: 'gu-IN', pa: 'pa-IN', ml: 'ml-IN', kn: 'kn-IN', or: 'or-IN', as: 'as-IN',
  ur: 'ur-PK', es: 'es-ES', fr: 'fr-FR', de: 'de-DE', pt: 'pt-BR', ar: 'ar-SA',
  zh: 'zh-CN', ja: 'ja-JP', ru: 'ru-RU', id: 'id-ID',
};

// Per-language prosody (rate, pitch) — tuned so each language sounds unhurried.
const PROSODY = {
  en: { rate: 0.97, pitch: 1.0 }, hi: { rate: 0.94, pitch: 1.0 }, bn: { rate: 0.94, pitch: 1.0 },
  mr: { rate: 0.94, pitch: 1.0 }, ta: { rate: 0.93, pitch: 1.0 }, te: { rate: 0.93, pitch: 1.0 },
  gu: { rate: 0.94, pitch: 1.0 }, pa: { rate: 0.94, pitch: 1.0 }, ml: { rate: 0.93, pitch: 1.0 },
  kn: { rate: 0.93, pitch: 1.0 }, or: { rate: 0.94, pitch: 1.0 }, as: { rate: 0.94, pitch: 1.0 },
  ur: { rate: 0.93, pitch: 1.0 }, ar: { rate: 0.94, pitch: 1.0 }, es: { rate: 0.98, pitch: 1.02 },
  fr: { rate: 0.97, pitch: 1.02 }, de: { rate: 0.96, pitch: 1.0 }, pt: { rate: 0.97, pitch: 1.02 },
  zh: { rate: 0.92, pitch: 1.02 }, ja: { rate: 0.94, pitch: 1.0 }, ru: { rate: 0.96, pitch: 1.0 },
  id: { rate: 0.97, pitch: 1.02 },
};

const state = {
  voices: [],
  loaded: false,
  preference: {}, // lang -> voiceURI (user-picked)
  listeners: [],
};

function scoreVoice(v, lang) {
  const locale = LANG_LOCALES[lang] || 'en-IN';
  const langPrefix = locale.split('-')[0];
  const vl = (v.lang || '').toLowerCase().replace('_', '-');
  const name = (v.voiceURI || '') + ' ' + (v.name || '');
  let s = 0;
  if (vl === locale.toLowerCase()) s += 100;
  else if (vl.startsWith(langPrefix)) s += 50;
  else if (locale.startsWith(vl.split('-')[0]) && vl.split('-')[0] === langPrefix) s += 50;
  else return -1; // wrong language entirely
  if (/natural|neural/i.test(name)) s += 46; // Edge/Chrome human-sounding voices
  if (/online/i.test(name)) s += 8; // network natural voices
  if (/google/i.test(name)) s += 30;
  if (/microsoft/i.test(name)) s += 14;
  if (v.localService) s += 4; // slight preference for offline reliability on ties
  if (/compact|espeak/i.test(name)) s -= 25; // last-resort robotic voices
  return s;
}

function loadVoices() {
  if (!('speechSynthesis' in window)) return;
  state.voices = window.speechSynthesis.getVoices() || [];
  if (state.voices.length && !state.loaded) {
    state.loaded = true;
    for (const fn of state.listeners.splice(0)) fn(state.voices);
  }
}

export const voice = {
  supported: 'speechSynthesis' in window,

  /** Resolve device voices; resolves immediately if already loaded. */
  init() {
    if (!this.supported) return Promise.resolve([]);
    if (state.loaded) return Promise.resolve(state.voices);
    return new Promise((resolve) => {
      state.listeners.push(resolve);
      loadVoices();
      window.speechSynthesis.onvoiceschanged = loadVoices;
      // Some engines populate lazily; poll briefly as a fallback.
      let tries = 0;
      const poll = setInterval(() => {
        loadVoices();
        if (state.loaded || ++tries > 20) clearInterval(poll);
        if (state.loaded) { clearInterval(poll); resolve(state.voices); }
      }, 150);
    });
  },

  /** Ranked voice list for a language (most human first). */
  voicesFor(lang) {
    return state.voices
      .map((v) => ({ v, s: scoreVoice(v, lang) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.v);
  },

  best(lang) {
    const list = this.voicesFor(lang);
    return list[0] || null;
  },

  isHumanGrade(lang) {
    const b = this.best(lang);
    return !!b && /natural|neural|google/i.test(b.name);
  },

  /** User voice preference (voiceURI) per language. */
  prefer(lang, voiceURI) {
    if (voiceURI) state.preference[lang] = voiceURI;
    else delete state.preference[lang];
  },

  chosen(lang) {
    const pref = state.preference[lang];
    if (pref) {
      const hit = this.voicesFor(lang).find((v) => v.voiceURI === pref);
      if (hit) return hit;
    }
    return this.best(lang);
  },

  /** Split reply text into sentence chunks with multilingual terminators. */
  chunk(text) {
    return String(text)
      .replace(/\s+/g, ' ')
      .split(/(?<=[.!?。！？।؟…])\s+/)
      .map((s) => s.trim())
      .filter(Boolean);
  },

  /**
   * Speak with human cadence: one utterance per sentence, a short breath
   * between sentences, per-language prosody, best available voice.
   * Chained via onend so the queue breathes naturally; a cancellation token
   * stops the chain instantly (barge-in / interrupt / new reply).
   */
  _seq: 0,
  speak(text, lang, opts = {}) {
    const synth = this.supported ? window.speechSynthesis : null;
    if (!synth) { opts.onEnd?.(); return; }
    const token = ++this._seq;
    const pros = PROSODY[lang] || PROSODY.en;
    const rate = Math.max(0.5, Math.min(1.6, pros.rate * (opts.rateMultiplier || 1)));
    const chunks = this.chunk(text);
    if (!chunks.length) { opts.onEnd?.(); return; }
    const chosen = this.chosen(lang);
    let started = false;
    let i = 0;
    const speakNext = () => {
      if (token !== this._seq) return; // cancelled
      if (i >= chunks.length) { opts.onEnd?.(); return; }
      const chunk = chunks[i++];
      const u = new SpeechSynthesisUtterance(chunk);
      u.lang = chosen ? chosen.lang : (LANG_LOCALES[lang] || 'en-IN');
      if (chosen) u.voice = chosen;
      u.rate = rate;
      u.pitch = pros.pitch;
      u.onstart = () => { if (!started) { started = true; opts.onStart?.(); } };
      u.onend = u.onerror = () => {
        if (token !== this._seq) return;
        if (i < chunks.length) setTimeout(speakNext, 140); // breath between sentences
        else opts.onEnd?.();
      };
      synth.speak(u);
    };
    speakNext();
    // Safety: engines that never fire onstart (muted autoplay) must not wedge UI state.
    setTimeout(() => { if (token === this._seq && !started) opts.onEnd?.(); }, 4000);
  },

  cancel() {
    this._seq += 1; // stop any chained speech
    if (this.supported) { try { window.speechSynthesis.cancel(); } catch { /* ignore */ } }
  },
};

export function localeFor(lang) {
  return LANG_LOCALES[lang] || 'en-IN';
}
