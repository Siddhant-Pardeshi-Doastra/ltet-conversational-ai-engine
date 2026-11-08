// Engine unit tests: intent parsing, language detection, fact validation.
// Self-seeding: portal-backed assertions need fixtures, so this process creates
// its own isolated, freshly seeded DB before any server import.
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.LTET_MODE = 'demo';
process.env.LTET_DB_FILE = join(tmpdir(), `ltet-engine-test-${randomUUID()}.db`);

import test from 'node:test';
import assert from 'node:assert/strict';

const { getDb } = await import('../server/db.js');
const { seed } = await import('../server/seed.js');
const { seedDefaultPolicy } = await import('../server/services/policy.js');
getDb();
seed({ force: true });
seedDefaultPolicy();

const { parseUtterance, detectLanguage } = await import('../server/engine/intents.js');

test('detectLanguage across all 12 FRS language scripts', () => {
  assert.equal(detectLanguage('What is my claim status?'), 'en');
  assert.equal(detectLanguage('मेरा दावा कहाँ है?'), 'hi');
  assert.equal(detectLanguage('माझा दावा आहे'), 'mr');
  assert.equal(detectLanguage('আমার দাবি কোথায়?'), 'bn');
  assert.equal(detectLanguage('মই দাবী জানিব বিচাৰোঁ'), 'as');
  assert.equal(detectLanguage('ਮੇਰਾ ਦਾਅਵਾ ਕਿੱਥੇ ਹੈ?'), 'pa');
  assert.equal(detectLanguage('મારો દાવો ક્યાં છે?'), 'gu');
  assert.equal(detectLanguage('എന്റെ ക്ലെയിം എവിടെ?'), 'ml');
  assert.equal(detectLanguage('ನನ್ನ ಕ್ಲೇಮ್ ಎಲ್ಲಿದೆ?'), 'kn');
  assert.equal(detectLanguage('ମୋ ଦାବି କେଉଁଠି?'), 'or');
  assert.equal(detectLanguage('என் கோரிக்கை எங்கே?'), 'ta');
  assert.equal(detectLanguage('నా క్లెయిమ్ ఎక్కడ?'), 'te');
});

test('detectLanguage across the extended catalogue (scripts + keywords)', () => {
  assert.equal(detectLanguage('میرا دعویٰ کہاں ہے؟'), 'ur', 'Urdu distinguished inside Arabic script');
  assert.equal(detectLanguage('أين مطالبتي؟'), 'ar', 'Arabic script default');
  assert.equal(detectLanguage('Где моё требование?'), 'ru', 'Cyrillic');
  assert.equal(detectLanguage('私の請求はどこですか'), 'ja', 'Kana');
  assert.equal(detectLanguage('我的申请在哪里'), 'zh', 'Han');
  assert.equal(detectLanguage('¿cuál es el estado de mi pago?'), 'es', 'Spanish keyword');
  assert.equal(detectLanguage('où est le paiement de ma demande'), 'fr', 'French keyword');
  assert.equal(detectLanguage('meine Zahlung bitte'), 'de', 'German keyword');
  assert.equal(detectLanguage('qual a situação do meu pagamento'), 'pt', 'Portuguese keyword');
  assert.equal(detectLanguage('statusnya pembayaran klaim saya'), 'id', 'Indonesian keyword');
});

test('mixed Hindi-English code-switching is detected as Hindi with English terms intact (FR-21)', () => {
  const p = parseUtterance('mera CLM-10020 ka payment status kya hai');
  assert.equal(p.lang, 'hi');
  assert.deepEqual(p.claimIds, ['CLM-10020']);
  assert.ok(p.intents.payment);
  assert.ok(p.intents.status);
});

test('claim IDs capture tolerates spacing and is case-insensitive (FR-21 English terminology)', () => {
  assert.deepEqual(parseUtterance('claim clm 10071 status').claimIds, ['CLM-10071']);
  assert.deepEqual(parseUtterance('status of CLM-10071 please').claimIds, ['CLM-10071']);
  assert.deepEqual(parseUtterance('no claim numbers here').claimIds, []);
});

