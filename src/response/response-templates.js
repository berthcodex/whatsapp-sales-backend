// src/response/response-templates.js — Hidata v20 Día 6
//
// TEMPLATE GENERATOR — Genera respuestas desde templates puros
//
// Sin LLM. Determinístico. Rápido (~5ms).
// Para acciones triviales: SALUDAR_INICIAL, PEDIR_CALIFICACION,
// PEDIR_SITUACION_EMPRESA, GREET_RETURNING, CONFIRMAR_PAGO
//
// Output format compatible con LLM response (ok, text, meta).

import { getTemplate, getFallbackTemplate, substituteVariables } from './response-prompts.js'

// ════════════════════════════════════════════════════════
// FUNCIÓN NÚCLEO — generateTemplateResponse()
// ════════════════════════════════════════════════════════

/**
 * Genera respuesta desde template puro (sin LLM).
 * 
 * @param {object} params
 * @param {string} params.actionType - Action que decidió Policy
 * @param {object} params.context - Contexto filtrado del context-builder
 * @returns {object} {
 *   ok: boolean,
 *   text: string|null,
 *   meta: {
 *     model_used, tokens_used, cost_usd, latency_ms,
 *     prompt_version, generation_method, errors
 *   }
 * }
 */
export function generateTemplateResponse({ actionType, context }) {
  const startTime = Date.now()
  const errors = []

  // ─── 1. Obtener template ───
  const template = getTemplate(actionType)
  
  if (!template) {
    errors.push(`No template defined for action: ${actionType}`)
    
    // Intentar fallback genérico
    const fallback = getFallbackTemplate(actionType)
    if (fallback) {
      const filledFallback = substituteVariables(fallback, context)
      return {
        ok: true,
        text: filledFallback,
        meta: {
          model_used: 'template_only',
          tokens_used: 0,
          cost_usd: 0,
          latency_ms: Date.now() - startTime,
          prompt_version: 'fallback',
          generation_method: 'fallback_template',
          errors
        }
      }
    }
    
    return buildErrorResponse({ errors, startTime })
  }

  // ─── 2. Validar que template tenga texto ───
  if (!template.text) {
    errors.push(`Template for ${actionType} has no text`)
    return buildErrorResponse({ errors, startTime })
  }

  // ─── 3. Substituir variables ───
  const filledText = substituteVariables(template.text, context)

  // ─── 4. Validar resultado ───
  if (!filledText || filledText.length < 10) {
    errors.push(`Filled template too short: ${filledText?.length || 0} chars`)
    return buildErrorResponse({ errors, startTime })
  }

  // ─── 5. Devolver respuesta exitosa ───
  return {
    ok: true,
    text: filledText,
    meta: {
      model_used: 'template_only',
      tokens_used: 0,
      cost_usd: 0,
      latency_ms: Date.now() - startTime,
      prompt_version: template.version,
      generation_method: 'template',
      errors
    }
  }
}

// ════════════════════════════════════════════════════════
// FUNCIÓN — generateFallbackResponse()
// Usado cuando LLM falla y necesitamos backup template
// ════════════════════════════════════════════════════════

/**
 * Genera respuesta usando SOLO el fallback template.
 * Llamado por response.js cuando LLM falla.
 * 
 * @param {object} params
 * @param {string} params.actionType
 * @param {object} params.context
 * @returns {object} mismo formato que generateTemplateResponse
 */
export function generateFallbackResponse({ actionType, context }) {
  const startTime = Date.now()
  const errors = []

  const fallback = getFallbackTemplate(actionType)
  
  if (!fallback) {
    errors.push(`No fallback template for action: ${actionType}`)
    return buildErrorResponse({ errors, startTime })
  }

  const filledText = substituteVariables(fallback, context)

  if (!filledText || filledText.length < 10) {
    errors.push(`Fallback template too short after fill`)
    return buildErrorResponse({ errors, startTime })
  }

  return {
    ok: true,
    text: filledText,
    meta: {
      model_used: 'fallback_template',
      tokens_used: 0,
      cost_usd: 0,
      latency_ms: Date.now() - startTime,
      prompt_version: 'fallback',
      generation_method: 'llm_fallback_template',
      errors
    }
  }
}

// ════════════════════════════════════════════════════════
// HELPER — Build error response
// ════════════════════════════════════════════════════════

function buildErrorResponse({ errors, startTime }) {
  return {
    ok: false,
    text: null,
    meta: {
      model_used: 'template_only',
      tokens_used: 0,
      cost_usd: 0,
      latency_ms: Date.now() - startTime,
      prompt_version: null,
      generation_method: 'template_failed',
      errors
    }
  }
}

// ════════════════════════════════════════════════════════
// HELPER PÚBLICO — para debug
// ════════════════════════════════════════════════════════

/**
 * Devuelve resumen humano del resultado template
 */
export function summarizeTemplateResult(result) {
  if (!result) return 'no result'

  if (!result.ok) {
    return `❌ Template failed: ${result.meta?.errors?.[0] || 'unknown'} (${result.meta?.latency_ms}ms)`
  }

  const method = result.meta?.generation_method || 'unknown'
  return `✅ ${method} ok (${result.text?.length || 0} chars, ${result.meta?.latency_ms}ms)`
}

// ════════════════════════════════════════════════════════
// VERSION TRACKING
// ════════════════════════════════════════════════════════
export const RESPONSE_TEMPLATES_VERSION = 'v1_day6_pure_templates'