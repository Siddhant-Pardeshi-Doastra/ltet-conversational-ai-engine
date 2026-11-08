// Human-grade browser speech engine (v2 — soft & attractive).
//
// What makes it sound like a warm human agent:
//  1. BEST-VOICE SELECTION — device voices ranked per language: exact locale,
//     then neural/natural voices ("Natural", "Neural", "Online"), then Google /
//     Microsoft network voices.
//  2. SPEECH NORMALIZATION — currency, claim IDs and bank references are
//     rewritten the way a human agent reads them ("₹24,500.00" → "24,500
//     rupees", "CLM-10020" → "C L M 1 0 0 2 0"), so nothing sounds robotic.
//  3. PHRASE-LEVEL CADENCE — replies breathe: short pause at commas, longer at
//     sentence ends, and the final sentence is spoken slightly slower
//     (natural sentence-final lengthening).
//  4. SOFT DELIVERY — volume just under full, gentle attack on the first
//     phrase, per-language rate/pitch tuned for calm warmth.
//  5. VOICE STYLES — Warm (default) / Standard / Crisp.
//  6. USER CONTROL — voice picker (most human first) + fine rate trim.

const LANG_LOCALES = {
  en: 'en-IN', hi: 'hi-IN', bn: 'bn-IN', mr: 'mr-IN', ta: 'ta-IN', te: 'te-IN',
  gu: 'gu-IN', pa: 'pa-IN', ml: 'ml-IN', kn: 'kn-IN', or: 'or-IN', as: 'as-IN',
  ur: 'ur-PK', es: 'es-ES', fr: 'fr-FR', de: 'de-DE', pt: 'pt-BR', ar: 'ar-SA',
  zh: 'zh-CN', ja: 'ja-JP', ru: 'ru-RU', id: 'id-ID',
};

const CURRENCY_WORD = { en: 'rupees', hi: 'रुपये', bn: 'টাকা', mr: 'रुपये', ta: 'ரூபாய்', te: 'రూపాయలు', gu: 'રૂપિયા', pa: 'ਰੁਪਏ', ml: 'രൂപ', kn: 'ರೂಪಾಯಿ', or: 'ଟଙ୍କା', as: 'টকা', ur: 'روپے', id: 'rupiah', pt: 'reais' };

const PROSODY = {
  en: { rate: 0.95, pitch: 1.0 }, hi: { rate: 0.9, pitch: 1.0 }, bn: { rate: 0.91, pitch: 1.0 },
  mr: { rate: 0.91, pitch: 1.0 }, ta: { rate: 0.9, pitch: 1.0 }, te: { rate: 0.9, pitch: 1.0 },
  gu: { rate: 0.91, pitch: 1.0 }, pa: { rate: 0.91, pitch: 1.0 }, ml: { rate: 0.9, pitch: 1.0 },
  kn: { rate: 0.9, pitch: 1.0 }, or: { rate: 0.91, pitch: 1.0 }, as: { rate: 0.91, pitch: 1.0 },
  ur: { rate: 0.9, pitch: 1.0 }, ar: { rate: 0.91, pitch: 1.0 }, es: { rate: 0.95, pitch: 1.02 },
  fr: { rate: 0.94, pitch: 1.02 }, de: { rate: 0.93, pitch: 1.0 }, pt: { rate: 0.94, pitch: 1.02 },
  zh: { rate: 0.89, pitch: 1.02 }, ja: { rate: 0.91, pitch: 1.0 }, ru: { rate: 0.93, pitch: 1.0 },
  id: { rate: 0.94, pitch: 1.02 },
};

