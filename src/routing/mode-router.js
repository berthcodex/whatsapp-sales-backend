// src/routing/mode-router.js — Hidata v20 Día 4
//
// MODE ROUTER — Dispatcher operacional del bot
//
// Responsabilidad: dado el estado actualizado por State Layer,
// evaluar guards operacionales y decidir el mode final con el que
// va a operar el bot en este turno.
//
// Guards implementados en Día 4:
//   1. Tenant inactivo (suscripción cancelada/past_due)
//   2. Quota mensual excedida (modo degradado para AUTO_CLOSING)
//   3. Vendor inactivo
//
// Guards diferidos a Día 5-6:
//   - HUMAN_ACTIVE detection (requiere webhook v20)
//   - Horario fuera de operación
//   - Bot disabled por admin
//   - Rate limit security
//
// Versión simple: NO toca BD directamente. Recibe datos como parámetros.
// El wrapper (en state.js) se encarga de las queries.

import { MODES } from '../state/stage-definitions.js'

// ════════════════════════════════════════════════════════
// FUNCIÓN NÚCLEO — decideMode()
// ════════════════════════════════════════════════════════

/**
 * Decide el mode final del lead aplicando guards operacionales.
 * 
 * @param {object} params
 * @param {object} params.leadState - lead_state actualizado por State Layer
 * @param {object} params.perception - Output de Perception
 * @param {object} params.context - contextFlags del builder
 * @param {object} params.tenantSettings - tenant_settings del tenant del lead
 * @param {object} params.vendorActivo - Vendor que tiene el lead asignado
 * @returns {object} {
 *   decision: { final_mode, initial_mode, reason, overrode_state },
 *   guards_triggered: string[],
 *   guards_evaluated: string[],
 *   metrics: { latency_ms }
 * }
 */
export function decideMode({ 
  leadState, 
  perception, 
  context = {}, 
  tenantSettings = null, 
  vendorActivo = null 
}) {
  const startTime = Date.now()
  const guardsEvaluated = []
  const guardsTriggered = []
  
  // ─── Defaults seguros ───
  const initialMode = leadState?.currentMode || MODES.AUTO_CONSULTIVO
  let finalMode = initialMode
  let reason = 'state_layer_decision_kept'

  // ════════════════════════════════════════════════════════
  // GUARD 1 — Tenant inactivo (suscripción cancelada)
  // ════════════════════════════════════════════════════════
  guardsEvaluated.push('tenant_status')
  
  if (tenantSettings) {
    const estado = tenantSettings.estadoSuscripcion
    if (estado === 'cancelled' || estado === 'suspended') {
      finalMode = MODES.PAUSED
      reason = `tenant_suscripcion_${estado}`
      guardsTriggered.push('tenant_inactive')
      // Return early — no necesitamos seguir evaluando
      return buildDecision({ 
        finalMode, initialMode, reason, 
        guardsTriggered, guardsEvaluated, startTime 
      })
    }
    
    if (estado === 'past_due') {
      // Past due: degradar pero permitir cerrar leads ya cerca
      if (finalMode !== MODES.AUTO_CLOSING) {
        finalMode = MODES.PAUSED
        reason = 'tenant_past_due_paused_non_closing'
        guardsTriggered.push('tenant_past_due_degraded')
      } else {
        guardsTriggered.push('tenant_past_due_allowed_closing')
      }
    }
  } else {
    // No tenant_settings cargado: defensivo, continuar
    guardsTriggered.push('tenant_settings_missing_defensive_continue')
  }

  // ════════════════════════════════════════════════════════
  // GUARD 2 — Quota mensual excedida
  // ════════════════════════════════════════════════════════
  guardsEvaluated.push('quota_check')
  
  if (tenantSettings) {
    const consumidos = tenantSettings.turnosConsumidosMesActual || 0
    const incluidosPorVendedor = tenantSettings.turnosIncluidosPorVendedorMes || 10000
    const numVendedores = tenantSettings.numVendedoresPagados || 1
    const quotaTotal = incluidosPorVendedor * numVendedores
    
    if (consumidos >= quotaTotal && quotaTotal > 0) {
      // Modo degradado: si está cerca de cerrar, permitir terminar
      const stagesCriticos = ['call_scheduling', 'call_confirmed', 'post_close']
      const enStageCritico = stagesCriticos.includes(leadState?.currentStage)
      
      if (finalMode === MODES.AUTO_CLOSING || enStageCritico) {
        // Permitir cerrar pero registrar el warning
        guardsTriggered.push(`quota_exceeded_allowed_${consumidos}_of_${quotaTotal}`)
      } else {
        finalMode = MODES.PAUSED
        reason = `quota_exceeded_consumed_${consumidos}_of_${quotaTotal}`
        guardsTriggered.push('quota_exceeded_paused')
      }
    } else if (consumidos > quotaTotal * 0.8) {
      // Warning: cerca del límite (>80%)
      guardsTriggered.push(`quota_warning_at_${Math.round((consumidos/quotaTotal)*100)}pct`)
    }
  }

  // ════════════════════════════════════════════════════════
  // GUARD 3 — Vendor inactivo
  // ════════════════════════════════════════════════════════
  guardsEvaluated.push('vendor_status')
  
  if (vendorActivo) {
    if (!vendorActivo.activo) {
      finalMode = MODES.PAUSED
      reason = `vendor_${vendorActivo.id}_inactivo`
      guardsTriggered.push('vendor_inactive')
    }
  } else if (leadState?.vendorActiveId) {
    // Tiene vendorId pero no se cargó el vendor: defensivo
    guardsTriggered.push('vendor_object_missing_defensive_continue')
  }

  // ════════════════════════════════════════════════════════
  // FUTURE GUARDS (Día 5-6, dejados como TODO documentado)
  // ════════════════════════════════════════════════════════
  // - GUARD 4: HUMAN_ACTIVE detection (requiere webhook v20)
  // - GUARD 5: Horario fuera de operación (timezone tenant)
  // - GUARD 6: Bot disabled por admin (BotConfig.activo)
  // - GUARD 7: Rate limit security (abuso/spam detection)

  // ════════════════════════════════════════════════════════
  // BUILD FINAL DECISION
  // ════════════════════════════════════════════════════════
  return buildDecision({ 
    finalMode, initialMode, reason, 
    guardsTriggered, guardsEvaluated, startTime 
  })
}

