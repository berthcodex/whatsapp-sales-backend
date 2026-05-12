// src/state/state-transitions.js — Hidata v20
//
// MOTOR DE TRANSICIONES DETERMINÍSTICO
//
// Función núcleo: resolveNextState(perception, currentState, flags)
//   Recibe → output de Perception + estado actual + flags de contexto
//   Devuelve → { nextStage, nextMode, slots_to_merge, transition_reason }
//
// CERO side effects. CERO BD. CERO API calls.
// Solo razonamiento determinístico sobre datos en memoria.
//
// Esta función la consume state.js que sí escribe en BD.

import {
  STAGES,
  MODES,
  isValidStage,
  isTransitionAllowed,
  getFastTrackStage,
  suggestStageFromIntent,
  canAdvanceToStage,
  SLOTS
} from './stage-definitions.js'

// ════════════════════════════════════════════════════════
// PRIORIDADES DE DECISIÓN (en orden)
// 
// 1. Mode override por intent crítico (rejecting → PAUSED)
// 2. Fast-track HOT signals (lead pide llamada en turn 1)
// 3. Returning lead recognition (lead vuelve después de 30+ días)
// 4. HUMAN_ACTIVE detection (no aplica en Día 3, va en webhook handler)
// 5. Stage suggestion del intent + validación de slots
// 6. Fallback: stay_and_acknowledge (no transicionar)
// ════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════
// INTENT → MODE OVERRIDES
// Algunos intents fuerzan cambio de mode independiente del stage
// ════════════════════════════════════════════════════════
const INTENT_FORCES_MODE = {
  'rejecting': MODES.PAUSED,  // lead explícitamente rechaza → pausar bot
  'paid':      MODES.AUTO_CLOSING  // lead dice que pagó → modo cierre
  // NOTA: 'requesting_call' NO fuerza AUTO_CLOSING todavía. 
  // Lo dejamos en AUTO_CONSULTIVO hasta que tengamos horario confirmado.
}

// ════════════════════════════════════════════════════════
// FUNCIÓN NÚCLEO — resolveNextState()
// ════════════════════════════════════════════════════════

/**
 * Decide el próximo estado según Perception + estado actual.
 * 
 * @param {object} params
 * @param {object} params.perception - Output completo de Perception
 * @param {object} params.currentState - lead_state actual (puede ser null si nuevo)
 * @param {object} params.flags - Flags del contexto (is_returning_lead, etc)
 * @returns {object} {
 *   nextStage: string,
 *   nextMode: string,
 *   transition_reason: string,
 *   slots_to_merge: object,
 *   stayed: boolean
 * }
 */
