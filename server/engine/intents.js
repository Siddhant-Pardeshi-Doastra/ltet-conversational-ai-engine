// Deterministic, no-key intent parser (stands in for the live IR-13 classifier).
//
// Handles mixed Hindi/English code-switching, spoken numbers, ordinals,
// claim-ID capture (English claim/PS terminology per FR-21) and multilingual
// yes/no. Output is structured only — it never creates identifiers, amounts,
// dates, ownership or status, and never decides access.
const SCRIPT_TESTS = [
  ['pa', /[\u0A00-\u0A7F]/],
  ['gu', /[\u0A80-\u0AFF]/],
  ['or', /[\u0B00-\u0B7F]/],
  ['ta', /[\u0B80-\u0BFF]/],
  ['te', /[\u0C00-\u0C7F]/],
  ['kn', /[\u0C80-\u0CFF]/],
  ['ml', /[\u0D00-\u0D7F]/],
];

const INTENT_WORDS = {
  status: ['status', 'stithi', 'स्थिति', 'कहाँ', 'कहां', 'kahan', 'kaha', 'progress', 'कैसा', 'कहा पर', 'stage', 'kahaan'],
  payment: ['payment', 'paisa', 'पैसा', 'पैसे', 'reimbursement', 'money', 'credit', 'credited', 'मिला', 'milta', 'kitna', 'कितना', 'प्राप्त', 'amount', 'pay'],
  human: ['agent', 'human', 'insaan', 'इंसान', 'आदमी', 'admi', 'representative', 'transfer', 'ट्रांसफर', 'व्यक्ति', 'manager', 'executive', 'इंसानी'],
  callback: ['callback', 'call back', 'baad me', 'बाद में', 'कॉलबैक', 'baadme', 'call me back'],
  repeat: ['repeat', 'dobara', 'दोबारा', 'फिर', 'फिर से', 'again', 'फिरसे'],
  slower: ['slow', 'slowly', 'dhire', 'धीरे', 'आराम से', 'dhire se', 'आइस्टी'],
  resend: ['resend', 'naya code', 'नया कोड', 'फिर भेजो', ' resend ', 'फिर से भेजो'],
  more: ['more', 'aur', 'और', 'next', 'अगला', 'remaining', 'बाकी', 'baaki', 'और दावे'],
  dispute: ['wrong', 'galat', 'गलत', 'kam', 'कम', 'less', 'mistake', 'गड़बड़', 'dispute', 'झूठ', 'दोष', 'बदलो', 'incorrect', 'mismatch', 'zyada', 'ज्यादा'],
  distress: ['frustrated', 'परेशान', 'pareshan', 'angry', 'गुस्सा', 'gussa', 'upset', 'dukhi', 'helpless', 'बहुत परेशान', 'thak gaya', 'थक गया'],
  stop: ['stop', 'बंद', 'band karo', 'cancel', 'रद्द', 'khatam', 'खतम'],
  // Out-of-scope mutation requests (FR-24/FR-26): Release 1 never approves,
  // rejects, expedites, uploads, edits or changes anything.
  mutation: ['approve', 'approval', 'expedite', 'reject', 'upload', 'documents', 'document', 'edit', 'withdraw', 'apply for', 'bank account change', 'स्वीकृत', 'मंजूर', 'जल्दी', 'अपलोड', 'दस्तावेज़', 'दस्तावेज', 'badlo claim', 'claim badlo'],
};

const YES_WORDS = ['yes', 'yeah', 'yup', 'haan', 'hann', 'haanji', 'ha', 'ji', 'ha ji', 'ok', 'okay', 'theek', 'thik', 'sahi', 'confirm', 'sure', 'हाँ', 'हां', 'जी', 'ठीक', 'सही', 'जी हाँ', 'हो', 'હા', 'ಹೌದು', 'ஆம்', 'ஆமாம்', 'അതെ', 'হ্যাঁ', 'হয়', 'ਹਾਂ', 'ହଁ', 'অসমীয়া হয়'];
const NO_WORDS = ['no', 'nope', 'nahi', 'nahin', 'nahiin', 'na', 'not', 'galat', 'नहीं', 'ना', 'नही', 'नाही', 'ના', 'ಇಲ್ಲ', 'இல்லை', 'வேண்டாம்', 'വേണ്ട', 'না', 'ਨਹੀਂ', 'ନା', 'নহে'];