test('ordinals and spoken numbers (English + Hindi)', () => {
  assert.deepEqual(parseUtterance('the second one').ordinals, [2]);
  assert.deepEqual(parseUtterance('दूसरा').ordinals, [2]);
  assert.deepEqual(parseUtterance('pehla wala').ordinals, [1]);
  assert.deepEqual(parseUtterance('2').ordinals, [2]);
});

test('digit groups preserve leading zeros (PS numbers)', () => {
  const p = parseUtterance('zero zero four three two one 004321');
  assert.ok(p.digitGroups.includes('004321'));
});

test('yes/no multilingual and no false positive from "no" inside other words', () => {
  assert.ok(parseUtterance('haan ji').yes);
  assert.ok(parseUtterance('theek hai').yes);
  assert.ok(parseUtterance('nahi nahi').no);
  assert.ok(parseUtterance('இல்லை').no);
  assert.ok(parseUtterance('হ্যাঁ').yes);
  assert.equal(parseUtterance('nothing special').yes, false);
  assert.equal(parseUtterance('nothing special').no, false);
});

test('caller role detection: beneficiary phrasing wins over the word employee', () => {
  assert.equal(parseUtterance('I am calling as a beneficiary of an employee').callerRole, 'beneficiary');
  assert.equal(parseUtterance('I am the employee').callerRole, 'employee');
  assert.equal(parseUtterance('मैं कर्मचारी हूँ').callerRole, 'employee');
  assert.equal(parseUtterance('मैं लाभार्थी हूँ').callerRole, 'beneficiary');
});

test('intents: human, dispute, distress, repeat, resend, callback', () => {
  assert.ok(parseUtterance('I want to talk to a human agent').intents.human);
  assert.ok(parseUtterance('the amount is wrong, galat hai').intents.dispute);
  assert.ok(parseUtterance('मैं बहुत परेशान हूँ').intents.distress);
  assert.ok(parseUtterance('repeat please').intents.repeat);
  assert.ok(parseUtterance('फिर भेजो').intents.resend);
  assert.ok(parseUtterance('please call me back').intents.callback);
});

test('unclear utterances are flagged for recognition-failure counting', () => {
  assert.ok(parseUtterance('asdf qwerty').isUnclear);
  assert.ok(parseUtterance('').isUnclear);
  assert.equal(parseUtterance('agent').isUnclear, false);
});

// ---- language packs -------------------------------------------------------
const { allPacks, packMeta, t } = await import('../server/engine/languages.js');

test('all 12 FRS-core packs + extended catalogue load with required metadata', () => {
  const packs = allPacks();
  const core = ['en', 'hi', 'bn', 'mr', 'ta', 'te', 'gu', 'pa', 'ml', 'kn', 'or', 'as'];
  for (const l of core) {
    assert.ok(packs[l], `pack ${l} missing`);
    assert.ok(packs[l].strings.greeting, `${l} greeting missing`);
    assert.ok(packs[l].locale, `${l} locale missing`);
  }
  const extended = ['ur', 'es', 'fr', 'de', 'pt', 'ar', 'zh', 'ja', 'ru', 'id'];
  for (const l of extended) {
    assert.ok(packs[l], `extended pack ${l} missing`);
    assert.equal(packs[l].catalogue, 'extended');
  }
  const meta = packMeta();
  assert.equal(meta.length, 22);
  assert.equal(meta.filter((m) => m.catalogue === 'frs-core').length, 12);
  assert.equal(meta.filter((m) => m.launch_ready).length, 1, 'only English is native-approved');
  assert.equal(meta.filter((m) => m.status === 'draft_translation').length, 21);
});

test('t() falls back to English for missing keys in draft packs', () => {
  const val = t('ta', 'claims_zero', {});
  assert.ok(val.includes('no open claims'), 'fallback to English expected');
  assert.ok(t('hi', 'greeting').includes('स्वागत'), 'Hindi greeting present');
  assert.equal(t('zz', 'greeting').includes('Welcome'), true, 'unknown language falls back');
});