const STYLES = {
  warm: { rate: 0.94, phraseBreathMs: 90, sentenceBreathMs: 200, volume: 0.96 },
  standard: { rate: 1.0, phraseBreathMs: 70, sentenceBreathMs: 150, volume: 0.98 },
  crisp: { rate: 1.09, phraseBreathMs: 50, sentenceBreathMs: 110, volume: 1.0 },
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
  else return -1;
  if (/natural|neural/i.test(name)) s += 46;
  if (/online/i.test(name)) s += 8;
  if (/google/i.test(name)) s += 30;
  if (/microsoft/i.test(name)) s += 14;
  if (v.localService) s += 4;
  if (/compact|espeak/i.test(name)) s -= 25;
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

/** Rewrite text so TTS reads it like a human agent would. Display text is untouched. */
export function normalizeForSpeech(text, lang = 'en') {
  let t = String(text ?? '');
  // Currency: "₹24,500.00" -> "24,500 rupees" (drop .00; use the language's word)
  const cur = CURRENCY_WORD[lang] || CURRENCY_WORD.en;
  t = t.replace(/₹\s?([0-9][0-9,]*(?:\.[0-9]{1,2})?)/g, (_m, num) => `${num.replace(/\.00$/, '')} ${cur}`);
  // Claim IDs: "CLM-10020" -> "C L M 1 0 0 2 0" (deliberate reference reading)
  t = t.replace(/\bCLM[\s-]?([0-9]{3,8})\b/gi, (_m, digits) => `C L M ${digits.split('').join(' ')}`);
  // Bank references and similar codes: space out letter-runs and digit-runs
  t = t.replace(/\b([A-Z]{3,10})([0-9]{4,12})\b/g, (_m, a, b) => `${a.split('').join(' ')} ${b.split('').join(' ')}`);
  // Tidy double spaces created by the above
  return t.replace(/\s{2,}/g, ' ').trim();
}

/** Sentence chunks with phrase-level sub-splitting for soft cadence. */
export function chunkSoft(text) {
  const sentences = String(text)
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?。！？।؟…])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const out = [];
  for (const sentence of sentences) {
    if (sentence.length > 70) {
      const parts = sentence.split(/(?<=,|;|、|،)\s+/).map((p) => p.trim()).filter(Boolean);
      parts.forEach((p, i) => out.push({ text: i < parts.length - 1 ? p.replace(/[,;、،]$/, '') + (/[،,;]$/.test(p) ? ',' : '') : p, pause: i < parts.length - 1 ? 'phrase' : 'sentence' }));
    } else {
      out.push({ text: sentence, pause: 'sentence' });
    }
  }
  return out;
}

export const voice = {
  get supported() { return typeof window !== 'undefined' && 'speechSynthesis' in window; },

  init() {
    if (!this.supported) return Promise.resolve([]);
    if (state.loaded) return Promise.resolve(state.voices);
    return new Promise((resolve) => {
      state.listeners.push(resolve);
      loadVoices();
      window.speechSynthesis.onvoiceschanged = loadVoices;
      let tries = 0;
      const poll = setInterval(() => {
        loadVoices();
        if (state.loaded || ++tries > 20) clearInterval(poll);
        if (state.loaded) { clearInterval(poll); resolve(state.voices); }
      }, 150);
    });
  },

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

  /** Sentence chunks (kept for compatibility/testing). */
  chunk(text) {
    return chunkSoft(text).map((c) => c.text);
  },

  _seq: 0,

  /**
   * Soft, human speech: normalized text, phrase cadence with variable breaths,
   * sentence-final slowing, gentle volume. Cancellation-token guarded.
   */
  speak(text, lang, opts = {}) {
    const synth = this.supported ? window.speechSynthesis : null;
    if (!synth) { opts.onEnd?.(); return; }
    const token = ++this._seq;
    const style = STYLES[opts.style || 'warm'] || STYLES.warm;
    const pros = PROSODY[lang] || PROSODY.en;
    const rate = Math.max(0.5, Math.min(1.5, pros.rate * style.rate * (opts.rateMultiplier || 1)));
    const spoken = normalizeForSpeech(text, lang);
    const parts = chunkSoft(spoken);
    if (!parts.length) { opts.onEnd?.(); return; }
    const chosen = this.chosen(lang);
    let started = false;
    let i = 0;
    const speakNext = () => {
      if (token !== this._seq) return;
      if (i >= parts.length) { opts.onEnd?.(); return; }
      const part = parts[i++];
      const isLast = i >= parts.length;
      const u = new SpeechSynthesisUtterance(part.text);
      u.lang = chosen ? chosen.lang : (LANG_LOCALES[lang] || 'en-IN');
      if (chosen) u.voice = chosen;
      // sentence-final lengthening: the closing phrase is a touch slower
      u.rate = Math.max(0.5, Math.min(1.5, rate * (isLast && parts.length > 1 ? 0.96 : 1)));
      u.pitch = pros.pitch;
      u.volume = i === 1 ? style.volume - 0.03 : style.volume; // gentle attack
      u.onstart = () => { if (!started) { started = true; opts.onStart?.(); } };
      u.onend = u.onerror = () => {
        if (token !== this._seq) return;
        if (i < parts.length) {
          const breath = parts[i - 1].pause === 'phrase' ? style.phraseBreathMs : style.sentenceBreathMs;
          setTimeout(speakNext, breath);
        } else opts.onEnd?.();
      };
      synth.speak(u);
    };
    speakNext();
    setTimeout(() => { if (token === this._seq && !started) opts.onEnd?.(); }, 4000);
  },

  cancel() {
    this._seq += 1;
    if (this.supported) { try { window.speechSynthesis.cancel(); } catch { /* ignore */ } }
  },
};

export function localeFor(lang) {
  return LANG_LOCALES[lang] || 'en-IN';
}
