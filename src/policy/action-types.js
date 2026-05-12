// src/policy/action-types.js — Hidata v20 Día 5
//
// CATÁLOGO DE ACTIONS — Policy Layer
//
// 9 action types core que cubren el flujo completo M1-M7 v19.
// Cada action es una ESTRATEGIA de alto nivel.
// Response Layer (Día 6) decide la TÁCTICA (palabras, montos exactos).
//
// Las variantes específicas de objeciones (precio, tiempo, dinero, familia, etc)
// se manejan con STRATEGIES dentro de handle_objection.

// ════════════════════════════════════════════════════════
// ACTION TYPES — 9 acciones core
// ════════════════════════════════════════════════════════
export const ACTIONS = {
  // Saludo inicial / Discovery
  SALUDAR_INICIAL:           'saludar_inicial',            // M1: bot saluda lead nuevo
  
  // Calificación
  PEDIR_CALIFICACION:        'pedir_calificacion',         // M2: pedir nombre + producto + experiencia
  PEDIR_SITUACION_EMPRESA:   'pedir_situacion_empresa',    // M3: empresa o independiente
  
  // Presentación y manejo de objeciones
  PRESENTAR_PROGRAMA:        'presentar_programa',         // M4: presentar curso + precio
  MANEJAR_OBJECION:          'manejar_objecion',           // Maneja objeciones (con strategy específica)
  
  // Cierre y agendamiento
  AGENDAR_LLAMADA:           'agendar_llamada',            // M5: pedir/confirmar horario
  CONFIRMAR_PAGO:            'confirmar_pago',             // Post-comprobante yape
  
  // Special cases
  GREET_RETURNING:           'greet_returning',            // Lead vuelve después de 30+ días
  
  // No respuesta
  SILENCE:                   'silence'                     // PAUSED/HUMAN_ACTIVE/mode permite no responder
}

// Array para validaciones
export const VALID_ACTIONS = Object.values(ACTIONS)

// ════════════════════════════════════════════════════════
// OBJECTION STRATEGIES — sub-tipos de manejar_objecion
// Estas son las TÁCTICAS específicas dentro de handle_objection
// Cada una mapea a una técnica de Peru Exporta validada
// ════════════════════════════════════════════════════════
export const OBJECTION_STRATEGIES = {
  // Precio
  PRECIO_REFRAME:            'precio_reframe',             // Reframe precio como inversión vs costo
  
  // Decisión
  DECISION_QUALIFY:          'decision_qualify',           // Calificar si la consulta es real o evasiva
  
  // Timing de pago
  TIMING_FRAGMENTAR:         'timing_fragmentar',          // 50/50 o cuotas
  
  // Estacional
  ESTACIONAL_SINCRONIZAR:    'estacional_sincronizar',     // Curso termina cuando empieza cosecha
  
  // Validación / Confianza
  VALIDACION_ENVIAR_ASSETS:  'validacion_enviar_assets',   // Mandar casos de éxito
  
  // Tiempo (no tengo tiempo)
  TIEMPO_CASCADA_FLEXIBLE:   'tiempo_cascada_flexible',    // Grabaciones + asesorías
  
  // Dinero (no tengo dinero ahora)
  DINERO_50_50_DEFAULT:      'dinero_50_50_default',       // Separar 50% + saldo
  
  // Familia/Socio (consulto con X)
  FAMILIA_FECHA_ESPECIFICA:  'familia_fecha_especifica',   // Acordar fecha de re-confirmación
  
  // Horario (sábados no puedo)
  HORARIO_CASCADA:           'horario_cascada',            // Grabaciones + flexibilidad
  
  // Ya gastó en otra cosa
  YA_GASTE_EMPATIA_MICRO:    'ya_gaste_empatia_micro',     // Empatía + micro-compromiso S/100
  
  // Default genérico cuando no se identifica
  GENERICA:                  'generica'                    // Manejo genérico de objeción
}

export const VALID_OBJECTION_STRATEGIES = Object.values(OBJECTION_STRATEGIES)