// ════════════════════════════════════════════════════════
// HELPER — Construir el objeto de decisión
// ════════════════════════════════════════════════════════
function buildDecision({ 
  finalMode, initialMode, reason, 
  guardsTriggered, guardsEvaluated, startTime 
}) {
  const overrodeState = finalMode !== initialMode
  
  return {
    decision: {
      final_mode: finalMode,
      initial_mode: initialMode,
      reason: overrodeState ? reason : 'state_layer_decision_kept',
      overrode_state: overrodeState
    },
    guards_triggered: guardsTriggered,
    guards_evaluated: guardsEvaluated,
    metrics: {
      latency_ms: Date.now() - startTime,
      router_version: MODE_ROUTER_VERSION
    }
  }
}

// ════════════════════════════════════════════════════════
// JERARQUÍA DE MODES — para validación futura
// ════════════════════════════════════════════════════════
// Más restrictivo arriba, menos abajo
// Mode Router puede escalar restricción libremente
// Para "relajar" requiere reglas explícitas (Días 5-6)
const MODE_RESTRICTIVENESS = {
  [MODES.PAUSED]:          4,
  [MODES.HUMAN_ACTIVE]:    3,
  [MODES.AUTO_CLOSING]:    2,
  [MODES.AUTO_CONSULTIVO]: 1
}

/**
 * Devuelve true si modeB es MÁS restrictivo que modeA
 * Útil para validar transiciones
 */
export function isMoreRestrictive(modeA, modeB) {
  return (MODE_RESTRICTIVENESS[modeB] || 0) > (MODE_RESTRICTIVENESS[modeA] || 0)
}

/**
 * Devuelve true si la transición de modes es válida según jerarquía
 * Mode Router solo puede ESCALAR restricción
 */
export function isValidEscalation(fromMode, toMode) {
  if (fromMode === toMode) return true
  return isMoreRestrictive(fromMode, toMode)
}

// ════════════════════════════════════════════════════════
// HELPER PÚBLICO — para debugging
// ════════════════════════════════════════════════════════

/**
 * Resumen humano de la decisión para logs
 */
export function summarizeModeDecision(routerResult) {
  if (!routerResult?.decision) return 'no decision'
  
  const { decision, guards_triggered, metrics } = routerResult
  
  const arrow = decision.overrode_state ? '⚠️ override' : '✓ kept'
  const guards = guards_triggered.length > 0 
    ? `[${guards_triggered.join(', ')}]`
    : '[no guards]'
  
  return `${arrow} ${decision.initial_mode} → ${decision.final_mode} | ${decision.reason} | ${guards} | ${metrics.latency_ms}ms`
}

// ════════════════════════════════════════════════════════
// VERSIÓN PARA TRACKING
// ════════════════════════════════════════════════════════
export const MODE_ROUTER_VERSION = 'v1_day4_minimal'