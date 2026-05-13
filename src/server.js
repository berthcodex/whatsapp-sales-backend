// src/server.js — Hidata v20
// Día 6: + Endpoint /debug/response-test

import 'dotenv/config'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import { PrismaClient } from '@prisma/client'
import { handleWebhook } from './webhook/handler.js'
import {
  getLeads, updateLead, sendMensaje, doAccion, getReportes, getMensajes
} from './api/leads.js'
import {
  getBotConfig, updateBotConfig,
  getVendedores, createVendedor, updateVendedor, desactivarVendedor
} from './api/config.js'
import {
  getCampaigns, getCampaign, createCampaign, updateCampaign, deleteCampaign,
  saveSteps, addTrigger, deleteTrigger, testTrigger, activarCampaign
} from './routes/campaigns.js'
import { loginVendor, getVendorNames } from './routes/auth.js'
import { ejecutarFollowup } from './motor/followupEngine.js'
import { geminiHealthCheck } from './lib/gemini.js'
import { analizarMensaje, analizarMensajeStateless } from './perception/perception.js'
import { buildPerceptionContext, summarizeContext } from './perception/perception-context-builder.js'
import { classifyExpectedIntent } from './perception/perception-schema.js'
import { actualizarEstado } from './state/state.js'
import { summarizeTransition } from './state/state-transitions.js'
import { describeLeadState } from './state/stage-definitions.js'
import { decideMode, summarizeModeDecision, isValidEscalation } from './routing/mode-router.js'
import { summarizeFullPolicyDecision } from './policy/policy.js'
import { summarizeBotResponse } from './response/response.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const prisma = new PrismaClient({ log: ['error'] })
const app = Fastify({ logger: false })

