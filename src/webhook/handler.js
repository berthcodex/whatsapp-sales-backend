// src/webhook/handler.js
// HIDATA — Webhook Handler Sprint 3
// Fix B1: modelo "vendor" (no "vendedor"), instanciaEvolution ahora en DB real

import { procesarConMotor } from './stateEngine.js'

const mensajesProcesados = new Set()
const debounceMap = new Map()

function yaFueProcesado(messageId) {
  if (!messageId) return false
  if (mensajesProcesados.has(messageId)) return true
  mensajesProcesados.add(messageId)
  if (mensajesProcesados.size > 500) mensajesProcesados.clear()
  return false
}

function debeEsperar(numero, callback) {
  if (debounceMap.has(numero)) clearTimeout(debounceMap.get(numero))
  const timer = setTimeout(() => {
    debounceMap.delete(numero)
    callback()
  }, 3000)
  debounceMap.set(numero, timer)
}

// Sprint 3 Fix: "prisma.vendor" es el modelo correcto (no "vendedor")
// instanciaEvolution ahora existe en DB (migration_sprint3.sql)
async function getVendorPorInstancia(prisma, instancia) {
  return await prisma.vendor.findFirst({
    where: { instanciaEvolution: instancia, activo: true }
  })
}

export async function handleWebhook(request, reply, prisma) {
  try {
    const body = request.body

    if (body.event !== 'messages.upsert' || !body.data) {
      return reply.send({ status: 'ignored' })
    }

    const msg = Array.isArray(body.data) ? body.data[0] : body.data
    const instancia = body.instance

    if (msg.key?.fromMe) return reply.send({ status: 'ignored' })

    const numero = msg.key?.remoteJid?.replace('@s.whatsapp.net', '')
    if (!numero || numero.includes('@g.us')) return reply.send({ status: 'ignored' })

    if (yaFueProcesado(msg.key?.id)) return reply.send({ status: 'ignored' })

    const texto = (
      msg.message?.conversation ||
      msg.message?.extendedTextMessage?.text ||
      msg.message?.buttonsResponseMessage?.selectedDisplayText ||
      msg.message?.listResponseMessage?.title ||
      ''
    ).trim()

    const tieneImagen = !!(
      msg.message?.imageMessage ||
      msg.message?.documentMessage
    )

    if (!texto && !tieneImagen) return reply.send({ status: 'ignored' })

    // Responder inmediato — Evolution API no espera más de 10s
    reply.send({ status: 'received' })

    const vendor = await getVendorPorInstancia(prisma, instancia)
    if (!vendor) {
      console.error(`[Handler] Instancia no reconocida: "${instancia}"`)
      console.error('[Handler] Verifica vendors.instanciaEvolution en DB con migration_sprint3.sql')
      return
    }

    debeEsperar(numero, () => {
      procesarConMotor({ prisma, instancia, numero, texto, tieneImagen, vendor })
        .catch(err => console.error('[Handler] Error en motor:', err.message))
    })

  } catch (error) {
    console.error('[Handler] Error crítico:', error.message)
    reply.status(500).send({ error: 'Internal server error' })
  }
}
