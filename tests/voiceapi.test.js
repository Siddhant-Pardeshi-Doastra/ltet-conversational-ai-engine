// Neural voice bridge: language coverage, guardrails, explicit unconfigured
// status. No real provider calls — an unreachable URL proves the failure path.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers.js';
import { SARVAM_TTS_LANGS, SARVAM_STT_LANGS, SARVAM_SPEAKERS } from '../server/adapters/sarvam.js';

const t = await startApp();
test.after(async () => { await t.close(); });

function noKey() { delete process.env.SARVAM_API_KEY; }

test('sarvam language maps cover the FRS core languages', () => {
  for (const l of ['en', 'hi', 'bn', 'mr', 'ta', 'te', 'gu', 'pa', 'ml', 'kn']) {
    assert.ok(SARVAM_TTS_LANGS[l], 'tts map covers ' + l);
  }
  assert.equal(SARVAM_TTS_LANGS.or, 'od-IN', 'Odia maps to the Sarvam code');
  assert.ok(!SARVAM_TTS_LANGS.ja, 'languages without neural coverage stay on device voices');
  assert.ok(!SARVAM_STT_LANGS.ur, 'Saaras ASR catalogue excludes ur');
  assert.ok(SARVAM_SPEAKERS.length >= 5);
});

test('status endpoint reports device engine without a key; no secret material', async () => {
  noKey();
  const r = await t.call('GET', '/api/voice/status');
  assert.equal(r.status, 200);
  assert.equal(r.json.neural_tts, false);
  assert.equal(r.json.neural_stt, false);
  assert.equal(r.json.engine, 'device');
  assert.equal(r.json.tts_langs.length, 0);
  assert.ok(r.json.note.includes('device voices'));
  assert.ok(!JSON.stringify(r.json).includes('sk-'), 'no key material in the response');
});

test('tts without a key fails explicitly (503) — never fabricated audio', async () => {
  noKey();
  const r = await t.call('POST', '/api/voice/tts', { text: 'hello there', lang: 'en' });
  assert.equal(r.status, 503);
  assert.equal(r.json.error, 'voice_provider_unconfigured');
});

test('tts guardrails reject unsupported language and empty text before any provider call', async () => {
  process.env.SARVAM_API_KEY = 'test-key-placeholder';
  try {
    const badLang = await t.call('POST', '/api/voice/tts', { text: 'hello', lang: 'ja' });
    assert.equal(badLang.status, 400);
    assert.equal(badLang.json.error, 'tts_lang_unsupported');
    const empty = await t.call('POST', '/api/voice/tts', { text: '   ', lang: 'en' });
    assert.equal(empty.status, 400);
    assert.equal(empty.json.error, 'tts_text_invalid');
    const tooLong = await t.call('POST', '/api/voice/tts', { text: 'x'.repeat(801), lang: 'en' });
    assert.equal(tooLong.status, 400);
    assert.equal(tooLong.json.error, 'tts_text_invalid');
  } finally { noKey(); }
});

test('stt without a key fails explicitly (503)', async () => {
  noKey();
  const res = await fetch(t.base + '/api/voice/stt', {
    method: 'POST', headers: { 'content-type': 'audio/wav' }, body: new Uint8Array([1, 2, 3, 4, 5]),
  });
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error, 'voice_provider_unconfigured');
});

test('stt with a key and an unreachable provider fails explicitly (502)', async () => {
  process.env.SARVAM_API_KEY = 'test-key-placeholder';
  process.env.SARVAM_STT_URL = 'http://127.0.0.1:9/'; // closed port: fails fast, no network
  try {
    const res = await fetch(t.base + '/api/voice/stt', {
      method: 'POST', headers: { 'content-type': 'audio/wav' }, body: new Uint8Array(4096),
    });
    assert.equal(res.status, 502);
    assert.equal((await res.json()).error, 'voice_provider_failed');
  } finally { noKey(); delete process.env.SARVAM_STT_URL; }
});

test('tts with a key and an unreachable provider fails explicitly (502)', async () => {
  process.env.SARVAM_API_KEY = 'test-key-placeholder';
  process.env.SARVAM_URL = 'http://127.0.0.1:9/';
  process.env.SARVAM_TTS_URL = 'http://127.0.0.1:9/';
  try {
    const r = await t.call('POST', '/api/voice/tts', { text: 'hello there', lang: 'en' });
    assert.equal(r.status, 502);
    assert.equal(r.json.error, 'voice_provider_failed');
  } finally { noKey(); delete process.env.SARVAM_URL; delete process.env.SARVAM_TTS_URL; }
});

test('voice playback queue: multi-bubble replies never overlap', async () => {
  const { voice } = await import('../public/voice.js');
  const spans = [];
  const originalLocal = voice._speakLocal;
  voice._speakLocal = async (text, lang, opts, token) => {
    if (token !== voice._seq) return;
    const start = Date.now();
    await new Promise((r) => setTimeout(r, 60));
    spans.push([start, Date.now()]);
    opts.onEnd?.();
  };
  try {
    const p1 = voice.speak('first reply', 'en');
    const p2 = voice.speak('second reply', 'en');
    const p3 = voice.speak('third reply', 'en');
    await Promise.all([p1, p2, p3]);
  } finally { voice._speakLocal = originalLocal; }
  assert.equal(spans.length, 3, 'all three replies spoke');
  for (let i = 1; i < spans.length; i++) {
    assert.ok(spans[i][0] >= spans[i - 1][1],
      'reply ' + (i + 1) + ' must start only after reply ' + i + ' finishes');
  }
});

test('voice cancel flushes the queue without speaking queued replies', async () => {
  const { voice } = await import('../public/voice.js');
  const spoken = [];
  const originalLocal = voice._speakLocal;
  voice._speakLocal = async (text, lang, opts, token) => {
    if (token !== voice._seq) return;
    spoken.push(text);
    await new Promise((r) => setTimeout(r, 40));
    opts.onEnd?.();
  };
  try {
    voice.speak('this one plays', 'en');
    await new Promise((r) => setTimeout(r, 90)); // let the first reply finish
    voice.speak('this one is cancelled before its turn', 'en');
    voice.cancel(); // barge-in: invalidates the queued generation
    await new Promise((r) => setTimeout(r, 120));
  } finally { voice._speakLocal = originalLocal; }
  assert.deepEqual(spoken, ['this one plays'], 'the in-flight reply completed; the queued reply was dropped by cancel');
});
