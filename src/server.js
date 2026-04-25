// src/server.js — Sprint 4
// Fix: getMensajes endpoint para historial de chat
// Fix: variables de entorno correctas

import 'dotenv/config'
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
