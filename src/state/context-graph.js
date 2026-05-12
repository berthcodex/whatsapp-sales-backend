// src/state/context-graph.js — Hidata v20
//
// GESTOR DE SLOTS — Versión Día 3 (simple)
//
// Responsabilidad: mergear slots actuales con slots nuevos del turno,
// respetando políticas por slot.
//
// 3 políticas de merge:
//   - first_write_wins: nombre y producto (raro corregirse)
//   - overwrite_if_new: empresa, experiencia (corrección legítima)
//   - always_overwrite: fecha, cantidad, monto, país (info dinámica)
//
// CERO side effects. CERO BD. CERO API calls.
// Funciones puras consumidas por state.js (Paso 4).

import { SLOTS } from './stage-definitions.js'

// ════════════════════════════════════════════════════════
// POLÍTICAS DE MERGE POR SLOT
// ════════════════════════════════════════════════════════
const MERGE_POLICIES = {
  // First-write-wins: una vez llenado, no se sobrescribe
  // Razón: nombre y producto rara vez son "corregidos" por el lead
  [SLOTS.NOMBRE]:   'first_write_wins',
  [SLOTS.PRODUCTO]: 'first_write_wins',
  
  // Overwrite-if-new: sobrescribe si el nuevo valor es diferente y no-null
  // Razón: lead puede corregir su empresa/experiencia con info más precisa
  [SLOTS.EMPRESA]:     'overwrite_if_new',
  [SLOTS.EXPERIENCIA]: 'overwrite_if_new',
  
  // Always-overwrite: el nuevo valor siempre gana si existe
  // Razón: estos son datos dinámicos que cambian naturalmente
  [SLOTS.FECHA_HORA]:   'always_overwrite',
  [SLOTS.CANTIDAD]:     'always_overwrite',
  [SLOTS.MONTO]:        'always_overwrite',
  [SLOTS.PAIS_DESTINO]: 'always_overwrite'
}

// Default policy para slots no listados (defensivo)
const DEFAULT_POLICY = 'overwrite_if_new'

// ════════════════════════════════════════════════════════
// FUNCIÓN NÚCLEO — mergeSlots()
// ════════════════════════════════════════════════════════

/**
 * Mergea slots actuales con slots nuevos del turno.
 * Aplica política específica por cada slot.
 * 
 * @param {object} actuales - slots_filled del lead_state actual
 * @param {object} nuevos - slots extraídos del turno actual (Perception entities)
 * @returns {object} {
 *   merged: object,        // slots después del merge
 *   changes: object,       // log de qué cambió y por qué
 *   change_count: number   // cuántos slots fueron modificados
 * }
 */
export function mergeSlots(actuales = {}, nuevos = {}) {
  const merged = { ...actuales }
  const changes = {}
  let changeCount = 0

  for (const [slotKey, newValue] of Object.entries(nuevos)) {
    // Saltar valores vacíos del nuevo turno
    if (newValue === null || newValue === undefined || newValue === '') {
      continue
    }

    const currentValue = actuales[slotKey]
    const policy = MERGE_POLICIES[slotKey] || DEFAULT_POLICY
    const decision = applyMergePolicy(policy, currentValue, newValue)

    if (decision.shouldUpdate) {
      merged[slotKey] = newValue
      changes[slotKey] = {
        old: currentValue,
        new: newValue,
        policy,
        reason: decision.reason
      }
      changeCount++
    }
  }

  return {
    merged,
    changes,
    change_count: changeCount
  }
}

// ════════════════════════════════════════════════════════
// APLICAR POLÍTICA DE MERGE
// ════════════════════════════════════════════════════════

/**
 * Decide si actualizar un slot según su política.
 * 
 * @returns {object} { shouldUpdate: boolean, reason: string }
 */