const EMPLOYEE_WORDS = ['employee', 'my own', 'myself', 'self', 'कर्मचारी', 'अपने', 'मैं खुद', 'मैं कर्मचारी', 'माझा', 'मी कर्मचारी'];
const BENEFICIARY_WORDS = ['beneficiary', 'listed', 'wife', 'husband', 'father', 'mother', 'son', 'daughter', 'family', 'लाभार्थी', 'पत्नी', 'पति', 'पिता', 'माता', 'बेटा', 'बेटी', 'घरचे', 'परिवार'];

const LANGUAGE_NAMES = {
  english: 'en', inglish: 'en', angrezi: 'en', अंग्रेजी: 'en',
  hindi: 'hi', हिंदी: 'hi', हिन्दी: 'hi',
  bengali: 'bn', बांग्ला: 'bn', বাংলা: 'bn',
  marathi: 'mr', मराठी: 'mr',
  tamil: 'ta', तमिल: 'ta', தமிழ்: 'ta',
  telugu: 'te', तेलुगु: 'te', తెలుగు: 'te',
  gujarati: 'gu', गुजराती: 'gu', ગુજરાતી: 'gu',
  punjabi: 'pa', पंजाबी: 'pa', ਪੰਜਾਬੀ: 'pa',
  malayalam: 'ml', मलयालम: 'ml', മലയാളം: 'ml',
  kannada: 'kn', कन्नड़: 'kn', ಕನ್ನಡ: 'kn',
  odia: 'or', ओडिया: 'or', ଓଡ଼ିଆ: 'or',
  assamese: 'as', असमिया: 'as', অসমীয়া: 'as',
};

const NUMBER_WORDS = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  ek: 1, do: 2, teen: 3, char: 4, paanch: 5, panch: 5, chhah: 6, chhe: 6, saat: 7, aath: 8, nau: 9, das: 10,
  'एक': 1, 'दो': 2, 'तीन': 3, 'चार': 4, 'पांच': 5, 'पाँच': 5, 'छह': 6, 'छः': 6, 'सात': 7, 'आठ': 8, 'नौ': 9, 'दस': 10,
};

const ORDINAL_WORDS = {
  first: 1, '1st': 1, second: 2, '2nd': 2, third: 3, '3rd': 3, fourth: 4, '4th': 4, fifth: 5, '5th': 5,
  pehla: 1, pehli: 1, dusra: 2, dusri: 2, tisra: 3, tisri: 3, chautha: 4, pachvan: 5,
  'पहला': 1, 'पहली': 1, 'दूसरा': 2, 'दूसरी': 2, 'तीसरा': 3, 'तीसरी': 3, 'चौथा': 4, 'पांचवां': 5,
};

