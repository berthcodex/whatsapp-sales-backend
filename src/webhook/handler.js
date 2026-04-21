// src/webhook/handler.js
// ================================================================
// HIDATA — Webhook Handler
// Sprint 1 — 20 Abril 2026
//
// Este archivo NO tiene lógica de negocio.
// Solo hace 3 cosas:
//   1. Valida que el evento de Evolution API sea un mensaje real
//   2. Deduplica mensajes repetidos
//   3. Delega TODO al motor de estados (stateEngine.js)
// ================================================================

import { procesarConMotor } from './stateEngine.js'

// ── Deduplicación en memoria ──────────────────────────────────────
// Evolution API v2.3.7 puede disparar el mismo webhook 2 veces.
// Este Set evita procesarlo dos veces.
const mensajesProcesados = new Set()

function yaFueProcesado(messageId) {
  if (!messageId) return false
  if (mensajesProcesados.has(messageId)) return true
  mensajesProcesados.add(messageId)
  if (mensajesProcesados.size > 1000) mensajesProcesados.clear()
  return false
}

// ── Buscar vendedor por instancia Evolution API ───────────────────
async function getVendedorPorInstancia(prisma, instancia) {
  return await prisma.vendedor.findFirst({
    where: { instanciaEvolution: instancia, activo: true },
    include: { tenant: true }
  })
}

// ── Handler principal ─────────────────────────────────────────────
export async function handleWebhook(request, reply, prisma) {
  try {
    const body = request.body

    // Log de diagnóstico — ver todos los eventos que llegan
    console.log(`[Handler] Evento recibido: ${body.event} | Instancia: ${body.instance}`)

    // Solo procesar mensajes entrantes (upsert = nuevo, update = editado/leído)
    if (!['messages.upsert', 'messages.update'].includes(body.event) || !body.data) {
      return reply.send({ status: 'ignored', reason: `event_${body.event}` })
    }

    // messages.update puede venir como array — tomamos el primer elemento
    const msg = Array.isArray(request.body.data)
      ? request.body.data[0]
      : request.body.data
    const instancia = body.instance

    // Ignorar mensajes propios del bot
    if (msg.key?.fromMe) {
      return reply.send({ status: 'ignored', reason: 'own_message' })
    }

    // Extraer número — ignorar grupos
    const numero = msg.key?.remoteJid?.replace('@s.whatsapp.net', '')
    if (!numero || numero.includes('@g.us')) {
      return reply.send({ status: 'ignored', reason: 'group_or_no_number' })
    }

    // Deduplicación
    const messageId = msg.key?.id
    if (yaFueProcesado(messageId)) {
      return reply.send({ status: 'ignored', reason: 'duplicate' })
    }

    // Extraer texto
    const texto = (
      msg.message?.conversation ||
      msg.message?.extendedTextMessage?.text ||
      msg.message?.buttonsResponseMessage?.selectedDisplayText ||
      msg.message?.listResponseMessage?.title ||
      ''
    ).trim()

    // Detectar imagen
    const tieneImagen = !!(
      msg.message?.imageMessage ||
      msg.message?.documentMessage
    )

    // Log de diagnóstico
    console.log(`[Handler] Número: ${numero} | Texto: "${texto}" | Imagen: ${tieneImagen}`)

    // Si no hay texto ni imagen — ignorar (ej: reacciones, estados)
    if (!texto && !tieneImagen) {
      return reply.send({ status: 'ignored', reason: 'no_text_no_image' })
    }

    // Responder a Evolution API inmediatamente para evitar reintentos
    reply.send({ status: 'received' })

    // Buscar vendedor por instancia
    const vendedor = await getVendedorPorInstancia(prisma, instancia)
    if (!vendedor) {
      console.log(`[Handler] Instancia no reconocida: ${instancia}`)
      return
    }

    // Delegar al motor de estados — toda la lógica vive ahí
    console.log(`[Handler] Delegando al motor — instancia: ${instancia} | vendedor: ${vendedor.nombre}`)
    procesarConMotor({
      prisma,
      instancia,
      numero,
      texto,
      tieneImagen,
      vendedor
    }).catch(err => console.error('[Handler] Error en motor:', err.message, err.stack))

  } catch (error) {
    console.error('[Handler] Error crítico:', error)
    reply.status(500).send({ error: 'Internal server error' })
  }
}
