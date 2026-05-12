// src/policy/policy-rules.js — Hidata v20 Día 5
//
// REGLAS DETERMINÍSTICAS DE POLICY
//
// Pipeline interno:
//   1. resolveCandidatesByStage() — genera pool de actions según stage
//   2. applyGuardrails() — filtra el pool (en policy.js)
//   3. selectFinalAction() — elige UNA action del pool filtrado
//   4. resolveObjectionStrategy() — si la acción es MANEJAR_OBJECION,
//      decide la strategy específica
//
// CERO side effects. CERO BD. CERO LLM. 100% determinístico.

import {
  ACTIONS,
  OBJECTION_STRATEGIES,
  getActionPriority
} from './action-types.js'
import { STAGES, MODES } from '../state/stage-definitions.js'

// ════════════════════════════════════════════════════════
// FUNCIÓN 1 — Generar pool de candidatos por stage
// ════════════════════════════════════════════════════════

/**
 * Genera el pool inicial de acciones candidatas según el stage actual.
 * Los guardrails después filtran este pool.
 * 
 * @param {string} currentStage 
 * @param {string} currentMode 
 * @returns {string[]} array de action types candidatos
 */
export function resolveCandidatesByStage(currentStage, currentMode) {
  // Si mode es restrictivo, solo SILENCE
  if (currentMode === MODES.PAUSED || currentMode === MODES.HUMAN_ACTIVE) {
    return [ACTIONS.SILENCE]
  }

  // Pool por stage
  switch (currentStage) {
    case STAGES.FIRST_CONTACT:
      return [
        ACTIONS.SALUDAR_INICIAL,
        ACTIONS.PEDIR_CALIFICACION,  // si ya saludamos antes
        ACTIONS.GREET_RETURNING       // si es returning lead
      ]

    case STAGES.DISCOVERY:
      return [
        ACTIONS.PEDIR_CALIFICACION,
        ACTIONS.PEDIR_SITUACION_EMPRESA,  // si ya tiene nombre+producto
        ACTIONS.MANEJAR_OBJECION,         // si surge objeción temprana
        ACTIONS.AGENDAR_LLAMADA           // si lead HOT pide llamada
      ]

    case STAGES.QUALIFYING_EMPRESA:
      return [
        ACTIONS.PEDIR_SITUACION_EMPRESA,
        ACTIONS.PRESENTAR_PROGRAMA,       // si ya tiene todos los slots
        ACTIONS.MANEJAR_OBJECION,
        ACTIONS.AGENDAR_LLAMADA           // si HOT signal
      ]

    case STAGES.PRESENTING:
      return [
        ACTIONS.PRESENTAR_PROGRAMA,       // si aún no presentó
        ACTIONS.MANEJAR_OBJECION,         // PRINCIPAL: post-presentación
        ACTIONS.AGENDAR_LLAMADA           // si lead acepta directo
      ]

    case STAGES.CALL_SCHEDULING:
      return [
        ACTIONS.AGENDAR_LLAMADA,
        ACTIONS.MANEJAR_OBJECION          // objeción de horario
      ]

    case STAGES.CALL_CONFIRMED:
      return [
        ACTIONS.AGENDAR_LLAMADA,          // re-confirmar si cambia algo
        ACTIONS.CONFIRMAR_PAGO,           // adelanta pago
        ACTIONS.MANEJAR_OBJECION
      ]

    case STAGES.POST_CLOSE:
      return [
        ACTIONS.CONFIRMAR_PAGO,
        ACTIONS.MANEJAR_OBJECION,         // post-cierre puede tener dudas
        ACTIONS.SILENCE                    // si lead solo conversa post-cierre
      ]

    case STAGES.RETURNING_RECOGNITION:
      return [
        ACTIONS.GREET_RETURNING,
        ACTIONS.PEDIR_CALIFICACION,       // si vuelve sin contexto
        ACTIONS.AGENDAR_LLAMADA           // si retoma desde llamada agendada
      ]

    default:
      // Stage desconocido — fallback defensivo
      return [ACTIONS.PEDIR_CALIFICACION]
  }
}

