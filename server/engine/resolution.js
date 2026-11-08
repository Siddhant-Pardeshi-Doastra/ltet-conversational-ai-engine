// Exhaustive reimbursement-resolution search — the agent's problem-solving brain.
//
// Given a verified caller and a reimbursement issue, the agent walks EVERY
// resolvable path against LIVE portal data, in order of resolution preference,
// and only speaks a path that passes fact validation. A human transfer happens
// only when no path resolves the issue (or the data service is down) — and the
// transfer carries a full brief so the client never repeats themselves.
//
// Resolution strategies (first match wins):
//   1 credited-inform        — payment already credited: give authoritative facts
//   2 delayed-escalate       — processed/pending beyond threshold: explain + escalation offer
//   3 failed-held-explain    — recorded failure/hold reason: explain + escalation offer
//   4 pending-timeline       — pending within threshold: approval + owner, no invented date
//   5 query-guidance         — open processor query: read it, direct to portal
//   6 stage-explain          — processing stage: what it means, generic next step
//   7 no-claims-inform       — nothing on record: say so + human offer
//   8 amount-dispute         — handled by the machine (FR-43: immediate handoff, no debate)
//
// "documents" requests are served by query-guidance or stage-explain + portal route.

import * as portal from '../adapters/portal.js';
import { buildClaimStagePlan, buildPaymentPlans, validateAndRender, fmtDate } from './answers.js';
import { t } from './languages.js';
import { formatInr } from '../util.js';

function seg(text, lang, templateKey) {
  return { text, lang, templateKey };
}

/**
 * Run the exhaustive search. Returns:
 *  { outcome: 'resolved'|'escalation_offered'|'needs_claim_selection'|'cannot',
 *    claimId?, segments, evidence, effects, attempted, transferReason? }
 */