export function resolveNextState({ perception, currentState, flags = {} }) {
  // ─── Defaults seguros ───
  const currentStage = currentState?.currentStage || STAGES.FIRST_CONTACT
  const currentMode  = currentState?.currentMode  || MODES.AUTO_CONSULTIVO
  const slotsFilled  = currentState?.slotsFilled  || {}

  // ─── Extraer datos clave de Perception ───
  const intents          = perception?.intents || []
  const intentSpecific   = perception?.intent_specific || null
  const entities         = perception?.entities || {}
  const isFallback       = perception?._is_fallback || false

  // ─── Slots nuevos del turno actual ───
  const slotsToMerge = extractSlotsFromEntities(entities)

  // ════════════════════════════════════════════════════════
  // CASO ESPECIAL — Perception falló (fallback)
  // ════════════════════════════════════════════════════════
  if (isFallback) {
    return {
      nextStage: currentStage,
      nextMode: currentMode,
      transition_reason: 'perception_fallback_stay',
      slots_to_merge: {},  // no merge si Perception falló
      stayed: true
    }
  }

  // ════════════════════════════════════════════════════════
  // PRIORIDAD 1 — Mode override por intent crítico
  // ════════════════════════════════════════════════════════
  const primaryIntent = intents[0] || 'confused'
  const forcedMode = INTENT_FORCES_MODE[primaryIntent]

  if (forcedMode === MODES.PAUSED) {
    return {
      nextStage: currentStage,  // mantenemos stage
      nextMode: MODES.PAUSED,
      transition_reason: `intent_forces_pause:${primaryIntent}`,
      slots_to_merge: slotsToMerge,
      stayed: false
    }
  }

  // ════════════════════════════════════════════════════════
  // PRIORIDAD 2 — Returning lead recognition
  // (antes del fast-track porque returning tiene prioridad arquitectónica)
  // ════════════════════════════════════════════════════════
  if (flags.is_returning_lead && currentStage !== STAGES.RETURNING_RECOGNITION) {
    return {
      nextStage: STAGES.RETURNING_RECOGNITION,
      nextMode: MODES.AUTO_CONSULTIVO,
      transition_reason: `returning_lead_${flags.days_since_last_msg}_days`,
      slots_to_merge: slotsToMerge,
      stayed: false
    }
  }

  // ════════════════════════════════════════════════════════
  // PRIORIDAD 3 — Fast-track HOT (lead pide llamada turn 1)
  // ════════════════════════════════════════════════════════
  if (intentSpecific) {
    const fastTrackStage = getFastTrackStage(currentStage, intentSpecific)
    if (fastTrackStage) {
      const nextMode = (fastTrackStage === STAGES.CALL_SCHEDULING) 
        ? MODES.AUTO_CLOSING 
        : currentMode
      return {
        nextStage: fastTrackStage,
        nextMode,
        transition_reason: `fast_track_hot:${intentSpecific}`,
        slots_to_merge: slotsToMerge,
        stayed: false
      }
    }
  }

  // ════════════════════════════════════════════════════════
  // PRIORIDAD 4 — Stage suggestion del intent + validación
  // ════════════════════════════════════════════════════════
  const suggestedStage = suggestStageFromIntent(primaryIntent)

  if (suggestedStage && suggestedStage !== currentStage) {
    // Verificar que la transición sea permitida
    if (isTransitionAllowed(currentStage, suggestedStage)) {
      // Verificar que el nuevo stage tenga sus slots requeridos
      // (consideramos los slots actuales MÁS los nuevos del turno)
      const mergedSlots = { ...slotsFilled, ...slotsToMerge }
      const { canAdvance, missingSlots } = canAdvanceToStage(suggestedStage, mergedSlots)
      
      if (canAdvance) {
        // Determinar mode según stage destino
        const nextMode = inferModeFromStage(suggestedStage, currentMode)
        return {
          nextStage: suggestedStage,
          nextMode,
          transition_reason: `intent_suggests:${primaryIntent}`,
          slots_to_merge: slotsToMerge,
          stayed: false
        }
      } else {
        // Quiere avanzar pero faltan slots → stay y collect
        return {
          nextStage: currentStage,
          nextMode: currentMode,
          transition_reason: `intent_suggests_but_missing_slots:${missingSlots.join(',')}`,
          slots_to_merge: slotsToMerge,
          stayed: true
        }
      }
    } else {
      // Transición no permitida según matriz
      return {
        nextStage: currentStage,
        nextMode: currentMode,
        transition_reason: `transition_not_allowed:${currentStage}→${suggestedStage}`,
        slots_to_merge: slotsToMerge,
        stayed: true
      }
    }
  }

  // ════════════════════════════════════════════════════════
  // PRIORIDAD 5 — Auto-progression por slots completos
  // Si estamos en discovery y ya tenemos nombre+producto+empresa+experiencia
  // → avanzar a presenting aunque el intent no lo sugiera
  // ════════════════════════════════════════════════════════
  const mergedSlots = { ...slotsFilled, ...slotsToMerge }
  const autoAdvanceStage = checkAutoAdvanceByStots(currentStage, mergedSlots)
  
  if (autoAdvanceStage && isTransitionAllowed(currentStage, autoAdvanceStage)) {
    return {
      nextStage: autoAdvanceStage,
      nextMode: inferModeFromStage(autoAdvanceStage, currentMode),
      transition_reason: `auto_advance_slots_complete:${currentStage}→${autoAdvanceStage}`,
      slots_to_merge: slotsToMerge,
      stayed: false
    }
  }

  // ════════════════════════════════════════════════════════
  // FALLBACK — Stay and acknowledge
  // No hay razón para transicionar, mantenemos todo
  // ════════════════════════════════════════════════════════
  return {
    nextStage: currentStage,
    nextMode: currentMode,
    transition_reason: 'stay_no_transition_triggered',
    slots_to_merge: slotsToMerge,
    stayed: true
  }
}