// ════════════════════════════════════════════════════════
// FUNCIÓN 2 — Resolver objection strategy
// ════════════════════════════════════════════════════════

/**
 * Si la acción decidida es MANEJAR_OBJECION, decide qué estrategia
 * específica aplicar basándose en intent_specific de Perception.
 * 
 * @param {object} perception 
 * @returns {string} objection strategy
 */
export function resolveObjectionStrategy(perception) {
  const intentSpecific = perception?.intent_specific
  const pattern = perception?.conversational_pattern?.pattern

  // ─── Patrón conversacional tiene PRIORIDAD ───
  // (señales sutiles ganan sobre intents granulares)
  if (pattern === 'señal_compra_disfrazada_de_objecion') {
    // Lead está usando objeción como puente a compra
    // Estrategia: responder como compra inminente, no como objeción
    return OBJECTION_STRATEGIES.GENERICA  // Response Layer detecta pattern y ajusta
  }

  // ─── Mapping intent_specific → strategy ───
  const INTENT_TO_STRATEGY = {
    'objecion_precio':              OBJECTION_STRATEGIES.PRECIO_REFRAME,
    'objecion_decision':            OBJECTION_STRATEGIES.DECISION_QUALIFY,
    'objecion_timing_pago':         OBJECTION_STRATEGIES.TIMING_FRAGMENTAR,
    'objecion_estacional':          OBJECTION_STRATEGIES.ESTACIONAL_SINCRONIZAR,
    'objecion_validacion':          OBJECTION_STRATEGIES.VALIDACION_ENVIAR_ASSETS,
    'objecion_no_tengo_tiempo':     OBJECTION_STRATEGIES.TIEMPO_CASCADA_FLEXIBLE,
    'objecion_no_tengo_dinero':     OBJECTION_STRATEGIES.DINERO_50_50_DEFAULT,
    'objecion_consulto_familia':    OBJECTION_STRATEGIES.FAMILIA_FECHA_ESPECIFICA,
    'objecion_horario_cascada':     OBJECTION_STRATEGIES.HORARIO_CASCADA,
    'objecion_ya_gaste_en_abono':   OBJECTION_STRATEGIES.YA_GASTE_EMPATIA_MICRO
  }

  return INTENT_TO_STRATEGY[intentSpecific] || OBJECTION_STRATEGIES.GENERICA
}

// ════════════════════════════════════════════════════════
// FUNCIÓN 3 — Selectar acción final del pool permitido
// ════════════════════════════════════════════════════════

/**
 * Dado el pool ya filtrado por guardrails, decide la acción final
 * basándose en intents, patterns, slots y stage.
 * 
 * @param {object} params
 * @param {string[]} params.allowed - Pool filtrado por guardrails
 * @param {object} params.leadState
 * @param {object} params.perception
 * @param {object} params.context
 * @returns {object} {
 *   action: string,
 *   strategy: string|null,
 *   rule_matched: string,
 *   decision_path: string[]
 * }
 */
