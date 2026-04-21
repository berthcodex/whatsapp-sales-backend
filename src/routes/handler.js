const { processIncoming } = require('../motor/stateEngine')
const evolutionApi = require('../plugins/evolutionApi')

// Debounce map — evita respuestas múltiples por enters rápidos
const debounceMap = new Map()
const DEBOUNCE_MS = 3000

async function handleWebhook(req, reply) {
  try {
    const body = req.body
    const event = body?.event

    if (event !== 'messages.upsert') return reply.send({ ok: true })

    const msg = body?.data?.messages?.[0]
    if (!msg) return reply.send({ ok: true })

    const fromMe = msg?.key?.fromMe
    if (fromMe) return reply.send({ ok: true })

    const telefono = msg?.key?.remoteJid?.replace('@s.whatsapp.net', '')
    const texto = msg?.message?.conversation ||
                  msg?.message?.extendedTextMessage?.text || ''

    if (!telefono || !texto) return reply.send({ ok: true })

    // Debounce — acumula mensajes rápidos del lead
    if (debounceMap.has(telefono)) {
      clearTimeout(debounceMap.get(telefono).timer)
      debounceMap.get(telefono).buffer += '\n' + texto
    } else {
      debounceMap.set(telefono, { buffer: texto, timer: null })
    }

    debounceMap.get(telefono).timer = setTimeout(async () => {
      const mensajeCompleto = debounceMap.get(telefono).buffer
      debounceMap.delete(telefono)

      await processIncoming({
        telefono,
        mensaje: mensajeCompleto,
        sendMessage: async (to, text) => {
          await evolutionApi.sendText(to, text)
        },
        notifyVendor: async (vendorTelefono, text) => {
          await evolutionApi.sendText(vendorTelefono, text)
        }
      })
    }, DEBOUNCE_MS)

    return reply.send({ ok: true })
  } catch (err) {
    req.log.error(err)
    return reply.code(500).send({ error: 'Internal error' })
  }
}

module.exports = { handleWebhook }
