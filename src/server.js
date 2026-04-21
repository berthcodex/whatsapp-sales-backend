// src/server.js
import 'dotenv/config'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import { PrismaClient } from '@prisma/client'
import { handleWebhook } from './webhook/handler.js'
import {
  getLeads,
  updateLead,
  sendMensaje,
  doAccion,
  getReportes
} from './api/leads.js'

import {
  getBotConfig,
  updateBotConfig,
  getVendedores,
  createVendedor,
  updateVendedor,
  desactivarVendedor
} from './api/config.js'

const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['error'] : ['error']
})

const app = Fastify({ logger: false })

await app.register(cors, {
  origin: [
    'https://testing1-crm.vercel.app',
    'https://peru-exporta-crm.vercel.app',
    'http://localhost:5173',
    'http://localhost:3000'
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']
})

app.get('/health', async () => ({
  status: 'ok',
  service: 'Hidata — WhatsApp Sales ERP',
  version: '2.0.0',
  timestamp: new Date().toISOString()
}))

app.post('/webhook', async (request, reply) => {
  return handleWebhook(request, reply, prisma)
})

app.get('/webhook', async () => ({
  status: 'webhook activo',
  service: 'Hidata WhatsApp Sales ERP'
}))

app.get('/leads', async (request, reply) => {
  return getLeads(request, reply, prisma)
})

app.put('/leads/:id', async (request, reply) => {
  return updateLead(request, reply, prisma)
})

app.post('/leads/:id/mensaje', async (request, reply) => {
  return sendMensaje(request, reply, prisma)
})

app.post('/leads/:id/accion', async (request, reply) => {
  return doAccion(request, reply, prisma)
})

app.get('/reportes', async (request, reply) => {
  return getReportes(request, reply, prisma)
})

// ── Config — Bot ─────────────────────────────────────────────
app.get('/config/bot', async (request, reply) => {
  return getBotConfig(request, reply, prisma)
})

app.put('/config/bot', async (request, reply) => {
  return updateBotConfig(request, reply, prisma)
})

// ── Config — Vendedores ──────────────────────────────────────
app.get('/config/vendedores', async (request, reply) => {
  return getVendedores(request, reply, prisma)
})

app.post('/config/vendedores', async (request, reply) => {
  return createVendedor(request, reply, prisma)
})

app.put('/config/vendedores/:id', async (request, reply) => {
  return updateVendedor(request, reply, prisma)
})

app.put('/config/vendedores/:id/desactivar', async (request, reply) => {
  return desactivarVendedor(request, reply, prisma)
})

const PORT = parseInt(process.env.PORT || '3000')
const HOST = process.env.HOST || '0.0.0.0'

try {
  await prisma.$connect()
  console.log('✅ PostgreSQL conectado')

  await app.listen({ port: PORT, host: HOST })
  console.log(`
╔════════════════════════════════════════╗
║   Hidata — WhatsApp Sales ERP v2.0     ║
║   Puerto: ${PORT}                          ║
║   DB: PostgreSQL (Prisma)              ║
║   WhatsApp: Evolution API              ║
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
