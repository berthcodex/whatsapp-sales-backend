// src/response/response-llm.js — Hidata v20 Día 6
//
// LLM CALLER — Llamada a Gemini para generación de respuestas
//
// Usa Gemini 2.5 Flash Lite (más rápido que Flash regular).
// Maneja timeouts, reintentos y fallback automático.
//
// Pipeline:
//   1. Construye prompt completo (system + few-shots + user)
//   2. Llama a Vertex AI con timeout estricto
//   3. Sanitiza output (quita markdown, quotes, etc)
//   4. Si falla, devuelve null para que response.js use fallback template
//   5. Registra todo en audit para turn_trace

import { callGemini, calculateCost } from '../lib/gemini.js'
import { getLLMPrompt, substituteVariables } from './response-prompts.js'

// ════════════════════════════════════════════════════════
// CONSTANTES
// ════════════════════════════════════════════════════════
const MODEL = 'gemini-2.5-flash-lite'   // Más rápido que flash regular
const TEMPERATURE = 0.7                  // Más alto que Perception (creatividad)
const MAX_OUTPUT_TOKENS = 800            // Mensajes WhatsApp cortos
const PRIMARY_TIMEOUT_MS = 8000          // 8s primer intento
const RETRY_TIMEOUT_MS = 5000            // 5s reintento

// ════════════════════════════════════════════════════════
// FUNCIÓN NÚCLEO — generateLLMResponse()
// ════════════════════════════════════════════════════════

/**
 * Genera respuesta usando LLM para un action_type específico.
 * 
 * @param {object} params
 * @param {string} params.actionType - Action que decidió Policy
 * @param {object} params.context - Contexto filtrado del context-builder
 * @returns {object} {
 *   ok: boolean,
 *   text: string|null,
 *   meta: {
 *     model_used, tokens_used, cost_usd, latency_ms,
 *     prompt_version, retry_used, errors
 *   }
 * }
 */
export async function generateLLMResponse({ actionType, context }) {
  const startTime = Date.now()
  const errors = []

  // ─── 1. Obtener el prompt completo para esta action ───
  const promptDef = getLLMPrompt(actionType)
  if (!promptDef) {
    errors.push(`No LLM prompt defined for action: ${actionType}`)
    return buildErrorResponse({ errors, startTime })
  }

  // ─── 2. Construir el prompt final ───
  const fullPrompt = buildFullPrompt(promptDef, context)
  if (!fullPrompt) {
    errors.push('Failed to build prompt')
    return buildErrorResponse({ errors, startTime })
  }

  // ─── 3. Intentar primer call con timeout primario ───
  try {
    const result = await callWithTimeout(fullPrompt, PRIMARY_TIMEOUT_MS)
    
    if (result.ok && result.text) {
      const sanitized = sanitizeResponse(result.text)
      
      return {
        ok: true,
        text: sanitized,
        meta: {
          model_used: MODEL,
          tokens_used: result.tokens || 0,
          cost_usd: calculateCost(MODEL, result.tokens || 0, result.outputTokens || 0),
          latency_ms: Date.now() - startTime,
          prompt_version: promptDef.version,
          retry_used: false,
          errors: []
        }
      }
    } else {
      errors.push(`Primary call failed: ${result.error || 'empty response'}`)
    }
  } catch (err) {
    errors.push(`Primary call exception: ${err.message}`)
  }

  // ─── 4. Reintento con timeout menor ───
  console.warn('[Response LLM] Primary call failed, retrying...')
  
  try {
    const result = await callWithTimeout(fullPrompt, RETRY_TIMEOUT_MS)
    
    if (result.ok && result.text) {
      const sanitized = sanitizeResponse(result.text)
      
      return {
        ok: true,
        text: sanitized,
        meta: {
          model_used: MODEL,
          tokens_used: result.tokens || 0,
          cost_usd: calculateCost(MODEL, result.tokens || 0, result.outputTokens || 0),
          latency_ms: Date.now() - startTime,
          prompt_version: promptDef.version,
          retry_used: true,
          errors
        }
      }
    } else {
      errors.push(`Retry failed: ${result.error || 'empty response'}`)
    }
  } catch (err) {
    errors.push(`Retry exception: ${err.message}`)
  }

  // ─── 5. Ambos intentos fallaron — devolver error ───
  return buildErrorResponse({ errors, startTime, retryUsed: true })
}

// ════════════════════════════════════════════════════════
// HELPER — Construir prompt completo
// ════════════════════════════════════════════════════════

/**
 * Combina system + few-shots + user template en un solo prompt.
 * Substituye variables del context.
 */
