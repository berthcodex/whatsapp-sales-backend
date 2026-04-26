// src/webhook/handler.js — v3 HIDATA 200X
// Multi-vendor ready: debounce por instancia:telefono
// presence.update adaptativo — respeta ritmo del usuario 40+

const { processIncoming } = require('../motor/stateEngine')

const DEBOUNCE_MS = 5000
const debounceMap = new Map()

async function handleWebhook(req, reply) {
  try {
    const body = req.body
    const event = body?.event

    // ── Instancia — identifica qué vendor recibe el mensaje ──
    const instancia = body?.instance || ''

    // ── PRESENCE UPDATE — debounce adaptativo ───────────────
    // Si el lead sigue escribiendo, resetea el timer
    // Respeta el ritmo de usuarios 40+ que escriben lento
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

    const msg = body?.data?.messages?.[0]
    if (!msg) return reply.send({ ok: true })

    const fromMe = msg?.key?.fromMe
    if (fromMe) return reply.send({ ok: true })

    const telefono = msg?.key?.remoteJid?.replace('@s.whatsapp.net', '')
    if (!telefono) return reply.send({ ok: true })

    // ── Detectar tipo de mensaje ─────────────────────────────
    const esImagen = !!(msg?.message?.imageMessage)
    const texto = msg?.message?.conversation ||
                  msg?.message?.extendedTextMessage?.text || ''

    if (!texto && !esImagen) return reply.send({ ok: true })

    const contenido = esImagen ? '__IMAGE__' : texto

    // ── Clave única por instancia + teléfono ─────────────────
    // Joan:lead → "peru-exporta-joan:51938188585"
    // Cristina:lead → "peru-exporta-cristina:51912345678"
    // Francisco:lead → "peru-exporta-francisco:51987654321"
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
    mensaje:   mensajeCompleto,
    esImagen:  mensajeCompleto.includes('__IMAGE__'),
    instancia
  })
}

module.exports = { handleWebhook }
