// Sarvam AI voice provider adapter (Bulbul TTS + Saaras STT).
//
// Optional live-speech integration. It activates only when SARVAM_API_KEY is
// present in the environment (.env locally). The key is read at call time,
// never logged, never sent to the browser, and never committed. Without a key
// the platform stays on its deterministic channel: the browser speech engines
// with typed-input fallback.
//
// Response shapes are handled defensively (JSON audios[] base64 or raw audio/*)
// so a provider-side version bump cannot break the console silently. Every
// failure carries an explicit code — there is never a fabricated audio payload.
//
// Facts never pass through here: TTS renders engine-validated reply text only;
// STT returns caller utterances to the deterministic intent engine.

const DEFAULT_TTS_URL = 'https://api.sarvam.ai/v1/text-to-speech';
const DEFAULT_STT_URL = 'https://api.sarvam.ai/v1/speech-to-text';
const TTS_TEXT_MAX = 800;
const STT_AUDIO_MAX = 12 * 1024 * 1024;

// Our catalogue codes -> Sarvam language codes. Languages outside these maps
// keep using the browser/device voices; the console reports coverage honestly.
export const SARVAM_TTS_LANGS = {
  en: 'en-IN', hi: 'hi-IN', bn: 'bn-IN', mr: 'mr-IN', ta: 'ta-IN', te: 'te-IN',
  gu: 'gu-IN', pa: 'pa-IN', ml: 'ml-IN', kn: 'kn-IN', ur: 'ur-IN', or: 'od-IN',
};
// Saaras ASR supports this subset (no ur).
export const SARVAM_STT_LANGS = {
  en: 'en-IN', hi: 'hi-IN', bn: 'bn-IN', mr: 'mr-IN', ta: 'ta-IN', te: 'te-IN',
  gu: 'gu-IN', pa: 'pa-IN', ml: 'ml-IN', kn: 'kn-IN', or: 'od-IN',
};
export const SARVAM_SPEAKERS = ['ananya', 'abhilash', 'manisha', 'vidya', 'arya', 'karun', 'hitesh'];

export function sarvamConfigured() {
  return !!String(process.env.SARVAM_API_KEY || '').trim();
}
export function ttsLangs() { return Object.keys(SARVAM_TTS_LANGS); }
export function sttLangs() { return Object.keys(SARVAM_STT_LANGS); }

const env = (k, d = '') => process.env[k] || d;

function fail(code, message, status) {
  const e = new Error(message);
  e.code = code;
  e.status = status;
  return e;
}

/** Provider endpoints come from operator environment only (never user input).
 *  Validation is defence-in-depth against SSRF: https required, with loopback
 *  http allowed solely for tests. Throws a coded error on violation. */
function providerUrl(envName, defaultUrl) {
  const raw = env(envName, defaultUrl);
  let parsed;
  try { parsed = new URL(raw); } catch {
    throw fail('voice_provider_url_invalid', `${envName} is not a valid URL`, 500);
  }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname);
  if (parsed.protocol === 'https:' || (parsed.protocol === 'http:' && loopback)) return raw;
  throw fail('voice_provider_url_invalid', `${envName} must be an https URL (loopback http is allowed for tests only)`, 500);
}

async function fetchWithTimeout(url, opts, ms) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctl.signal }); }
  finally { clearTimeout(t); }
}

/**
 * Neural TTS. Returns { mime, bytes }.
 * Throws Error with .code in { voice_provider_unconfigured, tts_lang_unsupported,
 * tts_text_invalid, voice_provider_failed }.
 */
export async function tts(text, lang, { speaker } = {}) {
  if (!sarvamConfigured()) throw fail('voice_provider_unconfigured', 'SARVAM_API_KEY not configured', 503);
  const code = SARVAM_TTS_LANGS[lang];
  if (!code) throw fail('tts_lang_unsupported', `neural voice not available for "${lang}"`, 400);
  const t = String(text || '');
  if (!t.trim() || t.length > TTS_TEXT_MAX) throw fail('tts_text_invalid', `text must be 1..${TTS_TEXT_MAX} characters`, 400);
  const sp = SARVAM_SPEAKERS.includes(speaker) ? speaker : env('SARVAM_TTS_SPEAKER', 'ananya');
  const ttsUrl = providerUrl('SARVAM_TTS_URL', DEFAULT_TTS_URL);
  let res;
  try {
    res = await fetchWithTimeout(ttsUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-subscription-key': env('SARVAM_API_KEY') },
      body: JSON.stringify({
        text: t,
        target_language_code: code,
        speaker: sp,
        model: env('SARVAM_TTS_MODEL', 'bulbul:v2'),
        speech_sample_rate: 22050,
        enable_preprocessing: true,
      }),
    }, 15000);
  } catch (err) {
    throw fail('voice_provider_failed', `TTS provider unreachable: ${err.message}`, 502);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw fail('voice_provider_failed', `TTS provider error ${res.status}${body ? `: ${body.slice(0, 160)}` : ''}`, 502);
  }
  const ctype = (res.headers.get('content-type') || '').toLowerCase();
  if (ctype.includes('json')) {
    const doc = await res.json().catch(() => null);
    const b64 = Array.isArray(doc?.audios) ? doc.audios[0] : (doc?.audio_base64 || doc?.audio);
    if (!b64 || typeof b64 !== 'string') throw fail('voice_provider_failed', 'TTS provider returned no audio', 502);
    return { mime: 'audio/wav', bytes: Buffer.from(b64, 'base64') };
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  if (!bytes.length) throw fail('voice_provider_failed', 'TTS provider returned empty audio', 502);
  return { mime: ctype.startsWith('audio/') ? ctype.split(';')[0] : 'audio/mpeg', bytes };
}

/**
 * Neural STT. `audio` is Buffer/Uint8Array (wav recommended), `mime` its type,
 * `lang` one of sttLangs() or undefined for auto.
 * Returns { transcript, language_code }.
 */
export async function stt(audio, mime, lang) {
  if (!sarvamConfigured()) throw fail('voice_provider_unconfigured', 'SARVAM_API_KEY not configured', 503);
  if (!audio || !audio.length) throw fail('stt_audio_invalid', 'audio payload required', 400);
  if (audio.length > STT_AUDIO_MAX) throw fail('stt_audio_too_large', 'audio exceeds 12 MB', 400);
  const code = lang ? SARVAM_STT_LANGS[lang] : null;
  if (lang && !code) throw fail('stt_lang_unsupported', `neural transcription not available for "${lang}"`, 400);
  const sttUrl = providerUrl('SARVAM_STT_URL', DEFAULT_STT_URL);
  const fd = new FormData();
  fd.append('file', new Blob([audio], { type: mime || 'audio/wav' }), 'utterance.wav');
  fd.append('model', env('SARVAM_STT_MODEL', 'saaras:v2'));
  if (code) fd.append('language_code', code);
  let res;
  try {
    res = await fetchWithTimeout(sttUrl, {
      method: 'POST',
      headers: { 'api-subscription-key': env('SARVAM_API_KEY') },
      body: fd,
    }, 20000);
  } catch (err) {
    throw fail('voice_provider_failed', `STT provider unreachable: ${err.message}`, 502);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw fail('voice_provider_failed', `STT provider error ${res.status}${body ? `: ${body.slice(0, 160)}` : ''}`, 502);
  }
  const doc = await res.json().catch(() => null);
  const transcript = doc && (doc.transcript ?? doc.text);
  if (typeof transcript !== 'string') throw fail('voice_provider_failed', 'STT provider returned no transcript', 502);
  return { transcript: transcript.trim(), language_code: code || null };
}