// ════════════════════════════════════════════════════════
// METADATA POR ACTION — descripción, requirements, next_stage_hint
// Esto guía a Response Layer (Día 6) sobre qué generar
// ════════════════════════════════════════════════════════
export const ACTION_METADATA = {
  [ACTIONS.SALUDAR_INICIAL]: {
    description:        'Bot saluda al lead por primera vez',
    requires_slots:     [],
    next_stage_hint:    'discovery',
    bot_should_respond: true,
    requires_human:     false
  },
  
  [ACTIONS.PEDIR_CALIFICACION]: {
    description:        'Pedir nombre, producto y experiencia exportando',
    requires_slots:     [],
    next_stage_hint:    'qualifying_empresa',
    bot_should_respond: true,
    requires_human:     false
  },
  
  [ACTIONS.PEDIR_SITUACION_EMPRESA]: {
    description:        'Preguntar si tiene empresa constituida o trabaja independiente',
    requires_slots:     ['nombre', 'producto'],
    next_stage_hint:    'presenting',
    bot_should_respond: true,
    requires_human:     false
  },
  
  [ACTIONS.PRESENTAR_PROGRAMA]: {
    description:        'Presentar curso/programa con precio promocional',
    requires_slots:     ['nombre', 'producto', 'empresa', 'experiencia'],
    next_stage_hint:    'call_scheduling',
    bot_should_respond: true,
    requires_human:     false
  },
  
  [ACTIONS.MANEJAR_OBJECION]: {
    description:        'Manejar objeción con estrategia específica',
    requires_slots:     [],  // varía según strategy
    next_stage_hint:    null,  // se mantiene en stage actual usualmente
    bot_should_respond: true,
    requires_human:     false
  },
  
  [ACTIONS.AGENDAR_LLAMADA]: {
    description:        'Pedir o confirmar horario de llamada',
    requires_slots:     ['nombre'],
    next_stage_hint:    'call_confirmed',
    bot_should_respond: true,
    requires_human:     false
  },
  
  [ACTIONS.CONFIRMAR_PAGO]: {
    description:        'Confirmar recepción de pago + notificar vendedor',
    requires_slots:     ['nombre'],
    next_stage_hint:    'post_close',
    bot_should_respond: true,
    requires_human:     true  // notificar vendor humano
  },
  
  [ACTIONS.GREET_RETURNING]: {
    description:        'Saludar lead que regresa después de 30+ días',
    requires_slots:     [],
    next_stage_hint:    'discovery',  // re-calificación suave
    bot_should_respond: true,
    requires_human:     false
  },
  
  [ACTIONS.SILENCE]: {
    description:        'No responder (modo PAUSED, HUMAN_ACTIVE, etc)',
    requires_slots:     [],
    next_stage_hint:    null,
    bot_should_respond: false,
    requires_human:     false
  }
}

// ════════════════════════════════════════════════════════
// OBJECTION STRATEGY METADATA — guía para Response Layer
// ════════════════════════════════════════════════════════
export const OBJECTION_STRATEGY_METADATA = {
  [OBJECTION_STRATEGIES.PRECIO_REFRAME]: {
    description:    'Reframe precio: inversión vs costo de no exportar',
    response_hint:  'Comparar S/X con cuánto deja de ganar cada mes sin exportar',
    requires_slots: ['producto']
  },
  
  [OBJECTION_STRATEGIES.DECISION_QUALIFY]: {
    description:    'Calificar si "consulto con X" es real o evasivo',
    response_hint:  'Pedir fecha específica de re-confirmación',
    requires_slots: []
  },
  
  [OBJECTION_STRATEGIES.TIMING_FRAGMENTAR]: {
    description:    'Ofrecer fragmentación de pago (50/50 o cuotas)',
    response_hint:  'Proponer separar con X% + saldo en N cuotas',
    requires_slots: []
  },
  
  [OBJECTION_STRATEGIES.ESTACIONAL_SINCRONIZAR]: {
    description:    'Sincronizar curso con calendario del lead',
    response_hint:  'Mostrar cómo el curso termina cuando empieza su cosecha',
    requires_slots: ['producto']
  },
  
  [OBJECTION_STRATEGIES.VALIDACION_ENVIAR_ASSETS]: {
    description:    'Enviar casos de éxito + testimonios',
    response_hint:  'Compartir 2-3 casos similares al producto del lead',
    requires_slots: ['producto']
  },
  
  [OBJECTION_STRATEGIES.TIEMPO_CASCADA_FLEXIBLE]: {
    description:    'Resolver "no tengo tiempo" con flexibilidad',
    response_hint:  'Grabaciones disponibles + asesorías 1:1',
    requires_slots: []
  },
  
  [OBJECTION_STRATEGIES.DINERO_50_50_DEFAULT]: {
    description:    'Resolver "no tengo dinero" con 50/50',
    response_hint:  'Separar 50% + resto antes de iniciar programa',
    requires_slots: []
  },
  
  [OBJECTION_STRATEGIES.FAMILIA_FECHA_ESPECIFICA]: {
    description:    'Resolver "consulto con familia" con fecha de re-confirmación',
    response_hint:  '"¿Cuándo podríamos confirmar?" + fecha específica',
    requires_slots: []
  },
  
  [OBJECTION_STRATEGIES.HORARIO_CASCADA]: {
    description:    'Resolver objeción de horario con cascada',
    response_hint:  'Grabaciones + flexibilidad de asesorías',
    requires_slots: []
  },
  
  [OBJECTION_STRATEGIES.YA_GASTE_EMPATIA_MICRO]: {
    description:    'Empatía + micro-compromiso para "ya gasté en X"',
    response_hint:  'Reconocer + proponer S/100 de separación',
    requires_slots: []
  },
  
  [OBJECTION_STRATEGIES.GENERICA]: {
    description:    'Manejo genérico cuando no se identifica estrategia',
    response_hint:  'Reconocer + redirigir a calificación',
    requires_slots: []
  }
}

