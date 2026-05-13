// src/response/response.js — Hidata v20 Día 6
//
// RESPONSE LAYER — Integrador del pipeline de generación de respuesta
//
// API pública: generarRespuesta({ policyDecision, leadState, perception, vendor, ultimoMensaje })
//
// Pipeline interno:
//   1. Verifica si bot_should_respond (si no → return no_response)
//   2. Construye contexto filtrado via buildResponseContext()
//   3. Dispatcha según RESPONSE_STRATEGY:
//      - 'template'      → generateTemplateResponse()
//      - 'llm'           → generateLLMResponse(), si falla → fallback template
//      - 'no_response'   → silence explícito
//   4. Construye botResponse rica para turn_trace
//
// CERO BD. CERO writes. CERO side effects.

import { 
  getResponseStrategy,
  RESPONSE_PROMPTS_VERSION
} from './response-prompts.js'

import { 
  buildResponseContext, 
  summarizeContext,
  CONTEXT_BUILDER_VERSION 
} from './context-builder.js'

import { 
  generateLLMResponse, 
  summarizeLLMResult,
  RESPONSE_LLM_VERSION 
} from './response-llm.js'

import { 
  generateTemplateResponse, 
  generateFallbackResponse,
  summarizeTemplateResult,
  RESPONSE_TEMPLATES_VERSION 
} from './response-templates.js'

// ════════════════════════════════════════════════════════
// API PÚBLICA — generarRespuesta()
// ════════════════════════════════════════════════════════

/**
 * Genera la respuesta del bot dado la decisión de Policy.
 * 
 * @param {object} params
 * @param {object} params.policyDecision - Decisión completa de Policy Layer
 * @param {object} params.leadState - lead_state actualizado
 * @param {object} params.perception - Output de Perception
 * @param {object} params.vendor - Info del vendor asignado
 * @param {object} params.tenantSettings - Settings del tenant
 * @param {string} params.ultimoMensaje - Texto del lead en este turno
 * @returns {object} botResponse rica con audit trail
 */
export async function generarRespuesta({
  policyDecision,
  leadState,
  perception,
  vendor = {},
  tenantSettings = {},
  ultimoMensaje = ''
}) {
  const startTime = Date.now()

  // ─── Validación defensiva ───
  if (!policyDecision) {
    return buildSilenceResponse({
      reason: 'policy_decision_missing',
      startTime
    })
  }

  const actionType = policyDecision?.action?.type
  const strategy = policyDecision?.action?.strategy
  const botShouldRespond = policyDecision?.action?.bot_should_respond

  if (!actionType) {
    return buildSilenceResponse({
      reason: 'no_action_type',
      startTime
    })
  }

  // ─── 1. Si bot_should_respond es false → silence ───
  if (botShouldRespond === false) {
    return buildSilenceResponse({
      reason: `bot_should_not_respond:${actionType}`,
      actionType,
      startTime
    })
  }

  try {
    // ─── 2. Construir contexto filtrado ───
    const context = buildResponseContext({
      actionType,
      strategy,
      leadState,
      perception,
      vendor,
      tenantSettings,
      ultimoMensaje
    })

    // ─── 3. Determinar strategy (template/LLM/no_response) ───
    const responseStrategy = getResponseStrategy(actionType)

    // ─── 4. Dispatch según strategy ───
    let result

    if (responseStrategy === 'template') {
      // ──────────────────────────────────────────
      // Path A: Template puro
      // ──────────────────────────────────────────
      result = generateTemplateResponse({ actionType, context })

    } else if (responseStrategy === 'llm') {
      // ──────────────────────────────────────────
      // Path B: LLM con fallback template
      // ──────────────────────────────────────────
      const llmResult = await generateLLMResponse({ actionType, context })

      if (llmResult.ok && llmResult.text) {
        result = llmResult
      } else {
        // LLM falló → intentar fallback template
        console.warn(`[Response] LLM failed for ${actionType}, using fallback template`)
        const fallbackResult = generateFallbackResponse({ actionType, context })
        
        // Acumular errores del LLM en el resultado fallback
        if (fallbackResult.meta) {
          fallbackResult.meta.errors = [
            ...(llmResult.meta?.errors || []),
            ...(fallbackResult.meta?.errors || [])
          ]
          fallbackResult.meta.llm_failed = true
        }
        
        result = fallbackResult
      }

    } else if (responseStrategy === 'no_response') {
      // ──────────────────────────────────────────
      // Path C: No response (SILENCE explícito)
      // ──────────────────────────────────────────
      return buildSilenceResponse({
        reason: `strategy_no_response:${actionType}`,
        actionType,
        context: summarizeContext(context),
        startTime
      })

    } else {
      // ──────────────────────────────────────────
      // Path D: Strategy desconocida
      // ──────────────────────────────────────────
      console.warn(`[Response] Unknown strategy: ${responseStrategy} for action: ${actionType}`)
      const fallbackResult = generateFallbackResponse({ actionType, context })
      result = fallbackResult
    }

    // ─── 5. Construir botResponse rica ───
    return buildBotResponse({
      result,
      actionType,
      strategy,
      responseStrategy,
      context,
      startTime
    })

  } catch (err) {
    console.error('[Response] Fatal error:', err.message)
    return buildErrorResponse({
      error: err.message,
      stack: err.stack?.split('\n').slice(0, 5),
      actionType,
      startTime
    })
  }
}