// ════════════════════════════════════════════════════════
// HELPERS INTERNOS
// ════════════════════════════════════════════════════════

/**
 * Extrae los slots desde entities de Perception
 * Filtra valores null/undefined/empty para no contaminar el merge
 */
function extractSlotsFromEntities(entities) {
  if (!entities || typeof entities !== 'object') return {}
  
  const slots = {}
  for (const slotKey of Object.values(SLOTS)) {
    const value = entities[slotKey]
    if (value !== null && value !== undefined && value !== '') {
      slots[slotKey] = value
    }
  }
  return slots
}

/**
 * Infiere el mode apropiado según el stage destino
 * 
 * - call_scheduling/confirmed/post_close → AUTO_CLOSING
 * - returning_recognition → AUTO_CONSULTIVO (re-calificar suavemente)
 * - resto → mantener currentMode (típicamente AUTO_CONSULTIVO)
 */
function inferModeFromStage(stage, currentMode) {
  // Si ya estamos en HUMAN_ACTIVE o PAUSED, no cambiar automáticamente
  if (currentMode === MODES.HUMAN_ACTIVE || currentMode === MODES.PAUSED) {
    return currentMode
  }

  // Stages de cierre → AUTO_CLOSING
  const CLOSING_STAGES = [
    STAGES.CALL_SCHEDULING,
    STAGES.CALL_CONFIRMED,
    STAGES.POST_CLOSE
  ]
  if (CLOSING_STAGES.includes(stage)) {
    return MODES.AUTO_CLOSING
  }

  // Returning recognition siempre vuelve a consultivo
  if (stage === STAGES.RETURNING_RECOGNITION) {
    return MODES.AUTO_CONSULTIVO
  }

  // Default: mantener mode actual
  return currentMode || MODES.AUTO_CONSULTIVO
}

/**
 * Detecta si los slots actuales permiten auto-progresión
 * sin esperar intent específico.
 * 
 * Ejemplo: si estamos en discovery y ya tenemos nombre+producto,
 * podemos avanzar a qualifying_empresa.
 */
function checkAutoAdvanceByStots(currentStage, slots) {
  // De discovery → qualifying_empresa si ya tenemos básicos
  if (currentStage === STAGES.DISCOVERY) {
    if (slots[SLOTS.NOMBRE] && slots[SLOTS.PRODUCTO]) {
      return STAGES.QUALIFYING_EMPRESA
    }
  }
  
  // De qualifying_empresa → presenting si ya respondió empresa+experiencia
  if (currentStage === STAGES.QUALIFYING_EMPRESA) {
    if (slots[SLOTS.EMPRESA] !== undefined && slots[SLOTS.EXPERIENCIA] !== undefined) {
      return STAGES.PRESENTING
    }
  }
  
  // De call_scheduling → call_confirmed si ya tenemos fecha_hora
  if (currentStage === STAGES.CALL_SCHEDULING) {
    if (slots[SLOTS.FECHA_HORA]) {
      return STAGES.CALL_CONFIRMED
    }
  }
  
  // De call_confirmed → post_close automáticamente
  if (currentStage === STAGES.CALL_CONFIRMED) {
    return STAGES.POST_CLOSE
  }
  
  return null
}

// ════════════════════════════════════════════════════════
// HELPER PÚBLICO — para debugging
// ════════════════════════════════════════════════════════

/**
 * Devuelve resumen humano de la decisión de transición
 */
export function summarizeTransition(transition) {
  if (!transition) return 'no transition'
  const arrow = transition.stayed ? '↻ stay' : '→'
  return `${arrow} stage=${transition.nextStage} mode=${transition.nextMode} reason="${transition.transition_reason}"`
}

// ════════════════════════════════════════════════════════
// VERSIÓN PARA TRACKING
// ════════════════════════════════════════════════════════
export const STATE_TRANSITIONS_VERSION = 'v1'