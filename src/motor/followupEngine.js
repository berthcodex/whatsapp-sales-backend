// src/motor/followupEngine.js — v2 HIDATA 200X
// Idempotente por diseño — no importa cuántos crons lleguen simultáneos
// Lock optimista mejorado con ventana de 30 segundos
// Vendor briefing completo con score y tip de cierre

import { enviarTexto } from '../whatsapp/sender.js'
import prisma from '../db/prisma.js'

const SEG_SILENCIO       = 20
const MAX_REACTIVACIONES = 3
const MIN_ENTRE_REACTIVA = 30
const LOCK_WINDOW_MS     = 30000  // 30s — ventana de lock ampliada vs 10s anterior

// ════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════
function interp(msg, vars) {
  return (msg || '')
    .replace(/\{\{nombre\}\}/g,   vars.nombre   || vars.telefono || '')
    .replace(/\{\{producto\}\}/g, vars.producto  || 'tu producto')
    .replace(/\{\{telefono\}\}/g, vars.telefono  || '')
    .replace(/\{\{vendedor\}\}/g, vars.vendedor  || '')
    .replace(/\{\{curso\}\}/g,    vars.curso     || 'Mi Primera Exportación')
}

async function guardarMsg(leadId, convId, texto) {
  try {
    await prisma.message.create({
      data: { leadId, conversationId: convId || null, origen: 'BOT', texto }
    })
  } catch(e) { console.error('[Followup] guardarMsg:', e.message) }
}

async function enviarLead(inst, tel, msg) {
  try { await enviarTexto(inst, tel, msg) }
  catch(e) { console.error(`[Followup] lead ${tel}:`, e.message) }
}

async function enviarVendedor(inst, num, msg) {
  try { await enviarTexto(inst, num, msg) }
  catch(e) { console.error('[Followup] vendor:', e.message) }
}

// ════════════════════════════════════════════════════════════
// VENDOR BRIEFING — ficha completa YC-level
// El vendedor recibe todo lo que necesita para cerrar en 5 min
// ════════════════════════════════════════════════════════════
async function construirBriefing(conv) {
  const historial = await prisma.message.findMany({
    where: { leadId: conv.leadId, origen: 'LEAD' },
    orderBy: { createdAt: 'asc' },
    take: 10
  })

  const nombre   = conv.lead.nombreDetectado   || 'Sin nombre'
  const producto = conv.lead.productoDetectado || 'Sin producto'
  const score    = conv.lead.perfilScore        || 0
  const emoji    = score >= 7 ? '🔴' : score >= 4 ? '🟠' : '🟡'

  const historialTexto = historial
    .slice(-5)
    .map(m => `  › "${m.texto.slice(0, 80)}"`)
    .join('\n')

  const tip = producto !== 'Sin producto'
    ? `Pregúntale por región y volumen de ${producto}. Ya tiene producto concreto.`
    : `Ayúdalo a identificar su producto primero.`

  return `${emoji} LEAD CALIFICADO — SCORE ${score}/10

📱 wa.me/${conv.lead.telefono}
👤 ${nombre}
📦 ${producto}
📊 ${score >= 7 ? 'ALTA PRIORIDAD' : score >= 4 ? 'MEDIA' : 'BAJA'}
📚 ${conv.campaign?.nombre || 'orgánico'}

💬 Dijo:
${historialTexto}

⚡ Tip de cierre: ${tip}

📞 Llama ${score >= 7 ? 'AHORA' : 'hoy'}`
}

// ════════════════════════════════════════════════════════════
// LOCK OPTIMISTA MEJORADO
// Ventana de 30s — cubre el peor caso de 3 crons simultáneos
// Idempotente — si el lock falla, skip silencioso
// ════════════════════════════════════════════════════════════
async function intentarLock(convId, ahora) {
  const locked = await prisma.conversation.updateMany({
    where: {
      id: convId,
      OR: [
        { lastBotMessageAt: null },
        { lastBotMessageAt: { lt: new Date(ahora.getTime() - LOCK_WINDOW_MS) } }
      ]
    },
    data: { lastBotMessageAt: new Date() }
  })
  return locked.count > 0
}

