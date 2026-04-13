// src/server.js
// Hidata — WhatsApp Sales ERP Backend
// Semana 2: endpoints completos para el CRM

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

// ============================================
// PRISMA
// ============================================
const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['error'] : ['error']
})

// ============================================
// FASTIFY
// ============================================
const app = Fastify({
  logger: false
})

// ============================================
// CORS — permite que el CRM React se conecte
// ============================================
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

// ============================================
// RUTAS — HEALTH
// ============================================
app.get('/health', async () => ({
  status: 'ok',
  service: 'Hidata — WhatsApp Sales ERP',
  version: '2.0.0',
  timestamp: new Date().toISOString()
}))

// ============================================
// RUTAS — WEBHOOK WhatsApp
// ============================================
app.post('/webhook', async (request, reply) => {
  return handleWebhook(request, reply, prisma)
})

app.get('/webhook', async () => ({
  status: 'webhook activo',
  service: 'Hidata WhatsApp Sales ERP'
}))

// ============================================
// RUTAS — API CRM (Semana 2)
// ============================================

// GET /leads — lista de leads
app.get('/leads', async (request, reply) => {
  return getLeads(request, reply, prisma)
})

// PUT /leads/:id — actualizar estado (mover Kanban)
app.put('/leads/:id', async (request, reply) => {
  return updateLead(request, reply, prisma)
})

// POST /leads/:id/mensaje — enviar mensaje manual
app.post('/leads/:id/mensaje', async (request, reply) => {
  return sendMensaje(request, reply, prisma)
})

// POST /leads/:id/accion — acciones del CRM
app.post('/leads/:id/accion', async (request, reply) => {
  return doAccion(request, reply, prisma)
})

// GET /reportes — métricas
app.get('/reportes', async (request, reply) => {
  return getReportes(request, reply, prisma)
})

// ============================================
// ARRANCAR SERVIDOR
// ============================================
const PORT = parseInt(process.env.PORT || '3000')
const HOST = process.env.HOST || '0.0.0.0'

try {
  await app.listen({ port: PORT, host: HOST })
  console.log(`
╔════════════════════════════════════════╗
║   Hidata — WhatsApp Sales ERP v2.0     ║
║   Puerto: ${PORT}                          ║
║   DB: PostgreSQL (Prisma)              ║
║   WhatsApp: Evolution API              ║
╚════════════════════════════════════════╝
  `)

  await prisma.$connect()
  console.log('✅ PostgreSQL conectado')

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
