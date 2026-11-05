// Fact-safe answer construction, validation and rendering (section 6 of the build prompt).
//
// - Answers are structured plans with typed factual slots rendered from approved
//   templates. No model can create identifiers, amounts, dates, ownership or status.
// - Every protected plan is VALIDATED against a fresh live source snapshot before
//   it can be spoken; a mismatch blocks the answer and falls back to a safe
//   template built from the same authorised facts (never invented content).
// - Each validated answer records AnswerEvidence (source ref/version/retrieval
//   time + snapshot) for provenance (NFR-09).
import { portalVersion } from '../adapters/portal.js';
import { getClaimSummary, getFinancePayment } from '../adapters/portal.js';
import { t, languageName } from './languages.js';
import { formatInr, nowIso, toIst } from '../util.js';

const STAGES = ['PMS Processor', 'Sub-panel Review', 'Apex Panel Review', 'Approval'];

function evidenceRecord(sessionId, claimId, factKey, snapshot) {
  return {
    session_id: sessionId,
    claim_id: claimId,
    at: nowIso(),
    fact_key: factKey,
    source_ref: `portal:${factKey}`,
    source_version: portalVersion(),
    retrieved_at: nowIso(),
    snapshot: JSON.stringify(snapshot),
  };
}

/** Plan: claim processing-stage answer (FR-10) with optional open query (FR-12). */
export function buildClaimStagePlan(sessionId, claim) {
  if (!claim || claim.status !== 'Processing' || !STAGES.includes(claim.stage)) {
    return null;
  }
  const snapshot = { claim_id: claim.claim_id, status: claim.status, stage: claim.stage };
  const slots = { stage: claim.stage, claim_id: claim.claim_id };
  const plans = [
    {
      kind: 'claim_stage',
      templateKey: 'claim_stage_answer',
      lang_params: { claim_id: claim.claim_id, stage: claim.stage },
      slots,
      // Validation compares the PLAN SLOTS against the fresh source — a tampered
      // slot value can never pass (fact safety before TTS).
      validate: (src) => src.claim?.status === 'Processing'
        && src.claim?.stage === slots.stage
        && src.claim?.claim_id === slots.claim_id,
      evidence: evidenceRecord(sessionId, claim.claim_id, 'claim.stage', snapshot),
    },
  ];
  if (claim.has_open_query && claim.open_query) {
    const qs = { claim_id: claim.claim_id, query_stage: claim.open_query.stage, query_text: claim.open_query.query_text };
    const qslots = { query_stage: claim.open_query.stage, query_text: claim.open_query.query_text };
    plans.push({
      kind: 'claim_query',
      templateKey: 'claim_query_note',
      lang_params: { query_stage: claim.open_query.stage, query_text: claim.open_query.query_text },
      slots: qslots,
      validate: (src) => src.claim?.has_open_query
        && src.claim?.open_query?.query_text === qslots.query_text
        && src.claim?.open_query?.stage === qslots.query_stage,
      evidence: evidenceRecord(sessionId, claim.claim_id, 'claim.query', qs),
    });
  }
  return plans;
}

/**
 * Plan: payment answer (UC-02 / FR-15..19, FR-40..46).
 * `fieldFilter` (beneficiary grants, FR-61) hides non-permitted fields.
 */