export function runResolutionSearch({ sessionId, ctx, claimId, policy, lang = 'en', understanding, fieldFilter = null }) {
  const attempted = [];
  const psNo = ctx.verification?.subjectPsNo;

  // --- locate the claim (single claim auto-selects; multiple need a pick) ---
  let claim = null;
  try {
    if (claimId) claim = portal.getClaimSummary(claimId);
    else {
      const open = portal.listOpenClaims(psNo, { scope: policy.open_claims_scope || 'processing_and_approved' });
      const allowed = ctx.verification?.subjectRole === 'beneficiary'
        ? open.filter((c) => (ctx.grant?.permittedClaimIds || []).includes(c.claim_id))
        : open;
      if (allowed.length === 1) claim = allowed[0];
      else if (allowed.length > 1) {
        return {
          outcome: 'needs_claim_selection',
          attempted,
          segments: [seg(t(lang, 'claims_many_intro', {
            count: allowed.length,
            list: allowed.slice(0, policy.claims_narrate_batch || 3).map((c, i) => `${i + 1}) ${c.claim_id} (${c.scheme_label})`).join(', '),
          }), lang, 'claims_many_intro')],
          effects: [],
          claims: allowed,
        };
      }
    }
  } catch (e) {
    attempted.push('claim-fetch');
    return { outcome: 'cannot', attempted, transferReason: `data service unreachable during resolution search (${e.code || 'error'})` };
  }

  if (!claim) {
    attempted.push('claim-locate');
    // Nothing on record — informational resolution + human offer.
    return {
      outcome: 'resolved',
      attempted,
      segments: [seg(t(lang, 'claims_zero'), lang, 'claims_zero')],
      evidence: [],
      effects: [],
    };
  }

  let payment = null;
  const paymentFetchFailed = (() => {
    try { payment = portal.getFinancePayment(claim.claim_id); return false; }
    catch { attempted.push('finance-fetch'); return true; }
  })();
  if (paymentFetchFailed) {
    // FR-42 handled upstream by the machine path; here report cannot for the search.
    return { outcome: 'cannot', attempted, claimId: claim.claim_id, transferReason: 'finance service unreachable during resolution search' };
  }

  const src = { claim, payment, mapping: policy.payment_status_mapping };
  const group = payment && policy.payment_status_mapping[payment.payment_status_raw];

  // --- 1 credited-inform ---
  if (group === 'credited') {
    attempted.push('credited-inform');
    const plans = buildPaymentPlans(sessionId, claim, payment, { mapping: policy.payment_status_mapping, delayThresholdDays: policy.payment_delay_threshold_days, fieldFilter });
    const rendered = validateAndRender(sessionId, claim.claim_id, plans, { lang, policy, fieldFilter });
    if (rendered.ok) {
      const extra = understanding?.issues?.includes('payment_missing')
        ? seg(t(lang, 'agent_resolved_missing_money', { claim_id: claim.claim_id }), lang, 'agent_resolved_missing_money')
        : [];
      return {
        outcome: 'resolved', claimId: claim.claim_id, attempted,
        segments: [...rendered.segments, ...extra],
        evidence: rendered.evidence, flags: rendered.flags,
        effects: [{ type: 'claim_discussed', claimId: claim.claim_id, topics: rendered.segments.map((s) => s.templateKey) }],
      };
    }
  }

  // --- 2 delayed-escalate ---
  if (group === 'processed' || group === 'pending') {
    attempted.push(group === 'processed' ? 'delayed-escalate' : 'pending-timeline');
    const ageDays = payment.approval_date ? (Date.now() - new Date(payment.approval_date).getTime()) / 86400000 : 0;
    const delayed = ageDays > policy.payment_delay_threshold_days;
    const plans = buildPaymentPlans(sessionId, claim, payment, { mapping: policy.payment_status_mapping, delayThresholdDays: policy.payment_delay_threshold_days, fieldFilter });
    const rendered = validateAndRender(sessionId, claim.claim_id, plans, { lang, policy, fieldFilter });
    if (rendered.ok) {
      const segments = [...rendered.segments];
      if (delayed) {
        segments.push(seg(t(lang, 'agent_delay_plan', {
          claim_id: claim.claim_id,
          days: Math.floor(ageDays),
          threshold: policy.payment_delay_threshold_days,
        }), lang, 'agent_delay_plan'));
      }
      return {
        outcome: delayed ? 'escalation_offered' : 'resolved',
        claimId: claim.claim_id, attempted,
        segments,
        evidence: rendered.evidence, flags: rendered.flags,
        effects: [
          { type: 'claim_discussed', claimId: claim.claim_id, topics: rendered.segments.map((s) => s.templateKey) },
          ...(delayed ? [{ type: 'alert', alertType: 'payment_delayed', claimId: claim.claim_id, stage: 'Approval', detail: 'resolution search: delayed beyond (demo) threshold' }] : []),
        ],
      };
    }
  }

  // --- 3 failed-held-explain ---
  if (group === 'failed' || group === 'held') {
    attempted.push('failed-held-explain');
    const plans = buildPaymentPlans(sessionId, claim, payment, { mapping: policy.payment_status_mapping, delayThresholdDays: policy.payment_delay_threshold_days, fieldFilter });
    const rendered = validateAndRender(sessionId, claim.claim_id, plans, { lang, policy, fieldFilter });
    if (rendered.ok) {
      const reason = group === 'failed' ? payment.failure_reason : payment.held_reason;
      const segments = [...rendered.segments];
      if (reason) {
        segments.push(seg(t(lang, 'agent_failure_next_step', { reason }), lang, 'agent_failure_next_step'));
      }
      return {
        outcome: 'escalation_offered', claimId: claim.claim_id, attempted,
        segments,
        evidence: rendered.evidence, flags: rendered.flags,
        effects: [
          { type: 'claim_discussed', claimId: claim.claim_id, topics: rendered.segments.map((s) => s.templateKey) },
          { type: 'alert', alertType: group === 'failed' ? 'payment_failed' : 'payment_held', claimId: claim.claim_id, stage: 'PMS Processor', detail: 'resolution search: caller has an unresolved failed/held payment' },
        ],
      };
    }
  }

  // --- 5 query-guidance (also serves documents kind) ---
  if (claim.has_open_query && claim.open_query) {
    attempted.push('query-guidance');
    const stagePlans = buildClaimStagePlan(sessionId, claim) || [];
    const rendered = validateAndRender(sessionId, claim.claim_id, stagePlans, { lang, policy, fieldFilter });
    if (rendered.ok) {
      return {
        outcome: 'resolved', claimId: claim.claim_id, attempted,
        segments: rendered.segments,
        evidence: rendered.evidence, flags: rendered.flags,
        effects: [{ type: 'claim_discussed', claimId: claim.claim_id, topics: rendered.segments.map((s) => s.templateKey) }],
      };
    }
  }

  // --- 6 stage-explain ---
  if (claim.status === 'Processing' && claim.stage) {
    attempted.push('stage-explain');
    const stagePlans = buildClaimStagePlan(sessionId, claim) || [];
    const rendered = validateAndRender(sessionId, claim.claim_id, stagePlans, { lang, policy, fieldFilter });
    if (rendered.ok) {
      return {
        outcome: 'resolved', claimId: claim.claim_id, attempted,
        segments: [
          seg(t(lang, 'agent_stage_meaning', { stage: claim.stage }), lang, 'agent_stage_meaning'),
          ...rendered.segments,
        ],
        evidence: rendered.evidence, flags: rendered.flags,
        effects: [{ type: 'claim_discussed', claimId: claim.claim_id, topics: rendered.segments.map((s) => s.templateKey) }],
      };
    }
  }

  attempted.push('all-paths-exhausted');
  return {
    outcome: 'cannot',
    claimId: claim.claim_id,
    attempted,
    transferReason: 'no automated resolution path could resolve the issue with current data',
  };
}

/** Human-readable status line for a stage (factual, non-committal). */
export function stageGuidance(stage, lang = 'en') {
  const map = {
    'PMS Processor': 'the PMS Processor team reviews new claims and checks the attached documents',
    'Sub-panel Review': 'the Sub-panel reviews documents verified at the first stage',
    'Apex Panel Review': 'the Apex Panel gives the final review before approval',
    'Approval': 'the approval stage records the Finance decision and releases the payment run',
  };
  return map[stage] ? t(lang, 'agent_stage_guidance', { stage, guidance: map[stage] }) : null;
}