// ════════════════════════════════════════════════════════
// PRIORIDAD DE ACCIONES — resolución de conflictos
// Cuando múltiples acciones aplican, gana la de mayor prioridad
// ════════════════════════════════════════════════════════
export const ACTION_PRIORITY = {
  [ACTIONS.SILENCE]:                100, // PAUSED/HUMAN_ACTIVE override TODO
  [ACTIONS.CONFIRMAR_PAGO]:          95, // Pago detectado, máxima prioridad
  [ACTIONS.MANEJAR_OBJECION]:        80, // Objeción detectada, manejar antes de avanzar
  [ACTIONS.GREET_RETURNING]:         75, // Returning lead, reconocer primero
  [ACTIONS.AGENDAR_LLAMADA]:         70, // Lead HOT pidiendo llamada
  [ACTIONS.PRESENTAR_PROGRAMA]:      60, // Avance natural del flujo
  [ACTIONS.PEDIR_SITUACION_EMPRESA]: 50, // Avance natural del flujo
  [ACTIONS.PEDIR_CALIFICACION]:      40, // Avance natural del flujo
  [ACTIONS.SALUDAR_INICIAL]:         30  // Base, primer turno
}

// ════════════════════════════════════════════════════════
// HELPERS PUROS
// ════════════════════════════════════════════════════════

/**
 * Valida si un action type es válido del catálogo
 */
export function isValidAction(action) {
  return VALID_ACTIONS.includes(action)
}

/**
 * Valida si una objection strategy es válida
 */
export function isValidObjectionStrategy(strategy) {
  return VALID_OBJECTION_STRATEGIES.includes(strategy)
}

/**
 * Devuelve la metadata de una action
 */
export function getActionMetadata(action) {
  return ACTION_METADATA[action] || null
}

/**
 * Devuelve la metadata de una objection strategy
 */
export function getObjectionStrategyMetadata(strategy) {
  return OBJECTION_STRATEGY_METADATA[strategy] || null
}

/**
 * Devuelve la prioridad de una action (0 si no existe)
 */
export function getActionPriority(action) {
  return ACTION_PRIORITY[action] || 0
}

/**
 * Compara dos actions y devuelve la de mayor prioridad
 */
export function getHigherPriorityAction(actionA, actionB) {
  const priA = getActionPriority(actionA)
  const priB = getActionPriority(actionB)
  return priA >= priB ? actionA : actionB
}

/**
 * Verifica si una action requiere ciertos slots
 * @returns {object} { canExecute: boolean, missingSlots: string[] }
 */
export function checkActionRequirements(action, slotsFilled = {}) {
  const meta = ACTION_METADATA[action]
  if (!meta) return { canExecute: false, missingSlots: [] }
  
  const required = meta.requires_slots || []
  const missing = required.filter(slot => {
    const value = slotsFilled[slot]
    return value === null || value === undefined || value === ''
  })
  
  return {
    canExecute: missing.length === 0,
    missingSlots: missing
  }
}

// ════════════════════════════════════════════════════════
// VERSION TRACKING
// ════════════════════════════════════════════════════════
export const ACTION_TYPES_VERSION = 'v1_day5_9_core_actions'