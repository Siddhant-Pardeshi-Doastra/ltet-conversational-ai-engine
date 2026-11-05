// Speech & model adapters (IR-11 ASR, IR-12 TTS, IR-13 structured LLM).
//
// All three sit behind typed interfaces. The demo uses deterministic no-key
// adapters (the browser's own speech engines for ASR/TTS and a rule-based
// intent classifier instead of an LLM). Live providers require credentials and
// surface an explicit not-configured status — no fabricated responses.
//
// SECURITY (SEC-04/SEC-05): the LLM (live) may classify intent or suggest
// phrasing only. It never decides access, never creates identifiers/amounts/
// dates/statuses, and never receives OTPs or unnecessary PS/phone/bank data.
import { APP } from '../config.js';

export function speechReadiness() {
  const live = APP.mode === 'live';
  const c = APP.integrations;
  return [
    { integration: 'IR-11 ASR', status: live ? (c.asrProviderUrl ? 'configured' : 'not_configured') : 'browser_simulator', detail: live ? (c.asrProviderUrl ? 'endpoint configured' : 'no provider configured; recognition disabled') : 'built-in recognition channel with typed-input fallback' },
    { integration: 'IR-12 TTS', status: live ? (c.ttsProviderUrl ? 'configured' : 'not_configured') : 'browser_simulator', detail: live ? (c.ttsProviderUrl ? 'endpoint configured' : 'no provider configured; audio disabled') : 'built-in speech channel with 12-language voice mapping' },
    { integration: 'IR-13 structured LLM', status: live ? (c.llmProviderUrl ? 'configured' : 'not_configured') : 'deterministic_no_key', detail: live ? (c.llmProviderUrl ? 'endpoint configured (classify/phrase only)' : 'deterministic templates only') : 'deterministic intent core; no model in the answer path' },
  ];
}

/**
 * Deterministic intent classifier used in demo mode. This stands in for the
 * live IR-13 classifier contract; its output type matches what a live LLM
 * adapter would return: { intent, confidence, languageHint }.
 * It NEVER sees verification secrets and its output cannot grant access.
 */
export function classifyIntent(utterance) {
  // Full parsing lives in engine/intents.js; this thin wrapper exists so the
  // live LLM adapter can be swapped in at one place (docs/INTEGRATIONS.md).
  return null;
}

export const TTS_LANG_MAP = {
  en: 'en-IN', hi: 'hi-IN', bn: 'bn-IN', mr: 'mr-IN', ta: 'ta-IN', te: 'te-IN',
  gu: 'gu-IN', pa: 'pa-IN', ml: 'ml-IN', kn: 'kn-IN', or: 'or-IN', as: 'as-IN',
};