export function buildPaymentPlans(sessionId, claim, payment, { mapping, delayThresholdDays, fieldFilter } = {}) {
  const plans = [];
  const claimId = claim.claim_id;

  // FR-41/BDD-23: a non-approved claim gets its stage answer and NO payment information.
  if (claim.status !== 'Approved') {
    return [
      {
        kind: 'pay_not_applicable',
        templateKey: 'pay_not_applicable',
        lang_params: { claim_id: claimId },
        slots: {},
        validate: (src) => src.claim.status !== 'Approved',
        evidence: evidenceRecord(sessionId, claimId, 'claim.status', { claim_id: claimId, status: claim.status }),
      },
    ];
  }

  // FR-44: Finance approval status comes FIRST.
  const approvalSlots = { claim_id: claimId };
  plans.push({
    kind: 'approval',
    templateKey: 'claim_approved_intro',
    lang_params: { claim_id: claimId },
    slots: approvalSlots,
    validate: (src) => src.claim?.status === 'Approved' && src.claim?.claim_id === approvalSlots.claim_id,
    evidence: evidenceRecord(sessionId, claimId, 'finance.approval_status', { claim_id: claimId, approval_status: payment?.approval_status ?? 'recorded' }),
  });

  if (!payment) {
    // Approval recorded but no payment record: state approval only; never invent a payment date/amount.
    plans.push({
      kind: 'pay_unknown',
      templateKey: 'pay_unmapped',
      lang_params: {},
      slots: {},
      validate: (src) => src.claim.status === 'Approved' && src.payment === null,
      evidence: evidenceRecord(sessionId, claimId, 'finance.payment', null),
    });
    return plans;
  }

  const raw = payment.payment_status_raw;
  const group = mapping && mapping[raw] ? mapping[raw] : null; // FR-45: unmapped stays unreadable

  if (!group) {
    plans.push({
      kind: 'pay_unmapped',
      templateKey: 'pay_unmapped',
      lang_params: {},
      slots: {},
      validate: (src) => src.claim.status === 'Approved' && !(src.mapping && src.mapping[src.payment?.payment_status_raw]),
      evidence: evidenceRecord(sessionId, claimId, 'finance.payment_status_raw', { raw }),
    });
    return plans;
  }

  const allowed = (f) => !fieldFilter || fieldFilter.includes(f);

  if (group === 'credited') {
    // FR-16: authoritative amount, credit date and bank reference only when authorised.
    const slots = {
      amount_minor: allowed('amount') ? payment.amount_minor : undefined,
      credit_date: allowed('credit_date') ? payment.credit_date : undefined,
      bank_reference: allowed('bank_reference') ? payment.bank_reference : undefined,
    };
    const langParams = {};
    if (slots.amount_minor !== undefined) langParams.amount = formatInr(slots.amount_minor);
    if (slots.credit_date !== undefined) langParams.credit_date = fmtDate(slots.credit_date);
    if (slots.bank_reference !== undefined) langParams.bank_reference = slots.bank_reference;
    plans.push({
      kind: 'pay_credited',
      templateKey: 'pay_credited',
      lang_params: langParams,
      slots,
      validate: (src) => {
        if (!src.payment || src.mapping[src.payment.payment_status_raw] !== 'credited') return false;
        return (src.payment.amount_minor ?? undefined) === (slots.amount_minor ?? undefined)
          && (src.payment.credit_date ?? undefined) === (slots.credit_date ?? undefined)
          && (src.payment.bank_reference ?? undefined) === (slots.bank_reference ?? undefined);
      },
      evidence: evidenceRecord(sessionId, claimId, 'finance.payment', { ...payment }),
    });
    return plans;
  }

  const owner = payment.owner_team || 'Finance';
  if (group === 'processed' || group === 'pending') {
    // FR-17: state recorded stage and owner; invent no payment date.
    const slots = { approval_date: payment.approval_date ?? undefined, owner };
    plans.push({
      kind: `pay_${group}`,
      templateKey: `pay_${group}`,
      lang_params: { approval_date: fmtDate(payment.approval_date), owner },
      slots,
      validate: (src) => !!src.payment && src.mapping[src.payment.payment_status_raw] === group
        && (src.payment.approval_date ?? undefined) === (slots.approval_date ?? undefined)
        && (src.payment.owner_team || 'Finance') === slots.owner,
      evidence: evidenceRecord(sessionId, claimId, 'finance.payment', { ...payment }),
    });
    // FR-46: delayed flag when approval date is older than the (demo-labelled) threshold.
    const delayed = isDelayed(payment, delayThresholdDays);
    if (delayed) {
      plans.push({
        kind: 'pay_delayed_flag',
        templateKey: null, // not spoken as a separate sentence in Release 1; included in summary + alert
        slots: { delayed: true, approval_date: payment.approval_date, threshold_days: delayThresholdDays },
        validate: (src) => isDelayed(src.payment, delayThresholdDays),
        evidence: evidenceRecord(sessionId, claimId, 'finance.delayed', { approval_date: payment.approval_date, threshold_days: delayThresholdDays }),
      });
    }
    return plans;
  }

  if (group === 'failed' || group === 'held') {
    // FR-18: recorded reason if present; alert + escalation offered by the flow.
    const reason = group === 'failed' ? payment.failure_reason : payment.held_reason;
    const slots = { approval_date: payment.approval_date ?? undefined, reason: reason ?? null };
    plans.push({
      kind: `pay_${group}`,
      templateKey: `pay_${group}`,
      lang_params: { approval_date: fmtDate(payment.approval_date), reason: reason || 'not recorded on the source' },
      slots,
      validate: (src) => !!src.payment && src.mapping[src.payment.payment_status_raw] === group
        && (src.payment.approval_date ?? undefined) === (slots.approval_date ?? undefined)
        && ((group === 'failed' ? src.payment.failure_reason : src.payment.held_reason) ?? null) === slots.reason,
      evidence: evidenceRecord(sessionId, claimId, 'finance.payment', { ...payment }),
    });
    return plans;
  }

  // Unknown group (defensive): never guessed.
  plans.push({
    kind: 'pay_unmapped',
    templateKey: 'pay_unmapped',
    lang_params: {},
    slots: {},
    validate: () => false,
    evidence: evidenceRecord(sessionId, claimId, 'finance.payment_status_raw', { raw }),
  });
  return plans;
}

