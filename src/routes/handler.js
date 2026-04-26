const { processIncoming } = require('../motor/stateEngine')
const evolutionApi = require('../plugins/evolutionApi')

const DEBOUNCE_MS = 5000
const debounceMap = new Map()

async function handleWebhook(req, reply) {
  try {
    const body = req.body
    const event = body?.event

    // ── PRESENCE UPDATE — resetea debounce si el lead sigue escribiendo ──
    if (event === 'presence.update') {
      const telefono = body?.data?.id?.replace('@s.whatsapp.net', '')
      const presence = body?.data?.presences?.[telefono]?.lastKnownPresence
      if (telefono && presence === 'composing' && debounceMap.has(telefono)) {
        clearTimeout(debounceMap.get(telefono).timer)
        debounceMap.get(telefono).timer = setTimeout(
          () => dispararBrain(telefono),
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

    // ── IMAGEN — manejo por estado, no hardcoded ──
    const esImagen = !!(msg?.message?.imageMessage)
    const texto = msg?.message?.conversation ||
                  msg?.message?.extendedTextMessage?.text || ''

    if (!telefono) return reply.send({ ok: true })
    if (!texto && !esImagen) return reply.send({ ok: true })

    const contenido = esImagen ? '__IMAGE__' : texto

    // ── ACUMULADOR con debounce adaptativo ──
    if (debounceMap.has(telefono)) {
      clearTimeout(debounceMap.get(telefono).timer)
      debounceMap.get(telefono).buffer += '\n' + contenido
    } else {
      debounceMap.set(telefono, { buffer: contenido, timer: null })
    }

    debounceMap.get(telefono).timer = setTimeout(
      () => dispararBrain(telefono),
      DEBOUNCE_MS
    )

    return reply.send({ ok: true })
  } catch (err) {
    req.log.error(err)
    return reply.code(500).send({ error: 'Internal error' })
  }
}

async function dispararBrain(telefono) {
  const mensajeCompleto = debounceMap.get(telefono)?.buffer
  debounceMap.delete(telefono)
  if (!mensajeCompleto) return

  console.log(`[Handler] → ${telefono}: "${mensajeCompleto.slice(0, 80)}"`)

  await processIncoming({
    telefono,
    mensaje: mensajeCompleto,
    esImagen: mensajeCompleto.includes('__IMAGE__'),
    sendMessage: async (to, text) => await evolutionApi.sendText(to, text),
    notifyVendor: async (vendorTelefono, text) => await evolutionApi.sendText(vendorTelefono, text)
  })
}

module.exports = { handleWebhook }
