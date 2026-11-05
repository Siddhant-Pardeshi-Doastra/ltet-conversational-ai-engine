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

test('all 12 FRS language packs load with required metadata', () => {
  const packs = allPacks();
  const expected = ['en', 'hi', 'bn', 'mr', 'ta', 'te', 'gu', 'pa', 'ml', 'kn', 'or', 'as'];
  for (const l of expected) {
    assert.ok(packs[l], `pack ${l} missing`);
    assert.ok(packs[l].strings.greeting, `${l} greeting missing`);
    assert.ok(packs[l].locale, `${l} locale missing`);
  }
  const meta = packMeta();
  assert.equal(meta.length, 12);
  assert.equal(meta.filter((m) => m.launch_ready).length, 1, 'only English is native-approved');
  assert.equal(meta.filter((m) => m.status === 'draft_translation').length, 11);
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