function isDelayed(payment, thresholdDays) {
  if (!payment?.approval_date) return false;
  if (!['Processed', 'Pending'].includes(payment.payment_status_raw)) return false;
  const ageDays = (Date.now() - new Date(payment.approval_date).getTime()) / 86400000;
  return ageDays > thresholdDays;
}

export function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'long', year: 'numeric' }).format(d);
}

/**
 * Validate all protected plans against a FRESH live fetch, then render speakable
 * text. Returns { ok, segments: [{text, lang}], evidence: [...], flags }.
 * On mismatch -> one safe rebuild attempt; if that also fails, a no-facts
 * fallback. Nothing unvalidated is ever rendered.
 */
export function validateAndRender(sessionId, claimId, plans, { lang, policy, fieldFilter } = {}) {
  const segments = [];
  const evidence = [];
  const flags = { delayed: false };

  // Fresh authoritative snapshot (fact validation fetches live at render time).
  let claim, payment;
  try {
    claim = getClaimSummary(claimId);
    payment = claim ? getFinancePayment(claimId) : null;
  } catch (e) {
    return { ok: false, reason: 'source_unavailable', segments: [], evidence, flags };
  }
  if (!claim) return { ok: false, reason: 'claim_missing', segments: [], evidence, flags };

  for (let plan of plans) {
    let source = { claim, payment, mapping: policy.payment_status_mapping };
    if (plan.validate && !plan.validate(source)) {
      // One safe rebuild from fresh facts.
      const rebuilt = plan.kind === 'claim_stage' || plan.kind === 'claim_query'
        ? buildClaimStagePlans(claim, sessionId)
        : buildPaymentPlans(sessionId, claim, payment, { mapping: policy.payment_status_mapping, delayThresholdDays: policy.payment_delay_threshold_days, fieldFilter });
      const match = (rebuilt || []).find((p) => p.kind === plan.kind);
      if (!match) return { ok: false, reason: 'validation_mismatch', segments: [], evidence, flags };
      source = { claim, payment, mapping: policy.payment_status_mapping };
      if (match.validate && !match.validate(source)) {
        return { ok: false, reason: 'validation_mismatch', segments: [], evidence, flags };
      }
      plans = plans.map((p) => (p === plan ? match : p));
      plan = match;
    }
    if (plan.slots?.delayed) flags.delayed = true;
    if (plan.templateKey) {
      segments.push({ text: t(lang, plan.templateKey, plan.lang_params), lang, templateKey: plan.templateKey });
    }
    evidence.push(plan.evidence);
  }
  return { ok: true, segments, evidence, flags };
}

function buildClaimStagePlans(claim, sessionId) {
  return buildClaimStagePlan(sessionId, claim) || [];
}