// ════════════════════════════════════════════════════════
// HELPER — Build silence response
// ════════════════════════════════════════════════════════

/**
 * Construye respuesta de silencio (bot no responde)
 */
function buildSilenceResponse({ reason, actionType = null, context = null, startTime }) {
  return {
    ok: true,
    bot_responded: false,
    text: null,
    generation: {
      action_type: actionType,
      strategy: null,
      method: 'silence',
      reason
    },
    audit: {
      context_used: context,
      model_used: null,
      tokens_used: 0,
      cost_usd: 0,
      latency_ms: Date.now() - startTime,
      retry_used: false,
      llm_failed: false,
      errors: []
    },
    meta: {
      response_version: RESPONSE_VERSION,
      prompts_version: RESPONSE_PROMPTS_VERSION,
      context_builder_version: CONTEXT_BUILDER_VERSION,
      llm_version: RESPONSE_LLM_VERSION,
      templates_version: RESPONSE_TEMPLATES_VERSION,
      timestamp: new Date().toISOString()
    }
  }
}

// ════════════════════════════════════════════════════════
// HELPER — Build bot response (success case)
// ════════════════════════════════════════════════════════

function buildBotResponse({ result, actionType, strategy, responseStrategy, context, startTime }) {
  const success = result?.ok === true && result?.text

  return {
    ok: success,
    bot_responded: success,
    text: result?.text || null,
    generation: {
      action_type: actionType,
      strategy: strategy || null,
      method: result?.meta?.generation_method || responseStrategy,
      reason: success ? 'response_generated' : 'generation_failed'
    },
    audit: {
      context_used: summarizeContext(context),
      model_used: result?.meta?.model_used || null,
      tokens_used: result?.meta?.tokens_used || 0,
      cost_usd: result?.meta?.cost_usd || 0,
      latency_ms: Date.now() - startTime,
      retry_used: result?.meta?.retry_used || false,
      llm_failed: result?.meta?.llm_failed || false,
      errors: result?.meta?.errors || []
    },
    meta: {
      response_version: RESPONSE_VERSION,
      prompts_version: RESPONSE_PROMPTS_VERSION,
      context_builder_version: CONTEXT_BUILDER_VERSION,
      llm_version: RESPONSE_LLM_VERSION,
      templates_version: RESPONSE_TEMPLATES_VERSION,
      timestamp: new Date().toISOString()
    }
  }
}

// ════════════════════════════════════════════════════════
// HELPER — Build error response
// ════════════════════════════════════════════════════════

function buildErrorResponse({ error, stack, actionType, startTime }) {
  return {
    ok: false,
    bot_responded: false,
    text: null,
    generation: {
      action_type: actionType,
      strategy: null,
      method: 'error',
      reason: `fatal_error:${error}`
    },
    audit: {
      context_used: null,
      model_used: null,
      tokens_used: 0,
      cost_usd: 0,
      latency_ms: Date.now() - startTime,
      retry_used: false,
      llm_failed: true,
      errors: [{ phase: 'response', message: error, stack }]
    },
    meta: {
      response_version: RESPONSE_VERSION,
      prompts_version: RESPONSE_PROMPTS_VERSION,
      context_builder_version: CONTEXT_BUILDER_VERSION,
      llm_version: RESPONSE_LLM_VERSION,
      templates_version: RESPONSE_TEMPLATES_VERSION,
      timestamp: new Date().toISOString(),
      had_error: true
    }
  }
}

// ════════════════════════════════════════════════════════
// HELPER PÚBLICO — Resumen humano (para logs)
// ════════════════════════════════════════════════════════

/**
 * Devuelve resumen one-liner del botResponse para logs
 */
export function summarizeBotResponse(botResponse) {
  if (!botResponse) return 'no response'

  if (!botResponse.ok) {
    return `❌ response error: ${botResponse.audit?.errors?.[0]?.message || 'unknown'}`
  }

  if (!botResponse.bot_responded) {
    return `🔇 silence: ${botResponse.generation?.reason || 'no reason'}`
  }

  const method = botResponse.generation?.method || 'unknown'
  const chars = botResponse.text?.length || 0
  const cost = botResponse.audit?.cost_usd?.toFixed(6) || '0'
  const latency = botResponse.audit?.latency_ms || 0
  const llmFailed = botResponse.audit?.llm_failed ? ' [llm_fallback]' : ''
  const retry = botResponse.audit?.retry_used ? ' [retry]' : ''

  return `🤖 ${method} (${chars} chars, $${cost}, ${latency}ms)${llmFailed}${retry}`
}

// ════════════════════════════════════════════════════════
// VERSION TRACKING
// ════════════════════════════════════════════════════════
export const RESPONSE_VERSION = 'v1_day6_pipeline'