// Language pack registry: loads the 12 FRS language packs, versions them into
// the DB, and provides t(lang, key, params) with English fallback.
//
// Pack statuses are explicit: 'native_approved' vs 'draft_translation'
// (FR-37/NFR-12: generated translations are NOT launch-ready until native-speaker
// sign-off; readiness can be phased per language without dropping the catalogue).
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, get, all } from '../db.js';
import { nowIso } from '../util.js';

const here = dirname(fileURLToPath(import.meta.url));
const PACKS_DIR = join(here, '..', '..', 'languages', 'packs');

// FRS-core catalogue order (Release 1 baseline). Extended-catalogue packs are
// appended dynamically from the packs directory.
export const LANGUAGE_ORDER = ['en', 'hi', 'bn', 'mr', 'ta', 'te', 'gu', 'pa', 'ml', 'kn', 'or', 'as'];

let cache = null;

function loadFiles() {
  if (cache) return cache;
  cache = {};
  for (const f of readdirSync(PACKS_DIR).filter((f) => f.endsWith('.json'))) {
    const pack = JSON.parse(readFileSync(join(PACKS_DIR, f), 'utf8'));
    cache[pack.lang] = pack;
  }
  return cache;
}

/** All configured languages: FRS core first, then extended catalogue. */
export function allLanguages() {
  const packs = loadFiles();
  const core = LANGUAGE_ORDER.filter((l) => packs[l]);
  const extended = Object.keys(packs).filter((l) => !core.includes(l)).sort();
  return [...core, ...extended];
}

export function allPacks() {
  return loadFiles();
}

export function packMeta() {
  const packs = loadFiles();
  return allLanguages().map((lang) => {
    const p = packs[lang];
    const total = Object.keys(packs.en.strings).length;
    const covered = Object.keys(p.strings).filter((k) => packs.en.strings[k]).length;
    return {
      lang,
      name: p.name,
      script: p.script,
      locale: p.locale,
      version: p.version,
      status: p.status,
      catalogue: p.catalogue || 'frs-core',
      coverage_keys: covered,
      coverage_total: total,
      voice_provider: p.voice_provider,
      launch_ready: p.status === 'native_approved', // FR-37: only native-approved packs are launch-ready
    };
  });
}

export function seedLanguagePacks() {
  const packs = loadFiles();
  for (const lang of allLanguages()) {
    const p = packs[lang];
    if (!p) continue;
    const existing = get(`SELECT version FROM language_packs WHERE lang = ? AND version = ?`, lang, p.version);
    if (existing) continue;
    run(
      `INSERT INTO language_packs(lang, version, status, strings, voice_provider, updated_at) VALUES (?,?,?,?,?,?)`,
      lang, p.version, p.status, JSON.stringify(p.strings), p.voice_provider, nowIso()
    );
  }
}

/** Translate with English fallback. {slots} are substituted after lookup. */
export function t(lang, key, params = {}) {
  const packs = loadFiles();
  const l = packs[lang] ? lang : 'en';
  let str = packs[l].strings[key];
  if (str === undefined) str = packs.en.strings[key];
  if (str === undefined) return key;
  return str.replace(/\{(\w+)\}/g, (_, k) => (params[k] !== undefined ? String(params[k]) : `{${k}}`));
}

export function languageName(lang) {
  const packs = loadFiles();
  return packs[lang]?.name ?? 'English';
}

export function ttsLocale(lang) {
  const packs = loadFiles();
  return packs[lang]?.locale ?? 'en-IN';
}

/** Which language is the primary for a code-switched utterance? Used for TTS locale. */
export function resolveSpeechLocale(utteranceLang, sessionLang) {
  return ttsLocale(utteranceLang || sessionLang || 'en');
}

export function approvedLanguagesCount() {
  return all(`SELECT lang, status FROM language_packs WHERE version = (SELECT MAX(version) FROM language_packs lp2 WHERE lp2.lang = language_packs.lang)`)
    .filter((r) => r.status === 'native_approved').length;
}
