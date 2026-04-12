// src/server.js
// Servidor principal — Bot Peru Exporta Backend
// Node.js + Fastify + Prisma + PostgreSQL

import 'dotenv/config'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import { PrismaClient } from '@prisma/client'
import { handleWebhook } from './webhook/handler.js'

// ============================================
// INICIALIZAR PRISMA
// ============================================
const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['query', 'error'] : ['error']
})

// ============================================
// INICIALIZAR FASTIFY
// ============================================
const app = Fastify({
  logger: {
    level: process.env.NODE_ENV === 'development' ? 'info' : 'warn'
  }
})

// ============================================
// PLUGINS
// ============================================
await app.register(cors, {
  origin: [
    'https://peru-exporta-crm.vercel.app',
    'http://localhost:5173',
    'http://localhost:3000'
  ],
  credentials: true
})

// ============================================
// RUTAS — SEMANA 1
// ============================================

// Health check — Railway lo usa para saber si el server está vivo
app.get('/health', async () => ({
  status: 'ok',
  service: 'peru-exporta-backend',
  timestamp: new Date().toISOString(),
  version: '1.0.0'
}))

// Webhook principal — recibe mensajes de Evolution API
// Los 3 números (joan, cristina, francisco) apuntan a esta misma URL
app.post('/webhook', async (request, reply) => {
  return handleWebhook(request, reply, prisma)
})

// Webhook GET — para verificación inicial de Evolution API
app.get('/webhook', async (request, reply) => {
  return reply.send({ status: 'webhook activo', service: 'peru-exporta-backend' })
})

// ============================================
// RUTAS — SEMANA 2 (stubs listos para implementar)
// ============================================

// GET /leads — lista de leads filtrada por vendedor o admin
app.get('/leads', async (request, reply) => {
  // TODO Semana 2: implementar con auth JWT
  return reply.send({ message: 'Disponible en Semana 2', leads: [] })
})

// PUT /leads/:id — actualizar estado
app.put('/leads/:id', async (request, reply) => {
  return reply.send({ message: 'Disponible en Semana 2' })
})

// GET /reportes — métricas
app.get('/reportes', async (request, reply) => {
  return reply.send({ message: 'Disponible en Semana 2' })
})

// ============================================
// ARRANCAR EL SERVIDOR
// ============================================
const PORT = parseInt(process.env.PORT || '3000')
const HOST = process.env.HOST || '0.0.0.0'

try {
  await app.listen({ port: PORT, host: HOST })
  console.log(`
╔════════════════════════════════════════╗
║   Bot Peru Exporta — Backend v1.0      ║
║   Puerto: ${PORT}                          ║
║   DB: PostgreSQL (Prisma)              ║
║   WhatsApp: Evolution API              ║
╚════════════════════════════════════════╝
  `)

  // Verificar conexión a BD
  await prisma.$connect()
  console.log('✅ PostgreSQL conectado')

} catch (error) {
  console.error('❌ Error arrancando servidor:', error)
  await prisma.$disconnect()
  process.exit(1)
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('Cerrando servidor...')
  await app.close()
  await prisma.$disconnect()
  process.exit(0)
})
