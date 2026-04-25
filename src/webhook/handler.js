// src/webhook/handler.js — Sprint 5
// Fix velocidad: debounce 1.5s (era 3s)
// Fix acumulación: los mensajes del lead se concatenan en el debounce
// Fix: usa llama-3.1-8b-instant para respuestas más rápidas

import { procesarConMotor } from './stateEngine.js'

const mensajesProcesados = new Set()
const debounceMap = new Map()
const acumuladorMap = new Map() // acumula textos del mismo número

function yaFueProcesado(messageId) {
  if (!messageId) return false
  if (mensajesProcesados.has(messageId)) return true
  mensajesProcesados.add(messageId)
  if (mensajesProcesados.size > 500) mensajesProcesados.clear()
  return false
}

// Acumula mensajes del mismo número en ventana de 1.5s
// Si el lead escribe 3 mensajes seguidos → se procesan como uno solo
function acumularYEsperar(numero, texto, tieneImagen, callback) {
  // Acumular texto
  if (texto) {
    const prev = acumuladorMap.get(numero) || ''
    acumuladorMap.set(numero, prev ? prev + ' ' + texto : texto)
  }
  if (tieneImagen) {
    acumuladorMap.set(numero + '_img', true)
  }

  // Resetear timer
  if (debounceMap.has(numero)) clearTimeout(debounceMap.get(numero))

  const timer = setTimeout(() => {
    debounceMap.delete(numero)
    const textoAcumulado = acumuladorMap.get(numero) || ''
    const imagenAcumulada = acumuladorMap.get(numero + '_img') || false
    acumuladorMap.delete(numero)
    acumuladorMap.delete(numero + '_img')
    callback(textoAcumulado, imagenAcumulada)
  }, 1500) // 1.5s — era 3s

  debounceMap.set(numero, timer)
}

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
      return
    }

    // Acumular y procesar con debounce 1.5s
    acumularYEsperar(numero, texto, tieneImagen, (textoFinal, imagenFinal) => {
      procesarConMotor({ prisma, instancia, numero, texto: textoFinal, tieneImagen: imagenFinal, vendor })
        .catch(err => console.error('[Handler] Error en motor:', err.message))
    })

  } catch (error) {
    console.error('[Handler] Error crítico:', error.message)
    reply.status(500).send({ error: 'Internal server error' })
  }
}
