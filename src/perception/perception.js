// src/perception/perception.js — Hidata v20
//
// EL CORAZÓN DEL DÍA 2
//
// Pipeline completo de Perception con resiliencia mejorada:
//   - MAX_OUTPUT_TOKENS=4096 (Gemini 2.5 thinking necesita más espacio)
//   - JSON sanitizer defensivo (limpia markdown, texto extra)
//   - Detección de truncamiento explícita

import prisma from '../db/prisma.js'
import { callGemini, calculateCost } from '../lib/gemini.js'
import { buildPerceptionContext } from './perception-context-builder.js'
import {
  buildPerceptionPrompt,
  PERCEPTION_VERSION,
  getPromptMetadata
} from './perception-prompt.js'
import {
  perceptionResponseSchema,
  validatePerceptionOutput,
  fallbackPerceptionOutput
} from './perception-schema.js'

// ════════════════════════════════════════════════════════
// CONSTANTES
// ════════════════════════════════════════════════════════
const MODEL = 'gemini-2.5-flash'
const TEMPERATURE = 0.2  // Bajo para clasificación consistente
const MAX_OUTPUT_TOKENS = 4096  // Subido de 1024: Gemini 2.5 usa thinking tokens

// ════════════════════════════════════════════════════════
// SANITIZER — limpia el output antes de parsear
// ════════════════════════════════════════════════════════
function sanitizeJsonOutput(rawText) {
  if (!rawText || typeof rawText !== 'string') return rawText
  
  let cleaned = rawText.trim()
  
  // Caso 1: Markdown code block tipo ```json ... ```
  const jsonBlockMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/)
  if (jsonBlockMatch) {
    cleaned = jsonBlockMatch[1].trim()
  }
  
  // Caso 2: Texto antes del primer { o [
  const jsonStartMatch = cleaned.match(/^[\s\S]*?(\{[\s\S]*\}|\[[\s\S]*\])\s*$/)
  if (jsonStartMatch) {
    cleaned = jsonStartMatch[1].trim()
  }
  
  return cleaned
}

// ════════════════════════════════════════════════════════
// DETECTOR DE TRUNCAMIENTO
// ════════════════════════════════════════════════════════
function isTruncated(geminiResult, parseError) {
  if (!parseError) return false
  
  // Heurística 1: finishReason explícito
  const finishReason = geminiResult?.response?.candidates?.[0]?.finishReason
  if (finishReason === 'MAX_TOKENS') return true
  
  // Heurística 2: el texto no termina en } o ]
  const text = geminiResult?.text || ''
  const trimmed = text.trim()
  if (trimmed.length > 100 && !trimmed.endsWith('}') && !trimmed.endsWith(']')) {
    return true
  }
  
  return false
}