export function selectFinalAction({ allowed, leadState, perception, context = {} }) {
  const decisionPath = []
  const stage = leadState?.currentStage || STAGES.FIRST_CONTACT
  const mode = leadState?.currentMode || MODES.AUTO_CONSULTIVO
  const slots = leadState?.slotsFilled || {}
  const intents = perception?.intents || []
  const intentSpecific = perception?.intent_specific
  const pattern = perception?.conversational_pattern?.pattern
  const isReturning = context?.is_returning_lead === true
  const turnNumber = context?.turn_number || 1

  decisionPath.push(`stage:${stage}`)
  decisionPath.push(`mode:${mode}`)
  decisionPath.push(`intents:[${intents.join(',')}]`)
  if (intentSpecific) decisionPath.push(`intent_specific:${intentSpecific}`)
  if (pattern) decisionPath.push(`pattern:${pattern}`)

  // ════════════════════════════════════════════════════════
  // CASO ESPECIAL: SILENCE forzado por guardrails
  // ════════════════════════════════════════════════════════
  if (allowed.length === 1 && allowed[0] === ACTIONS.SILENCE) {
    decisionPath.push('rule:silence_forced_by_guardrails')
    return {
      action: ACTIONS.SILENCE,
      strategy: null,
      rule_matched: 'silence_forced',
      decision_path: decisionPath
    }
  }

  // ════════════════════════════════════════════════════════
  // CASO 1: Returning lead detectado
  // ════════════════════════════════════════════════════════
  if (isReturning && allowed.includes(ACTIONS.GREET_RETURNING)) {
    decisionPath.push('rule:returning_lead_greet_first')
    return {
      action: ACTIONS.GREET_RETURNING,
      strategy: null,
      rule_matched: 'rule_returning_lead_priority',
      decision_path: decisionPath
    }
  }

  // ════════════════════════════════════════════════════════
  // CASO 2: HOT signals — lead pide llamada en primer turno
  // ════════════════════════════════════════════════════════
  if (intentSpecific === 'lead_pide_llamada_first_turn_HOT' && 
      allowed.includes(ACTIONS.AGENDAR_LLAMADA)) {
    decisionPath.push('rule:hot_signal_fast_track_to_call')
    return {
      action: ACTIONS.AGENDAR_LLAMADA,
      strategy: null,
      rule_matched: 'rule_hot_signal_fast_track',
      decision_path: decisionPath
    }
  }

  // ════════════════════════════════════════════════════════
  // CASO 3: Lead pide llamada (general)
  // ════════════════════════════════════════════════════════
  if (intents.includes('requesting_call') && 
      allowed.includes(ACTIONS.AGENDAR_LLAMADA)) {
    decisionPath.push('rule:lead_requests_call')
    return {
      action: ACTIONS.AGENDAR_LLAMADA,
      strategy: null,
      rule_matched: 'rule_lead_requests_call',
      decision_path: decisionPath
    }
  }

  // ════════════════════════════════════════════════════════
  // CASO 4: Confirmación de pago / yape detectado
  // ════════════════════════════════════════════════════════
  if ((intents.includes('paid') || perception?.signals?.is_media) && 
      allowed.includes(ACTIONS.CONFIRMAR_PAGO)) {
    decisionPath.push('rule:payment_evidence_detected')
    return {
      action: ACTIONS.CONFIRMAR_PAGO,
      strategy: null,
      rule_matched: 'rule_payment_detected',
      decision_path: decisionPath
    }
  }

  // ════════════════════════════════════════════════════════
  // CASO 5: Objeción detectada (intent_specific o pattern)
  // ════════════════════════════════════════════════════════
  const hasObjectionIntent = intentSpecific && intentSpecific.startsWith('objecion_')
  const hasObjectionPattern = pattern === 'señal_compra_disfrazada_de_objecion'

  if ((hasObjectionIntent || hasObjectionPattern) && 
      allowed.includes(ACTIONS.MANEJAR_OBJECION)) {
    const strategy = resolveObjectionStrategy(perception)
    decisionPath.push(`rule:objection_detected:${strategy}`)
    return {
      action: ACTIONS.MANEJAR_OBJECION,
      strategy,
      rule_matched: 'rule_objection_handling',
      decision_path: decisionPath
    }
  }

  // ════════════════════════════════════════════════════════
  // CASO 6: Avance natural del flujo por stage
  // ════════════════════════════════════════════════════════
  // FIRST_CONTACT con primer turno → saludar
  if (stage === STAGES.FIRST_CONTACT && turnNumber === 1 && 
      allowed.includes(ACTIONS.SALUDAR_INICIAL)) {
    decisionPath.push('rule:first_contact_first_turn_greet')
    return {
      action: ACTIONS.SALUDAR_INICIAL,
      strategy: null,
      rule_matched: 'rule_first_contact_greet',
      decision_path: decisionPath
    }
  }

  // DISCOVERY → pedir calificación si faltan slots básicos
  if (stage === STAGES.DISCOVERY && allowed.includes(ACTIONS.PEDIR_CALIFICACION)) {
    if (!slots.nombre || !slots.producto) {
      decisionPath.push('rule:discovery_missing_basic_slots')
      return {
        action: ACTIONS.PEDIR_CALIFICACION,
        strategy: null,
        rule_matched: 'rule_discovery_calificar',
        decision_path: decisionPath
      }
    }
    // Ya tiene básicos → avanzar a pedir empresa
    if (allowed.includes(ACTIONS.PEDIR_SITUACION_EMPRESA)) {
      decisionPath.push('rule:discovery_has_basics_advance_to_empresa')
      return {
        action: ACTIONS.PEDIR_SITUACION_EMPRESA,
        strategy: null,
        rule_matched: 'rule_advance_to_empresa',
        decision_path: decisionPath
      }
    }
  }

  // QUALIFYING_EMPRESA → pedir empresa si falta el slot
  if (stage === STAGES.QUALIFYING_EMPRESA && 
      allowed.includes(ACTIONS.PEDIR_SITUACION_EMPRESA)) {
    if (slots.empresa === undefined || slots.empresa === null) {
      decisionPath.push('rule:qualifying_missing_empresa_slot')
      return {
        action: ACTIONS.PEDIR_SITUACION_EMPRESA,
        strategy: null,
        rule_matched: 'rule_pedir_empresa',
        decision_path: decisionPath
      }
    }
    // Ya tiene empresa+experiencia → presentar
    if (allowed.includes(ACTIONS.PRESENTAR_PROGRAMA)) {
      decisionPath.push('rule:qualifying_complete_advance_to_present')
      return {
        action: ACTIONS.PRESENTAR_PROGRAMA,
        strategy: null,
        rule_matched: 'rule_advance_to_present',
        decision_path: decisionPath
      }
    }
  }

  // PRESENTING → presentar programa
  if (stage === STAGES.PRESENTING && 
      allowed.includes(ACTIONS.PRESENTAR_PROGRAMA)) {
    decisionPath.push('rule:presenting_stage_present')
    return {
      action: ACTIONS.PRESENTAR_PROGRAMA,
      strategy: null,
      rule_matched: 'rule_present_program',
      decision_path: decisionPath
    }
  }

  // CALL_SCHEDULING → agendar
  if (stage === STAGES.CALL_SCHEDULING && 
      allowed.includes(ACTIONS.AGENDAR_LLAMADA)) {
    decisionPath.push('rule:call_scheduling_stage_agendar')
    return {
      action: ACTIONS.AGENDAR_LLAMADA,
      strategy: null,
      rule_matched: 'rule_agendar_llamada',
      decision_path: decisionPath
    }
  }

  // ════════════════════════════════════════════════════════
  // CASO 7: Fallback inteligente
  // Si nada matchea, usar la action de mayor prioridad del pool
  // ════════════════════════════════════════════════════════
  if (allowed.length === 0) {
    // No hay acciones permitidas — algo raro pasó
    decisionPath.push('rule:no_allowed_actions_fallback_to_silence')
    return {
      action: ACTIONS.SILENCE,
      strategy: null,
      rule_matched: 'fallback_no_actions',
      decision_path: decisionPath
    }
  }

  // Tomar la action de mayor prioridad del pool permitido
  const sortedByPriority = [...allowed].sort(
    (a, b) => getActionPriority(b) - getActionPriority(a)
  )
  const fallbackAction = sortedByPriority[0]

  decisionPath.push(`rule:fallback_highest_priority:${fallbackAction}`)
  return {
    action: fallbackAction,
    strategy: fallbackAction === ACTIONS.MANEJAR_OBJECION 
      ? OBJECTION_STRATEGIES.GENERICA 
      : null,
    rule_matched: 'fallback_highest_priority',
    decision_path: decisionPath
  }
}

// ════════════════════════════════════════════════════════
// HELPER PÚBLICO — para debug
// ════════════════════════════════════════════════════════

/**
 * Resumen humano de la decisión final
 */
export function summarizePolicyDecision(decision) {
  if (!decision) return 'no decision'
  
  const action = decision.action
  const strategy = decision.strategy ? ` (${decision.strategy})` : ''
  const rule = decision.rule_matched || 'unknown'
  
  return `→ ${action}${strategy} | rule: ${rule}`
}

// ════════════════════════════════════════════════════════
// VERSION TRACKING
// ════════════════════════════════════════════════════════
export const POLICY_RULES_VERSION = 'v1_day5_rule_based'