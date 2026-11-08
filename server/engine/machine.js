// Deterministic conversation state machine (no free-form agent).
//
// Trust rules enforced here:
//  - Identity is established ONLY by the verification service (SEC-01/SEC-02);
//    caller-ID matches are confirmation signals, never proof.
//  - OTP codes travel only through the protected keypad path; spoken digit
//    utterances during a challenge are refused and redacted (SEC-04).
//  - All claim/payment facts come from the portal adapter at answer time and
//    pass fact validation before being rendered (section 6).
//  - The machine can never mutate claims/payments; its writes are limited to
//    engine-owned operational records.
import { parseUtterance } from './intents.js';
import { t, languageName, allLanguages } from './languages.js';
import * as portal from '../adapters/portal.js';
import { createChallenge, verifyChallenge, resendChallenge, hasActiveChallenge } from '../adapters/otp.js';
import { buildClaimStagePlan, buildPaymentPlans, validateAndRender } from './answers.js';
import { raiseAlert } from '../services/alerts.js';
import { nowIso } from '../util.js';

export const STATES = [
  'greeting', 'language', 'caller_type', 'ident_confirm', 'ident_enter', 'ident_enter_confirm',
  'benef_ps', 'benef_name', 'challenge_pending', 'claims_selection', 'claim_select_confirm',
  'claim_answer', 'more_help', 'no_claims', 'transfer_pending', 'callback_offer',
  'busy_fallback', 'ending', 'ended',
];

const ALLOWED_TRANSITIONS = {
  greeting: ['language', 'busy_fallback', 'ended'],
  language: ['caller_type', 'ident_confirm', 'ident_enter', 'benef_ps', 'challenge_pending', 'busy_fallback', 'ending', 'ended'],
  caller_type: ['ident_enter', 'benef_ps', 'transfer_pending', 'ending', 'ended'],
  ident_confirm: ['challenge_pending', 'caller_type', 'ident_enter', 'transfer_pending', 'ending', 'ended'],
  ident_enter: ['ident_enter_confirm', 'ident_enter', 'transfer_pending', 'ending', 'ended'],
  ident_enter_confirm: ['challenge_pending', 'ident_enter', 'transfer_pending', 'ending', 'ended'],
  benef_ps: ['benef_name', 'challenge_pending', 'beneficiary_denied', 'transfer_pending', 'ident_benef_retry', 'ending', 'ended'],
  benef_name: ['challenge_pending', 'beneficiary_denied', 'transfer_pending', 'ending', 'ended'],
  beneficiary_denied: ['transfer_pending', 'ending', 'ended'],
  ident_benef_retry: ['benef_ps', 'transfer_pending', 'ending', 'ended'],
  challenge_pending: ['claims_selection', 'no_claims', 'transfer_pending', 'challenge_pending', 'ending', 'ended'],
  claims_selection: ['claim_select_confirm', 'claim_answer', 'more_help', 'no_claims', 'claim_cap', 'transfer_pending', 'ending', 'ended'],
  claim_select_confirm: ['claim_answer', 'claims_selection', 'transfer_pending', 'ending', 'ended'],
  claim_answer: ['more_help', 'claims_selection', 'transfer_pending', 'callback_offer', 'ending', 'ended'],
  more_help: ['claims_selection', 'ending', 'claim_cap', 'transfer_pending', 'ended'],
  no_claims: ['more_help', 'transfer_pending', 'ending', 'ended'],
  claim_cap: ['transfer_pending', 'ending', 'ended'],
  transfer_pending: ['callback_offer', 'ended'],
  callback_offer: ['ending', 'ended'],
  busy_fallback: ['callback_offer', 'ending', 'ended'],
  ending: ['ended'],
  ended: [],
};
// 'beneficiary_denied', 'ident_benef_retry', 'claim_cap' are terminal-waypoint
// states kept out of the public list for clarity; transitions map them explicitly.

export function freshCtx() {
  return {
    noticeDelivered: false,
    identity: { matched: false, channelType: 'none', psNo: null },
    claimedPsNo: null,
    callerType: null,
    confirmRetries: 0,
    enterRetries: 0,
    claims: [],
    batchIndex: 0,
    claimIntent: null,
    selectedClaimId: null,
    confirmClaimId: null,
    discussed: [],
    capReached: false,
    verification: null,
    transferRequested: false,
    transferOutcome: null,
    callbackId: null,
    recognitionFailures: 0,
    lastSegments: [],
    durationWrapped: false,
    nameCheckPending: false,
    grant: null,
    statedIntent: null,
    outcomeHint: null,
    beneficiaryAttempts: 0,
  };
}

export function loadCtx(session) {
  return { ...freshCtx(), ...JSON.parse(session.ctx || '{}') };
}

export function checkTransition(from, to) {
  const allowed = ALLOWED_TRANSITIONS[from];
  if (allowed && allowed.includes(to)) return true;
  // waypoint states have open outbound edges (documented)
  if (['beneficiary_denied', 'ident_benef_retry', 'claim_cap'].includes(from)) return true;
  return false;
}

/**
 * Handle a trusted call event for a session.
 * Returns { replies:[{text,lang}], state, ctx, patch, effects }.
 */