function hasWord(textLower, words) {
  return words.some((w) => new RegExp(`(^|[^\\p{L}])${escapeRe(w)}([^\\p{L}]|$)`, 'u').test(textLower));
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Script-based language detection with code-switch awareness (FR-20/FR-21)
 *  plus the extended catalogue (Arabic/Urdu, Cyrillic, CJK, Latin-European). */
export function detectLanguage(text) {
  if (!text) return null;
  for (const [lang, re] of SCRIPT_TESTS) if (re.test(text)) return lang;
  if (/[\u0900-\u097F]/.test(text)) {
    // Devanagari: distinguish Marathi (आहे/आहै words) from Hindi
    if (/आहे|आहै|माझ|तुमचा|केलं|झालं/.test(text)) return 'mr';
    return 'hi';
  }
  if (/[\u0980-\u09FF]/.test(text)) {
    if (/অসমীয়া|আপুনি|মই |কৰিছো|হ'ব/.test(text)) return 'as';
    return 'bn';
  }
  if (/[\u0600-\u06FF]/.test(text)) {
    // Arabic script: Urdu shares it — distinguish by Urdu-specific vocabulary
    if (/میرا|میری|دعویٰ|دعوے|ہے|کیا|ٹرسٹ|ہیلپ/.test(text)) return 'ur';
    return 'ar';
  }
  if (/[\u0400-\u04FF]/.test(text)) return 'ru';
  if (/[\u3040-\u30FF]/.test(text)) return 'ja';
  if (/[\u4E00-\u9FFF]/.test(text)) return 'zh';
  const lower = text.toLowerCase();
  // Romanized Hindi/Marathi code-switching: presence of distinctive function words
  if (/\b(mujhe|mera|meri|kya|chahiye|nahi|nahin|haan|kahan|paisa|milega|hoga|karna|kripya)\b/.test(lower)) return 'hi';
  if (/\b(mala|mazha|ahe|tumcha|kelay|pan)\b/.test(lower)) return 'mr';
  // Extended Latin catalogue (best-effort; explicit selection is authoritative)
  if (/\b(reclamación|reclamo|pago|estado de|solicitud|gracias)\b/.test(lower)) return 'es';
  if (/\b(réclamation|paiement|demande|statut de|bonjour)\b/.test(lower)) return 'fr';
  if (/\b(antrag|zahlung|genehmigt|gutschrift|meine)\b/.test(lower)) return 'de';
  if (/\b(reclamação|pagamento|pedido|situação do|olá)\b/.test(lower)) return 'pt';
  if (/\b(klaim|pembayaran|permintaan|terima kasih|statusnya)\b/.test(lower)) return 'id';
  return 'en';
}

/**
 * Parse a caller utterance into a structured, action-safe result.
 */
export function parseUtterance(text) {
  const raw = String(text || '');
  const lower = raw.toLowerCase().trim();
  const lang = detectLanguage(raw);

  const intents = {};
  for (const [intent, words] of Object.entries(INTENT_WORDS)) {
    intents[intent] = hasWord(lower, words) || (intent !== 'stop' && words.some((w) => w.length > 5 && lower.includes(w)));
  }

  const digitGroups = (raw.match(/\d+/g) || []).map((d) => d.replace(/^0+(?=\d)/, '') === '' ? d : d.replace(/^0+(?=\d)/, ''));
  // preserve original digit strings (leading zeros matter for PS numbers)
  const digitGroupsRaw = raw.match(/\d+/g) || [];

  const claimIds = [];
  for (const m of raw.matchAll(/\bCLM[\s\-–]?([0-9]{3,8})\b/gi)) {
    claimIds.push(`CLM-${m[1]}`);
  }

  const numbers = [];
  const wordTokens = lower.split(/[^\p{L}\p{N}\p{M}]+/u).filter(Boolean); // \p{M}: keep Devanagari vowel signs intact
  for (const tok of wordTokens) {
    if (NUMBER_WORDS[tok] !== undefined) numbers.push(NUMBER_WORDS[tok]);
  }
  const ordinals = [];
  for (const tok of wordTokens) {
    if (ORDINAL_WORDS[tok] !== undefined) ordinals.push(ORDINAL_WORDS[tok]);
  }
  for (const g of digitGroupsRaw) {
    const n = Number(g);
    if (Number.isInteger(n) && n >= 1 && n <= 99 && g.length <= 2) ordinals.push(n);
  }

  let switchLang = null;
  for (const [name, code] of Object.entries(LANGUAGE_NAMES)) {
    if (lower.includes(name)) { switchLang = code; break; }
  }

  const yes = hasWord(lower, YES_WORDS);
  const no = hasWord(lower, NO_WORDS) && !yes;

  let callerRole = null;
  // beneficiary phrasing wins: 'beneficiary of employee ...' contains the word 'employee'
  if (hasWord(lower, BENEFICIARY_WORDS)) callerRole = 'beneficiary';
  else if (hasWord(lower, EMPLOYEE_WORDS)) callerRole = 'employee';

  const actionable =
    digitGroupsRaw.length > 0 ||
    claimIds.length > 0 ||
    numbers.length > 0 ||
    ordinals.length > 0 ||
    yes || no ||
    Object.values(intents).some(Boolean) ||
    switchLang ||
    callerRole;

  return {
    raw,
    lang,
    yes,
    no,
    intents,
    digitGroups: digitGroupsRaw, // original strings, leading zeros preserved
    claimIds,
    numbers,
    ordinals: [...new Set(ordinals)].sort((a, b) => a - b),
    switchLang,
    callerRole,
    isUnclear: !actionable,
  };
}

/** Spoken digits "0 0 4 3 2 1" -> "004321" (FR-22 read-back confirmation upstream). */
export function digitsOnly(text) {
  const m = String(text || '').replace(/[\s\-.,]/g, '').match(/^\d{4,10}$/);
  return m ? m[0] : null;
}
