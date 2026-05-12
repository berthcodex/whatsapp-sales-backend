// src/state/state-transitions.js — Hidata v20 (Día 5 fix)
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
// FIX Día 5: rejecting + objecion_* NO pausa el lead (negociación legítima).
// Solo rejecting puro (sin intent_specific de objeción) pausa.

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
// 1. Perception fallback → stay
// 2. Mode override por intent crítico (rejecting REAL → PAUSED, paid → AUTO_CLOSING)
// 3. Returning lead recognition
// 4. Fast-track HOT signals
// 5. Stage suggestion del intent + slot validation
// 6. Auto-progression por slots completos
// 7. Fallback: stay
// ════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════
// FUNCIÓN — shouldForceMode()
// 
// Decide si un intent debe forzar un mode override.
// Considera tanto intent (level_1) como intent_specific (level_2).
//
// Lógica:
//   - paid                                  → AUTO_CLOSING (siempre)
//   - rejecting + intent_specific='objecion_*'   → NO forzar (negociación)
//   - rejecting + intent_specific='promesa_*'    → NO forzar (postpone)
//   - rejecting + intent_specific=null            → PAUSED (rechazo real)
//   - rejecting + cualquier otro intent_specific → NO forzar (caso ambiguo, NO pausar)
// 
// Filosofía: en duda, NO pausamos. Mejor seguir conversando que perder ventas.
// ════════════════════════════════════════════════════════
function shouldForceMode(primaryIntent, intentSpecific) {
  // Caso 1: paid siempre fuerza AUTO_CLOSING
  if (primaryIntent === 'paid') {
    return { forced: true, mode: MODES.AUTO_CLOSING, reason: 'paid' }
  }

  // Caso 2: rejecting requiere análisis del intent_specific
  if (primaryIntent === 'rejecting') {
    // Sin intent_specific = rechazo definitivo → pausar
    if (!intentSpecific) {
      return { forced: true, mode: MODES.PAUSED, reason: 'rejecting_definitivo' }
    }

    // Con intent_specific de objeción = negociación legítima → NO pausar
    if (intentSpecific.startsWith('objecion_')) {
      return { forced: false, reason: `rejecting_objecion:${intentSpecific}` }
    }

    // Con intent_specific de promesa diferida = postpone → NO pausar
    if (intentSpecific.startsWith('promesa_')) {
      return { forced: false, reason: `rejecting_postpone:${intentSpecific}` }
    }

    // Cualquier otro intent_specific = caso ambiguo → NO pausar (mejor seguir conversando)
    return { forced: false, reason: `rejecting_ambiguous:${intentSpecific}` }
  }

  // Cualquier otro intent: no forzar
  return { forced: false, reason: 'no_force_needed' }
}

// ════════════════════════════════════════════════════════
// FUNCIÓN NÚCLEO — resolveNextState()
// ════════════════════════════════════════════════════════

