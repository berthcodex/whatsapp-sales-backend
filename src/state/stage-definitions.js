// src/state/stage-definitions.js — Hidata v20
//
// CATÁLOGO MAESTRO del State Layer
//
// 3 conceptos clave:
//   1. STAGES   → momento del flujo conversacional (8 estados)
//   2. MODES    → quién maneja la conversación (4 modos)
//   3. SLOTS    → datos del perfil del lead (8 campos)
//
// Mapping bidireccional con v19 para que ambos motores coexistan
// hasta Día 7 cuando apaguemos v19.

// ════════════════════════════════════════════════════════
// STAGES — momento conversacional (8 estados)
// Mapean 1-a-1 con los momentos M1-M7 de v19 + returning_recognition
// ════════════════════════════════════════════════════════
export const STAGES = {
  FIRST_CONTACT:         'first_contact',          // M1 — lead nuevo, antes de saludar
  DISCOVERY:             'discovery',              // M2 — pidiendo nombre + producto
  QUALIFYING_EMPRESA:    'qualifying_empresa',     // M3 — empresa o independiente
  PRESENTING:            'presenting',             // M4 — presentando programa con precio
  CALL_SCHEDULING:       'call_scheduling',        // M5 — coordinando horario
  CALL_CONFIRMED:        'call_confirmed',         // M6 — horario confirmado
  POST_CLOSE:            'post_close',             // M7 — post-agendado
  RETURNING_RECOGNITION: 'returning_recognition'   // v20 especial — lead reactivado
}

// Array para validaciones
export const VALID_STAGES = Object.values(STAGES)

// ════════════════════════════════════════════════════════
// MODES — quién maneja la conversación (4 modos)
// ════════════════════════════════════════════════════════
export const MODES = {
  AUTO_CONSULTIVO: 'AUTO_CONSULTIVO',  // Bot maneja, modo calificación
  AUTO_CLOSING:    'AUTO_CLOSING',     // Bot maneja, modo cierre rápido
  HUMAN_ACTIVE:    'HUMAN_ACTIVE',     // Vendedor humano respondió, bot callado
  PAUSED:          'PAUSED'            // Lead pausado/cerrado/archivado
}

export const VALID_MODES = Object.values(MODES)

// ════════════════════════════════════════════════════════
// MAPPING v20 → v19 — para sincronizar con motor viejo
// ════════════════════════════════════════════════════════

// Stage v20 → pasoActual v19 (1-7)
export const STAGE_TO_PASO_ACTUAL = {
  [STAGES.FIRST_CONTACT]:         1,
  [STAGES.DISCOVERY]:             2,
  [STAGES.QUALIFYING_EMPRESA]:    3,
  [STAGES.PRESENTING]:            4,
  [STAGES.CALL_SCHEDULING]:       5,
  [STAGES.CALL_CONFIRMED]:        6,
  [STAGES.POST_CLOSE]:            7,
  [STAGES.RETURNING_RECOGNITION]: 1  // reactiva como nuevo
}

// Mode v20 → lead.estado v19 (solo se sincroniza en casos críticos)
// null significa "no tocar lead.estado, dejarlo como esté"
export const MODE_TO_LEAD_ESTADO = {
  [MODES.AUTO_CONSULTIVO]: null,        // no tocar, dejar EN_FLUJO
  [MODES.AUTO_CLOSING]:    null,        // no tocar, dejar EN_FLUJO
  [MODES.HUMAN_ACTIVE]:    null,        // no tocar (humano activo)
  [MODES.PAUSED]:          'CERRADO'    // SÍ sincronizar — v19 debe parar
}

// ════════════════════════════════════════════════════════
// SLOTS — campos del perfil que se llenan progresivamente
// ════════════════════════════════════════════════════════

// Estos son los 8 slots que Perception extrae como entities
export const SLOTS = {
  NOMBRE:       'nombre',
  PRODUCTO:     'producto',
  CANTIDAD:     'cantidad',
  PAIS_DESTINO: 'pais_destino',
  FECHA_HORA:   'fecha_hora',
  MONTO:        'monto',
  EMPRESA:      'empresa',      // boolean: true=tiene empresa, false=independiente
  EXPERIENCIA:  'experiencia'   // boolean: true=tiene experiencia, false=primera vez
}

export const VALID_SLOTS = Object.values(SLOTS)

// De estos 8 slots, ¿cuáles tienen columnas equivalentes en lead?
// El State Layer va a sincronizar AMBOS: lead_state.slots_filled + lead.X
export const SLOT_TO_LEAD_COLUMN = {
  [SLOTS.NOMBRE]:   'nombreDetectado',
  [SLOTS.PRODUCTO]: 'productoDetectado'
  // Los otros 6 solo viven en lead_state.slots_filled (no hay columnas)
}

