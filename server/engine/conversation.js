// Conversational interpretation layer — the agent's "listening brain".
//
// Turns free-form caller speech (multi-clause, emotional, indirect) into a
// structured understanding: topic, issue kind, sentiment, urgency, entities.
// This is what lets the agent behave like a human instead of a keyword menu.
//
// Fact safety is preserved: this layer decides HOW to help and WHAT to check —
// it never produces facts. All facts still come from the portal adapter and
// pass the validator before TTS.

const ISSUE_PATTERNS = [
  { kind: 'payment_missing', re: /(not\s*received|haven'?t\s*received|no\s*money|money\s*not|payment\s*not|paise\s*nahi|paisa\s*nahi|पैसा\s*नहीं|रकम\s*नहीं|अभी\s*तक\s*नहीं|मिला\s*नहीं|नहीं\s*मिला)/i },
  { kind: 'payment_missing', re: /(has\s*a\s*problem|problem\s*with|issue\s*with|trouble|not\s*working|complaint|समस्या|दिक्कत)/i },
  { kind: 'payment_delay', re: /(still\s*pending|waiting|how\s*long|since\s*\w+|weeks?|months?|days?|itubta|कितने\s*दिन|कब\s*तक|देरी|pending\s*kyun|और\s*कितना)/i },
  { kind: 'payment_failed', re: /(failed|rejected|declined|bounced|returned|fail\s*hua|कट\s*गया|वापस)/i },
  { kind: 'amount_issue', re: /(wrong\s*amount|less\s*amount|less\s*than|partial|kam\s*aaya|कम\s*आया|गलत\s*रकम)/i },
  { kind: 'documents', re: /(document|bill|receipt|upload|proof|kagzat|कागज|दस्तावेज़)/i },
  { kind: 'query_help', re: /(query|notice|message\s*from|processor\s*(asked|wants)|प्रश्न)/i },
  { kind: 'status', re: /(status|kahan|where|stage|kya\s*hal|progress|स्थिति)/i },
  { kind: 'payment', re: /(payment|paid|credit|reimburse|paisa|पैसा|पैसे|भुगतान)/i },
];

const URGENCY_PATTERNS = /(urgent|emergency|immediately|abhi|जल्दी|अभी|turant|hospital|medical\s*emergency)/i;
const DISTRESS_PATTERNS = /(frustrated|angry|upset|worried|anxious|depressed|helpless|thak\s*gay|परेशान|गुस्सा|चिंता|परेशान|thak\s*gaaya|bhot\s*pareshan)/i;
const GREETING_PATTERNS = /^(hi|hello|hey|namaste|namaskar|नमस्ते|नमस्कार|salaam|good\s*(morning|afternoon|evening))[\s!.,]*$/i;
const THANK_PATTERNS = /(thank|thanks|dhanyavad|shukriya|धन्यवाद|शुक्रिया|merci)/i;
const NEGATIVE_MARKERS = /(not\s*received|failed|wrong|less|delay|pending|frustrated|angry|worried|nahi|नहीं|गलत|कम|देरी|परेशान)/i;

/**
 * Interpret a caller utterance into structured understanding.
 * Returns { kind, topics, sentiment, urgency, greeting, thanks, confidence }.
 */
export function interpret(text, { state = '' } = {}) {
  const raw = String(text || '').trim();
  const t = raw.toLowerCase();

  const issues = ISSUE_PATTERNS.filter((p) => p.re.test(t)).map((p) => p.kind);
  const sentiment = DISTRESS_PATTERNS.test(t) || NEGATIVE_MARKERS.test(t)
    ? (DISTRESS_PATTERNS.test(t) ? 'distressed' : 'negative')
    : THANK_PATTERNS.test(t) ? 'positive' : 'neutral';
  const urgency = URGENCY_PATTERNS.test(t) ? 'high' : 'normal';

  // The most specific issue kind wins (missing > delay > failed > amount > query > docs > status > payment)
  const priority = ['payment_missing', 'payment_delay', 'payment_failed', 'amount_issue', 'query_help', 'documents', 'status', 'payment'];
  const kind = issues.sort((a, b) => priority.indexOf(a) - priority.indexOf(b))[0] || null;

  return {
    kind,
    issues,
    isIssue: issues.length > 0,
    greeting: GREETING_PATTERNS.test(raw),
    thanks: THANK_PATTERNS.test(t),
    sentiment,
    urgency,
    multiIssue: issues.length > 1,
    confidence: issues.length ? 0.9 : 0.3,
  };
}

/** Natural acknowledgment before an answer — the human touch. */
const ACKS = {
  thinking: ['Let me check that for you.', 'Give me just a moment — looking into it.', 'Sure, let me pull that up right now.'],
  empathy: ['I am sorry to hear that — let me see exactly what is happening.', 'I understand this is frustrating. Let me check everything on my side.', 'That should not be happening — let me look into it for you.'],
  urgency: ['I understand this is urgent. Let me check immediately.', 'Understood — let me check this right away for you.'],
};
const ACKS_HI = {
  thinking: ['मैं अभी जाँच करता हूँ।', 'एक क्षण दीजिए — मैं देख रहा हूँ।', 'जी, मैं अभी देखता हूँ।'],
  empathy: ['मुझे खेद है कि ऐसा हुआ — मैं अभी पूरी जाँच करता हूँ।', 'मैं समझ सकता हूँ कि यह परेशान करने वाला है। मैं अभी देखता हूँ।'],
  urgency: ['समझ गया, यह अत्यावश्यक है। मैं तुरंत जाँच करता हूँ।'],
};

/**
 * Compose a natural acknowledgment for the situation.
 * Returns { key, params, text, lang } entries to speak BEFORE the factual
 * answer. Deterministic templates only — no generated facts.
 */
export function acknowledge(understanding, lang = 'en') {
  const bank = lang === 'hi' ? ACKS_HI : ACKS;
  let pool;
  if (understanding.urgency === 'high') pool = bank.urgency;
  else if (understanding.sentiment === 'distressed' || understanding.sentiment === 'negative') pool = bank.empathy;
  else pool = bank.thinking;
  const line = pool[(understanding.raw?.length || 0) % pool.length];
  return [{ text: line, lang, templateKey: 'agent_ack' }];
}

/** A brief human-style wrap line after resolving, before the more-help ask. */
export function wrapLine(understanding, lang = 'en') {
  if (lang === 'hi') return [{ text: 'और कुछ जानना चाहेंगे तो बताइए।', lang, templateKey: 'agent_wrap' }];
  if (understanding.thanks) return [{ text: 'Happy to help — that is what we are here for.', lang, templateKey: 'agent_wrap' }];
  return [];
}

/**
 * Context pack handed to a human agent on transfer after exhaustive search —
 * so the client never repeats themselves.
 */
export function transferBrief(ctx, session) {
  return {
    transfer_reason: ctx.transferReason || 'unresolved after exhaustive resolution search',
    attempted_resolutions: ctx.attemptedResolutions || [],
    claimed_ps_masked: session.claimed_ps_no ? `${String(session.claimed_ps_no).slice(0, 2)}••••${String(session.claimed_ps_no).slice(-2)}` : null,
    verified: !!session.verified_ps_no,
    language: session.language,
    claims_discussed: (ctx.discussed || []).map((d) => d.claimId),
    sentiment_estimate: understandingSentiment(ctx),
  };
}
function understandingSentiment(ctx) {
  return ctx.lastUnderstanding?.sentiment || 'neutral';
}