function applyMergePolicy(policy, currentValue, newValue) {
  const isCurrentEmpty = (
    currentValue === null || 
    currentValue === undefined || 
    currentValue === ''
  )

  switch (policy) {
    case 'first_write_wins':
      // Solo actualiza si el slot está vacío
      if (isCurrentEmpty) {
        return { shouldUpdate: true, reason: 'first_write' }
      }
      return { shouldUpdate: false, reason: 'first_write_already_set' }

    case 'overwrite_if_new':
      // Actualiza si está vacío O si el nuevo valor es diferente
      if (isCurrentEmpty) {
        return { shouldUpdate: true, reason: 'overwrite_was_empty' }
      }
      if (currentValue !== newValue) {
        return { shouldUpdate: true, reason: 'overwrite_value_changed' }
      }
      return { shouldUpdate: false, reason: 'overwrite_same_value' }

 case 'always_overwrite':
      // Actualiza solo si el valor realmente cambia
      if (currentValue === newValue) {
        return { shouldUpdate: false, reason: 'always_overwrite_same_value' }
      }
      return { shouldUpdate: true, reason: 'always_overwrite' }

    default:
      // Política desconocida: defensivamente, no actualizar
      return { shouldUpdate: false, reason: `unknown_policy:${policy}` }
  }
}

// ════════════════════════════════════════════════════════
// HELPERS PÚBLICOS
// ════════════════════════════════════════════════════════

/**
 * Cuenta cuántos slots están llenos en un objeto slots_filled
 * Útil para calcular "completitud" del perfil
 */
export function countFilledSlots(slotsFilled = {}) {
  let count = 0
  for (const value of Object.values(slotsFilled)) {
    if (value !== null && value !== undefined && value !== '') {
      count++
    }
  }
  return count
}

/**
 * Calcula el % de completitud del perfil (0-1)
 * Considera solo los 8 slots oficiales del catálogo
 */
export function calculateProfileCompleteness(slotsFilled = {}) {
  const totalSlots = Object.values(SLOTS).length  // 8
  const filledCount = countFilledSlots(slotsFilled)
  return filledCount / totalSlots
}

/**
 * Devuelve lista de slots faltantes (vacíos) del catálogo
 */
export function getMissingSlots(slotsFilled = {}) {
  return Object.values(SLOTS).filter(slotKey => {
    const value = slotsFilled[slotKey]
    return value === null || value === undefined || value === ''
  })
}

/**
 * Devuelve lista de slots llenos del catálogo
 */
export function getFilledSlots(slotsFilled = {}) {
  return Object.values(SLOTS).filter(slotKey => {
    const value = slotsFilled[slotKey]
    return value !== null && value !== undefined && value !== ''
  })
}

/**
 * Filtra slots para extraer SOLO los del catálogo oficial
 * Útil para limpiar input que podría tener keys extras
 */
export function sanitizeSlots(rawSlots = {}) {
  const clean = {}
  const validKeys = Object.values(SLOTS)
  for (const key of validKeys) {
    if (rawSlots[key] !== undefined) {
      clean[key] = rawSlots[key]
    }
  }
  return clean
}

// ════════════════════════════════════════════════════════
// HELPER DE DEBUG
// ════════════════════════════════════════════════════════

/**
 * Devuelve resumen humano de un merge para logs
 */
export function summarizeMerge(mergeResult) {
  if (!mergeResult) return 'no merge'
  
  if (mergeResult.change_count === 0) {
    return 'no changes'
  }
  
  const changesList = Object.entries(mergeResult.changes).map(
    ([slot, info]) => `${slot}: ${formatValue(info.old)}→${formatValue(info.new)}`
  )
  
  return `${mergeResult.change_count} change${mergeResult.change_count > 1 ? 's' : ''}: ${changesList.join(', ')}`
}

/**
 * Formatea un valor para display en logs
 */
function formatValue(v) {
  if (v === null || v === undefined) return '∅'
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (typeof v === 'string' && v.length > 20) return `"${v.slice(0, 20)}..."`
  return `"${v}"`
}

// ════════════════════════════════════════════════════════
// VERSIÓN PARA TRACKING
// ════════════════════════════════════════════════════════
export const CONTEXT_GRAPH_VERSION = 'v1_simple_per_slot_policies'