// ════════════════════════════════════════════════════════
// SLOTS REQUERIDOS POR STAGE
// Para avanzar de un stage al siguiente, ciertos slots deben estar llenos
// ════════════════════════════════════════════════════════
export const REQUIRED_SLOTS_BY_STAGE = {
  [STAGES.FIRST_CONTACT]:         [],  // nada requerido para saludar
  [STAGES.DISCOVERY]:             [],  // estamos descubriendo, todavía no exigimos
  [STAGES.QUALIFYING_EMPRESA]:    [SLOTS.NOMBRE, SLOTS.PRODUCTO],  // necesitamos básicos
  [STAGES.PRESENTING]:            [SLOTS.NOMBRE, SLOTS.PRODUCTO, SLOTS.EMPRESA, SLOTS.EXPERIENCIA],
  [STAGES.CALL_SCHEDULING]:       [SLOTS.NOMBRE, SLOTS.PRODUCTO],  // mínimo para agendar
  [STAGES.CALL_CONFIRMED]:        [SLOTS.NOMBRE, SLOTS.FECHA_HORA],
  [STAGES.POST_CLOSE]:            [SLOTS.NOMBRE, SLOTS.FECHA_HORA],
  [STAGES.RETURNING_RECOGNITION]: []  // sin requisitos para reconocer regreso
}

// ════════════════════════════════════════════════════════
// MATRIZ DE TRANSICIONES PERMITIDAS
// Para cada stage actual, qué stages siguientes son válidos
// Las transiciones NO listadas se rechazan (stay_and_acknowledge)
// ════════════════════════════════════════════════════════
export const STAGE_TRANSITIONS = {
  [STAGES.FIRST_CONTACT]: {
    allowed_next: [
      STAGES.DISCOVERY,
      STAGES.RETURNING_RECOGNITION
    ],
    // Si el lead pide llamada en el primer turno (HOT) → saltar a call_scheduling
    fast_track: {
      'lead_pide_llamada_first_turn_HOT': STAGES.CALL_SCHEDULING
    },
    on_invalid: 'stay_and_acknowledge'
  },

  [STAGES.DISCOVERY]: {
    allowed_next: [
      STAGES.QUALIFYING_EMPRESA,
      STAGES.PRESENTING,
      STAGES.CALL_SCHEDULING  // si ya tiene perfil completo
    ],
    fast_track: {
      'lead_pide_llamada_first_turn_HOT': STAGES.CALL_SCHEDULING
    },
    on_invalid: 'stay_and_acknowledge'
  },

  [STAGES.QUALIFYING_EMPRESA]: {
    allowed_next: [
      STAGES.PRESENTING,
      STAGES.CALL_SCHEDULING
    ],
    on_invalid: 'stay_and_acknowledge'
  },

  [STAGES.PRESENTING]: {
    allowed_next: [
      STAGES.CALL_SCHEDULING,
      STAGES.PRESENTING  // puede quedarse aquí manejando objeciones
    ],
    // Si Perception detecta objeción, NO transicionamos pero sí marcamos
    on_objection: STAGES.PRESENTING,  // stay
    on_invalid: 'stay_and_acknowledge'
  },

  [STAGES.CALL_SCHEDULING]: {
    allowed_next: [
      STAGES.CALL_CONFIRMED,
      STAGES.CALL_SCHEDULING  // puede quedarse pidiendo el horario
    ],
    on_invalid: 'stay_and_acknowledge'
  },

  [STAGES.CALL_CONFIRMED]: {
    allowed_next: [
      STAGES.POST_CLOSE
    ],
    on_invalid: 'stay_and_acknowledge'
  },

  [STAGES.POST_CLOSE]: {
    allowed_next: [
      STAGES.POST_CLOSE  // este es terminal, solo se queda aquí
    ],
    on_invalid: 'stay_and_acknowledge'
  },

  [STAGES.RETURNING_RECOGNITION]: {
    allowed_next: [
      STAGES.DISCOVERY,
      STAGES.PRESENTING,
      STAGES.CALL_SCHEDULING
    ],
    on_invalid: 'stay_and_acknowledge'
  }
}

// ════════════════════════════════════════════════════════
// PERCEPTION INTENTS → STAGE INDICATORS
// Sugiere a qué stage podría avanzar según intent detectado
// El motor de transiciones decide si la sugerencia se aplica
// ════════════════════════════════════════════════════════
export const INTENT_SUGGESTS_STAGE = {
  // Intents que sugieren avance
  'greeting':           STAGES.DISCOVERY,
  'providing_info':     STAGES.QUALIFYING_EMPRESA,  // si ya dijo nombre+producto
  'ready_to_pay':       STAGES.POST_CLOSE,           // pagar = ya cerramos
  'paid':               STAGES.POST_CLOSE,
  'requesting_call':    STAGES.CALL_SCHEDULING,
  'confirming_schedule': STAGES.CALL_CONFIRMED,
  'returning_lead_acknowledge': STAGES.RETURNING_RECOGNITION,

  // Intents que NO sugieren avance (mantienen stage)
  'muletilla_aprobacion_suave': null,
  'muletilla_pregunta':         null,
  'confused':                   null,
  'off_topic':                  null,

  // Intents que sugieren retroceso o pausa
  'rejecting':          null  // se maneja con mode → PAUSED separado
}

