// src/policy/policy.js — Hidata v20 Día 5
//
// POLICY LAYER — Integrador del pipeline decisional
//
// API pública: decidirPolicy({ leadState, perception, context })
//
// Pipeline interno:
//   1. resolveCandidatesByStage() → pool inicial por stage
//   2. applyGuardrails() → filtra pool según contexto
//   3. selectFinalAction() → decide acción final
//   4. construye policyDecision rica para turn_trace
//
// CERO BD. CERO LLM. CERO side effects.
// Pure function que recibe estado y devuelve decisión.

import {
  resolveCandidatesByStage,
  selectFinalAction,
  summarizePolicyDecision,
  POLICY_RULES_VERSION
} from './policy-rules.js'

import {
  applyGuardrails,
  summarizeGuardrails,
  getPassedGuardrails,
  getBlockingGuardrails,
  GUARDRAILS_VERSION
} from './guardrails.js'

import {
  getActionMetadata,
  ACTIONS,
  ACTION_TYPES_VERSION
} from './action-types.js'

// ════════════════════════════════════════════════════════
// API PÚBLICA — decidirPolicy()
// ════════════════════════════════════════════════════════

/**
 * Decide qué acción debe tomar el bot dado el contexto actual.
 * 
 * @param {object} params
 * @param {object} params.leadState - lead_state actualizado (post Mode Router)
 * @param {object} params.perception - Output de Perception
 * @param {object} params.context - contextFlags del builder
 * @returns {object} policyDecision rica con audit trail
 */
export function decidirPolicy({ leadState, perception, context = {} }) {
  const startTime = Date.now()

  // ─── Validaciones defensivas ───
  if (!leadState) {
    return buildErrorDecision({
      error: 'leadState_missing',
      startTime
    })
  }
  if (!perception) {
    return buildErrorDecision({
      error: 'perception_missing',
      startTime
    })
  }

  try {
    // ════════════════════════════════════════════════════════
    // PASO 1 — Generar pool de candidatos por stage
    // ════════════════════════════════════════════════════════
    const candidates = resolveCandidatesByStage(
      leadState.currentStage,
      leadState.currentMode
    )

    // ════════════════════════════════════════════════════════
    // PASO 2 — Aplicar guardrails (filtrado proactivo)
    // ════════════════════════════════════════════════════════
    const guardrailsResult = applyGuardrails({
      candidates,
      leadState,
      perception,
      context
    })

    // ════════════════════════════════════════════════════════
    // PASO 3 — Seleccionar acción final del pool permitido
    // ════════════════════════════════════════════════════════
    const finalDecision = selectFinalAction({
      allowed: guardrailsResult.allowed,
      leadState,
      perception,
      context
    })

    // ════════════════════════════════════════════════════════
    // PASO 4 — Construir policyDecision rica para turn_trace
    // ════════════════════════════════════════════════════════
    const actionMeta = getActionMetadata(finalDecision.action)

    const policyDecision = {
      // ─── Decisión final ───
      action: {
        type: finalDecision.action,
        strategy: finalDecision.strategy || null,
        bot_should_respond: actionMeta?.bot_should_respond ?? true,
        requires_human: actionMeta?.requires_human ?? false,
        next_stage_hint: actionMeta?.next_stage_hint || null
      },

      // ─── Audit de guardrails ───
      guardrails: {
        evaluated: guardrailsResult.evaluated,
        blocked: guardrailsResult.blocked,
        forced: guardrailsResult.forced,
        passed_names: getPassedGuardrails(guardrailsResult),
        blocking_names: getBlockingGuardrails(guardrailsResult)
      },

      // ─── Trazabilidad de la decisión ───
      rule_matched: finalDecision.rule_matched,
      decision_path: finalDecision.decision_path,

      // ─── Pool original vs filtrado ───
      candidates: {
        initial_pool: candidates,
        after_guardrails: guardrailsResult.allowed,
        final_choice: finalDecision.action
      },

      // ─── Metadata ───
      meta: {
        policy_version: POLICY_VERSION,
        rules_version: POLICY_RULES_VERSION,
        guardrails_version: GUARDRAILS_VERSION,
        action_types_version: ACTION_TYPES_VERSION,
        latency_ms: Date.now() - startTime,
        timestamp: new Date().toISOString()
      },

      // ─── Estado al momento de decidir ───
      input_snapshot: {
        stage: leadState.currentStage,
        mode: leadState.currentMode,
        intents: perception.intents || [],
        intent_specific: perception.intent_specific || null,
        pattern: perception.conversational_pattern?.pattern || null,
        is_returning: context?.is_returning_lead || false,
        turn_number: context?.turn_number || 1
      },

      // ─── Sin errores ───
      ok: true,
      errors: []
    }

    return policyDecision

  } catch (err) {
    console.error('[Policy] Fatal error:', err.message)
    return buildErrorDecision({
      error: err.message,
      stack: err.stack?.split('\n').slice(0, 5),
      startTime
    })
  }
}

// ════════════════════════════════════════════════════════
// HELPER — Build error decision (fallback seguro)
// ════════════════════════════════════════════════════════

/**
 * Cuando Policy falla, devolvemos una decisión segura: SILENCE.
 * El bot no responde, pero el sistema NO crashea.
 */
function buildErrorDecision({ error, stack = null, startTime }) {
  return {
    action: {
      type: ACTIONS.SILENCE,
      strategy: null,
      bot_should_respond: false,
      requires_human: false,
      next_stage_hint: null
    },
    guardrails: {
      evaluated: [],
      blocked: [],
      forced: null,
      passed_names: [],
      blocking_names: []
    },
    rule_matched: 'policy_error_fallback',
    decision_path: [`error:${error}`],
    candidates: {
      initial_pool: [],
      after_guardrails: [],
      final_choice: ACTIONS.SILENCE
    },
    meta: {
      policy_version: POLICY_VERSION,
      rules_version: POLICY_RULES_VERSION,
      guardrails_version: GUARDRAILS_VERSION,
      action_types_version: ACTION_TYPES_VERSION,
      latency_ms: Date.now() - startTime,
      timestamp: new Date().toISOString(),
      had_error: true
    },
    input_snapshot: {},
    ok: false,
    errors: [{ phase: 'policy', message: error, stack }]
  }
}

// ════════════════════════════════════════════════════════
// HELPER PÚBLICO — Resumen humano (para logs)
// ════════════════════════════════════════════════════════

/**
 * Devuelve resumen one-liner de la decisión para logs
 */
export function summarizeFullPolicyDecision(policyDecision) {
  if (!policyDecision) return 'no policy decision'
  if (!policyDecision.ok) {
    return `❌ policy error: ${policyDecision.errors?.[0]?.message || 'unknown'}`
  }

  const { action, rule_matched, guardrails, meta } = policyDecision
  const strategy = action.strategy ? ` (${action.strategy})` : ''
  const guardrailNote = guardrails.blocking_names.length > 0
    ? ` | blocked: ${guardrails.blocking_names.join(',')}`
    : ''
  const respondNote = action.bot_should_respond ? '🤖' : '🔇'

  return `${respondNote} ${action.type}${strategy} | rule: ${rule_matched}${guardrailNote} | ${meta.latency_ms}ms`
}

// ════════════════════════════════════════════════════════
// VERSION TRACKING
// ════════════════════════════════════════════════════════
export const POLICY_VERSION = 'v1_day5_pipeline'