await app.register(cors, {
  origin: [
    'https://testing1-crm.vercel.app',
    'https://peru-exporta-crm.vercel.app',
    'http://localhost:5173',
    'http://localhost:3000'
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH']
})

// ── Health ───────────────────────────────────────────────────
app.get('/health', async () => ({
  status: 'ok',
  service: 'Hidata — WhatsApp Sales ERP',
  version: '6.0.0',
  timestamp: new Date().toISOString()
}))

// ── Debug — Gemini connection ────────────────────────────────
app.get('/debug/gemini-check', async (req, reply) => {
  const result = await geminiHealthCheck()
  return reply.send(result)
})

// ── Debug — Perception single test ───────────────────────────
app.post('/debug/perception-test', async (req, reply) => {
  const startTime = Date.now()
  const { mensaje, telefono, context, tenantId = 'peru_exporta', stateless = false } = req.body || {}

  if (!mensaje) {
    return reply.status(400).send({
      error: 'Body must include "mensaje" field',
      example: { mensaje: 'ya pe causa, suena bien', telefono: '51938188585', stateless: true }
    })
  }

  try {
    let result

    if (stateless || !telefono) {
      result = await analizarMensajeStateless({
        mensaje, contexto: context || {}, tenantId
      })
      result._mode = 'stateless'
    } else {
      result = await analizarMensaje({
        mensaje, telefono, tenantId, saveTrace: true
      })
      result._mode = 'full'

      const builtContext = await buildPerceptionContext({ telefono, mensaje, tenantId })
      result._context_summary = summarizeContext(builtContext)
    }

    result._endpoint_latency_ms = Date.now() - startTime
    return reply.send(result)
  } catch (err) {
    console.error('[Debug] Perception test error:', err)
    return reply.status(500).send({
      error: err.message,
      stack: err.stack?.split('\n').slice(0, 5)
    })
  }
})

// ────────────────────────────────────────────────────────────
// ── Debug — State Layer test (Día 3) ─────────────────────────
// ────────────────────────────────────────────────────────────
app.post('/debug/state-test', async (req, reply) => {
  const startTime = Date.now()
  const { mensaje, telefono, tenantId = 'peru_exporta' } = req.body || {}

  if (!mensaje || !telefono) {
    return reply.status(400).send({
      error: 'Body must include both "mensaje" and "telefono"',
      example: {
        mensaje: 'Hola, soy Juan, quiero exportar palta',
        telefono: '51938188585'
      }
    })
  }

  try {
    const builtContext = await buildPerceptionContext({ telefono, mensaje, tenantId })
    const leadId = builtContext.contexto.lead_id
    const contextFlags = builtContext.contexto.flags

    if (!leadId) {
      return reply.status(404).send({
        error: 'Lead does not exist. State Layer requires existing lead.',
        telefono,
        hint: 'Try /debug/perception-test first to verify the lead exists.'
      })
    }

    const perceptionStart = Date.now()
    const perception = await analizarMensaje({
      mensaje, telefono, tenantId, saveTrace: true
    })
    perception.meta = perception.meta || {}
    perception.meta.mensaje_original = mensaje
    const perceptionLatency = Date.now() - perceptionStart

    const stateStart = Date.now()
    const stateResult = await actualizarEstado({
      perception, leadId, telefono, contextFlags
    })
    const stateLatency = Date.now() - stateStart

    const totalLatency = Date.now() - startTime

    return reply.send({
      ok: stateResult.ok,
      _endpoint_latency_ms: totalLatency,
      summary: {
        lead_id: leadId,
        telefono,
        mensaje,
        perception_intents: perception.intents,
        perception_intent_specific: perception.intent_specific,
        state_before: stateResult.stateBefore
          ? `[${stateResult.stateBefore.mode}] stage=${stateResult.stateBefore.stage}`
          : null,
        state_after: stateResult.leadState
          ? describeLeadState(stateResult.leadState)
          : null,
        transition_summary: stateResult.transition
          ? summarizeTransition(stateResult.transition)
          : null,
        mode_router_summary: stateResult.modeRouterDecision
          ? summarizeModeDecision(stateResult.modeRouterDecision)
          : null,
        policy_summary: stateResult.policyDecision
          ? summarizeFullPolicyDecision(stateResult.policyDecision)
          : null,
        response_summary: stateResult.botResponse
          ? summarizeBotResponse(stateResult.botResponse)
          : null,
        bot_text: stateResult.botResponse?.text || null,
        slots_changed: stateResult.mergeResult?.change_count || 0,
        latency: {
          perception_ms: perceptionLatency,
          state_ms: stateLatency,
          total_ms: totalLatency
        }
      },
      perception: {
        intents: perception.intents,
        intent_specific: perception.intent_specific,
        conversational_pattern: perception.conversational_pattern,
        entities: perception.entities,
        sentiment: perception.sentiment,
        signals: perception.signals,
        rationale: perception.rationale,
        meta: perception.meta,
        is_fallback: perception._is_fallback || false
      },
      state: {
        ok: stateResult.ok,
        leadState: stateResult.leadState,
        transition: stateResult.transition,
        mergeResult: stateResult.mergeResult,
        modeRouterDecision: stateResult.modeRouterDecision,
        policyDecision: stateResult.policyDecision,
        botResponse: stateResult.botResponse,
        stateBefore: stateResult.stateBefore,
        errors: stateResult.errors,
        latency_ms: stateResult.latency_ms
      },
      context_flags: contextFlags
    })

  } catch (err) {
    console.error('[Debug] State test error:', err)
    return reply.status(500).send({
      error: err.message,
      stack: err.stack?.split('\n').slice(0, 8)
    })
  }
})

// ────────────────────────────────────────────────────────────
// ── Debug — Mode Router test (Día 4) ─────────────────────────
// ────────────────────────────────────────────────────────────
app.post('/debug/mode-test', async (req, reply) => {
  const startTime = Date.now()
  const { mensaje, telefono, tenantId = 'peru_exporta', simulate = null } = req.body || {}

  if (!mensaje || !telefono) {
    return reply.status(400).send({
      error: 'Body must include both "mensaje" and "telefono"',
      example_normal: {
        mensaje: 'Hola, soy Juan',
        telefono: '51938188585'
      },
      example_with_simulation: {
        mensaje: 'Hola, soy Juan',
        telefono: '51938188585',
        simulate: {
          tenantSettings: { estadoSuscripcion: 'past_due', turnosConsumidosMesActual: 10500, turnosIncluidosPorVendedorMes: 10000, numVendedoresPagados: 1 },
          vendorActivo: { id: 1, activo: false, nombre: 'Joan' }
        }
      }
    })
  }

  try {
    const builtContext = await buildPerceptionContext({ telefono, mensaje, tenantId })
    const leadId = builtContext.contexto.lead_id
    const contextFlags = builtContext.contexto.flags

    if (!leadId) {
      return reply.status(404).send({ error: 'Lead does not exist.', telefono })
    }

    if (simulate) {
      const currentLeadState = await prisma.leadState.findUnique({ where: { leadId } })
      if (!currentLeadState) {
        return reply.status(404).send({
          error: 'lead_state does not exist. Use /debug/state-test first.',
          telefono, leadId
        })
      }

      const perception = await analizarMensaje({ mensaje, telefono, tenantId, saveTrace: false })

      const modeRouterDecision = decideMode({
        leadState: currentLeadState,
        perception,
        context: contextFlags,
        tenantSettings: simulate.tenantSettings || null,
        vendorActivo: simulate.vendorActivo || null
      })

      const escalationValid = isValidEscalation(
        currentLeadState.currentMode,
        modeRouterDecision.decision.final_mode
      )

      return reply.send({
        ok: true,
        _mode: 'simulated',
        _endpoint_latency_ms: Date.now() - startTime,
        summary: {
          lead_id: leadId,
          telefono,
          mensaje,
          mode_router_summary: summarizeModeDecision(modeRouterDecision),
          escalation_valid: escalationValid,
          state_unchanged: 'simulation does not persist any change'
        },
        simulation_inputs: { tenantSettings: simulate.tenantSettings, vendorActivo: simulate.vendorActivo },
        perception_summary: {
          intents: perception.intents,
          intent_specific: perception.intent_specific,
          temperature: perception.sentiment?.temperature
        },
        leadState_used: {
          currentMode: currentLeadState.currentMode,
          currentStage: currentLeadState.currentStage,
          slotsFilled: currentLeadState.slotsFilled
        },
        mode_router_decision: modeRouterDecision
      })
    }

    const perceptionStart = Date.now()
    const perception = await analizarMensaje({ mensaje, telefono, tenantId, saveTrace: true })
    perception.meta = perception.meta || {}
    perception.meta.mensaje_original = mensaje
    const perceptionLatency = Date.now() - perceptionStart

    const stateStart = Date.now()
    const stateResult = await actualizarEstado({ perception, leadId, telefono, contextFlags })
    const stateLatency = Date.now() - stateStart

    const totalLatency = Date.now() - startTime

    return reply.send({
      ok: stateResult.ok,
      _mode: 'real',
      _endpoint_latency_ms: totalLatency,
      summary: {
        lead_id: leadId,
        telefono,
        mensaje,
        state_before: stateResult.stateBefore ? `[${stateResult.stateBefore.mode}] stage=${stateResult.stateBefore.stage}` : null,
        state_after: stateResult.leadState ? describeLeadState(stateResult.leadState) : null,
        mode_router_summary: stateResult.modeRouterDecision ? summarizeModeDecision(stateResult.modeRouterDecision) : 'router not executed',
        mode_router_overrode_state: stateResult.modeRouterDecision?.decision?.overrode_state || false,
        guards_triggered: stateResult.modeRouterDecision?.guards_triggered || [],
        latency: { perception_ms: perceptionLatency, state_ms: stateLatency, total_ms: totalLatency }
      },
      perception_summary: { intents: perception.intents, intent_specific: perception.intent_specific, temperature: perception.sentiment?.temperature },
      state: { ok: stateResult.ok, leadState: stateResult.leadState, transition: stateResult.transition, modeRouterDecision: stateResult.modeRouterDecision, errors: stateResult.errors },
      context_flags: contextFlags
    })

  } catch (err) {
    console.error('[Debug] Mode test error:', err)
    return reply.status(500).send({ error: err.message, stack: err.stack?.split('\n').slice(0, 8) })
  }
})

// ────────────────────────────────────────────────────────────
// ── Debug — Policy Layer test (Día 5) ────────────────────────
// ────────────────────────────────────────────────────────────
app.post('/debug/policy-test', async (req, reply) => {
  const startTime = Date.now()
  const { mensaje, telefono, tenantId = 'peru_exporta' } = req.body || {}

  if (!mensaje || !telefono) {
    return reply.status(400).send({
      error: 'Body must include both "mensaje" and "telefono"',
      example: { mensaje: 'esta caro pe, mucha plata', telefono: '51938188585' }
    })
  }

  try {
    const builtContext = await buildPerceptionContext({ telefono, mensaje, tenantId })
    const leadId = builtContext.contexto.lead_id
    const contextFlags = builtContext.contexto.flags

    if (!leadId) {
      return reply.status(404).send({ error: 'Lead does not exist.', telefono })
    }

    const perceptionStart = Date.now()
    const perception = await analizarMensaje({ mensaje, telefono, tenantId, saveTrace: true })
    perception.meta = perception.meta || {}
    perception.meta.mensaje_original = mensaje
    const perceptionLatency = Date.now() - perceptionStart

    const stateStart = Date.now()
    const stateResult = await actualizarEstado({ perception, leadId, telefono, contextFlags })
    const stateLatency = Date.now() - stateStart

    const totalLatency = Date.now() - startTime
    const policyDecision = stateResult.policyDecision

    return reply.send({
      ok: stateResult.ok,
      _endpoint_latency_ms: totalLatency,
      summary: {
        lead_id: leadId,
        telefono,
        mensaje,
        intents: perception.intents,
        intent_specific: perception.intent_specific,
        conversational_pattern: perception.conversational_pattern?.pattern,
        state_before: stateResult.stateBefore ? `[${stateResult.stateBefore.mode}] stage=${stateResult.stateBefore.stage}` : null,
        state_after: stateResult.leadState ? describeLeadState(stateResult.leadState) : null,
        mode_router_summary: stateResult.modeRouterDecision ? summarizeModeDecision(stateResult.modeRouterDecision) : null,
        policy_summary: policyDecision ? summarizeFullPolicyDecision(policyDecision) : 'policy not executed',
        action_type: policyDecision?.action?.type || null,
        action_strategy: policyDecision?.action?.strategy || null,
        bot_should_respond: policyDecision?.action?.bot_should_respond ?? null,
        rule_matched: policyDecision?.rule_matched || null,
        guardrails_blocking: policyDecision?.guardrails?.blocking_names || [],
        latency: { perception_ms: perceptionLatency, state_ms: stateLatency, total_ms: totalLatency }
      },
      policy: policyDecision ? {
        action: policyDecision.action,
        guardrails: policyDecision.guardrails,
        rule_matched: policyDecision.rule_matched,
        decision_path: policyDecision.decision_path,
        candidates: policyDecision.candidates,
        input_snapshot: policyDecision.input_snapshot,
        meta: policyDecision.meta,
        ok: policyDecision.ok,
        errors: policyDecision.errors
      } : null,
      perception_summary: {
        intents: perception.intents,
        intent_specific: perception.intent_specific,
        pattern: perception.conversational_pattern?.pattern,
        entities: perception.entities,
        temperature: perception.sentiment?.temperature
      },
      state_summary: {
        ok: stateResult.ok,
        currentStage: stateResult.leadState?.currentStage,
        currentMode: stateResult.leadState?.currentMode,
        slotsFilled: stateResult.leadState?.slotsFilled,
        transition_reason: stateResult.transition?.transition_reason
      },
      context_flags: contextFlags
    })

  } catch (err) {
    console.error('[Debug] Policy test error:', err)
    return reply.status(500).send({ error: err.message, stack: err.stack?.split('\n').slice(0, 8) })
  }
})

// ════════════════════════════════════════════════════════════════
// ── Debug — Response Layer test (Día 6) ──────────────────────────
// Pipeline completo: Perception → State → ModeRouter → Policy → Response
//
// Body:
//   { mensaje: string, telefono: string }
//
// Devuelve:
//   - El TEXTO generado por el bot (lo más importante)
//   - Audit completo del Response Layer
//   - Decisiones de todas las capas previas
// ════════════════════════════════════════════════════════════════
app.post('/debug/response-test', async (req, reply) => {
  const startTime = Date.now()
  const { mensaje, telefono, tenantId = 'peru_exporta' } = req.body || {}

  if (!mensaje || !telefono) {
    return reply.status(400).send({
      error: 'Body must include both "mensaje" and "telefono"',
      example: {
        mensaje: 'esta caro pe, mucha plata',
        telefono: '51938188585'
      }
    })
  }

  try {
    // ─── 1. Construir contexto ───
    const builtContext = await buildPerceptionContext({ telefono, mensaje, tenantId })
    const leadId = builtContext.contexto.lead_id
    const contextFlags = builtContext.contexto.flags

    if (!leadId) {
      return reply.status(404).send({ error: 'Lead does not exist.', telefono })
    }

    // ─── 2. Pipeline completo Perception → State → ModeRouter → Policy → Response ───
    const perceptionStart = Date.now()
    const perception = await analizarMensaje({
      mensaje, telefono, tenantId, saveTrace: true
    })
    // Asegurar que el mensaje original esté disponible para Response Layer
    perception.meta = perception.meta || {}
    perception.meta.mensaje_original = mensaje
    const perceptionLatency = Date.now() - perceptionStart

    const stateStart = Date.now()
    const stateResult = await actualizarEstado({
      perception, leadId, telefono, contextFlags
    })
    const stateLatency = Date.now() - stateStart

    const totalLatency = Date.now() - startTime

    const botResponse = stateResult.botResponse
    const policyDecision = stateResult.policyDecision

    // ─── 3. Construir respuesta enriquecida con FOCO en Response ───
    return reply.send({
      ok: stateResult.ok,
      _endpoint_latency_ms: totalLatency,

      // ─── 🎯 LO MÁS IMPORTANTE: el texto generado por el bot ───
      bot_text: botResponse?.text || null,
      bot_responded: botResponse?.bot_responded || false,

      // ─── Resumen ejecutivo del pipeline completo ───
      summary: {
        lead_id: leadId,
        telefono,
        mensaje,

        // Perception
        intents: perception.intents,
        intent_specific: perception.intent_specific,
        conversational_pattern: perception.conversational_pattern?.pattern,

        // State
        state_before: stateResult.stateBefore
          ? `[${stateResult.stateBefore.mode}] stage=${stateResult.stateBefore.stage}`
          : null,
        state_after: stateResult.leadState
          ? describeLeadState(stateResult.leadState)
          : null,

        // Mode Router
        mode_router_summary: stateResult.modeRouterDecision
          ? summarizeModeDecision(stateResult.modeRouterDecision)
          : null,

        // Policy
        policy_summary: policyDecision
          ? summarizeFullPolicyDecision(policyDecision)
          : null,
        action_type: policyDecision?.action?.type || null,
        action_strategy: policyDecision?.action?.strategy || null,

        // ⭐ Response (lo principal de este endpoint)
        response_summary: botResponse
          ? summarizeBotResponse(botResponse)
          : 'response not executed',
        generation_method: botResponse?.generation?.method || null,
        text_length: botResponse?.text?.length || 0,
        response_cost_usd: botResponse?.audit?.cost_usd || 0,
        response_latency_ms: botResponse?.audit?.latency_ms || 0,
        llm_failed: botResponse?.audit?.llm_failed || false,

        latency: {
          perception_ms: perceptionLatency,
          state_ms: stateLatency,
          total_ms: totalLatency
        }
      },

      // ─── Response completo (audit trail) ───
      response: botResponse ? {
        ok: botResponse.ok,
        bot_responded: botResponse.bot_responded,
        text: botResponse.text,
        generation: botResponse.generation,
        audit: botResponse.audit,
        meta: botResponse.meta
      } : null,

      // ─── Datos de soporte ───
      perception_summary: {
        intents: perception.intents,
        intent_specific: perception.intent_specific,
        pattern: perception.conversational_pattern?.pattern,
        entities: perception.entities,
        temperature: perception.sentiment?.temperature,
        rationale: perception.rationale
      },

      policy_summary: policyDecision ? {
        action_type: policyDecision.action?.type,
        strategy: policyDecision.action?.strategy,
        bot_should_respond: policyDecision.action?.bot_should_respond,
        rule_matched: policyDecision.rule_matched,
        guardrails_blocking: policyDecision.guardrails?.blocking_names || []
      } : null,

      state_summary: {
        ok: stateResult.ok,
        currentStage: stateResult.leadState?.currentStage,
        currentMode: stateResult.leadState?.currentMode,
        slotsFilled: stateResult.leadState?.slotsFilled,
        transition_reason: stateResult.transition?.transition_reason
      },

      context_flags: contextFlags
    })

  } catch (err) {
    console.error('[Debug] Response test error:', err)
    return reply.status(500).send({
      error: err.message,
      stack: err.stack?.split('\n').slice(0, 8)
    })
  }
})

// ────────────────────────────────────────────────────────────
// ── Debug — Run Perception Evals (Día 2) ─────────────────────
// ────────────────────────────────────────────────────────────
app.post('/debug/run-perception-evals', async (req, reply) => {
  const startTime = Date.now()
  const { categoryFilter = null, idFilter = null } = req.body || {}

  try {
    const datasetPath = join(__dirname, '..', 'data', 'evals-peru-exporta-v2.jsonl')
    const fileContent = await readFile(datasetPath, 'utf-8')
    const allEvals = fileContent
      .split('\n')
      .filter(line => line.trim().length > 0)
      .map((line, i) => {
        try { return JSON.parse(line) } catch (err) { console.error(`[Evals] Línea ${i + 1} inválida:`, err.message); return null }
      })
      .filter(Boolean)

    let perceptionEvals = allEvals.filter(e => e.expected?.perception_intent)
    if (idFilter) perceptionEvals = perceptionEvals.filter(e => idFilter.includes(e.id))
    if (categoryFilter) perceptionEvals = perceptionEvals.filter(e => e.category === categoryFilter)

    const ejecutables = perceptionEvals.filter(e => { const msg = e.input?.lead_message; return msg && typeof msg === 'string' && msg.trim().length > 0 })
    const noEjecutables = perceptionEvals.filter(e => { const msg = e.input?.lead_message; return !msg || typeof msg !== 'string' || msg.trim().length === 0 })

    const CHUNK_SIZE = 3
    const SLEEP_BETWEEN_CHUNKS_MS = 1000
    const details = []

    for (let i = 0; i < ejecutables.length; i += CHUNK_SIZE) {
      const chunk = ejecutables.slice(i, i + CHUNK_SIZE)
      const chunkResults = await Promise.all(chunk.map(async (evalCase) => runSingleEval(evalCase)))
      details.push(...chunkResults)
      if (i + CHUNK_SIZE < ejecutables.length) await sleep(SLEEP_BETWEEN_CHUNKS_MS)
    }

    const passed = details.filter(d => d.status === 'passed').length
    const failed = details.filter(d => d.status === 'failed').length
    const errors = details.filter(d => d.status === 'error').length
    const totalCost = details.reduce((sum, d) => sum + (d.cost_usd || 0), 0)
    const totalLatency = details.reduce((sum, d) => sum + (d.latency_ms || 0), 0)
    const avgLatency = details.length > 0 ? Math.round(totalLatency / details.length) : 0

    return reply.send({
      summary: {
        total_in_dataset: allEvals.length,
        with_perception_intent: perceptionEvals.length,
        executable: ejecutables.length,
        skipped_sequence_evals: noEjecutables.length,
        passed, failed, errors,
        pass_rate: ejecutables.length > 0 ? (passed / ejecutables.length).toFixed(2) : 0,
        total_cost_usd: totalCost.toFixed(6),
        avg_latency_ms: avgLatency,
        total_runtime_ms: Date.now() - startTime
      },
      passed_evals: details.filter(d => d.status === 'passed').map(d => ({ id: d.eval_id, category: d.category, expected: d.expected_intent, got: d.got_summary })),
      failed_evals: details.filter(d => d.status === 'failed').map(d => ({ id: d.eval_id, category: d.category, expected: d.expected_intent, expected_level: d.expected_level, got_intents: d.got_intents, got_intent_specific: d.got_intent_specific, got_pattern: d.got_pattern, rationale: d.rationale, diagnosis: d.diagnosis, latency_ms: d.latency_ms, cost_usd: d.cost_usd })),
      error_evals: details.filter(d => d.status === 'error').map(d => ({ id: d.eval_id, category: d.category, error: d.error, latency_ms: d.latency_ms })),
      skipped_evals: noEjecutables.map(e => ({