// ════════════════════════════════════════════════════════════
// ENTRY POINT — llamado desde el cron endpoint
// prisma se recibe como parámetro para compatibilidad con routes
// ════════════════════════════════════════════════════════════
export async function ejecutarFollowup(prismaParam) {
  // Usar prisma importado directamente — prismaParam es legacy
  const ahora = new Date()
  let procesados = 0

  // ── FASE 1: Avanzar pasos MSG en ACTIVE/REACTIVATED ────────
  const convsActivas = await prisma.conversation.findMany({
    where: {
      state: { in: ['ACTIVE', 'REACTIVATED'] },
      lastLeadMessageAt: {
        not: null,
        lt: new Date(ahora.getTime() - SEG_SILENCIO * 1000)
      }
    },
    include: {
      lead: true,
      campaign: { include: { steps: { orderBy: { orden: 'asc' } } } },
      vendor: true
    }
  })

  for (const conv of convsActivas) {
    try {
      // LOCK OPTIMISTA — ventana 30s
      const locked = await intentarLock(conv.id, ahora)
      if (!locked) continue

      // GUARD — solo si lead respondió DESPUÉS del bot
      if (conv.lastBotMessageAt && conv.lastLeadMessageAt) {
        const botTs  = new Date(conv.lastBotMessageAt).getTime()
        const leadTs = new Date(conv.lastLeadMessageAt).getTime()
        if (botTs >= leadTs) continue
      }
      if (!conv.lastLeadMessageAt) continue

      const instancia = conv.vendor?.instanciaEvolution
      if (!instancia) continue

      const vars = {
        nombre:   conv.lead.nombreDetectado   || conv.lead.telefono,
        producto: conv.lead.productoDetectado || 'tu producto',
        telefono: conv.lead.telefono,
        vendedor: conv.vendor?.nombre         || '',
        curso:    conv.campaign?.nombre       || 'Mi Primera Exportación'
      }

      const steps    = conv.campaign?.steps || []
      const pasoActual = conv.currentStep || 0
      const pasosSig = steps.filter(s => s.orden > pasoActual)

      let proximoMSG = null
      const notifys  = []
      for (const paso of pasosSig) {
        if (paso.tipo === 'NOTIFY') { notifys.push(paso); continue }
        if (paso.tipo === 'MSG' && !proximoMSG) { proximoMSG = paso; break }
      }

      // ── Hay próximo MSG → avanzar paso ──────────────────
      if (proximoMSG) {
        for (const n of notifys) {
          if (conv.vendor?.whatsappNumber)
            await enviarVendedor(instancia, conv.vendor.whatsappNumber, interp(n.mensaje, vars))
        }
        const msgLead = interp(proximoMSG.mensaje, vars)
        await enviarLead(instancia, conv.lead.telefono, msgLead)
        await guardarMsg(conv.leadId, conv.id, msgLead)
        await prisma.conversation.update({
          where: { id: conv.id },
          data: { currentStep: proximoMSG.orden, lastBotMessageAt: new Date() }
        })
        await prisma.lead.update({
          where: { id: conv.leadId },
          data: { pasoActual: proximoMSG.orden, ultimoMensaje: new Date() }
        }).catch(() => {})
        procesados++
        console.log(`[Followup] Paso ${proximoMSG.orden}: ${conv.lead.telefono}`)
        continue
      }

      // ── Sin más pasos → briefing al vendedor → NOTIFIED ──
      if (conv.vendorNotificationCount === 0) {
        const briefing = await construirBriefing(conv)
        if (conv.vendor?.whatsappNumber) {
          await enviarVendedor(instancia, conv.vendor.whatsappNumber, briefing)
        }
      }

      await prisma.conversation.update({
        where: { id: conv.id },
        data: {
          state: 'NOTIFIED',
          vendorNotifiedAt: new Date(),
          vendorNotificationCount: conv.vendorNotificationCount + 1
        }
      })
      await prisma.lead.update({
        where: { id: conv.leadId },
        data: { estado: 'NOTIFICADO', ultimoMensaje: new Date() }
      }).catch(() => {})
      procesados++
      console.log(`[Followup] NOTIFIED: ${conv.lead.telefono}`)

    } catch (err) {
      console.error(`[Followup] Error conv ${conv.id}:`, err.message)
    }
  }

  // ── FASE 2: FOLLOWUP steps por horas de silencio ──────────
  const convsF = await prisma.conversation.findMany({
    where: {
      state: { in: ['ACTIVE', 'REACTIVATED'] },
      campaignId: { not: null }
    },
    include: {
      lead: true,
      campaign: { include: { steps: { orderBy: { orden: 'asc' } } } },
      vendor: true
    }
  })

  for (const conv of convsF) {
    try {
      const instancia = conv.vendor?.instanciaEvolution
      if (!instancia) continue

      const ultimoTs = conv.lastLeadMessageAt
        ? new Date(conv.lastLeadMessageAt).getTime() : 0
      const horasSilencio = (ahora.getTime() - ultimoTs) / 3600000
      const pasoActual = conv.currentStep || 0

      const followup = conv.campaign?.steps?.find(s =>
        s.tipo === 'FOLLOWUP' &&
        s.orden > pasoActual &&
        s.followupHrs &&
        horasSilencio >= s.followupHrs &&
        horasSilencio < s.followupHrs + (5 / 60)
      )
      if (!followup) continue

      // Lock para followup steps
      const locked = await intentarLock(conv.id, ahora)
      if (!locked) continue

      const vars = {
        nombre:   conv.lead.nombreDetectado   || conv.lead.telefono,
        producto: conv.lead.productoDetectado || 'tu producto',
        telefono: conv.lead.telefono,
        vendedor: conv.vendor?.nombre         || '',
        curso:    conv.campaign?.nombre       || ''
      }

      const msgF = interp(followup.mensaje, vars)
      await enviarLead(instancia, conv.lead.telefono, msgF)
      await guardarMsg(conv.leadId, conv.id, msgF)
      await prisma.conversation.update({
        where: { id: conv.id },
        data: { currentStep: followup.orden, lastBotMessageAt: new Date() }
      })
      await prisma.lead.update({
        where: { id: conv.leadId },
        data: { pasoActual: followup.orden, ultimoMensaje: new Date() }
      }).catch(() => {})
      procesados++
      console.log(`[Followup] FOLLOWUP ${followup.followupHrs}h: ${conv.lead.telefono}`)

    } catch (err) {
      console.error(`[Followup] Error followup ${conv.id}:`, err.message)
    }
  }

  // ── FASE 3: Reactivaciones NOTIFIED ───────────────────────
  const convsR = await prisma.conversation.findMany({
    where: {
      state: 'NOTIFIED',
      reactivationCount: { lt: MAX_REACTIVACIONES },
      lastLeadMessageAt: { lt: new Date(ahora.getTime() - 30 * 60 * 1000) },
      OR: [
        { lastReactivationAt: null },
        { lastReactivationAt: { lt: new Date(ahora.getTime() - MIN_ENTRE_REACTIVA * 60 * 1000) } }
      ]
    },
    include: { lead: true, vendor: true, campaign: true }
  })

  for (const conv of convsR) {
    try {
      const instancia = conv.vendor?.instanciaEvolution
      if (!instancia) continue

      const locked = await intentarLock(conv.id, ahora)
      if (!locked) continue

      const ultimoTs = conv.lastLeadMessageAt
        ? new Date(conv.lastLeadMessageAt).getTime()
        : new Date(conv.createdAt).getTime()
      const minutos = Math.floor((ahora.getTime() - ultimoTs) / 60000)
      const reactCount = conv.reactivationCount

      // 48h → CLOSED
      if (minutos >= 2880) {
        await prisma.conversation.update({
          where: { id: conv.id },
          data: { state: 'CLOSED' }
        })
        await prisma.lead.update({
          where: { id: conv.leadId },
          data: { estado: 'CERRADO' }
        }).catch(() => {})
        console.log(`[Followup] CLOSED 48h: ${conv.lead.telefono}`)
        continue
      }

      let msg = null
      let alertV = null

      if (minutos >= 1440 && reactCount === 0) {
        msg    = `¡Hola! 👋 Tenemos nuevas fechas disponibles.\n\n¿Sigues interesado/a? 😊`
        alertV = `🔄 Lead reactivado +24h\n📱 wa.me/${conv.lead.telefono}`
      } else if (minutos >= 120 && minutos < 180 && reactCount === 0) {
        msg    = `Hola! 🙏 Lamentamos la espera. Ya escalé tu caso.\n\nUn asesor te llama hoy. ¿A qué hora? 👇`
        alertV = `⚠️ URGENTE — 2h esperando\n📱 wa.me/${conv.lead.telefono}`
      } else if (minutos >= 60 && minutos < 65 && reactCount === 0) {
        msg    = `Hola! 😊 Ya le recordé a tu asesor — te contacta hoy.\n\n¿A qué hora? 👇`
        alertV = `📌 1h esperando\n📱 wa.me/${conv.lead.telefono}`
      } else if (minutos >= 30 && minutos < 35 && reactCount === 0) {
        if (conv.vendor?.whatsappNumber)
          await enviarVendedor(instancia, conv.vendor.whatsappNumber,
            `🔔 Lead 30min esperando\n📱 wa.me/${conv.lead.telefono}`)
        await prisma.conversation.update({
          where: { id: conv.id },
          data: { reactivationCount: reactCount + 1, lastReactivationAt: new Date() }
        })
        procesados++
        continue
      }

      if (!msg) continue

      await enviarLead(instancia, conv.lead.telefono, msg)
      await guardarMsg(conv.leadId, conv.id, msg)

      if (alertV && conv.vendor?.whatsappNumber)
        await enviarVendedor(instancia, conv.vendor.whatsappNumber, alertV)

      await prisma.conversation.update({
        where: { id: conv.id },
        data: {
          reactivationCount: reactCount + 1,
          lastReactivationAt: new Date(),
          lastBotMessageAt: new Date()
        }
      })
      procesados++
      console.log(`[Followup] Reactivación #${reactCount + 1}: ${conv.lead.telefono}`)

    } catch (err) {
      console.error(`[Followup] Error reactivando ${conv.id}:`, err.message)
    }
  }

  console.log(`[Followup] Total procesados: ${procesados}`)
  return { ok: true, procesados, timestamp: ahora.toISOString() }
}