// ════════════════════════════════════════════════════════
// API PRINCIPAL — analizarMensaje()
// ════════════════════════════════════════════════════════
export async function analizarMensaje({
  telefono,
  mensaje,
  tenantId = 'peru_exporta',
  instanciaEvolution = null,
  saveTrace = true
}) {
  const startTime = Date.now()
  const errors = []

  // ─── 1. Construir contexto desde BD ───
  let builtContext
  try {
    builtContext = await buildPerceptionContext({
      telefono, mensaje, tenantId, instanciaEvolution
    })
  } catch (err) {
    console.error('[Perception] Error building context:', err.message)
    return {
      ...fallbackPerceptionOutput('context_builder_failed'),
      meta: errorMeta(err, startTime)
    }
  }

  const { contexto } = builtContext
  const { lead_id, flags } = contexto

  // ─── 2. Determinar data_quality según test_phone ───
  const dataQuality = flags.is_test_phone ? 'test' : 'real_pilot'

  // ─── 3. Construir prompt completo ───
  const promptString = buildPerceptionPrompt({ mensaje, contexto })

  // ─── 4. Llamar a Gemini con structured output ───
  let geminiResult = null
  let perceptionOutput = null
  let validationErrors = []

  try {
    geminiResult = await callGemini({
      tenantId,
      model: MODEL,
      contents: promptString,
      responseSchema: perceptionResponseSchema,
      temperature: TEMPERATURE,
      maxOutputTokens: MAX_OUTPUT_TOKENS
    })

    // Sanitizar antes de parsear
    const rawText = geminiResult.text || ''
    const sanitized = sanitizeJsonOutput(rawText)

    try {
      perceptionOutput = JSON.parse(sanitized)
    } catch (parseErr) {
      const wasTruncated = isTruncated(geminiResult, parseErr)
      const reason = wasTruncated ? 'output_truncated' : 'json_parse_failed'
      
      const rawPreview = rawText.length > 1000
        ? rawText.slice(0, 500) + '\n...[TRUNCADO]...\n' + rawText.slice(-500)
        : rawText

      console.error(`[Perception] ${reason}. Raw output (${rawText.length} chars):`)
      console.error(rawPreview)

      errors.push({
        phase: 'json_parse',
        error: parseErr.message,
        reason,
        was_truncated: wasTruncated,
        raw_output_preview: rawPreview,
        raw_output_length: rawText.length,
        finish_reason: geminiResult?.response?.candidates?.[0]?.finishReason || 'unknown'
      })
      perceptionOutput = fallbackPerceptionOutput(reason)
    }

    // Validar output contra schema (si no es fallback)
    if (!perceptionOutput._is_fallback) {
      const validation = validatePerceptionOutput(perceptionOutput)
      if (!validation.valid) {
        validationErrors = validation.errors
        errors.push({ phase: 'schema_validation', errors: validation.errors })
      }
    }
  } catch (err) {
    console.error('[Perception] Gemini error:', err.message)
    errors.push({ phase: 'gemini_call', error: err.message })
    perceptionOutput = fallbackPerceptionOutput(`gemini_error: ${err.message.slice(0, 100)}`)
  }

  // ─── 5. Calcular costos ───
  let costInfo = null
  if (geminiResult?.usage) {
    costInfo = calculateCost(MODEL, geminiResult.usage)
  }

  // ─── 6. Construir meta del output ───
  const latencyMs = Date.now() - startTime
  const meta = {
    perception_version: PERCEPTION_VERSION,
    model_used: MODEL,
    latency_ms: latencyMs,
    tokens_used: costInfo?.total_tokens || 0,
    cost_usd: costInfo?.total_cost_usd || 0,
    data_quality: dataQuality,
    has_errors: errors.length > 0,
    validation_errors: validationErrors,
    is_fallback: !!perceptionOutput._is_fallback,
    errors: errors  // ← AHORA SÍ se devuelven al cliente para debug
  }

  // ─── 7. Registrar en turn_trace (si aplica) ───
  if (saveTrace && lead_id) {
    try {
      await registrarTurnTrace({
        lead_id, contexto, mensaje, perceptionOutput, meta, costInfo, errors
      })
    } catch (err) {
      console.error('[Perception] Error saving turn_trace:', err.message)
    }
  }

 // ─── 8. Incrementar contador del tenant ───
  // Solo si saveTrace=true (es turno de producción real, no debug ni eval)
  if (geminiResult?.usage && saveTrace) {
    await incrementarTurnoConsumido(tenantId).catch(err =>
      console.error('[Perception] Error incrementing tenant counter:', err.message)
    )
  }

  // ─── 9. Devolver output completo ───
  return {
    ...perceptionOutput,
    meta
  }
}

// ════════════════════════════════════════════════════════
// REGISTRO EN turn_trace (observabilidad inmutable)
// ════════════════════════════════════════════════════════
async function registrarTurnTrace({
  lead_id, contexto, mensaje, perceptionOutput, meta, costInfo, errors
}) {
  const { perception_version, model_used, latency_ms, data_quality } = meta

  const perceptionForTrace = { ...perceptionOutput }
  delete perceptionForTrace.meta

  const model_costs = costInfo ? {
    perception: {
      input_tokens: costInfo.input_tokens,
      output_tokens: costInfo.output_tokens,
      total_tokens: costInfo.total_tokens,
      cost_usd: costInfo.total_cost_usd
    },
    total_usd: costInfo.total_cost_usd,
    total_tokens: costInfo.total_tokens
  } : {}

  const promptMeta = getPromptMetadata()
  const audit_log = {
    perception_prompt: promptMeta,
    contexto_flags: contexto.flags,
    historial_turns_used: contexto.historial_corto.length
  }

  await prisma.turnTrace.create({
    data: {
      leadId: lead_id,
      leadIdArchived: contexto.flags.archived ? lead_id : null,
      conversationId: null,
      
      resetGeneration: contexto.flags.reset_generation || 1,
      dataQuality: data_quality,
      
      leadMessage: mensaje,
      leadMessageType: 'text',
      
      perception: perceptionForTrace,
      perceptionVersion: perception_version,
      
      stateBefore: { mode: contexto.flags.current_mode, stage: contexto.flags.current_stage },
      stateAfter: {},
      
      modeRouterDecision: {},
      
      policyDecision: {},
      policyVersion: null,
      guardrailsEvaluated: [],
      
      botResponse: null,
      responseVersion: null,
      
      modelUsed: model_used,
      
      auditLog: audit_log,
      errors: errors,
      
      latencyMs: latency_ms,
      modelCosts: model_costs
    }
  })
}

