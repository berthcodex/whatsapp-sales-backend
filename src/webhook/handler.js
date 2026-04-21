// src/webhook/handler.js
// HIDATA — Webhook Handler

import { procesarConMotor } from './stateEngine.js'

const mensajesProcesados = new Set()
const debounceMap = new Map() // numero -> timeout

function yaFueProcesado(messageId) {
  if (!messageId) return false
  if (mensajesProcesados.has(messageId)) return true
  mensajesProcesados.add(messageId)
  if (mensajesProcesados.size > 500) mensajesProcesados.clear()
  return false
}

// Debounce por número — si el lead manda múltiples mensajes en 3 segundos
// solo procesa el último. Evita que cada "enter" genere una respuesta.
function debeEsperar(numero, texto, callback) {
  if (debounceMap.has(numero)) {
    clearTimeout(debounceMap.get(numero).timer)
  }
  const timer = setTimeout(() => {
    debounceMap.delete(numero)
    callback()
  }, 3000)
  debounceMap.set(numero, { timer, texto })
}

async function getVendedorPorInstancia(prisma, instancia) {
  return await prisma.vendedor.findFirst({
    where: { instanciaEvolution: instancia, activo: true },
    include: { tenant: true }
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

    reply.send({ status: 'received' })

    const vendedor = await getVendedorPorInstancia(prisma, instancia)
    if (!vendedor) {
      console.error(`[Handler] Instancia no reconocida: ${instancia}`)
      return
    }

    // Debounce 3s — procesa solo el ultimo mensaje si el lead manda varios seguidos
    debeEsperar(numero, texto, () => {
      procesarConMotor({
        prisma, instancia, numero, texto, tieneImagen, vendedor
      }).catch(err => console.error('[Handler] Error:', err.message))
    })

  } catch (error) {
    console.error('[Handler] Error crítico:', error.message)
    reply.status(500).send({ error: 'Internal server error' })
  }
}
