// src/webhook/handler.js — v4 HIDATA 111X
// Multi-vendor ready: debounce por instancia:telefono
// presence.update adaptativo — composing/paused
// Guard: ignora grupos @g.us y broadcasts
// Guard: idempotencia por message ID — anti-duplicados Evolution API

import { processIncoming } from './stateEngine.js'

const DEBOUNCE_COMPOSING_MS = 5000
const DEBOUNCE_PAUSED_MS    = 1500

const debounceMap  = new Map()
const procesadosId = new Set() // idempotencia — últimos 500 message IDs
const MAX_IDS      = 500

async function handleWebhook(req, reply) {
  try {
    const body      = req.body
    const event     = body?.event
    const instancia = body?.instance || ''

    // ── PRESENCE.UPDATE ──────────────────────────────────────
    if (event === 'presence.update') {
      const rawId    = body?.data?.id || ''
      const telefono = rawId.replace('@s.whatsapp.net', '')
      const presences = body?.data?.presences || {}
      const presence  = presences[rawId]?.lastKnownPresence
                     || presences[telefono]?.lastKnownPresence

      const key = `${instancia}:${telefono}`

      if (telefono && debounceMap.has(key)) {
        if (presence === 'composing') {
          clearTimeout(debounceMap.get(key).timer)
          debounceMap.get(key).timer = setTimeout(
            () => dispararBrain(key, instancia, telefono),
            DEBOUNCE_COMPOSING_MS
          )
          console.log(`[Handler] composing → reset 5s: ${telefono}`)
        } else if (presence === 'paused') {
          clearTimeout(debounceMap.get(key).timer)
          debounceMap.get(key).timer = setTimeout(
            () => dispararBrain(key, instancia, telefono),
            DEBOUNCE_PAUSED_MS
          )
          console.log(`[Handler] paused → reduce 1.5s: ${telefono}`)
        }
      }
      return reply.send({ ok: true })
    }

    // ── MESSAGES.UPSERT ──────────────────────────────────────
    if (event !== 'messages.upsert') return reply.send({ ok: true })

    const msg = body?.data?.messages?.[0] || body?.data
    if (!msg) return reply.send({ ok: true })

    // ── GUARD: fromMe ────────────────────────────────────────
    if (msg?.key?.fromMe) return reply.send({ ok: true })

    // ── GUARD: grupos y broadcasts ───────────────────────────
    const remoteJid = msg?.key?.remoteJid || ''
    if (remoteJid.endsWith('@g.us') || remoteJid.endsWith('@broadcast')) {
      console.log(`[Handler] Grupo/broadcast ignorado: ${remoteJid}`)
      return reply.send({ ok: true })
    }

    // ── GUARD: idempotencia por message ID ───────────────────
    const msgId = msg?.key?.id
    if (msgId) {
      if (procesadosId.has(msgId)) {
        console.log(`[Handler] Duplicado ignorado: ${msgId}`)
        return reply.send({ ok: true })
      }
      procesadosId.add(msgId)
      if (procesadosId.size > MAX_IDS) {
        const first = procesadosId.values().next().value
        procesadosId.delete(first)
      }
    }

    const telefono = remoteJid.replace('@s.whatsapp.net', '')
    if (!telefono) return reply.send({ ok: true })

    const esImagen = !!(msg?.message?.imageMessage)
    const texto    = msg?.message?.conversation ||
                     msg?.message?.extendedTextMessage?.text || ''

    if (!texto && !esImagen) return reply.send({ ok: true })

    const contenido = esImagen ? '__IMAGE__' : texto
    const key       = `${instancia}:${telefono}`

    if (debounceMap.has(key)) {
      clearTimeout(debounceMap.get(key).timer)
      debounceMap.get(key).buffer += '\n' + contenido
    } else {
      debounceMap.set(key, { buffer: contenido, timer: null })
    }

    debounceMap.get(key).timer = setTimeout(
      () => dispararBrain(key, instancia, telefono),
      DEBOUNCE_COMPOSING_MS
    )

    console.log(`[Handler] buffer acumulado (${debounceMap.get(key).buffer.split('\n').length} msgs): ${telefono}`)

    return reply.send({ ok: true })

  } catch (err) {
    console.error('[Handler] Error:', err.message)
    return reply.code(500).send({ error: 'Internal error' })
  }
}

async function dispararBrain(key, instancia, telefono) {
  const entry = debounceMap.get(key)
  debounceMap.delete(key)
  if (!entry?.buffer) return
  console.log(`[Handler] DISPARO → ${instancia}:${telefono}: "${entry.buffer.slice(0, 80)}"`)
  await processIncoming({
    telefono,
    mensaje:  entry.buffer,
    esImagen: entry.buffer.includes('__IMAGE__'),
    instancia
  })
}

export { handleWebhook }
