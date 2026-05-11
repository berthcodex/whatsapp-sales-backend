// src/lib/gemini.js — Hidata v20
// Wrapper de Gemini 2.5 Flash usando Vertex AI (Google Cloud)
// 
// MIGRADO desde AI Studio API a Vertex AI para aprovechar los créditos
// de Google Cloud Free Trial (S/1,057 disponibles).
//
// Multi-tenant ready: cada tenant puede tener su propio project_id futuro.
//
// Autenticación: Service Account JSON via GOOGLE_APPLICATION_CREDENTIALS

import { GoogleGenAI } from '@google/genai'
import prisma from '../db/prisma.js'

// ════════════════════════════════════════════════════════
// CONFIGURACIÓN GLOBAL
// ════════════════════════════════════════════════════════
const DEFAULT_MODEL = 'gemini-2.5-flash'
const DEFAULT_PROJECT = process.env.GOOGLE_CLOUD_PROJECT || 'graceful-envoy-493005-m7'
const DEFAULT_LOCATION = process.env.GOOGLE_CLOUD_LOCATION || 'us-central1'

// ════════════════════════════════════════════════════════
// CLIENT FACTORY — multi-tenant ready (Vertex AI)
// ════════════════════════════════════════════════════════
async function getGeminiClient(tenantId = 'peru_exporta') {
  // Intenta leer configuración dedicada del tenant
  let projectId = DEFAULT_PROJECT
  let location = DEFAULT_LOCATION
  
  try {
    const tenant = await prisma.tenantSettings.findUnique({
      where: { tenantId }
    })
    
    // En el futuro: si el tenant tiene byok_enabled, usar su propio project
    // Hoy: todos los tenants usan el project maestro de Hidata
    if (tenant?.byokEnabled && tenant?.geminiApiKeyEncrypted) {
      // TODO Fase 4: parsear project/location desde tenant settings
      // Por ahora ignoramos byok y usamos el master
    }
  } catch (err) {
    console.warn('[Gemini] No se pudo leer tenant_settings:', err.message)
  }
  
  // Vertex AI usa Application Default Credentials (Service Account)
  // No requiere apiKey: las credenciales vienen del JSON via env var
  // GOOGLE_APPLICATION_CREDENTIALS=/etc/secrets/google-credentials.json
  return new GoogleGenAI({
    vertexai: true,
    project: projectId,
    location: location
  })
}

// ════════════════════════════════════════════════════════
// HEALTH CHECK — verifica que Gemini responde via Vertex AI
// ════════════════════════════════════════════════════════
export async function geminiHealthCheck(tenantId = 'peru_exporta') {
  const startTime = Date.now()
  
  try {
    const client = await getGeminiClient(tenantId)
    
    const response = await client.models.generateContent({
      model: DEFAULT_MODEL,
      contents: 'Responde solo con la palabra: OK'
    })
    
    const text = response.text || ''
    const latencyMs = Date.now() - startTime
    
    return {
      ok: true,
      tenantId,
      project: DEFAULT_PROJECT,
      location: DEFAULT_LOCATION,
      model: DEFAULT_MODEL,
      response: text.trim(),
      latency_ms: latencyMs,
      usage: response.usageMetadata || null,
      _backend: 'vertex_ai'
    }
  } catch (err) {
    return {
      ok: false,
      tenantId,
      project: DEFAULT_PROJECT,
      location: DEFAULT_LOCATION,
      error: err.message,
      error_stack: err.stack?.split('\n').slice(0, 5),
      latency_ms: Date.now() - startTime,
      _backend: 'vertex_ai'
    }
  }
}

// ════════════════════════════════════════════════════════
// API PRINCIPAL — la usan Perception, Policy, Response
// ════════════════════════════════════════════════════════
export async function callGemini({
  tenantId = 'peru_exporta',
  model = DEFAULT_MODEL,
  systemInstruction = null,
  contents,
  responseSchema = null,
  temperature = 0.3,
  maxOutputTokens = 2048
}) {
  const startTime = Date.now()
  const client = await getGeminiClient(tenantId)
  
  const config = {
    temperature,
    maxOutputTokens
  }
  
  if (systemInstruction) {
    config.systemInstruction = systemInstruction
  }
  
  if (responseSchema) {
    config.responseMimeType = 'application/json'
    config.responseSchema = responseSchema
  }
  
  const response = await client.models.generateContent({
    model,
    contents,
    config
  })
  
  return {
    text: response.text,
    response,
    latencyMs: Date.now() - startTime,
    usage: response.usageMetadata,
    model
  }
}

// ════════════════════════════════════════════════════════
// CALCULADORA DE COSTOS — Gemini 2.5 Flash pricing
// Vertex AI usa mismos precios que AI Studio paid tier
// ════════════════════════════════════════════════════════
const PRICING_PER_1M_TOKENS = {
  'gemini-2.5-flash': {
    input:  0.075,   // USD por 1M tokens
    output: 0.30     // USD por 1M tokens
  },
  'gemini-2.5-pro': {
    input:  1.25,
    output: 5.00
  }
}

export function calculateCost(model, usage) {
  if (!usage) return null
  
  const pricing = PRICING_PER_1M_TOKENS[model]
  if (!pricing) return null
  
  const inputTokens  = usage.promptTokenCount     || 0
  const outputTokens = usage.candidatesTokenCount || 0
  
  const inputCost  = (inputTokens  / 1_000_000) * pricing.input
  const outputCost = (outputTokens / 1_000_000) * pricing.output
  const totalCost  = inputCost + outputCost
  
  return {
    input_tokens:  inputTokens,
    output_tokens: outputTokens,
    total_tokens:  inputTokens + outputTokens,
    input_cost_usd:  inputCost,
    output_cost_usd: outputCost,
    total_cost_usd:  totalCost
  }
}
