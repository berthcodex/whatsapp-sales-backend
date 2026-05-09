// src/server.js — Hidata v20
// + Endpoint /debug/run-perception-evals para correr el dataset

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
  version: '4.0.0',
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
        mensaje,
        contexto: context || {},
        tenantId
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

// ── Debug — Run Perception Evals ─────────────────────────────
app.post('/debug/run-perception-evals', async (req, reply) => {
  const startTime = Date.now()
  const { categoryFilter = null, idFilter = null } = req.body || {}

  try {
    // ─── 1. Cargar dataset ───
    const datasetPath = join(__dirname, '..', 'data', 'evals-peru-exporta-v2.jsonl')
    const fileContent = await readFile(datasetPath, 'utf-8')
    const allEvals = fileContent
      .split('\n')
      .filter(line => line.trim().length > 0)
      .map((line, i) => {
        try {
          return JSON.parse(line)
        } catch (err) {
          console.error(`[Evals] Línea ${i + 1} inválida:`, err.message)
          return null
        }
      })
      .filter(Boolean)

    // ─── 2. Filtrar evals ejecutables por Perception ───
    let perceptionEvals = allEvals.filter(e => e.expected?.perception_intent)

    if (idFilter) {
      perceptionEvals = perceptionEvals.filter(e => idFilter.includes(e.id))
    }
    if (categoryFilter) {
      perceptionEvals = perceptionEvals.filter(e => e.category === categoryFilter)
    }

    const ejecutables = perceptionEvals.filter(e => {
      const msg = e.input?.lead_message
      return msg && typeof msg === 'string' && msg.trim().length > 0
    })

    const noEjecutables = perceptionEvals.filter(e => {
      const msg = e.input?.lead_message
      return !msg || typeof msg !== 'string' || msg.trim().length === 0
    })

    // ─── 3. Procesar en chunks de 3 paralelo + sleep 1s ───
    const CHUNK_SIZE = 3
    const SLEEP_BETWEEN_CHUNKS_MS = 1000
    const details = []

    for (let i = 0; i < ejecutables.length; i += CHUNK_SIZE) {
      const chunk = ejecutables.slice(i, i + CHUNK_SIZE)

      const chunkResults = await Promise.all(
        chunk.map(async (evalCase) => runSingleEval(evalCase))
      )

      details.push(...chunkResults)

      // Sleep entre chunks (excepto el último)
      if (i + CHUNK_SIZE < ejecutables.length) {
        await sleep(SLEEP_BETWEEN_CHUNKS_MS)
      }
    }

    // ─── 4. Construir reporte ───
    const passed = details.filter(d => d.status === 'passed').length
    const failed = details.filter(d => d.status === 'failed').length
    const errors = details.filter(d => d.status === 'error').length

    const totalCost = details.reduce((sum, d) => sum + (d.cost_usd || 0), 0)
    const totalLatency = details.reduce((sum, d) => sum + (d.latency_ms || 0), 0)
    const avgLatency = details.length > 0 ? Math.round(totalLatency / details.length) : 0

    const report = {
      summary: {
        total_in_dataset: allEvals.length,
        with_perception_intent: perceptionEvals.length,
        executable: ejecutables.length,
        skipped_sequence_evals: noEjecutables.length,
        passed,
        failed,
        errors,
        pass_rate: ejecutables.length > 0 ? (passed / ejecutables.length).toFixed(2) : 0,
        total_cost_usd: totalCost.toFixed(6),
        avg_latency_ms: avgLatency,
        total_runtime_ms: Date.now() - startTime
      },
      passed_evals: details.filter(d => d.status === 'passed').map(d => ({
        id: d.eval_id,
        category: d.category,
        expected: d.expected_intent,
        got: d.got_summary
      })),
      failed_evals: details.filter(d => d.status === 'failed').map(d => ({
        id: d.eval_id,
        category: d.category,
        expected: d.expected_intent,
        expected_level: d.expected_level,
        got_intents: d.got_intents,
        got_intent_specific: d.got_intent_specific,
        got_pattern: d.got_pattern,
        rationale: d.rationale,
        diagnosis: d.diagnosis,
        latency_ms: d.latency_ms,
        cost_usd: d.cost_usd
      })),
      error_evals: details.filter(d => d.status === 'error').map(d => ({
        id: d.eval_id,
        category: d.category,
        error: d.error,
        latency_ms: d.latency_ms
      })),
      skipped_evals: noEjecutables.map(e => ({
        id: e.id,
        category: e.category,
        reason: 'requires_sequence_evaluation_not_perception'
      }))
    }

    return reply.send(report)
  } catch (err) {
    console.error('[Evals] Fatal error:', err)
    return reply.status(500).send({
      error: err.message,
      stack: err.stack?.split('\n').slice(0, 8)
    })
  }
})

