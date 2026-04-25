// src/motor/followupEngine.js — Sprint 4
// Fix Bug 8: ventana de FOLLOWUP ampliada a 5 min (era 2 min imposibles)
// Fix: usa prisma.conversation (modelo real) en vez de $queryRawUnsafe
// Fix: sincroniza conversation + lead siempre juntos

import { enviarTexto } from '../whatsapp/sender.js'
import {
  extraerNombre,
  extraerProducto,
  clasificarConScoring,
  clasificarConIA
} from '../webhook/classifier.js'

const SEG_SILENCIO       = 20
const MAX_REACTIVACIONES = 3
const MIN_ENTRE_REACTIVA = 30

async function escribirEnSheets(data) {
  const url = process.env.SHEETS_WEBHOOK_URL
  if (!url) return
  try {
    const params = new URLSearchParams({
      accion:     data.accion     || 'nuevo',
      telefono:   data.telefono   || '',
      msgInicial: (data.msgInicial|| '').slice(0, 200),
      mensajes:   (data.mensajes  || '').slice(0, 500),
      nombre:     data.nombre     || '',
      producto:   data.producto   || '',
      perfil:     data.perfil     || '',
      prioridad:  data.prioridad  || '',
      estado:     data.estado     || '',
      vendedor:   data.vendedor   || '',
      campana:    data.campana    || ''
    })
    await fetch(`${url}?${params.toString()}`, {
      method: 'GET', redirect: 'follow',
      signal: AbortSignal.timeout(8000)
    })
  } catch (err) {
    console.error('[Sheets] Error:', err.message)
  }
}

async function clasificar(texto) {
  if (!texto || texto.trim().length < 3) {
    return { tipo: 'A', tipoPreciso: 'Tipo A — formación', prioridad: 'MEDIA', confianza: 'baja' }
  }
  const nombre   = extraerNombre(texto)
  const producto = extraerProducto(texto)
  const scoring  = clasificarConScoring(texto)
  let clasif = scoring
  if (scoring.confianza === 'baja' && process.env.GROQ_API_KEY) {
    try { const ia = await clasificarConIA(texto); clasif = { ...scoring, ...ia } } catch {}
  }
  return { nombre, producto, ...clasif }
}

function interp(msg, vars) {
  return (msg || '')
    .replace(/\{\{nombre\}\}/g,    vars.nombre    || vars.telefono || '')
    .replace(/\{\{producto\}\}/g,  vars.producto  || 'tu producto')
    .replace(/\{\{telefono\}\}/g,  vars.telefono  || '')
    .replace(/\{\{vendedor\}\}/g,  vars.vendedor  || '')
    .replace(/\{\{curso\}\}/g,     vars.curso     || 'Mi Primera Exportación')
    .replace(/\{\{historial\}\}/g, vars.historial || '')
}

async function guardarMsg(prisma, leadId, convId, texto) {
  try {
    await prisma.message.create({
      data: { leadId, conversationId: convId || null, origen: 'BOT', texto }
    })
  } catch {}
}

async function enviarLead(inst, tel, msg) {
  try { await enviarTexto(inst, tel, msg) }
  catch (e) { console.error(`[Followup] enviarLead ${tel}:`, e.message) }
}

async function enviarVendedor(inst, num, msg) {
  try { await enviarTexto(inst, num, msg) }
  catch (e) { console.error('[Followup] enviarVendedor:', e.message) }
}

