// src/webhook/handler.js — Sprint 5 DEFINITIVO
// Estrategia: timer 5s robusto + presence.update como bonus opcional
// Sin depender de eventos inconsistentes de Baileys
// Cubre: rápido, despacio, largo, público 40+, con/sin presence.update

import { procesarConMotor } from './stateEngine.js'

const mensajesProcesados = new Set()
const debounceMap        = new Map()
const acumuladorMap      = new Map()
const callbackMap        = new Map()

const TYPING_WINDOW_MS = 5000 // 5s — estándar para LATAM público 40+

function yaFueProcesado(messageId) {
  if (!messageId) return false
  if (mensajesProcesados.has(messageId)) return true
  mensajesProcesados.add(messageId)
  if (mensajesProcesados.size > 500) mensajesProcesados.clear()
  return false
}

function programarDisparo(numero, ms) {
  if (debounceMap.has(numero)) clearTimeout(debounceMap.get(numero))
  const timer = setTimeout(() => {
    debounceMap.delete(numero)
    const textoFinal  = acumuladorMap.get(numero) || ''
    const imagenFinal = acumuladorMap.get(`${numero}_img`) || false
    const cb = callbackMap.get(numero)
    acumuladorMap.delete(numero)
    acumuladorMap.delete(`${numero}_img`)
    callbackMap.delete(numero)
    if (cb && (textoFinal || imagenFinal)) cb(textoFinal, imagenFinal)
  }, ms)
  debounceMap.set(numero, timer)
}

function acumularYEsperar(numero, texto, tieneImagen, callback) {
  if (texto) {
    const prev = acumuladorMap.get(numero) || ''
    acumuladorMap.set(numero, prev ? `${prev} ${texto}` : texto)
  }
  if (tieneImagen) acumuladorMap.set(`${numero}_img`, true)
  callbackMap.set(numero, callback)
  programarDisparo(numero, TYPING_WINDOW_MS)
}

async function getVendorPorInstancia(prisma, instancia) {
  return await prisma.vendor.findFirst({
    where: { instanciaEvolution: instancia, activo: true }
  })
}

export async function handleWebhook(request, reply, prisma) {
  try {
    const body      = request.body
    const instancia = body.instance

    // presence.update — BONUS opcional, no crítico
    // Si llega "composing" → resetear timer (lead sigue escribiendo)
    // Si no llega → el timer de 5s maneja todo igual
    if (body.event === 'presence.update' && body.data) {
      const items = Array.isArray(body.data) ? body.data : [body.data]
      for (const item of items) {
        const numero = item.id?.replace('@s.whatsapp.net', '')
        if (!numero) continue
        const estado = item.presences?.[item.id]?.lastKnownPresence
        // Solo resetear si hay texto acumulado esperando
        if (estado === 'composing' && acumuladorMap.has(numero)) {
          programarDisparo(numero, TYPING_WINDOW_MS)
        }
      }
      return reply.send({ status: 'ok' })
    }

    if (body.event !== 'messages.upsert' || !body.data) {
      return reply.send({ status: 'ignored' })
    }

    const msg = Array.isArray(body.data) ? body.data[0] : body.data
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

    reply.send({ status: 'received' })

    const vendor = await getVendorPorInstancia(prisma, instancia)
    if (!vendor) {
      console.error(`[Handler] Instancia no reconocida: "${instancia}"`)
      return
    }

    acumularYEsperar(numero, texto, tieneImagen, (textoFinal, imagenFinal) => {
      console.log(`[Handler] → ${numero}: "${textoFinal.slice(0, 80)}"`)
      procesarConMotor({
        prisma, instancia, numero,
        texto: textoFinal,
        tieneImagen: imagenFinal,
        vendor
      }).catch(err => console.error('[Handler] Error:', err.message))
    })

  } catch (error) {
    console.error('[Handler] Error crítico:', error.message)
    reply.status(500).send({ error: 'Internal server error' })
  }
}