// ════════════════════════════════════════════════════════
// HELPERS PUROS — sin side effects
// ════════════════════════════════════════════════════════

/**
 * Valida si un stage es válido del catálogo
 */
export function isValidStage(stage) {
  return VALID_STAGES.includes(stage)
}

/**
 * Valida si un mode es válido del catálogo
 */
export function isValidMode(mode) {
  return VALID_MODES.includes(mode)
}

/**
 * Devuelve el pasoActual v19 equivalente al stage v20
 */
export function getStagePasoActual(stage) {
  return STAGE_TO_PASO_ACTUAL[stage] || 1
}

/**
 * Devuelve el lead.estado que debe sincronizarse según el mode
 * Retorna null si el mode no requiere sincronización
 */
export function getModeLeadEstado(mode) {
  return MODE_TO_LEAD_ESTADO[mode] || null
}

/**
 * Lista los slots requeridos para llegar a un stage
 */
export function getRequiredSlotsForStage(stage) {
  return REQUIRED_SLOTS_BY_STAGE[stage] || []
}

/**
 * Verifica si un slots_filled tiene todos los slots requeridos para un stage
 * @param {string} stage - stage al que queremos llegar
 * @param {object} slotsFilled - slots actuales del lead
 * @returns {object} { canAdvance: boolean, missingSlots: string[] }
 */
export function canAdvanceToStage(stage, slotsFilled = {}) {
  const required = getRequiredSlotsForStage(stage)
  const missing = required.filter(slot => {
    const value = slotsFilled[slot]
    // null, undefined, '' cuentan como faltante
    return value === null || value === undefined || value === ''
  })
  return {
    canAdvance: missing.length === 0,
    missingSlots: missing
  }
}

/**
 * Verifica si una transición es permitida según la matriz
 * @returns {boolean}
 */
export function isTransitionAllowed(fromStage, toStage) {
  const config = STAGE_TRANSITIONS[fromStage]
  if (!config) return false
  return config.allowed_next.includes(toStage)
}

/**
 * Devuelve la configuración completa de transición para un stage
 */
export function getTransitionConfig(stage) {
  return STAGE_TRANSITIONS[stage] || null
}

/**
 * Sugiere stage siguiente según intent de Perception
 * Solo devuelve sugerencia, NO valida si es transición permitida
 */
export function suggestStageFromIntent(intent) {
  return INTENT_SUGGESTS_STAGE[intent] || null
}

/**
 * Aplica fast-track si el intent específico lo dispara
 * @param {string} currentStage
 * @param {string} intentSpecific
 * @returns {string|null} stage destino del fast-track o null
 */
export function getFastTrackStage(currentStage, intentSpecific) {
  const config = STAGE_TRANSITIONS[currentStage]
  if (!config || !config.fast_track) return null
  return config.fast_track[intentSpecific] || null
}

// ════════════════════════════════════════════════════════
// METADATA PARA DEBUG / LOGGING
// ════════════════════════════════════════════════════════

export const STAGE_DESCRIPTIONS = {
  [STAGES.FIRST_CONTACT]:         'Lead recién creado, antes de saludar',
  [STAGES.DISCOVERY]:             'Descubriendo perfil (nombre + producto)',
  [STAGES.QUALIFYING_EMPRESA]:    'Calificando: ¿empresa o independiente?',
  [STAGES.PRESENTING]:            'Presentando programa y precio',
  [STAGES.CALL_SCHEDULING]:       'Coordinando horario de llamada',
  [STAGES.CALL_CONFIRMED]:        'Horario de llamada confirmado',
  [STAGES.POST_CLOSE]:            'Post-cierre, esperando llamada o pago',
  [STAGES.RETURNING_RECOGNITION]: 'Lead reactivado tras 30+ días dormant'
}

export const MODE_DESCRIPTIONS = {
  [MODES.AUTO_CONSULTIVO]: 'Bot maneja calificación consultiva',
  [MODES.AUTO_CLOSING]:    'Bot maneja cierre rápido',
  [MODES.HUMAN_ACTIVE]:    'Vendedor humano activo, bot en silencio',
  [MODES.PAUSED]:          'Lead pausado, cerrado o archivado'
}

/**
 * Devuelve resumen humano del estado actual para logs
 */
export function describeLeadState(leadState) {
  if (!leadState) return 'lead_state: null'
  return `[${leadState.currentMode}] stage=${leadState.currentStage} | ${
    Object.keys(leadState.slotsFilled || {}).length
  } slots filled`
}

// ════════════════════════════════════════════════════════
// VERSIÓN PARA TRACKING
// Si cambiamos transiciones o stages, incrementar versión
// ════════════════════════════════════════════════════════
export const STATE_DEFINITIONS_VERSION = 'v1'