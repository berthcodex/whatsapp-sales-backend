// src/policy/guardrails.js — Hidata v20 Día 5
//
// SISTEMA DE GUARDRAILS PROACTIVOS
//
// Filtra acciones del pool de candidatos ANTES de que Policy Rules decida.
// Cada guardrail evalúa una acción contra el contexto y devuelve:
//   - allow: la acción pasa
//   - block: la acción se elimina del pool
//   - force: la acción se fuerza como única opción
//
// Los 4 guardrails core implementados:
//   1. no_precio_sin_calificar
//   2. no_llamada_sin_perfil_basico
//   3. no_confirmar_pago_sin_evidencia
//   4. respect_mode_silence
//
// CERO side effects. CERO BD. CERO API calls.

import { ACTIONS, checkActionRequirements } from './action-types.js'
import { MODES } from '../state/stage-definitions.js'

// ════════════════════════════════════════════════════════
// CONSTANTES
// ════════════════════════════════════════════════════════

// Outcomes de un guardrail
const OUTCOMES = {
  ALLOW: 'allow',   // acción permitida
  BLOCK: 'block',   // acción eliminada del pool
  FORCE: 'force'    // acción se fuerza como única opción
}

// ════════════════════════════════════════════════════════
// FUNCIÓN NÚCLEO — applyGuardrails()
// ════════════════════════════════════════════════════════

/**
 * Aplica los guardrails sobre un pool de acciones candidatas.
 * 
 * @param {object} params
 * @param {string[]} params.candidates - Array de action types candidatos
 * @param {object} params.leadState - lead_state actual
 * @param {object} params.perception - Output de Perception
 * @param {object} params.context - contextFlags
 * @returns {object} {
 *   allowed: string[],          // acciones que pasaron todos los guardrails
 *   blocked: object[],          // acciones bloqueadas con razón
 *   forced: string|null,        // acción forzada (si algún guardrail forzó)
 *   evaluated: object[]         // log de cada guardrail evaluado
 * }
 */