// ---- answer fact validation (against real seeded fixture claims) -----------
const { buildPaymentPlans, buildClaimStagePlan, validateAndRender } = await import('../server/engine/answers.js');
const { DEFAULT_POLICY } = await import('../server/config.js');
const { getClaimSummary } = await import('../server/adapters/portal.js');

test('claim stage plan validates against matching source (seeded CLM-10010: PMS + query)', () => {
  const claim = getClaimSummary('CLM-10010');
  assert.ok(claim, 'seeded fixture present');
  assert.equal(claim.status, 'Processing');
  const plans = buildClaimStagePlan('CS-T', claim);
  assert.equal(plans.length, 2, 'stage plan + open-query plan');
  const rendered = validateAndRender('CS-T', 'CLM-10010', plans, { lang: 'en', policy: DEFAULT_POLICY });
  assert.equal(rendered.ok, true);
  assert.ok(rendered.segments.some((s) => s.text.includes('PMS Processor')));
  assert.ok(rendered.segments.some((s) => s.text.includes('hotel stay')), 'query text conveyed');
});

test('mismatched stage between plan and fresh source BLOCKS the answer (fact safety)', () => {
  const claim = getClaimSummary('CLM-10010');
  const plans = buildClaimStagePlan('CS-T', claim);
  plans[0].slots.stage = 'Apex Panel Review'; // tamper
  plans[0].lang_params.stage = 'Apex Panel Review';
  const rendered = validateAndRender('CS-T', 'CLM-10010', plans, { lang: 'en', policy: DEFAULT_POLICY });
  // rebuild must re-derive from source; the tampered value must NOT be spoken
  if (rendered.ok) {
    assert.ok(!rendered.segments.some((s) => s.text.includes('Apex Panel Review')), 'tampered stage must never be spoken');
  }
});

test('payment plans: non-approved claim yields NO payment info (FR-41)', () => {
  const claim = { ...getClaimSummary('CLM-10010') };
  const plans = buildPaymentPlans('CS-T', claim, { payment_status_raw: 'Credited', amount_minor: 100 }, { mapping: DEFAULT_POLICY.payment_status_mapping });
  assert.equal(plans.length, 1);
  assert.equal(plans[0].kind, 'pay_not_applicable');
});

test('payment plans: credited carries typed slots; unmapped raw status stays unreadable (FR-45)', () => {
  const approved = { ...getClaimSummary('CLM-10020'), status: 'Approved' };
  const credited = buildPaymentPlans('CS-T', approved, { payment_status_raw: 'Credited', amount_minor: 2450000, credit_date: '2026-10-31', bank_reference: 'MOCK123', approval_status: 'Approved' }, { mapping: DEFAULT_POLICY.payment_status_mapping });
  assert.ok(credited.some((p) => p.kind === 'approval'));
  assert.ok(credited.some((p) => p.kind === 'pay_credited'));
  const unmapped = buildPaymentPlans('CS-T', approved, { payment_status_raw: 'Sent-to-Bank-X', approval_status: 'Approved' }, { mapping: DEFAULT_POLICY.payment_status_mapping });
  assert.ok(unmapped.some((p) => p.kind === 'pay_unmapped'));
});

test('credited amount mismatch between plan and fresh source blocks rendering', () => {
  const approved = { ...getClaimSummary('CLM-10020'), status: 'Approved' };
  const payment = { payment_status_raw: 'Credited', amount_minor: 2450000, credit_date: '2026-10-31', bank_reference: 'MOCK123', approval_status: 'Approved' };
  const plans = buildPaymentPlans('CS-T', approved, payment, { mapping: DEFAULT_POLICY.payment_status_mapping });
  const payPlan = plans.find((p) => p.kind === 'pay_credited');
  payPlan.slots.amount_minor = 999999; // tamper
  const src = { claim: approved, payment, mapping: DEFAULT_POLICY.payment_status_mapping };
  assert.equal(payPlan.validate(src), false, 'tampered amount must fail validation');
});