/**
 * Decide el próximo estado según Perception + estado actual.
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
      slots_to_merge: {},
      stayed: true
    }
  }

  // ════════════════════════════════════════════════════════
  // PRIORIDAD 1 — Mode override por intent crítico
  // FIX Día 5: usar shouldForceMode() que considera intent_specific
  // ════════════════════════════════════════════════════════
  const primaryIntent = intents[0] || 'confused'
  const forceCheck = shouldForceMode(primaryIntent, intentSpecific)

  if (forceCheck.forced) {
    return {
      nextStage: currentStage,
      nextMode: forceCheck.mode,
      transition_reason: `intent_forces_${forceCheck.mode.toLowerCase()}:${forceCheck.reason}`,
      slots_to_merge: slotsToMerge,
      stayed: false
    }
  }

  // Si no se fuerza pero hubo razón documentada, queda en log
  // (esto ayuda a debug: "por qué rejecting NO pausó")
  const forceReasonLog = forceCheck.reason !== 'no_force_needed' 
    ? `force_skipped:${forceCheck.reason}` 
    : null

  // ════════════════════════════════════════════════════════
  // PRIORIDAD 2 — Returning lead recognition
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
    if (isTransitionAllowed(currentStage, suggestedStage)) {
      const mergedSlots = { ...slotsFilled, ...slotsToMerge }
      const { canAdvance, missingSlots } = canAdvanceToStage(suggestedStage, mergedSlots)
      
      if (canAdvance) {
        const nextMode = inferModeFromStage(suggestedStage, currentMode)
        return {
          nextStage: suggestedStage,
          nextMode,
          transition_reason: forceReasonLog
            ? `intent_suggests:${primaryIntent};${forceReasonLog}`
            : `intent_suggests:${primaryIntent}`,
          slots_to_merge: slotsToMerge,
          stayed: false
        }
      } else {
        return {
          nextStage: currentStage,
          nextMode: currentMode,
          transition_reason: `intent_suggests_but_missing_slots:${missingSlots.join(',')}`,
          slots_to_merge: slotsToMerge,
          stayed: true
        }
      }
    } else {
      return {
        nextStage: currentStage,
        nextMode: currentMode,
        transition_reason: forceReasonLog
          ? `transition_not_allowed:${currentStage}→${suggestedStage};${forceReasonLog}`
          : `transition_not_allowed:${currentStage}→${suggestedStage}`,
        slots_to_merge: slotsToMerge,
        stayed: true
      }
    }
  }

  // ════════════════════════════════════════════════════════
  // PRIORIDAD 5 — Auto-progression por slots completos
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
  // ════════════════════════════════════════════════════════
  return {
    nextStage: currentStage,
    nextMode: currentMode,
    transition_reason: forceReasonLog
      ? `stay_no_transition_triggered;${forceReasonLog}`
      : 'stay_no_transition_triggered',
    slots_to_merge: slotsToMerge,
    stayed: true
  }
}

// ════════════════════════════════════════════════════════
// HELPERS INTERNOS
// ════════════════════════════════════════════════════════

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

function inferModeFromStage(stage, currentMode) {
  if (currentMode === MODES.HUMAN_ACTIVE || currentMode === MODES.PAUSED) {
    return currentMode
  }

  const CLOSING_STAGES = [
    STAGES.CALL_SCHEDULING,
    STAGES.CALL_CONFIRMED,
    STAGES.POST_CLOSE
  ]
  if (CLOSING_STAGES.includes(stage)) {
    return MODES.AUTO_CLOSING
  }

  if (stage === STAGES.RETURNING_RECOGNITION) {
    return MODES.AUTO_CONSULTIVO
  }

  return currentMode || MODES.AUTO_CONSULTIVO
}

function checkAutoAdvanceByStots(currentStage, slots) {
  if (currentStage === STAGES.DISCOVERY) {
    if (slots[SLOTS.NOMBRE] && slots[SLOTS.PRODUCTO]) {
      return STAGES.QUALIFYING_EMPRESA
    }
  }
  
  if (currentStage === STAGES.QUALIFYING_EMPRESA) {
    if (slots[SLOTS.EMPRESA] !== undefined && slots[SLOTS.EXPERIENCIA] !== undefined) {
      return STAGES.PRESENTING
    }
  }
  
  if (currentStage === STAGES.CALL_SCHEDULING) {
    if (slots[SLOTS.FECHA_HORA]) {
      return STAGES.CALL_CONFIRMED
    }
  }
  
  if (currentStage === STAGES.CALL_CONFIRMED) {
    return STAGES.POST_CLOSE
  }
  
  return null
}

// ════════════════════════════════════════════════════════
// HELPER PÚBLICO — para debugging
// ════════════════════════════════════════════════════════

export function summarizeTransition(transition) {
  if (!transition) return 'no transition'
  const arrow = transition.stayed ? '↻ stay' : '→'
  return `${arrow} stage=${transition.nextStage} mode=${transition.nextMode} reason="${transition.transition_reason}"`
}

// ════════════════════════════════════════════════════════
// VERSIÓN PARA TRACKING
// ════════════════════════════════════════════════════════
export const STATE_TRANSITIONS_VERSION = 'v2_day5_fix_objection_no_pause'
