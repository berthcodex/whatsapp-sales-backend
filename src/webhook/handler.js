// src/webhook/handler.js — v3 HIDATA 200X
// Multi-vendor ready: debounce por instancia:telefono
// presence.update adaptativo — respeta ritmo del usuario 40+
import { processIncoming } from './stateEngine.js'

const DEBOUNCE_MS = 5000
const debounceMap = new Map()

async function handleWebhook(req, reply) {
  try {
    const body = req.body
    const event = body?.event
    const instancia = body?.instance || ''

    if (event === 'presence.update') {
      const telefono = body?.data?.id?.replace('@s.whatsapp.net', '')
      const presence = body?.data?.presences?.[telefono]?.lastKnownPresence
      const key = `${instancia}:${telefono}`
      if (telefono && presence === 'composing' && debounceMap.has(key)) {
        clearTimeout(debounceMap.get(key).timer)
        debounceMap.get(key).timer = setTimeout(
          () => dispararBrain(key, instancia, telefono),
          DEBOUNCE_MS
        )
      }
      return reply.send({ ok: true })
    }

    if (event !== 'messages.upsert') return reply.send({ ok: true })

    const msg = body?.data?.messages?.[0] || body?.data

    if (!msg) return reply.send({ ok: true })

    const fromMe = msg?.key?.fromMe
    if (fromMe) return reply.send({ ok: true })

    const telefono = msg?.key?.remoteJid?.replace('@s.whatsapp.net', '')
    if (!telefono) return reply.send({ ok: true })

    const esImagen = !!(msg?.message?.imageMessage)
    const texto = msg?.message?.conversation ||
                  msg?.message?.extendedTextMessage?.text || ''

    if (!texto && !esImagen) return reply.send({ ok: true })

    const contenido = esImagen ? '__IMAGE__' : texto
    const key = `${instancia}:${telefono}`

    if (debounceMap.has(key)) {
      clearTimeout(debounceMap.get(key).timer)
      debounceMap.get(key).buffer += '\n' + contenido
    } else {
      debounceMap.set(key, { buffer: contenido, timer: null })
    }

    debounceMap.get(key).timer = setTimeout(
      () => dispararBrain(key, instancia, telefono),
      DEBOUNCE_MS
    )

    return reply.send({ ok: true })

  } catch (err) {
    req.log.error(err)
    return reply.code(500).send({ error: 'Internal error' })
  }
}

async function dispararBrain(key, instancia, telefono) {
  const mensajeCompleto = debounceMap.get(key)?.buffer
  debounceMap.delete(key)
  if (!mensajeCompleto) return
  console.log(`[Handler] ${instancia} → ${telefono}: "${mensajeCompleto.slice(0, 80)}"`)
  await processIncoming({
    telefono,
    mensaje:  mensajeCompleto,
    esImagen: mensajeCompleto.includes('__IMAGE__'),
    instancia
  })
}

export { handleWebhook }