test('money formatting: Indian grouping in integer minor units', async () => {
  const { formatInr } = await import('../server/util.js');
  assert.equal(formatInr(2450000), '₹24,500.00');
  assert.equal(formatInr(123456789), '₹12,34,567.89');
  assert.equal(formatInr(5), '₹0.05');
  assert.equal(formatInr(null), 'Unknown');
});

// ---- conversational interpretation layer ----
const { interpret, acknowledge } = await import('../server/engine/conversation.js');

test('interpret: free-form reimbursement problems classify into resolvable kinds', () => {
  assert.equal(interpret('I still have not received the money in my account').kind, 'payment_missing');
  assert.equal(interpret('payment has been pending for three weeks now').kind, 'payment_delay');
  assert.equal(interpret('my reimbursement got rejected by the bank').kind, 'payment_failed');
  assert.equal(interpret('the credited amount is less than what I claimed').kind, 'amount_issue');
  assert.equal(interpret('the processor asked for hotel bills').kind, 'query_help');
  assert.equal(interpret('what is the status of CLM-10010').kind, 'status');
});

test('interpret: sentiment, urgency and greeting/thanks signals', () => {
  const u = interpret('this is ridiculous, I am very frustrated, nobody is helping');
  assert.equal(u.sentiment, 'distressed');
  const urgent = interpret('this is urgent, I need it immediately for a hospital payment');
  assert.equal(urgent.urgency, 'high');
  assert.ok(interpret('hello').greeting);
  assert.ok(interpret('thank you so much').sentiment === 'positive' || interpret('thank you so much').thanks);
});

test('acknowledge: deterministic template lines only, no invented facts', () => {
  for (const u of [
    interpret('payment pending for weeks'),
    interpret('I am frustrated, nothing is happening'),
    interpret('this is urgent'),
  ]) {
    for (const a of acknowledge(u, 'en')) {
      assert.ok(a.text.length > 0 && a.text.length < 140, 'short human ack line');
      assert.ok(!/d{5,}/.test(a.text), 'no identifiers or amounts fabricated');
    }
  }
});


// ---- voice speech normalization + cadence (public/voice.js, pure functions) ----
const { normalizeForSpeech, chunkSoft } = await import('../public/voice.js');

test('speech normalization: currency reads naturally per language', () => {
  assert.equal(normalizeForSpeech('An amount of ₹24,500.00 was credited.', 'en'), 'An amount of 24,500 rupees was credited.');
  assert.equal(normalizeForSpeech('₹15,600.00 की राशि जमा हुई।', 'hi'), '15,600 रुपये की राशि जमा हुई।');
  assert.ok(normalizeForSpeech('₹1,234.56 credited', 'en').includes('1,234.56 rupees'), 'paise preserved when non-zero');
});

test('speech normalization: reference codes read like a human agent', () => {
  const out = normalizeForSpeech('Your claim CLM-10020 has been approved. The bank reference is MOCKBANK0045678.', 'en');
  assert.ok(out.includes('C L M 1 0 0 2 0'), 'claim id digit-spaced for clarity');
  assert.ok(out.includes('M O C K B A N K 0 0 4 5 6 7 8'), 'bank reference letter/digit runs spaced');
  // accuracy guard: every original digit survives normalization
  assert.ok(out.replace(/\s/g, '').includes('10020'), 'digits unchanged');
});

test('cadence: sentences and phrases carry breath markers for the speech chain', () => {
  const parts = chunkSoft('Finance approved your claim on 10 October 2026. The payment is pending with the Finance Disbursement team, and no payment date is available yet.');
  assert.equal(parts.length, 3);
  assert.equal(parts[0].pause, 'sentence');
  assert.equal(parts[1].pause, 'phrase', 'comma gets a phrase breath');
  assert.equal(parts[2].pause, 'sentence');
  assert.ok(parts.every((p) => p.text.length > 0));
});