function buildFullPrompt(promptDef, context) {
  if (!promptDef.system || !promptDef.user_template) return null

  // Substituir variables en system prompt (algunos prompts tienen {vendorNombre} en system)
  const systemFilled = substituteVariables(promptDef.system, context)
  
  // Substituir variables en user template
  const userFilled = substituteVariables(promptDef.user_template, context)

  // Construir few-shots si existen
  let fewShotsText = ''
  if (Array.isArray(promptDef.examples) && promptDef.examples.length > 0) {
    fewShotsText = '\n\n--- EJEMPLOS DE REFERENCIA ---\n'
    for (const example of promptDef.examples) {
      const exampleInputText = JSON.stringify(example.input, null, 2)
      fewShotsText += `\nINPUT:\n${exampleInputText}\n\nOUTPUT:\n${example.output}\n---\n`
    }
  }

  // Prompt final
  return `${systemFilled}${fewShotsText}\n\n--- AHORA RESPONDE A ESTE CASO ---\n${userFilled}`
}

// ════════════════════════════════════════════════════════
// HELPER — Call con timeout
// ════════════════════════════════════════════════════════

/**
 * Llama a Gemini con timeout estricto.
 * Si pasa el timeout, devuelve { ok: false, error: 'timeout' }
 */
async function callWithTimeout(prompt, timeoutMs) {
  let timeoutId

  const timeoutPromise = new Promise((resolve) => {
    timeoutId = setTimeout(() => {
      resolve({ ok: false, error: `timeout_${timeoutMs}ms` })
    }, timeoutMs)
  })

  const callPromise = (async () => {
    try {
      const result = await callGemini({
        model: MODEL,
        contents: prompt,
        temperature: TEMPERATURE,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        tenantId: 'peru_exporta'
      })

      if (timeoutId) clearTimeout(timeoutId)

      if (!result || !result.text) {
        return { ok: false, error: 'empty_response' }
      }

      return {
        ok: true,
        text: result.text,
        tokens: result.usage?.totalTokenCount || 0,
        outputTokens: result.usage?.candidatesTokenCount || 0,
        finishReason: result.response?.candidates?.[0]?.finishReason
      }
    } catch (err) {
      if (timeoutId) clearTimeout(timeoutId)
      return { ok: false, error: err.message }
    }
  })()

  return Promise.race([callPromise, timeoutPromise])
}

// ════════════════════════════════════════════════════════
// HELPER — Sanitización del output
// ════════════════════════════════════════════════════════

/**
 * Limpia el output del LLM:
 *   - Quita markdown wrappers
 *   - Quita quotes excesivas
 *   - Trim spaces
 *   - Valida que tenga contenido mínimo
 */
function sanitizeResponse(rawText) {
  if (!rawText || typeof rawText !== 'string') return ''

  let clean = rawText.trim()

  // Caso 1: Markdown code block (```...```)
  const codeBlockMatch = clean.match(/```(?:[a-z]*)?\s*([\s\S]*?)\s*```/)
  if (codeBlockMatch) {
    clean = codeBlockMatch[1].trim()
  }

  // Caso 2: Quotes envolventes ("..." o '...')
  if ((clean.startsWith('"') && clean.endsWith('"')) ||
      (clean.startsWith("'") && clean.endsWith("'"))) {
    clean = clean.slice(1, -1).trim()
  }

  // Caso 3: Prefacios como "Aquí está el mensaje:" o "Respuesta:"
  const prefacePatterns = [
    /^(aquí (está|tienes) (el|la|tu) (mensaje|respuesta)|respuesta|texto|mensaje generado):\s*/i,
    /^(here'?s? (the|your) (message|response)|response|generated text|message):\s*/i
  ]
  for (const pattern of prefacePatterns) {
    clean = clean.replace(pattern, '').trim()
  }

  // Caso 4: Validar longitud mínima
  if (clean.length < 10) {
    console.warn('[Response LLM] Sanitized response too short:', clean)
    return ''
  }

  return clean
}

// ════════════════════════════════════════════════════════
// HELPER — Build error response
// ════════════════════════════════════════════════════════

/**
 * Construye respuesta de error consistente
 */
function buildErrorResponse({ errors, startTime, retryUsed = false }) {
  return {
    ok: false,
    text: null,
    meta: {
      model_used: MODEL,
      tokens_used: 0,
      cost_usd: 0,
      latency_ms: Date.now() - startTime,
      prompt_version: null,
      retry_used: retryUsed,
      errors
    }
  }
}

// ════════════════════════════════════════════════════════
// HELPER PÚBLICO — para debug
// ════════════════════════════════════════════════════════

/**
 * Devuelve resumen humano del resultado LLM
 */
export function summarizeLLMResult(result) {
  if (!result) return 'no result'

  if (!result.ok) {
    return `❌ LLM failed: ${result.meta?.errors?.[0] || 'unknown'} (${result.meta?.latency_ms}ms)`
  }

  const retry = result.meta?.retry_used ? ' [retry]' : ''
  const cost = result.meta?.cost_usd?.toFixed(6) || '0'
  const tokens = result.meta?.tokens_used || 0
  
  return `✅ LLM ok (${result.text?.length || 0} chars, ${tokens} tokens, $${cost}, ${result.meta?.latency_ms}ms)${retry}`
}

// ════════════════════════════════════════════════════════
// VERSION TRACKING
// ════════════════════════════════════════════════════════
export const RESPONSE_LLM_VERSION = 'v1_day6_gemini_flash_lite'