// ════════════════════════════════════════════════════════
// INCREMENTAR CONTADOR DE TURNOS DEL TENANT (lazy reset)
// ════════════════════════════════════════════════════════
async function incrementarTurnoConsumido(tenantId) {
  const tenant = await prisma.tenantSettings.findUnique({
    where: { tenantId }
  })

  if (!tenant) {
    console.warn(`[Perception] Tenant ${tenantId} no existe en tenant_settings`)
    return
  }

  const ahora = new Date()
  const inicioMesActualReal = new Date(ahora.getFullYear(), ahora.getMonth(), 1)
  const inicioMesGuardado = new Date(tenant.mesActualInicio)

  const mesGuardadoEsAntiguo =
    inicioMesGuardado.getFullYear() < inicioMesActualReal.getFullYear() ||
    inicioMesGuardado.getMonth() < inicioMesActualReal.getMonth()

  if (mesGuardadoEsAntiguo) {
    await prisma.tenantSettings.update({
      where: { tenantId },
      data: {
        turnosConsumidosMesActual: 1,
        mesActualInicio: inicioMesActualReal
      }
    })
  } else {
    await prisma.tenantSettings.update({
      where: { tenantId },
      data: {
        turnosConsumidosMesActual: { increment: 1 }
      }
    })
  }
}

// ════════════════════════════════════════════════════════
// HELPER — meta para casos de error catastrófico
// ════════════════════════════════════════════════════════
function errorMeta(err, startTime) {
  return {
    perception_version: PERCEPTION_VERSION,
    model_used: MODEL,
    latency_ms: Date.now() - startTime,
    tokens_used: 0,
    cost_usd: 0,
    data_quality: 'unknown',
    has_errors: true,
    validation_errors: [],
    is_fallback: true,
    fatal_error: err.message
  }
}

// ════════════════════════════════════════════════════════
// HELPER PÚBLICO — para tests sin guardar a BD
// ════════════════════════════════════════════════════════
export async function analizarMensajeStateless({ mensaje, contexto, tenantId = 'peru_exporta' }) {
  const startTime = Date.now()

  const promptString = buildPerceptionPrompt({ mensaje, contexto: contexto || {} })

  let perceptionOutput = null
  let geminiResult = null
  let errors = []

  try {
    geminiResult = await callGemini({
      tenantId,
      model: MODEL,
      contents: promptString,
      responseSchema: perceptionResponseSchema,
      temperature: TEMPERATURE,
      maxOutputTokens: MAX_OUTPUT_TOKENS
    })

    const rawText = geminiResult.text || ''
    const sanitized = sanitizeJsonOutput(rawText)
    
    try {
      perceptionOutput = JSON.parse(sanitized)
    } catch (parseErr) {
      const wasTruncated = isTruncated(geminiResult, parseErr)
      errors.push({
        phase: 'json_parse',
        error: parseErr.message,
        was_truncated: wasTruncated,
        raw_output_length: rawText.length
      })
      perceptionOutput = fallbackPerceptionOutput(wasTruncated ? 'output_truncated' : 'json_parse_failed')
    }
  } catch (err) {
    errors.push({ phase: 'gemini_call', error: err.message })
    perceptionOutput = fallbackPerceptionOutput(err.message)
  }

  const costInfo = geminiResult?.usage ? calculateCost(MODEL, geminiResult.usage) : null

  return {
    ...perceptionOutput,
    meta: {
      perception_version: PERCEPTION_VERSION,
      model_used: MODEL,
      latency_ms: Date.now() - startTime,
      tokens_used: costInfo?.total_tokens || 0,
      cost_usd: costInfo?.total_cost_usd || 0,
      stateless: true,
      errors: errors
    }
  }
}