// ─── Helper: correr 1 eval con retry ───
async function runSingleEval(evalCase, retryCount = 0) {
  const startTime = Date.now()
  const expectedIntent = evalCase.expected.perception_intent
  const expectedLevel = classifyExpectedIntent(expectedIntent)

  try {
    const result = await analizarMensajeStateless({
      mensaje: evalCase.input.lead_message,
      contexto: evalCase.input.context || {},
      tenantId: 'peru_exporta'
    })

    // Si el output es fallback y tenemos retries disponibles, reintentar
    if (result._is_fallback && retryCount < 1) {
      await sleep(2000)
      return runSingleEval(evalCase, retryCount + 1)
    }

    // Comparar según nivel del expected
    let passed = false
    let diagnosis = null

    if (expectedLevel === 'level_1') {
      // Alto nivel: buscar en intents[]
      passed = result.intents?.includes(expectedIntent)
      if (!passed) {
        diagnosis = `Expected "${expectedIntent}" in intents[], got [${result.intents?.join(', ')}]`
      }
    } else if (expectedLevel === 'level_2') {
      // Granular: comparar intent_specific exact match
      passed = result.intent_specific === expectedIntent
      if (!passed) {
        if (result.intent_specific === null) {
          diagnosis = `Expected intent_specific="${expectedIntent}" but got null. Parent intent was [${result.intents?.join(', ')}]`
        } else {
          diagnosis = `Expected intent_specific="${expectedIntent}" but got "${result.intent_specific}"`
        }
      }
    } else if (expectedLevel === 'level_3') {
      // Patrón conversacional
      passed = result.conversational_pattern?.pattern === expectedIntent
      if (!passed) {
        diagnosis = `Expected conversational_pattern="${expectedIntent}" but got ${
          result.conversational_pattern?.pattern || 'null'
        }`
      }
    } else {
      diagnosis = `Unknown expected level for "${expectedIntent}"`
    }

    return {
      eval_id: evalCase.id,
      category: evalCase.category,
      status: passed ? 'passed' : 'failed',
      expected_intent: expectedIntent,
      expected_level: expectedLevel,
      got_intents: result.intents,
      got_intent_specific: result.intent_specific,
      got_pattern: result.conversational_pattern?.pattern || null,
      got_summary: passed ? `${expectedIntent} ✓` : null,
      rationale: result.rationale,
      diagnosis,
      latency_ms: Date.now() - startTime,
      cost_usd: result.meta?.cost_usd || 0,
      _retried: retryCount > 0
    }
  } catch (err) {
    return {
      eval_id: evalCase.id,
      category: evalCase.category,
      status: 'error',
      error: err.message,
      expected_intent: expectedIntent,
      latency_ms: Date.now() - startTime,
      cost_usd: 0
    }
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// ── Auth ─────────────────────────────────────────────────────
app.get('/auth/vendors',  async (req, reply) => getVendorNames(req, reply, prisma))
app.post('/auth/login',   async (req, reply) => loginVendor(req, reply, prisma))

// ── Webhook ──────────────────────────────────────────────────
app.post('/webhook', async (req, reply) => handleWebhook(req, reply, prisma))
app.get('/webhook',  async () => ({ status: 'webhook activo', version: '4.0.0' }))

// ── Leads ────────────────────────────────────────────────────
app.get('/leads',                async (req, reply) => getLeads(req, reply, prisma))
app.put('/leads/:id',            async (req, reply) => updateLead(req, reply, prisma))
app.post('/leads/:id/mensaje',   async (req, reply) => sendMensaje(req, reply, prisma))
app.post('/leads/:id/accion',    async (req, reply) => doAccion(req, reply, prisma))
app.get('/leads/:id/mensajes',   async (req, reply) => getMensajes(req, reply, prisma))
app.get('/reportes',             async (req, reply) => getReportes(req, reply, prisma))

// ── Config ───────────────────────────────────────────────────
app.get('/config/bot',  async (req, reply) => getBotConfig(req, reply, prisma))
app.put('/config/bot',  async (req, reply) => updateBotConfig(req, reply, prisma))
app.get('/config/vendedores',                async (req, reply) => getVendedores(req, reply, prisma))
app.post('/config/vendedores',               async (req, reply) => createVendedor(req, reply, prisma))
app.put('/config/vendedores/:id',            async (req, reply) => updateVendedor(req, reply, prisma))
app.put('/config/vendedores/:id/desactivar', async (req, reply) => desactivarVendedor(req, reply, prisma))

// ── Campaigns ────────────────────────────────────────────────
app.get('/campaigns',                      async (req, reply) => getCampaigns(req, reply, prisma))
app.get('/campaigns/:id',                  async (req, reply) => getCampaign(req, reply, prisma))
app.post('/campaigns',                     async (req, reply) => createCampaign(req, reply, prisma))
app.put('/campaigns/:id',                  async (req, reply) => updateCampaign(req, reply, prisma))
app.delete('/campaigns/:id',               async (req, reply) => deleteCampaign(req, reply, prisma))
app.put('/campaigns/:id/steps',            async (req, reply) => saveSteps(req, reply, prisma))
app.post('/campaigns/:id/triggers',        async (req, reply) => addTrigger(req, reply, prisma))
app.delete('/campaigns/:id/triggers/:tid', async (req, reply) => deleteTrigger(req, reply, prisma))
app.post('/campaigns/test-trigger',        async (req, reply) => testTrigger(req, reply, prisma))
app.patch('/campaigns/:id/activar',        async (req, reply) => activarCampaign(req, reply, prisma))

// ── Vendors ──────────────────────────────────────────────────
app.get('/vendors', async (req, reply) => {
  const vendors = await prisma.vendor.findMany({
    where: { activo: true },
    select: { id: true, nombre: true, telefono: true, role: true, instanciaEvolution: true }
  })
  return vendors
})

// ── Cron ─────────────────────────────────────────────────────
app.get('/cron/followup', async (req, reply) => {
  const secret = req.headers['x-cron-secret'] || req.query.secret
  if (secret !== process.env.CRON_SECRET) return reply.status(401).send({ error: 'Unauthorized' })
  try {
    const result = await ejecutarFollowup(prisma)
    console.log(`[Cron] Followup ejecutado: ${result.procesados} leads`)
    return reply.send({ ok: true, ...result })
  } catch (err) {
    console.error('[Cron] Error:', err.message)
    return reply.status(500).send({ error: err.message })
  }
})

// ── Start ────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '3000')
const HOST = process.env.HOST || '0.0.0.0'

try {
  await prisma.$connect()
  console.log('✅ PostgreSQL conectado')
  await app.listen({ port: PORT, host: HOST })
  console.log(`
╔════════════════════════════════════════╗
║   Hidata — WhatsApp Sales ERP v4.0     ║
║   Puerto: ${PORT}                          ║
║   Sprint 4: Prisma models + Bug fixes  ║
╚════════════════════════════════════════╝
  `)
} catch (error) {
  console.error('❌ Error arrancando servidor:', error)
  await prisma.$disconnect()
  process.exit(1)
}

process.on('SIGTERM', async () => {
  await app.close()
  await prisma.$disconnect()
  process.exit(0)
})