export function applyGuardrails({ candidates = [], leadState, perception, context = {} }) {
  const evaluated = []
  const blocked = []
  let allowed = [...candidates]
  let forced = null

  // ════════════════════════════════════════════════════════
  // GUARDRAIL 4 — respect_mode_silence (PRIMERO, return early)
  // Si el mode es PAUSED o HUMAN_ACTIVE, forzamos SILENCE
  // y ninguna otra acción pasa el filtro
  // ════════════════════════════════════════════════════════
  const mode = leadState?.currentMode
  if (mode === MODES.PAUSED || mode === MODES.HUMAN_ACTIVE) {
    evaluated.push({
      guardrail: 'respect_mode_silence',
      outcome: OUTCOMES.FORCE,
      reason: `mode_is_${mode.toLowerCase()}`,
      forced_action: ACTIONS.SILENCE
    })
    return {
      allowed: [ACTIONS.SILENCE],
      blocked: candidates.filter(c => c !== ACTIONS.SILENCE).map(action => ({
        action,
        reason: `mode_${mode.toLowerCase()}_blocks_all_except_silence`
      })),
      forced: ACTIONS.SILENCE,
      evaluated
    }
  }

  // ════════════════════════════════════════════════════════
  // GUARDRAIL 1 — no_precio_sin_calificar
  // PRESENTAR_PROGRAMA requiere nombre, producto, empresa, experiencia
  // Si falta alguno, lo bloqueamos
  // ════════════════════════════════════════════════════════
  if (allowed.includes(ACTIONS.PRESENTAR_PROGRAMA)) {
    const slots = leadState?.slotsFilled || {}
    const { canExecute, missingSlots } = checkActionRequirements(
      ACTIONS.PRESENTAR_PROGRAMA,
      slots
    )

    if (!canExecute) {
      evaluated.push({
        guardrail: 'no_precio_sin_calificar',
        outcome: OUTCOMES.BLOCK,
        action: ACTIONS.PRESENTAR_PROGRAMA,
        reason: `missing_slots:${missingSlots.join(',')}`
      })
      blocked.push({
        action: ACTIONS.PRESENTAR_PROGRAMA,
        reason: `no_precio_sin_calificar:missing:${missingSlots.join(',')}`
      })
      allowed = allowed.filter(a => a !== ACTIONS.PRESENTAR_PROGRAMA)
    } else {
      evaluated.push({
        guardrail: 'no_precio_sin_calificar',
        outcome: OUTCOMES.ALLOW,
        action: ACTIONS.PRESENTAR_PROGRAMA,
        reason: 'all_required_slots_filled'
      })
    }
  }

  // ════════════════════════════════════════════════════════
  // GUARDRAIL 2 — no_llamada_sin_perfil_basico
  // AGENDAR_LLAMADA requiere al menos nombre
  // ════════════════════════════════════════════════════════
  if (allowed.includes(ACTIONS.AGENDAR_LLAMADA)) {
    const slots = leadState?.slotsFilled || {}
    const { canExecute, missingSlots } = checkActionRequirements(
      ACTIONS.AGENDAR_LLAMADA,
      slots
    )

    if (!canExecute) {
      evaluated.push({
        guardrail: 'no_llamada_sin_perfil_basico',
        outcome: OUTCOMES.BLOCK,
        action: ACTIONS.AGENDAR_LLAMADA,
        reason: `missing_slots:${missingSlots.join(',')}`
      })
      blocked.push({
        action: ACTIONS.AGENDAR_LLAMADA,
        reason: `no_llamada_sin_perfil_basico:missing:${missingSlots.join(',')}`
      })
      allowed = allowed.filter(a => a !== ACTIONS.AGENDAR_LLAMADA)
    } else {
      evaluated.push({
        guardrail: 'no_llamada_sin_perfil_basico',
        outcome: OUTCOMES.ALLOW,
        action: ACTIONS.AGENDAR_LLAMADA,
        reason: 'has_basic_profile'
      })
    }
  }

  // ════════════════════════════════════════════════════════
  // GUARDRAIL 3 — no_confirmar_pago_sin_evidencia
  // CONFIRMAR_PAGO requiere evidencia válida:
  //   - is_media=true (imagen yape recibida)
  //   - O intent específico 'paid' con signals contundentes
  // ════════════════════════════════════════════════════════
  if (allowed.includes(ACTIONS.CONFIRMAR_PAGO)) {
    const hasMedia = perception?.signals?.is_media === true
    const hasPaidIntent = perception?.intents?.includes('paid') || 
                          perception?.intents?.includes('ready_to_pay')
    const hasMonto = perception?.entities?.monto !== null && 
                     perception?.entities?.monto !== undefined

    const hasEvidence = hasMedia || (hasPaidIntent && hasMonto)

    if (!hasEvidence) {
      evaluated.push({
        guardrail: 'no_confirmar_pago_sin_evidencia',
        outcome: OUTCOMES.BLOCK,
        action: ACTIONS.CONFIRMAR_PAGO,
        reason: 'no_payment_evidence_detected'
      })
      blocked.push({
        action: ACTIONS.CONFIRMAR_PAGO,
        reason: 'no_confirmar_pago_sin_evidencia:no_image_no_monto'
      })
      allowed = allowed.filter(a => a !== ACTIONS.CONFIRMAR_PAGO)
    } else {
      evaluated.push({
        guardrail: 'no_confirmar_pago_sin_evidencia',
        outcome: OUTCOMES.ALLOW,
        action: ACTIONS.CONFIRMAR_PAGO,
        reason: hasMedia ? 'has_media_evidence' : 'has_paid_intent_with_monto'
      })
    }
  }

  // ════════════════════════════════════════════════════════
  // RESULTADO FINAL
  // ════════════════════════════════════════════════════════
  return {
    allowed,
    blocked,
    forced,
    evaluated
  }
}

// ════════════════════════════════════════════════════════
// HELPERS PÚBLICOS
// ════════════════════════════════════════════════════════

/**
 * Resumen humano de los guardrails aplicados (para debug)
 */
export function summarizeGuardrails(result) {
  if (!result) return 'no guardrails'
  
  const total = result.evaluated.length
  const blockedCount = result.blocked.length
  const forcedNote = result.forced ? ` | FORCED: ${result.forced}` : ''
  
  return `${total} evaluated, ${blockedCount} blocked${forcedNote}`
}

/**
 * Lista los nombres de guardrails que pasaron (allow)
 */
export function getPassedGuardrails(result) {
  if (!result?.evaluated) return []
  return result.evaluated
    .filter(e => e.outcome === OUTCOMES.ALLOW)
    .map(e => e.guardrail)
}

/**
 * Lista los nombres de guardrails que bloquearon
 */
export function getBlockingGuardrails(result) {
  if (!result?.evaluated) return []
  return result.evaluated
    .filter(e => e.outcome === OUTCOMES.BLOCK)
    .map(e => e.guardrail)
}

// ════════════════════════════════════════════════════════
// VERSION TRACKING
// ════════════════════════════════════════════════════════
export const GUARDRAILS_VERSION = 'v1_day5_4_core_guardrails'