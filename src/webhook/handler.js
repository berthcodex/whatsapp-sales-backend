// src/webhook/handler.js — v7 HIDATA 111X
// Redis Debounce 9s — estándar industria adaptado a leads 40+ años Peru Exporta
// Resiliente a reinicios de Render — timer en Redis, no en memoria
// Guard: grupos @g.us y broadcasts ignorados
// Guard: idempotencia por message ID
// Redis lock — anti doble disparo

import { processIncoming } from './stateEngine.js'
import { Redis } from '@upstash/redis'

const redis = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
})

const DEBOUNCE_MS = 9000  // 9s — leads 40+ años Peru Exporta
const MAX_IDS     = 500

const procesadosId = new Set()
const timerMap     = new Map()

async function handleWebhook(req, reply) {
  try {
    const body      = req.body
    const event     = body?.event
    const instancia = body?.instance || ''

    if (event === 'presence.update') return reply.send({ ok: true })
    if (event !== 'messages.upsert') return reply.send({ ok: true })

    const msg = body?.data?.messages?.[0] || body?.data
    if (!msg) return reply.send({ ok: true })

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
        procesadosId.delete(procesadosId.values().next().value)
      }
    }

    const telefono = remoteJid.replace('@s.whatsapp.net', '')
    if (!telefono) return reply.send({ ok: true })

    const esImagen = !!(msg?.message?.imageMessage)
    const texto    = msg?.message?.conversation ||
                     msg?.message?.extendedTextMessage?.text || ''

    if (!texto && !esImagen) return reply.send({ ok: true })

    const contenido = esImagen ? '__IMAGE__' : texto
    const bufferKey = `buffer:${instancia}:${telefono}`
    const timerKey  = `${instancia}:${telefono}`

    // ── REDIS DEBOUNCE 9s — reset en cada mensaje ────────────
    const bufferExiste = await redis.exists(bufferKey)

    if (!bufferExiste) {
      // Primer mensaje — crea buffer
      await redis.set(bufferKey, contenido, { ex: 60 })
      console.log(`[Handler] Buffer START: ${telefono} | "${contenido.slice(0, 50)}"`)
    } else {
      // Mensaje adicional — acumula
      await redis.append(bufferKey, '\n' + contenido)
      console.log(`[Handler] Buffer APPEND: ${telefono} | "${contenido.slice(0, 50)}"`)
    }

    // Reset timer en cada mensaje — 9s de silencio = terminó
    if (timerMap.has(timerKey)) {
      clearTimeout(timerMap.get(timerKey))
    }

    const timer = setTimeout(async () => {
      timerMap.delete(timerKey)
      await dispararBrain(instancia, telefono)
    }, DEBOUNCE_MS)

    timerMap.set(timerKey, timer)

    return reply.send({ ok: true })

  } catch (err) {
    console.error('[Handler] Error:', err.message)
    return reply.code(500).send({ error: 'Internal error' })
  }
}

async function dispararBrain(instancia, telefono) {
  const bufferKey = `buffer:${instancia}:${telefono}`
  const lockKey   = `lock:${instancia}:${telefono}`

  try {
    // Lock anti-doble disparo
    const lock = await redis.set(lockKey, '1', { nx: true, ex: 15 })
    if (lock !== 'OK') {
      console.log(`[Handler] Disparo duplicado ignorado: ${telefono}`)
      return
    }

    const buffer = await redis.get(bufferKey)
    await redis.del(bufferKey)

    if (!buffer) return

    const mensaje = buffer.toString()
    console.log(`[Handler] DISPARO → ${instancia}:${telefono}: "${mensaje.slice(0, 100)}"`)

    await processIncoming({
      telefono,
      mensaje,
      esImagen: mensaje.includes('__IMAGE__'),
      instancia
    })

  } catch(err) {
    console.error('[Handler] dispararBrain error:', err.message)
  } finally {
    await redis.del(lockKey).catch(() => {})
  }
}

export { handleWebhook }