// ════════════════════════════════════════════════════════════
export async function ejecutarFollowup(prisma) {
  const ahora = new Date()
  let procesados = 0

  // ══════════════════════════════════════════════════════════
  // FASE 1: Avanzar pasos del FlowBuilder en conversations ACTIVE
  // ══════════════════════════════════════════════════════════
  const convsActivas = await prisma.conversation.findMany({
    where: {
      state: { in: ['ACTIVE', 'REACTIVATED'] },
      lastLeadMessageAt: {
        lt: new Date(ahora.getTime() - SEG_SILENCIO * 1000)
      },
      OR: [
        { lastBotMessageAt: null },
        { lastBotMessageAt: { lt: prisma.conversation.fields?.lastLeadMessageAt } }
      ]
    },
    include: {
      lead: true,
      campaign: { include: { steps: { orderBy: { orden: 'asc' } } } },
      vendor: true
    }
  })

  for (const conv of convsActivas) {
    try {
      const instancia = conv.vendor?.instanciaEvolution
      if (!instancia) continue

      // Re-verificar que lastBotMessage < lastLeadMessage
      if (conv.lastBotMessageAt && conv.lastLeadMessageAt &&
          conv.lastBotMessageAt >= conv.lastLeadMessageAt) continue

      const mensajes = await prisma.message.findMany({
        where: { leadId: conv.leadId, origen: 'LEAD' },
        orderBy: { createdAt: 'asc' }
      })
      const textoAcumulado = mensajes.map(m => m.texto).join(' ')
      const historial      = mensajes.map(m => `  > "${m.texto.slice(0, 100)}"`).join('\n')
      const clasif = await clasificar(textoAcumulado)

      await prisma.lead.update({
        where: { id: conv.leadId },
        data: {
          nombreDetectado:   clasif.nombre   || undefined,
          productoDetectado: clasif.producto || undefined
        }
      }).catch(() => {})

      const vars = {
        nombre:   clasif.nombre   || conv.lead.telefono,
        producto: clasif.producto || 'tu producto',
        telefono: conv.lead.telefono,
        vendedor: conv.vendor?.nombre  || '',
        curso:    conv.campaign?.nombre || 'Mi Primera Exportación',
        historial
      }

      const steps     = conv.campaign?.steps || []
      const pasoActual = conv.currentStep || 0
      const pasosSig  = steps.filter(s => s.orden > pasoActual)

      let proximoMSG = null
      const notifysAhora = []

      for (const paso of pasosSig) {
        if (paso.tipo === 'NOTIFY') { notifysAhora.push(paso); continue }
        if (paso.tipo === 'MSG' && !proximoMSG) { proximoMSG = paso; break }
      }

      if (proximoMSG) {
        for (const notify of notifysAhora) {
          if (conv.vendor?.whatsappNumber) {
            await enviarVendedor(instancia, conv.vendor.whatsappNumber, interp(notify.mensaje, vars))
          }
        }
        const msgLead = interp(proximoMSG.mensaje, vars)
        await enviarLead(instancia, conv.lead.telefono, msgLead)
        await guardarMsg(prisma, conv.leadId, conv.id, msgLead)
        await prisma.conversation.update({
          where: { id: conv.id },
          data: { currentStep: proximoMSG.orden, lastBotMessageAt: new Date(), updatedAt: new Date() }
        })
        await prisma.lead.update({
          where: { id: conv.leadId },
          data: { pasoActual: proximoMSG.orden, ultimoMensaje: new Date() }
        }).catch(() => {})
        procesados++
        console.log(`[Followup] Paso ${proximoMSG.orden}: ${conv.lead.telefono}`)
        continue
      }

      // Sin más pasos MSG → notificar vendedor → NOTIFIED
      if (conv.vendorNotificationCount === 0) {
        for (const notify of notifysAhora) {
          if (conv.vendor?.whatsappNumber) {
            await enviarVendedor(instancia, conv.vendor.whatsappNumber, interp(notify.mensaje, vars))
          }
        }

        if (notifysAhora.length === 0 && conv.vendor?.whatsappNumber) {
          const prioEmoji = clasif.prioridad === 'URGENTE' ? '🔴' : clasif.prioridad === 'ALTA' ? '🟠' : '🟡'
          const msgVendedor =
            `${prioEmoji} NUEVO LEAD — ${clasif.prioridad}\n\n` +
            `📱 wa.me/${conv.lead.telefono}\n` +
            `👤 ${clasif.nombre || 'Sin nombre'}\n` +
            `📦 ${clasif.producto || 'Sin producto'}\n` +
            `🎯 ${clasif.tipoPreciso || ''}\n` +
            `📚 ${conv.campaign?.nombre || 'orgánico'}\n` +
            (historial ? `\n💬 Dijo:\n${historial}\n` : '') +
            `\n⚡ ${clasif.prioridad === 'URGENTE' ? '¡Llama AHORA!' : 'Llama hoy'}`
          await enviarVendedor(instancia, conv.vendor.whatsappNumber, msgVendedor)
        }

        await escribirEnSheets({
          accion: 'nuevo', telefono: conv.lead.telefono,
          msgInicial: mensajes[0]?.texto || '',
          mensajes: mensajes.map(m => m.texto).join(' | '),
          nombre: clasif.nombre || '', producto: clasif.producto || '',
          perfil: clasif.tipoPreciso, prioridad: clasif.prioridad,
          estado: 'pendiente llamar',
          vendedor: conv.vendor?.nombre || '',
          campana: conv.campaign?.nombre || ''
        })
      }

      await prisma.conversation.update({
        where: { id: conv.id },
        data: {
          state: 'NOTIFIED',
          vendorNotifiedAt: new Date(),
          vendorNotificationCount: conv.vendorNotificationCount + 1,
          updatedAt: new Date()
        }
      })
      await prisma.lead.update({
        where: { id: conv.leadId },
        data: { estado: 'NOTIFICADO', ultimoMensaje: new Date() }
      }).catch(() => {})

      procesados++
      console.log(`[Followup] NOTIFIED: ${conv.lead.telefono} | ${clasif.tipoPreciso} | ${clasif.prioridad}`)

    } catch (err) {
      console.error(`[Followup] Error conv ${conv.id}:`, err.message)
    }
  }

  // ══════════════════════════════════════════════════════════
  // FASE 2: FOLLOWUP steps (ventana ampliada a 5 min)
  // Fix Bug 8: era 2 min, ahora 5 min para no perderse con el cron
  // ══════════════════════════════════════════════════════════
  const convsFollowup = await prisma.conversation.findMany({
    where: { state: { in: ['ACTIVE', 'REACTIVATED'] }, campaignId: { not: null } },
    include: {
      lead: true,
      campaign: { include: { steps: { orderBy: { orden: 'asc' } } } },
      vendor: true
    }
  })

  for (const conv of convsFollowup) {
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
        horasSilencio < s.followupHrs + (5 / 60) // ← ventana 5 minutos (era 2)
      )
      if (!followup) continue

      const vars = {
        nombre:   conv.lead.nombreDetectado || conv.lead.telefono,
        producto: conv.lead.productoDetectado || 'tu producto',
        telefono: conv.lead.telefono,
        vendedor: conv.vendor?.nombre || '',
        curso:    conv.campaign?.nombre || '',
        historial: ''
      }

      const msgFollowup = interp(followup.mensaje, vars)
      await enviarLead(instancia, conv.lead.telefono, msgFollowup)
      await guardarMsg(prisma, conv.leadId, conv.id, msgFollowup)
      await prisma.conversation.update({
        where: { id: conv.id },
        data: { currentStep: followup.orden, lastBotMessageAt: new Date(), updatedAt: new Date() }
      })
      await prisma.lead.update({
        where: { id: conv.leadId },
        data: { pasoActual: followup.orden, ultimoMensaje: new Date() }
      }).catch(() => {})

      procesados++
      console.log(`[Followup] FOLLOWUP ${followup.followupHrs}h: ${conv.lead.telefono}`)
    } catch (err) {
      console.error(`[Followup] Error followup step ${conv.id}:`, err.message)
    }
  }

  // ══════════════════════════════════════════════════════════
  // FASE 3: Reactivaciones anti-loop
  // ══════════════════════════════════════════════════════════
  const convsReactivar = await prisma.conversation.findMany({
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

  for (const conv of convsReactivar) {
    try {
      const instancia = conv.vendor?.instanciaEvolution
      if (!instancia) continue

      const ultimoTs = conv.lastLeadMessageAt
        ? new Date(conv.lastLeadMessageAt).getTime()
        : new Date(conv.createdAt).getTime()
      const minutos = Math.floor((ahora.getTime() - ultimoTs) / 60000)
      const reactCount = conv.reactivationCount

      if (minutos >= 2880) {
        await prisma.conversation.update({ where: { id: conv.id }, data: { state: 'CLOSED', updatedAt: new Date() } })
        await prisma.lead.update({ where: { id: conv.leadId }, data: { estado: 'CERRADO' } }).catch(() => {})
        console.log(`[Followup] CLOSED (48h): ${conv.lead.telefono}`)
        continue
      }

      let msg = null
      let alertVendedor = null

      if (minutos >= 1440 && reactCount === 0) {
        msg = `¡Hola! 👋 Qué gusto saber de ti de nuevo.\n\nTenemos nuevas fechas disponibles.\n\n¿Sigues interesado/a? 😊`
        alertVendedor = `🔄 Lead reactivado +24h\n📱 wa.me/${conv.lead.telefono}`
      } else if (minutos >= 120 && minutos < 180 && reactCount === 0) {
        msg = `Hola! 🙏\n\nLamentamos la espera. Ya escalé tu caso como urgente.\n\nUn asesor te llama hoy sin falta. ¿A qué hora te viene mejor? 👇`
        alertVendedor = `⚠️ URGENTE — Lead lleva 2h esperando\n📱 wa.me/${conv.lead.telefono}`
      } else if (minutos >= 60 && minutos < 65 && reactCount === 0) {
        msg = `Hola de nuevo! 😊\n\nYa le recordé a tu asesor — te contacta hoy.\n\n¿A qué hora te viene mejor? 👇`
        alertVendedor = `📌 Lead lleva 1h esperando\n📱 wa.me/${conv.lead.telefono}`
      } else if (minutos >= 30 && minutos < 35 && reactCount === 0) {
        if (conv.vendor?.whatsappNumber) {
          await enviarVendedor(instancia, conv.vendor.whatsappNumber, `🔔 Lead lleva 30min esperando\n📱 wa.me/${conv.lead.telefono}`)
        }
        await prisma.conversation.update({
          where: { id: conv.id },
          data: { reactivationCount: reactCount + 1, lastReactivationAt: new Date(), updatedAt: new Date() }
        })
        procesados++
        continue
      }

      if (!msg) continue

      await enviarLead(instancia, conv.lead.telefono, msg)
      await guardarMsg(prisma, conv.leadId, conv.id, msg)
      if (alertVendedor && conv.vendor?.whatsappNumber) {
        await enviarVendedor(instancia, conv.vendor.whatsappNumber, alertVendedor)
      }

      await prisma.conversation.update({
        where: { id: conv.id },
        data: {
          reactivationCount: reactCount + 1,
          lastReactivationAt: new Date(),
          lastBotMessageAt: new Date(),
          updatedAt: new Date()
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
