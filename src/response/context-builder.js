// src/response/context-builder.js — Hidata v20 Día 6
//
// CONTEXT BUILDER — Filtra contexto por action_type
//
// Objetivo: reducir tokens pasados a Gemini un 70-80% pasando solo
// lo que cada prompt/template necesita.
//
// Cada action declara EXPLÍCITAMENTE qué variables necesita.
// Si falta algo, usamos defaults seguros (no null, no undefined).
//
// CERO side effects. CERO BD. CERO LLM.

import { ACTIONS, OBJECTION_STRATEGIES } from '../policy/action-types.js'

// ════════════════════════════════════════════════════════
// DEFAULTS SEGUROS
// Si un slot está vacío, usamos un valor legible
// ════════════════════════════════════════════════════════
const SAFE_DEFAULTS = {
  nombre:         'amigo',
  producto:       'tu producto',
  vendorNombre:   'el equipo de Peru Exporta',
  pais_destino:   'el mercado internacional',
  fecha_hora:     null,  // si es null, prompt dispara propuesta de horarios
  monto:          null,
  empresa_status: 'aún no me dijo',
  experiencia_status: 'aún no me dijo'
}

// ════════════════════════════════════════════════════════
// FUNCIÓN NÚCLEO — buildResponseContext()
// ════════════════════════════════════════════════════════

/**
 * Construye el contexto filtrado para Response Layer según action_type.
 * Solo pasa lo que el prompt/template realmente necesita.
 * 
 * @param {object} params
 * @param {string} params.actionType - Action que decidió Policy
 * @param {string} params.strategy - Strategy específica (si MANEJAR_OBJECION)
 * @param {object} params.leadState - lead_state actualizado
 * @param {object} params.perception - Output de Perception
 * @param {object} params.vendor - Info del vendor asignado
 * @param {object} params.tenantSettings - Settings del tenant
 * @param {string} params.ultimoMensaje - Texto del lead en este turno
 * @returns {object} contexto filtrado listo para template/prompt
 */
export function buildResponseContext({
  actionType,
  strategy = null,
  leadState = {},
  perception = {},
  vendor = {},
  tenantSettings = {},
  ultimoMensaje = ''
}) {
  // ─── Extraer slots con defaults seguros ───
  const slots = leadState?.slotsFilled || {}
  const safeName = slots.nombre || SAFE_DEFAULTS.nombre
  const safeProducto = slots.producto || SAFE_DEFAULTS.producto
  const safeVendor = vendor?.nombre || SAFE_DEFAULTS.vendorNombre
  const safePais = slots.pais_destino || SAFE_DEFAULTS.pais_destino

  // ─── Empresa/experiencia formateados ───
  const empresaStatus = formatEmpresaStatus(slots.empresa)
  const experienciaStatus = formatExperienciaStatus(slots.experiencia)

  // ─── Switch por action_type ───
  switch (actionType) {

    // ════════════════════════════════════════════════════
    // TEMPLATES SIMPLES — pasan solo lo esencial
    // ════════════════════════════════════════════════════
    case ACTIONS.SALUDAR_INICIAL:
      return {
        vendorNombre: safeVendor
      }

    case ACTIONS.PEDIR_CALIFICACION:
      return {}  // no requiere variables

    case ACTIONS.PEDIR_SITUACION_EMPRESA:
      return {
        nombre: safeName,
        producto: safeProducto
      }

    case ACTIONS.GREET_RETURNING:
      return {
        nombre: safeName,
        producto: safeProducto
      }

    case ACTIONS.CONFIRMAR_PAGO:
      return {
        nombre: safeName,
        vendorNombre: safeVendor
      }

    // ════════════════════════════════════════════════════
    // LLM PROMPTS — pasan contexto rico pero filtrado
    // ════════════════════════════════════════════════════
    case ACTIONS.PRESENTAR_PROGRAMA:
      return {
        nombre: safeName,
        producto: safeProducto,
        empresa_status: empresaStatus,
        experiencia_status: experienciaStatus,
        ultimo_mensaje: truncateMessage(ultimoMensaje, 200)
      }

    case ACTIONS.MANEJAR_OBJECION:
      return {
        nombre: safeName,
        producto: safeProducto,
        stage: leadState?.currentStage || 'unknown',
        strategy: strategy || OBJECTION_STRATEGIES.GENERICA,
        ultimo_mensaje: truncateMessage(ultimoMensaje, 200),
        rationale: truncateMessage(perception?.rationale || '', 300)
      }

    case ACTIONS.AGENDAR_LLAMADA:
      return {
        nombre: safeName,
        producto: safeProducto,
        stage: leadState?.currentStage || 'unknown',
        fecha_hora: slots.fecha_hora || null,
        ultimo_mensaje: truncateMessage(ultimoMensaje, 200),
        vendorNombre: safeVendor
      }

    case ACTIONS.SILENCE:
      return {}  // no se va a usar, pero devolvemos algo válido

    default:
      // Fallback defensivo: si llega un action desconocido, contexto básico
      console.warn(`[ContextBuilder] Action desconocida: ${actionType}, usando defaults`)
      return {
        nombre: safeName,
        producto: safeProducto,
        vendorNombre: safeVendor
      }
  }
}

// ════════════════════════════════════════════════════════
// HELPERS — formatters para slots booleanos
// ════════════════════════════════════════════════════════

/**
 * Convierte slots.empresa (true/false/null) a texto legible
 */
function formatEmpresaStatus(empresaSlot) {
  if (empresaSlot === true) return 'tiene empresa constituida'
  if (empresaSlot === false) return 'es independiente, sin empresa formal'
  return SAFE_DEFAULTS.empresa_status  // null/undefined
}

/**
 * Convierte slots.experiencia (true/false/null) a texto legible
 */
function formatExperienciaStatus(expSlot) {
  if (expSlot === true) return 'ya tiene experiencia exportando'
  if (expSlot === false) return 'es su primera vez exportando'
  return SAFE_DEFAULTS.experiencia_status  // null/undefined
}

/**
 * Trunca mensajes largos para que no infle el prompt
 * @param {string} text 
 * @param {number} maxLength 
 */
function truncateMessage(text, maxLength = 200) {
  if (!text) return ''
  if (text.length <= maxLength) return text
  return text.substring(0, maxLength) + '...'
}

// ════════════════════════════════════════════════════════
// HELPER PÚBLICO — para debug
// ════════════════════════════════════════════════════════

/**
 * Devuelve resumen del contexto (sin valores largos) para logs
 */
export function summarizeContext(context) {
  if (!context) return 'empty'
  
  const keys = Object.keys(context)
  const summary = keys.map(k => {
    const val = context[k]
    if (typeof val === 'string' && val.length > 30) {
      return `${k}=<${val.length} chars>`
    }
    return `${k}=${val}`
  }).join(', ')
  
  return `{${summary}}`
}

// ════════════════════════════════════════════════════════
// VERSION TRACKING
// ════════════════════════════════════════════════════════
export const CONTEXT_BUILDER_VERSION = 'v1_day6_selective_per_action'