export function handleEvent(session, event, { policy }) {
  const ctx = loadCtx(session);
  const lang = () => session.language || 'en';
  const say = (key, params = {}, l = lang()) => [{ text: t(l, key, params), lang: l, templateKey: key }];
  const sayMany = (arr) => arr;

  const replies = [];
  const effects = [];
  let state = session.state;
  const patch = {};

  const push = (segs) => { for (const s of segs) replies.push(s); };
  const ctxSet = (fn) => fn(ctx);

  const finish = (nextState) => {
    if (nextState && nextState !== state && !checkTransition(state, nextState)) {
      // Unknown/out-of-order transitions are made safe: log and stay.
      effects.push({ type: 'anomaly', detail: `unsafe transition ${state} -> ${nextState}` });
      nextState = state;
    }
    ctx.lastSegments = replies.slice(-6);
    return { replies, state: nextState, ctx, patch, effects };
  };

  // ---------------- global events ----------------
  if (event.type === 'hangup') {
    const expected = !!event.expected || ctx.hangupExpected;
    state = 'ended';
    let outcome;
    if (ctx.outcomeHint === 'verification_failed') outcome = 'verification_failed';
    else if (ctx.transferOutcome === 'connected' || ctx.transferRequested) outcome = 'escalated';
    else if (expected) outcome = 'resolved';
    else outcome = 'abandoned'; // FR-52: unexpected hang-up => abandoned + post-call processing
    patch.outcome = outcome;
    patch.ended_at = nowIso();
    effects.push({ type: 'finalize' });
    return finish('ended');
  }

  if (event.type === 'transfer.result') {
    ctx.transferOutcome = event.connected ? 'connected' : 'failed';
    if (event.connected) {
      patch.outcome = 'escalated';
      patch.ended_at = nowIso();
      effects.push({ type: 'finalize' });
      return finish('ended');
    }
    // FR-53: state configured hours and offer a callback.
    const hours = describeHours(policy.helpdesk_hours);
    push(say('transfer_fail', { hours }));
    return finish('callback_offer');
  }

  if (event.type === 'call.started') {
    if (event.callerNumberType) ctx.callerNumberType = event.callerNumberType;
    // FR-51/BDD-32: capacity/busy fallback.
    if (event.busy) {
      push(say('busy_fallback', {}));
      return finish('busy_fallback');
    }
    ctx.identity = event.identity || ctx.identity;
    push(say('greeting'));
    push(say('recording_notice', { recording_state: policy.recordings_enabled ? 'on' : 'off' }));
    push(say('language_offer', { language: 'English' }));
    return finish('language');
  }

  if (state === 'ended') {
    // Unknown/out-of-order: safe no-op.
    effects.push({ type: 'anomaly', detail: `event ${event.type} on ended session` });
    return finish('ended');
  }

  // NFR-13: configurable maximum call duration with polite wrap-up.
  const elapsedMin = (Date.now() - new Date(session.started_at).getTime()) / 60000;
  if (!ctx.durationWrapped && elapsedMin > policy.max_call_minutes && session.state !== 'transfer_pending') {
    ctx.durationWrapped = true;
    push(say('call_duration_wrap', {}));
    return finish('callback_offer');
  }

  // ---------------- utterance & keypad events ----------------
  let p = null;
  if (event.type === 'utterance') {
    p = parseUtterance(event.text);

    // FR-20: language switch on request (any state).
    if (p.switchLang && allLanguages().includes(p.switchLang) && p.switchLang !== session.language) {
      session.language = p.switchLang;
      patch.language = p.switchLang;
      push(say('language_switch_ack', { language: languageName(p.switchLang) }, p.switchLang));
      // continue processing the remainder of the utterance in the new language
    }
    // FR-23: repeat & slower controls.
    if (p.intents.repeat && ctx.lastSegments.length) {
      push(say('repeat_ack'));
      push(ctx.lastSegments);
      return finish(state);
    }
    if (p.intents.slower) {
      push(say('slow_ack'));
      push(ctx.lastSegments);
      return finish(state);
    }
    // FR-25: human handoff on request or distress.
    if (p.intents.human || p.intents.distress) {
      push(say('human_transfer'));
      ctx.transferRequested = true;
      effects.push({ type: 'transfer' });
      return finish('transfer_pending');
    }
    if (p.intents.stop) {
      push(say('final_goodbye'));
      patch.outcome = patch.outcome || 'resolved';
      ctx.hangupExpected = true;
      effects.push({ type: 'finalize' });
      return finish('ending');
    }
    // FR-24/FR-26: out-of-scope mutation requests are refused with the scope
    // explanation and the portal route; no promises, no mutations.
    if (p.intents.mutation && !p.intents.dispute) {
      push(say('scope_explain'));
      if (ctx.verification) {
        push(say('more_help'));
        return finish(state === 'claims_selection' || state === 'claim_answer' ? 'more_help' : state);
      }
      return finish(state);
    }
    // FR-43/BDD-25: amount/payment dispute => immediate handoff, no debate.
    if (p.intents.dispute && ctx.verification && (ctx.selectedClaimId || ctx.discussed.length > 0)) {
      push(say('amount_dispute_handoff'));
      ctx.transferRequested = true;
      effects.push({ type: 'transfer' });
      effects.push({ type: 'alert', alertType: 'payment_dispute', claimId: ctx.selectedClaimId || ctx.discussed[ctx.discussed.length - 1]?.claimId, stage: 'PMS Processor', detail: 'caller disputed amount/payment on call' });
      return finish('transfer_pending');
    }
  }

  // ---------------- state dispatch ----------------
  switch (state) {
    case 'language': {
      if (event.type === 'keypad') {
        if (event.digits === '1') { session.language = 'en'; patch.language = 'en'; }
        else if (event.digits === '2') { session.language = 'hi'; patch.language = 'hi'; }
      } else if (event.type === 'utterance') {
        if (!p.switchLang && p.lang && allLanguages().includes(p.lang)) {
          session.language = p.lang;
          patch.language = p.lang;
        }
        if (p.isUnclear) {
          // FR-50: offer spoken language choices when unclear after the first sentence.
          push(say('unclear_retry'));
          ctx.recognitionFailures += 1;
          if (ctx.recognitionFailures >= 2 && policy.human_handoff.on_two_recognition_failures) {
            return humanHandoff(ctx, effects, say, 'language');
          }
          return finish('language');
        }
      }
      ctx.statedIntent = p?.intents?.payment ? 'payment' : p?.intents?.status ? 'status' : ctx.statedIntent;
      return routeIdentification(session, ctx, patch, policy, { say, push, effects, replies, utterance: p });
    }

    case 'caller_type': {
      if (event.type === 'utterance') {
        if (p.callerRole === 'employee' || (p.yes && !p.no && ctx.confirmRetries > 0)) {
          ctx.callerType = 'employee';
          patch.caller_type = 'employee';
          push(say('ask_enter_ps'));
          return finish('ident_enter');
        }
        if (p.callerRole === 'beneficiary') {
          ctx.callerType = 'beneficiary';
          patch.caller_type = 'beneficiary';
          push(say('beneficiary_intro'));
          return finish('benef_ps');
        }
        if (p.isUnclear) {
          ctx.recognitionFailures += 1;
          if (ctx.recognitionFailures >= 2 && policy.human_handoff.on_two_recognition_failures) return humanHandoff(ctx, effects, say, 'caller_type');
          push(say('unclear_retry'));
          push(say('ask_employee_or_beneficiary'));
          return finish('caller_type');
        }
        // default ambiguous affirmative -> employee
        ctx.callerType = 'employee';
        patch.caller_type = 'employee';
        push(say('ask_enter_ps'));
        return finish('ident_enter');
      }
      if (event.type === 'keypad') {
        // keypad digits here mean the employee path with direct PS entry (FR-49)
        ctx.callerType = 'employee';
        patch.caller_type = 'employee';
        return handlePsEntry(event.digits, { session, ctx, patch, policy, say, push, effects, replies });
      }
      return finish(state);
    }

    case 'ident_confirm': {
      // Linked-number masked candidate confirmation (FR-02, SEC-01).
      if (event.type === 'utterance') {
        if (p.yes && !p.no) {
          ctx.claimedPsNo = ctx.identity.psNo;
          patch.claimed_ps_no = ctx.identity.psNo;
          ctx.callerType = 'employee';
          patch.caller_type = 'employee';
          return sendChallenge(session, ctx, patch, policy, { say, push, effects, replies }, 'employee');
        }
        if (p.no) {
          ctx.confirmRetries += 1;
          if (ctx.confirmRetries === 1) {
            push(say('confirm_number_retry', { ending: psEnding(ctx.identity.psNo) }));
            return finish('ident_confirm');
          }
          // one rejection retry allowed, then ask employee vs beneficiary (FR-02)
          push(say('ask_employee_or_beneficiary'));
          return finish('caller_type');
        }
        if (p.isUnclear) {
          ctx.recognitionFailures += 1;
          if (ctx.recognitionFailures >= 2 && policy.human_handoff.on_two_recognition_failures) return humanHandoff(ctx, effects, say, 'ident_confirm');
          push(say('unclear_retry'));
          push(say('confirm_number_linked', { ending: psEnding(ctx.identity.psNo) }));
          return finish('ident_confirm');
        }
      }
      if (event.type === 'keypad') {
        // caller may enter the PS to disambiguate
        return handlePsEntry(event.digits, { session, ctx, patch, policy, say, push, effects, replies });
      }
      return finish(state);
    }

    case 'ident_enter': {
      if (event.type === 'keypad') return handlePsEntry(event.digits, { session, ctx, patch, policy, say, push, effects, replies });
      if (event.type === 'utterance') {
        const digits = p.digitGroups.filter((d) => d.length >= 4 && d.length <= 10);
        if (digits.length) return handlePsEntry(digits[digits.length - 1], { session, ctx, patch, policy, say, push, effects, replies });
        if (p.yes || p.no) return finish(state);
        ctx.recognitionFailures += 1;
        if (ctx.recognitionFailures >= 2 && policy.human_handoff.on_two_recognition_failures) return humanHandoff(ctx, effects, say, 'ident_enter');
        push(say('unclear_retry'));
        push(say('ask_enter_ps'));
        return finish('ident_enter');
      }
      return finish(state);
    }

    case 'ident_enter_confirm': {
      if (event.type === 'utterance' || event.type === 'keypad') {
        const yes = event.type === 'keypad' ? event.digits === '1' : (p.yes && !p.no);
        const no = event.type === 'keypad' ? event.digits === '2' : (p.no && !p.yes);
        if (yes) {
          return sendChallenge(session, ctx, patch, policy, { say, push, effects, replies }, 'employee');
        }
        if (no) {
          push(say('ask_enter_ps'));
          return finish('ident_enter');
        }
      }
      return finish(state);
    }

    case 'benef_ps': {
      // UC-03: capture and confirm the employee PS No. digit by digit (FR-55).
      const digits = event.type === 'keypad' ? event.digits : event.type === 'utterance' ? (p.digitGroups.filter((d) => d.length >= 4 && d.length <= 10)[0] ?? null) : null;
      if (digits) {
        const emp = portal.findEmployee(digits);
        if (!emp) {
          // FR-56/BDD-38: generic cannot-verify response; no enumeration of profiles.
          ctx.beneficiaryAttempts += 1;
          if (ctx.beneficiaryAttempts >= 2) {
            push(say('beneficiary_no_grant'));
            return finish('beneficiary_denied');
          }
          push(say('beneficiary_lookup_fail'));
          return finish('ident_benef_retry');
        }
        // SEC-03: trusted beneficiary binding + explicit grant required.
        const grant = session.caller_number ? portal.findTrustedGrant(digits, session.caller_number) : null;
        const usable = portal.grantIsUsable(grant);
        if (!usable.ok) {
          // Existence of a beneficiary, a known name/relationship, or an OTP to the
          // calling number can NOT unlock the employee's claims (SEC-03).
          effects.push({ type: 'alert', alertType: 'beneficiary_denied', claimId: null, stage: 'PMS Processor', detail: `beneficiary verification failed closed (${usable.reason})` });
          push(say('beneficiary_no_grant'));
          ctx.outcomeHint = 'verification_failed';
          return finish('beneficiary_denied');
        }
        ctx.grant = {
          bindingId: grant.binding_id,
          permittedClaimIds: JSON.parse(grant.permitted_claim_ids),
          permittedFields: JSON.parse(grant.permitted_fields),
          beneficiaryName: grant.beneficiary_name,
          smsCapable: !!grant.beneficiary_sms_capable,
        };
        patch.caller_type = 'beneficiary';
        ctx.callerType = 'beneficiary';
        ctx.claimedPsNo = digits;
        patch.claimed_ps_no = digits;
        // FR-59: hidden/landline/SMS-incapable calling number => no SMS attempt.
        if (session.caller_number_type === 'hidden' || !ctx.grant.smsCapable) {
          push(say('beneficiary_no_grant'));
          return finish('beneficiary_denied');
        }
        if (policy.identity.beneficiary_name_compare) {
          ctx.nameCheckPending = true;
          push(say('name_ask'));
          return finish('benef_name');
        }
        return sendChallenge(session, ctx, patch, policy, { say, push, effects, replies }, 'beneficiary');
      }
      if (event.type === 'utterance' && p.callerRole === 'employee') {
        // employee fallback
        ctx.callerType = 'employee';
        patch.caller_type = 'employee';
        push(say('ask_enter_ps'));
        return finish('ident_enter');
      }
      ctx.recognitionFailures += 1;
      if (ctx.recognitionFailures >= 2 && policy.human_handoff.on_two_recognition_failures) return humanHandoff(ctx, effects, say, 'benef_ps');
      push(say('unclear_retry'));
      push(say('beneficiary_intro'));
      return finish('benef_ps');
    }

    case 'benef_name': {
      // FR-60: optional name/relationship comparison; never reveals listed names.
      if (event.type === 'utterance') {
        const said = event.text.trim().toLowerCase();
        const expected = (ctx.grant?.beneficiaryName || '').toLowerCase();
        const nameMatch = expected && (said === expected || said.includes(expected.split(/\s+/)[0]));
        if (!nameMatch) {
          effects.push({ type: 'alert', alertType: 'beneficiary_denied', claimId: null, stage: 'PMS Processor', detail: 'beneficiary name comparison failed' });
          push(say('name_mismatch'));
          ctx.outcomeHint = 'verification_failed';
          return finish('beneficiary_denied');
        }
        // Name match alone is never authentication; challenge still required.
        return sendChallenge(session, ctx, patch, policy, { say, push, effects, replies }, 'beneficiary');
      }
      return finish(state);
    }

    case 'challenge_pending': {
      if (event.type === 'keypad') {
        if (event.digits === '*') {
          return resendCode(session, ctx, patch, policy, { say, push, effects, replies });
        }
        // FR-49: protected keypad entry; payload never persisted with the transcript.
        const code = String(event.digits || '').replace(/\D/g, '');
        if (!code) return finish(state);
        const subjectRole = ctx.callerType === 'beneficiary' ? 'beneficiary' : 'employee';
        const result = verifyChallenge({ subjectPsNo: ctx.claimedPsNo, subjectRole, code });
        effects.push({ type: 'verification_attempt', result: result.result, subjectRole, subjectPsNo: ctx.claimedPsNo, attemptsUsed: policy.otp.max_attempts - result.attemptsLeft });
        if (result.result === 'success') {
          ctx.verification = {
            subjectPsNo: ctx.claimedPsNo,
            subjectRole,
            method: 'otp',
            assurance: 'otp_registered_channel',
            verifiedAt: nowIso(),
            grant: ctx.grant,
          };
          patch.verified_ps_no = ctx.claimedPsNo;
          patch.verification_method = 'otp';
          patch.verification_assurance = 'otp_registered_channel';
          patch.verified_at = ctx.verification.verifiedAt;
          patch.verification_result = 'success';
          push(say('verification_success'));
          return loadClaims(session, ctx, patch, policy, { say, push, effects, replies });
        }
        if (result.result === 'expired') {
          return resendCode(session, ctx, patch, policy, { say, push, effects, replies }, 'otp_expired');
        }
        if (result.result === 'locked') {
          // FR-58/BDD-39: attempts exceeded -> human/recovery path. FR-04: transfer on failed verification.
          patch.verification_result = 'locked';
          ctx.outcomeHint = 'verification_failed';
          push(say('otp_locked'));
          ctx.transferRequested = true;
          effects.push({ type: 'transfer' });
          return finish('transfer_pending');
        }
        patch.verification_result = 'failed';
        push(say('otp_wrong', { attempts: result.attemptsLeft }));
        return finish('challenge_pending');
      }
      if (event.type === 'utterance') {
        // SEC-04: OTPs must never ride the ASR/LLM path. Refuse; redact the digits.
        if (/\d{4,}/.test(event.text)) {
          push(say('otp_sent', { ending: '' }).map((s) => ({ ...s, text: 'For your security, please enter the code using your phone keypad. I cannot accept a spoken code.' })));
          return finish('challenge_pending');
        }
        if (p.intents.resend) return resendCode(session, ctx, patch, policy, { say, push, effects, replies });
        if (p.intents.human || p.intents.distress) {
          push(say('human_transfer'));
          ctx.transferRequested = true;
          effects.push({ type: 'transfer' });
          return finish('transfer_pending');
        }
        ctx.recognitionFailures += 1;
        if (ctx.recognitionFailures >= 2 && policy.human_handoff.on_two_recognition_failures) return humanHandoff(ctx, effects, say, 'challenge_pending');
        push(say('unclear_retry'));
        return finish('challenge_pending');
      }
      return finish(state);
    }

    case 'claims_selection': {
      if (event.type === 'keypad') {
        const n = Number(event.digits);
        if (Number.isInteger(n) && n >= 1) return selectClaimByOrdinal(n, session, ctx, patch, policy, { say, push, effects, replies });
      }
      if (event.type === 'utterance') {
        // explicit claim ID (FR-22: read-back + confirm)
        if (p.claimIds.length) {
          const id = p.claimIds.find((c) => ctx.claims.some((cl) => cl.claim_id === c));
          if (id) {
            ctx.confirmClaimId = id;
            push(say('claim_select_confirm', { claim_id: id }));
            return finish('claim_select_confirm');
          }
        }
        if (p.intents.more) return narrateNextBatch(session, ctx, patch, policy, { say, push, effects, replies });
        const digits = p.digitGroups.filter((d) => d.length <= 2);
        if (digits.length && !ctx.claims.length) {
          // no claims loaded (e.g., direct payment intent before selection) -> reload
          return loadClaims(session, ctx, patch, policy, { say, push, effects, replies });
        }
        if (digits.length) return selectClaimByOrdinal(Number(digits[digits.length - 1]), session, ctx, patch, policy, { say, push, effects, replies });
        if (p.ordinals.length) return selectClaimByOrdinal(p.ordinals[p.ordinals.length - 1], session, ctx, patch, policy, { say, push, effects, replies });
        if (p.intents.payment) {
          ctx.claimIntent = 'payment';
          if (ctx.claims.length === 1) return answerClaim(session, ctx, patch, policy, { say, push, effects, replies }, ctx.claims[0].claim_id);
          if (ctx.claims.length > 1) return narrateClaims(session, ctx, patch, policy, { say, push, effects, replies });
          return loadClaims(session, ctx, patch, policy, { say, push, effects, replies });
        }
        if (p.intents.status) {
          ctx.claimIntent = 'status';
          if (ctx.claims.length === 1) return answerClaim(session, ctx, patch, policy, { say, push, effects, replies }, ctx.claims[0].claim_id);
          return narrateClaims(session, ctx, patch, policy, { say, push, effects, replies });
        }
        if (p.yes && ctx.claims.length === 1) {
          return answerClaim(session, ctx, patch, policy, { say, push, effects, replies }, ctx.claims[0].claim_id);
        }
        ctx.recognitionFailures += 1;
        if (ctx.recognitionFailures >= 2 && policy.human_handoff.on_two_recognition_failures) return humanHandoff(ctx, effects, say, 'claims_selection');
        push(say('unclear_retry'));
        return narrateClaims(session, ctx, patch, policy, { say, push, effects, replies }, { repeatList: true });
      }
      return finish(state);
    }

    case 'claim_select_confirm': {
      if (event.type === 'utterance' || event.type === 'keypad') {
        const yes = event.type === 'keypad' ? event.digits === '1' : (p.yes && !p.no);
        const no = event.type === 'keypad' ? event.digits === '2' : (p.no && !p.yes);
        if (yes && ctx.confirmClaimId) return answerClaim(session, ctx, patch, policy, { say, push, effects, replies }, ctx.confirmClaimId);
        if (no) {
          ctx.confirmClaimId = null;
          return narrateClaims(session, ctx, patch, policy, { say, push, effects, replies }, { repeatList: true });
        }
      }
      return finish(state);
    }

    case 'claim_answer': {
      if (event.type === 'utterance') {
        if (p.intents.payment && ctx.selectedClaimId) {
          return answerClaim(session, ctx, patch, policy, { say, push, effects, replies }, ctx.selectedClaimId, { intent: 'payment' });
        }
        if (p.intents.more || (p.yes && !p.no)) return afterAnswer(session, ctx, patch, policy, { say, push, effects, replies });
        if (p.no && !p.yes) {
          push(say('final_goodbye'));
          patch.outcome = patch.outcome || 'resolved';
          ctx.hangupExpected = true;
          effects.push({ type: 'finalize' });
          return finish('ending');
        }
      }
      return afterAnswer(session, ctx, patch, policy, { say, push, effects, replies });
    }

    case 'more_help': {
      if (event.type === 'utterance') {
        if (p.no && !p.yes) {
          push(say('final_goodbye'));
          patch.outcome = patch.outcome || 'resolved';
          ctx.hangupExpected = true;
          effects.push({ type: 'finalize' });
          return finish('ending');
        }
        if (p.yes || p.intents.more || p.intents.status || p.intents.payment || p.claimIds.length || p.ordinals.length || p.digitGroups.length) {
          // FR-13/BDD-11: another claim restarts claim selection.
          return enterSelection(session, ctx, patch, policy, { say, push, effects, replies }, { keepClaims: true });
        }
      }
      if (event.type === 'keypad') {
        const n = Number(event.digits);
        if (Number.isInteger(n) && n >= 1) return selectClaimByOrdinal(n, session, ctx, patch, policy, { say, push, effects, replies });
      }
      ctx.recognitionFailures += 1;
      if (ctx.recognitionFailures >= 2 && policy.human_handoff.on_two_recognition_failures) return humanHandoff(ctx, effects, say, 'more_help');
      push(say('unclear_retry'));
      push(say('more_help'));
      return finish('more_help');
    }

    case 'no_claims': {
      // FR-07: explain after verification and offer human help.
      if (event.type === 'utterance') {
        if (p.intents.human) {
          push(say('human_transfer'));
          ctx.transferRequested = true;
          effects.push({ type: 'transfer' });
          return finish('transfer_pending');
        }
        if (p.yes && !p.no) {
          push(say('human_transfer'));
          ctx.transferRequested = true;
          effects.push({ type: 'transfer' });
          return finish('transfer_pending');
        }
        if (p.no && !p.yes) {
          push(say('final_goodbye'));
          patch.outcome = patch.outcome || 'resolved';
          ctx.hangupExpected = true;
          effects.push({ type: 'finalize' });
          return finish('ending');
        }
      }
      push(say('more_help'));
      return finish('no_claims');
    }

    case 'claim_cap': {
      // FR-14: cap reached -> wrap up or offer a human.
      if (event.type === 'utterance') {
        if (p.yes || p.intents.human) {
          push(say('human_transfer'));
          ctx.transferRequested = true;
          effects.push({ type: 'transfer' });
          return finish('transfer_pending');
        }
        if (p.no && !p.yes) {
          push(say('final_goodbye'));
          patch.outcome = patch.outcome || 'resolved';
          ctx.hangupExpected = true;
          effects.push({ type: 'finalize' });
          return finish('ending');
        }
      }
      push(say('more_help'));
      return finish('claim_cap');
    }

    case 'transfer_pending':
      return finish(state);

    case 'callback_offer': {
      if (event.type === 'utterance') {
        if (p.intents.callback || p.yes) {
          effects.push({ type: 'callback_create' });
          return finish(state); // callback id provided via effect result by the service
        }
        if (p.no && !p.yes) {
          push(say('final_goodbye'));
          patch.outcome = patch.outcome || (ctx.verification ? 'resolved' : (ctx.outcomeHint || 'abandoned'));
          ctx.hangupExpected = true;
          effects.push({ type: 'finalize' });
          return finish('ending');
        }
      }
      if (event.type === 'keypad' && event.digits === '1') {
        effects.push({ type: 'callback_create' });
        return finish(state);
      }
      return finish(state);
    }

    case 'busy_fallback': {
      // FR-51: configured human support, callback request or portal route.
      if (event.type === 'utterance') {
        if (p.intents.callback || p.yes) {
          effects.push({ type: 'callback_create' });
          return finish(state);
        }
        if (p.intents.human) {
          push(say('human_transfer'));
          ctx.transferRequested = true;
          effects.push({ type: 'transfer' });
          return finish('transfer_pending');
        }
      }
      if (event.type === 'keypad' && event.digits === '1') {
        effects.push({ type: 'callback_create' });
        return finish(state);
      }
      return finish(state);
    }

    case 'ending':
      return finish(state);

    default:
      effects.push({ type: 'anomaly', detail: `unhandled state ${state}` });
      return finish(state);
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function psEnding(ps) { return String(ps ?? '').slice(-4); }

function describeHours(h) {
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const dayList = (h.days || []).map((d) => days[d]).join(', ');
  return `${dayList || 'Weekdays'} ${h.start} to ${h.end} IST`;
}

function humanHandoff(ctx, effects, say, from) {
  say('human_transfer');
  ctx.transferRequested = true;
  effects.push({ type: 'transfer' });
  return { replies: [{ text: t('en', 'human_transfer'), lang: 'en', templateKey: 'human_transfer' }], state: 'transfer_pending', ctx, patch: {}, effects };
}

function routeIdentification(session, ctx, patch, policy, io) {
  const { say, push, replies } = io;
  const id = ctx.identity;
  // A stated caller role in the same breath skips the role question (FR-54 honoured, no re-ask).
  const statedRole = io.utterance?.callerRole;
  if (statedRole === 'beneficiary' && !id.matched) {
    ctx.callerType = 'beneficiary';
    patch.caller_type = 'beneficiary';
    push(say('beneficiary_intro'));
    return { replies, state: 'benef_ps', ctx, patch, effects: io.effects };
  }
  if (statedRole === 'employee' && !id.matched) {
    ctx.callerType = 'employee';
    patch.caller_type = 'employee';
    push(say('ask_enter_ps'));
    return { replies, state: 'ident_enter', ctx, patch, effects: io.effects };
  }
  if (id.matched && id.channelType === 'sms_capable') {
    // FR-01: candidate resolution through the identity adapter.
    push(say('confirm_number_linked', { ending: psEnding(id.psNo) }));
    return finishState('ident_confirm');
  }
  if (!policy.identity.allow_unlinked_fallback) {
    // FR-04/BDD-03: transfer when unlinked fallback is disabled/unavailable.
    io.push(say('human_transfer'));
    ctx.transferRequested = true;
    io.effects.push({ type: 'transfer' });
    return finishState('transfer_pending');
  }
  // FR-54/BDD-36: employee versus listed beneficiary.
  push(say('ask_employee_or_beneficiary'));
  return finishState('caller_type');

  function finishState(s) { return { replies: io.replies, state: s, ctx, patch, effects: io.effects }; }
}

function handlePsEntry(digits, { session, ctx, patch, policy, say, push, effects, replies }) {
  const clean = String(digits || '').replace(/\D/g, '');
  if (!clean || clean.length < 4) {
    push(say('unclear_retry'));
    push(say('ask_enter_ps'));
    return { replies: replies, state: 'ident_enter', ctx, patch, effects };
  }
  const emp = portal.findEmployee(clean);
  if (!emp) {
    ctx.enterRetries += 1;
    if (ctx.enterRetries >= 2) {
      // generic response; no enumeration (FR-56 principle)
      push(say('human_transfer'));
      ctx.transferRequested = true;
      effects.push({ type: 'transfer' });
      return { replies: replies, state: 'transfer_pending', ctx, patch, effects };
    }
    push(say('beneficiary_lookup_fail'));
    return { replies: replies, state: 'ident_enter', ctx, patch, effects };
  }
  ctx.claimedPsNo = clean;
  patch.claimed_ps_no = clean;
  patch.caller_type = 'employee';
  ctx.callerType = 'employee';
  // FR-02/FR-55: confirm digit by digit before use.
  push(say('ps_confirm_readback', { digits: clean.split('').join(' ') }));
  return { replies: replies, state: 'ident_enter_confirm', ctx, patch, effects };
}

function sendChallenge(session, ctx, patch, policy, io, role) {
  const { say, push, effects, replies } = io;
  const subjectPsNo = ctx.claimedPsNo;
  let target;
  if (role === 'beneficiary') {
    // FR-57: challenge to the beneficiary's calling number — which equals the
    // previously verified binding contact (SEC-03), checked before this state.
    target = { channel: 'sms', phone: session.caller_number, smsCapable: true };
  } else {
    // SEC-02: employee challenges go ONLY to the authoritative registered channel.
    target = portal.registeredChallengeTarget(subjectPsNo);
  }
  try {
    const ch = createChallenge({ sessionId: session.id, subjectPsNo, subjectRole: role, target, policy });
    effects.push({ type: 'otp_sent', challengeId: ch.challengeId });
    push(say('otp_sent', { ending: psEnding(ch.sentToMasked) }));
    return { replies: replies, state: 'challenge_pending', ctx, patch, effects };
  } catch (e) {
    if (e.code === 'channel_not_sms_capable') {
      // FR-59: no SMS attempt on hidden/landline numbers.
      push(say('beneficiary_no_grant'));
      ctx.outcomeHint = 'verification_failed';
      return { replies: replies, state: 'beneficiary_denied', ctx, patch, effects };
    }
    if (e.code === 'otp_rate_limited') {
      push(say('otp_locked'));
      ctx.outcomeHint = 'verification_failed';
      ctx.transferRequested = true;
      effects.push({ type: 'transfer' });
      return { replies: replies, state: 'transfer_pending', ctx, patch, effects };
    }
    // Not-configured provider in live mode: fail closed to human path.
    push(say('human_transfer'));
    ctx.transferRequested = true;
    effects.push({ type: 'transfer' });
    effects.push({ type: 'anomaly', detail: `challenge send failed: ${e.code}` });
    return { replies: replies, state: 'transfer_pending', ctx, patch, effects };
  }
}

function resendCode(session, ctx, patch, policy, io, expiredKey) {
  const { say, push, effects, replies } = io;
  const role = ctx.callerType === 'beneficiary' ? 'beneficiary' : 'employee';
  const target = role === 'beneficiary'
    ? { channel: 'sms', phone: session.caller_number, smsCapable: true }
    : portal.registeredChallengeTarget(ctx.claimedPsNo);
  try {
    const ch = resendChallenge({ sessionId: session.id, subjectPsNo: ctx.claimedPsNo, subjectRole: role, target, policy });
    effects.push({ type: 'otp_sent', challengeId: ch.challengeId, resent: true });
    if (expiredKey) push(say(expiredKey));
    push(say('otp_sent', { ending: psEnding(ch.sentToMasked) }));
    return { replies: replies, state: 'challenge_pending', ctx, patch, effects };
  } catch (e) {
    if (e.code === 'resend_limit_reached' || e.code === 'otp_rate_limited') {
      // FR-58: human/recovery path on limit.
      push(say('otp_locked'));
      ctx.outcomeHint = 'verification_failed';
      ctx.transferRequested = true;
      effects.push({ type: 'transfer' });
      return { replies: replies, state: 'transfer_pending', ctx, patch, effects };
    }
    throw e;
  }
}

/** FR-06: fetch open claims live at the beginning of the status flow. */
function loadClaims(session, ctx, patch, policy, io) {
  const { say, push, effects, replies } = io;
  let claims;
  try {
    claims = portal.listOpenClaims(ctx.verification.subjectPsNo, { scope: policy.open_claims_scope || 'processing_and_approved' });
  } catch (e) {
    // BDD-21: portal failure -> truthful explanation + human/callback + failure log.
    push(say('portal_unavailable'));
    ctx.transferRequested = true;
    effects.push({ type: 'transfer' });
    effects.push({ type: 'alert', alertType: 'portal_failure', claimId: null, stage: 'PMS Processor', detail: `claims fetch failed: ${e.code}` });
    return { replies: replies, state: 'transfer_pending', ctx, patch, effects };
  }
  if (ctx.verification.subjectRole === 'beneficiary') {
    // FR-61/SEC-03: least-privilege — only grant-permitted claims, never all employee claims.
    const allowed = new Set(ctx.grant?.permittedClaimIds || []);
    claims = claims.filter((c) => allowed.has(c.claim_id));
  }
  ctx.claims = claims;
  if (!claims.length) {
    push(say('claims_zero'));
    return { replies: replies, state: 'no_claims', ctx, patch, effects };
  }
  if (claims.length === 1) {
    push(say('claims_one_confirm', { claim_id: claims[0].claim_id, scheme: claims[0].scheme_label }));
    return { replies: replies, state: 'claims_selection', ctx, patch, effects };
  }
  return narrateClaims(session, ctx, patch, policy, io);
}

function narrateClaims(session, ctx, patch, policy, io, opts = {}) {
  const { say, push, replies } = io;
  const batch = policy.claims_narrate_batch || 3;
  const start = ctx.batchIndex * batch;
  if (start >= ctx.claims.length) {
    ctx.batchIndex = 0;
    return narrateClaims(session, ctx, patch, policy, io, { ...opts, restart: true });
  }
  if (ctx.claims.length === 1 && !opts.repeatList) {
    push(say('claims_one_confirm', { claim_id: ctx.claims[0].claim_id, scheme: ctx.claims[0].scheme_label }));
    return { replies, state: 'claims_selection', ctx, patch, effects: io.effects };
  }
  const slice = ctx.claims.slice(start, start + batch);
  const list = slice.map((c, i) => `${start + i + 1}) ${c.claim_id} (${c.scheme_label})`).join(', ');
  if (start === 0 && !opts.repeatList) {
    // FR-08: narrate the latest three IDs, newest first.
    push(say('claims_many_intro', { count: ctx.claims.length, list }));
  } else {
    // FR-09: remaining open claims in bounded batches until selection or exit.
    push(say('claims_remaining', { list }));
  }
  return { replies: replies, state: 'claims_selection', ctx, patch, effects: io.effects };
}

function narrateNextBatch(session, ctx, patch, policy, io) {
  const batch = policy.claims_narrate_batch || 3;
  if ((ctx.batchIndex + 1) * batch < ctx.claims.length) ctx.batchIndex += 1;
  else ctx.batchIndex = 0;
  return narrateClaims(session, ctx, patch, policy, io, { repeatList: ctx.batchIndex === 0 });
}

function selectClaimByOrdinal(n, session, ctx, patch, policy, io) {
  const { say, push } = io;
  const claim = ctx.claims[n - 1];
  if (!claim) {
    push(say('claims_remaining', { list: ctx.claims.map((c, i) => `${i + 1}) ${c.claim_id}`).join(', ') }));
    return { replies: io.replies, state: 'claims_selection', ctx, patch, effects: io.effects };
  }
  // FR-22: read back a caller-supplied claim ID digit by digit and confirm before use.
  push(say('claim_select_confirm', { claim_id: claim.claim_id }));
  ctx.confirmClaimId = claim.claim_id;
  return { replies: io.replies, state: 'claim_select_confirm', ctx, patch, effects: io.effects };
}

function enterSelection(session, ctx, patch, policy, io, opts = {}) {
  const { say, push, replies } = io;
  if (!opts.keepClaims || !ctx.claims.length) {
    return loadClaims(session, ctx, patch, policy, io);
  }
  ctx.batchIndex = 0;
  return narrateClaims(session, ctx, patch, policy, io);
}

/**
 * Answer a selected claim (UC-01/UC-02): fetch live permitted data, build
 * validated plans, render. Records discussion + evidence via effects.
 */
function answerClaim(session, ctx, patch, policy, io, claimId, opts = {}) {
  const { say, push, effects, replies } = io;
  // FR-14: configurable claims-per-call limit, enforced at every answer.
  if (ctx.discussed.length >= policy.claims_per_call_limit) {
    ctx.capReached = true;
    push(say('claim_cap_reached', { count: policy.claims_per_call_limit }));
    return { replies: replies, state: 'claim_cap', ctx, patch, effects };
  }
  const claim = ctx.claims.find((c) => c.claim_id === claimId) || null;
  if (!claim) {
    push(say('general_failure'));
    return { replies: replies, state: 'more_help', ctx, patch, effects };
  }
  ctx.selectedClaimId = claimId;
  ctx.claimIntent = opts.intent || ctx.claimIntent || (claim.status === 'Approved' ? 'payment' : 'status');

  const fieldFilter = ctx.verification?.subjectRole === 'beneficiary' ? ctx.grant?.permittedFields : null;

  try {
    let plans;
    if (ctx.claimIntent === 'payment') {
      const payment = portal.getFinancePayment(claimId); // throws on finance outage (FR-42)
      plans = buildPaymentPlans(session.id, claim, payment, {
        mapping: policy.payment_status_mapping,
        delayThresholdDays: policy.payment_delay_threshold_days,
        fieldFilter,
      });
      // FR-41: a non-approved claim gets its STAGE/QUERY answer too, plus the
      // explicit "no payment information" sentence — never payment facts.
      if (claim.status !== 'Approved') {
        const stagePlans = buildClaimStagePlan(session.id, claim) || [];
        plans = [...stagePlans, ...plans];
      }
    } else {
      plans = buildClaimStagePlan(session.id, claim);
      if (!plans) plans = buildPaymentPlans(session.id, claim, null, { mapping: policy.payment_status_mapping, fieldFilter });
    }
    const rendered = validateAndRender(session.id, claimId, plans, { lang: session.language || 'en', policy, fieldFilter });
    if (!rendered.ok) {
      // Blocked before any audio: safe fallback with no invented facts.
      effects.push({ type: 'anomaly', detail: `fact validation blocked (${rendered.reason}) for ${claimId}` });
      push(say('general_failure'));
      return { replies: replies, state: 'more_help', ctx, patch, effects };
    }
    for (const seg of rendered.segments) push([seg]);
    for (const ev of rendered.evidence) effects.push({ type: 'evidence', evidence: ev });
    if (rendered.flags.delayed) {
      effects.push({ type: 'alert', alertType: 'payment_delayed', claimId, stage: claim.stage || 'Approval', detail: 'payment delayed beyond configured (demo) threshold' });
    }
    const group = rendered.segments.map((s) => s.templateKey).join(',');
    if (group.includes('pay_failed') || group.includes('pay_held')) {
      // FR-18: alert the responsible processor (FR-30 routing).
      effects.push({ type: 'alert', alertType: group.includes('pay_failed') ? 'payment_failed' : 'payment_held', claimId, stage: 'PMS Processor', detail: 'caller informed of failed/held payment' });
      effects.push({ type: 'escalation_offer' });
    }
    effects.push({ type: 'claim_discussed', claimId, topics: rendered.segments.map((s) => s.templateKey) });
    ctx.discussed = [...ctx.discussed, { claimId, topics: rendered.segments.map((s) => s.templateKey) }]; // FR-14 cap accounting
    // FR-13: ask whether more help is needed.
    push(say('more_help'));
    return { replies: replies, state: 'more_help', ctx, patch, effects };
  } catch (e) {
    if (e.code === 'finance_unavailable') {
      // FR-42/BDD-24: truthful explanation, human/callback option, failure log; no cached answer.
      push(say('finance_unavailable'));
      effects.push({ type: 'alert', alertType: 'finance_failure', claimId, stage: 'Approval', detail: 'Finance data unavailable during call' });
      push(say('callback_offer'));
      return { replies: replies, state: 'callback_offer', ctx, patch, effects };
    }
    if (e.code === 'portal_unavailable') {
      push(say('portal_unavailable'));
      ctx.transferRequested = true;
      effects.push({ type: 'transfer' });
      effects.push({ type: 'alert', alertType: 'portal_failure', claimId, stage: 'PMS Processor', detail: 'claim detail fetch failed' });
      return { replies: replies, state: 'transfer_pending', ctx, patch, effects };
    }
    throw e;
  }
}

function afterAnswer(session, ctx, patch, policy, io) {
  const { say, push, replies } = io;
  // FR-14: configurable claims-per-call limit.
  if (ctx.discussed.length + 1 > policy.claims_per_call_limit || (ctx.discussed.length >= policy.claims_per_call_limit)) {
    ctx.capReached = true;
    push(say('claim_cap_reached', { count: policy.claims_per_call_limit }));
    return { replies: replies, state: 'claim_cap', ctx, patch, effects: io.effects };
  }
  push(say('more_help'));
  return { replies: replies, state: 'more_help', ctx, patch, effects: io.effects };
}
