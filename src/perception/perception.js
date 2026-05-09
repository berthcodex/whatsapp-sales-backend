// src/perception/perception.js — Hidata v20
//
// EL CORAZÓN DEL DÍA 2
//
// Pipeline completo de Perception:
//   1. Recibe {telefono, mensaje, tenantId}
//   2. Llama context-builder (lee BD, ~50ms)
//   3. Construye prompt (system + few-shots + input real)
//   4. Llama Gemini 2.5 Flash con structured output
//   5. Valida output contra schema
//   6. Si falla → devuelve fallback (NUNCA crashea)
//   7. Registra turn completo en turn_trace
//   8. Incrementa contador de tenant_settings (lazy reset mensual)
//   9. Devuelve perception output al caller
//
// COSTO: ~$0.0003 por turn (input + thinking + output ~2,500 tokens total)
// LATENCIA: ~1.5-2.5s (1.5s Gemini + 0.5s context + 0.1s BD writes)

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
const MAX_OUTPUT_TOKENS = 1024

// ════════════════════════════════════════════════════════
// API PRINCIPAL — analizarMensaje()
// ════════════════════════════════════════════════════════
export async function analizarMensaje({
  telefono,
  mensaje,
  tenantId = 'peru_exporta',
  instanciaEvolution = null,
  saveTrace = true  // false útil en evals para no contaminar BD
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

    // Parsear JSON (Gemini garantiza que es JSON válido por structured output)
    try {
      perceptionOutput = JSON.parse(geminiResult.text)
    } catch (parseErr) {
      errors.push({ phase: 'json_parse', error: parseErr.message })
      perceptionOutput = fallbackPerceptionOutput('json_parse_failed')
    }

    // Validar output contra schema (defensa en profundidad)
    if (!perceptionOutput._is_fallback) {
      const validation = validatePerceptionOutput(perceptionOutput)
      if (!validation.valid) {
        validationErrors = validation.errors
        errors.push({ phase: 'schema_validation', errors: validation.errors })
        // Conservamos el output pero marcamos los errores
        // (no devolvemos fallback porque a veces validación es estricta de más)
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
    is_fallback: !!perceptionOutput._is_fallback
  }

  // ─── 7. Registrar en turn_trace (si aplica) ───
  if (saveTrace && lead_id) {
    try {
      await registrarTurnTrace({
        lead_id,
        contexto,
        mensaje,
        perceptionOutput,
        meta,
        costInfo,
        errors
      })
    } catch (err) {
      console.error('[Perception] Error saving turn_trace:', err.message)
      // No falla el flow principal, solo loggea
    }
  }

  // ─── 8. Incrementar contador del tenant (lazy reset) ───
  if (geminiResult?.usage) {
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

  // Compactar el output para guardar (sin la meta que duplicaría info)
  const perceptionForTrace = { ...perceptionOutput }
  delete perceptionForTrace.meta

  // Build model_costs object para guardar
  const model_costs = costInfo ? {
    perception: {
      input_tokens:  costInfo.input_tokens,
      output_tokens: costInfo.output_tokens,
      total_tokens:  costInfo.total_tokens,
      cost_usd:      costInfo.total_cost_usd
    },
    total_usd:    costInfo.total_cost_usd,
    total_tokens: costInfo.total_tokens
  } : {}

  // Audit log con metadata reproducible (sin el prompt completo, solo versión)
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
      conversationId: null,  // se setea cuando integremos con webhook handler en Día 6/7
      
      resetGeneration: contexto.flags.reset_generation || 1,
      dataQuality: data_quality,
      
      leadMessage: mensaje,
      leadMessageType: 'text',
      
      perception: perceptionForTrace,
      perceptionVersion: perception_version,
      
      stateBefore: { mode: contexto.flags.current_mode, stage: contexto.flags.current_stage },
      stateAfter: {},  // Día 3 lo llenará
      
      modeRouterDecision: {},  // Día 4 lo llenará
      
      policyDecision: {},  // Día 5 lo llenará
      policyVersion: null,
      guardrailsEvaluated: [],
      
      botResponse: null,  // Día 6 lo llenará
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

  // Verificar si necesita reset mensual (lazy)
  const ahora = new Date()
  const inicioMesActualReal = new Date(ahora.getFullYear(), ahora.getMonth(), 1)
  const inicioMesGuardado = new Date(tenant.mesActualInicio)

  const mesGuardadoEsAntiguo =
    inicioMesGuardado.getFullYear() < inicioMesActualReal.getFullYear() ||
    inicioMesGuardado.getMonth() < inicioMesActualReal.getMonth()

  if (mesGuardadoEsAntiguo) {
    // Reset: nuevo mes empezó
    await prisma.tenantSettings.update({
      where: { tenantId },
      data: {
        turnosConsumidosMesActual: 1,
        mesActualInicio: inicioMesActualReal
      }
    })
  } else {
    // Incremento normal
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
  
  try {
    geminiResult = await callGemini({
      tenantId,
      model: MODEL,
      contents: promptString,
      responseSchema: perceptionResponseSchema,
      temperature: TEMPERATURE,
      maxOutputTokens: MAX_OUTPUT_TOKENS
    })
    
    perceptionOutput = JSON.parse(geminiResult.text)
  } catch (err) {
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
      stateless: true
    }
  }
}