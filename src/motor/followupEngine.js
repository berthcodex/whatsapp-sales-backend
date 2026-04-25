// src/motor/followupEngine.js
// HIDATA — Motor de Seguimiento v3.0 — CON CONVERSATIONS
//
// FIX DEFINITIVO de mensajes repetidos:
// ANTES: usaba lead.estado + timestamp → drift temporal causaba loops
// AHORA: usa conversations.state + reactivation_count → control exacto
//
// REGLAS ANTI-LOOP:
// 1. Max 3 reactivaciones por conversation (campo reactivation_count)
// 2. Ventana de reactivación: min 30min desde last_reactivation_at
// 3. Reactivación no resetea pasoActual=0 — continúa desde current_step
// 4. Estado REACTIVATED → mismo comportamiento que ACTIVE pero con contador
// 5. vendor_notification_count evita notificar al vendedor más de 1 vez por conv

import { enviarTexto } from '../whatsapp/sender.js'
import {
  extraerNombre,
  extraerProducto,
  clasificarConScoring,
  clasificarConIA
} from '../webhook/classifier.js'

const SEG_SILENCIO      = 20
const MAX_REACTIVACIONES = 3
const MIN_ENTRE_REACTIVA = 30   // minutos mínimos entre reactivaciones

// ── Mirror a Google Sheets ───────────────────────────────────
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
    console.log('[Sheets] Sincronizado:', data.telefono)
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
      data: { leadId, conversation_id: convId || null, origen: 'BOT', texto }
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

// Actualizar conversation state con raw SQL (tabla nueva sin modelo Prisma)
async function updateConv(prisma, convId, fields) {
  const sets = Object.entries(fields)
    .map(([k, v], i) => `${k} = $${i + 2}`)
    .join(', ')
  const vals = Object.values(fields)
  await prisma.$executeRawUnsafe(
    `UPDATE conversations SET ${sets}, updated_at = NOW() WHERE id = $1`,
    convId, ...vals
  ).catch(err => console.error('[Followup] updateConv:', err.message))
}

// ════════════════════════════════════════════════════════════
// FUNCIÓN PRINCIPAL
// ════════════════════════════════════════════════════════════
export async function ejecutarFollowup(prisma) {
  const ahora = new Date()
  let procesados = 0

  // ══════════════════════════════════════════════════════════
  // FASE 1: Avanzar conversations ACTIVE con silencio > 20s
  // ══════════════════════════════════════════════════════════
  const convsActivas = await prisma.$queryRawUnsafe(`
    SELECT c.*, l.telefono, l."pasoActual", l."nombreDetectado", l."productoDetectado",
           cam.nombre AS campaign_nombre, cam.slug AS campaign_slug,
           v."whatsappNumber" AS vendor_phone, v.nombre AS vendor_nombre,
           v."instanciaEvolution" AS instancia
    FROM conversations c
    JOIN leads l ON l.id = c.lead_id
    LEFT JOIN campaigns cam ON cam.id = c.campaign_id
    LEFT JOIN vendors v ON v.id = c.vendor_id
    WHERE c.state IN ('ACTIVE', 'REACTIVATED')
      AND c.last_lead_message_at < NOW() - INTERVAL '${SEG_SILENCIO} seconds'
      AND (c.last_bot_message_at IS NULL OR c.last_bot_message_at < c.last_lead_message_at)
  `)

  for (const conv of convsActivas) {
    try {
      const instancia = conv.instancia
      if (!instancia) continue

      // Cargar campaign con steps
      const campaign = conv.campaign_id
        ? await prisma.campaign.findUnique({
            where: { id: conv.campaign_id },
            include: { steps: { orderBy: { orden: 'asc' } } }
          })
        : null

      // Mensajes del lead en esta conversation
      const mensajes = await prisma.message.findMany({
        where: { leadId: Number(conv.lead_id), origen: 'LEAD' },
        orderBy: { createdAt: 'asc' }
      })
      const textoAcumulado = mensajes.map(m => m.texto).join(' ')
      const historial      = mensajes.map(m => `  > "${m.texto.slice(0, 100)}"`).join('\n')

      const clasif = await clasificar(textoAcumulado)

      // Guardar clasificación
      await prisma.lead.update({
        where: { id: Number(conv.lead_id) },
        data: {
          nombreDetectado:   clasif.nombre   || null,
          productoDetectado: clasif.producto || null,
        }
      }).catch(() => {})

      const vars = {
        nombre:    clasif.nombre   || conv.telefono,
        producto:  clasif.producto || 'tu producto',
        telefono:  conv.telefono,
        vendedor:  conv.vendor_nombre  || '',
        curso:     conv.campaign_nombre|| 'Mi Primera Exportación',
        historial
      }

      const steps      = campaign?.steps || []
      const pasoActual = Number(conv.current_step) || 0
      const pasosSig   = steps.filter(s => s.orden > pasoActual)

      let proximoMSG = null
      const notifysAhora = []

      for (const paso of pasosSig) {
        if (paso.tipo === 'MSG' && !proximoMSG) {
          proximoMSG = paso; break
        }
        if (paso.tipo === 'NOTIFY') notifysAhora.push(paso)
      }

      // Hay próximo MSG → enviarlo
      if (proximoMSG) {
        for (const notify of notifysAhora) {
          if (conv.vendor_phone) {
            await enviarVendedor(instancia, conv.vendor_phone, interp(notify.mensaje, vars))
          }
        }

        const msgLead = interp(proximoMSG.mensaje, vars)
        await enviarLead(instancia, conv.telefono, msgLead)
        await guardarMsg(prisma, Number(conv.lead_id), Number(conv.id), msgLead)

        await updateConv(prisma, Number(conv.id), {
          current_step: proximoMSG.orden,
          last_bot_message_at: new Date()
        })
        await prisma.lead.update({
          where: { id: Number(conv.lead_id) },
          data: { pasoActual: proximoMSG.orden, ultimoMensaje: new Date() }
        }).catch(() => {})

        procesados++
        console.log(`[Followup] Avanzó paso ${proximoMSG.orden}: ${conv.telefono}`)
        continue
      }

      // No hay más MSGs → Notificar vendedor → NOTIFIED
      // GUARD: solo notificar si vendor_notification_count == 0
      if (Number(conv.vendor_notification_count) === 0) {
        for (const notify of notifysAhora) {
          if (conv.vendor_phone) {
            await enviarVendedor(instancia, conv.vendor_phone, interp(notify.mensaje, vars))
          }
        }

        if (notifysAhora.length === 0 && conv.vendor_phone) {
          const prioEmoji = clasif.prioridad === 'URGENTE' ? '🔴' :
                            clasif.prioridad === 'ALTA'    ? '🟠' : '🟡'
          const msgVendedor =
            `${prioEmoji} NUEVO LEAD — ${clasif.prioridad}\n\n` +
            `📱 wa.me/${conv.telefono}\n` +
            `👤 ${clasif.nombre   || 'Sin nombre'}\n` +
            `📦 ${clasif.producto || 'Sin producto'}\n` +
            `🎯 ${clasif.tipoPreciso || ''}\n` +
            `📚 ${conv.campaign_nombre || 'orgánico'}\n` +
            (historial ? `\n💬 Dijo:\n${historial}\n` : '') +
            `\n⚡ ${clasif.prioridad === 'URGENTE' ? '¡Llama AHORA!' : 'Llama hoy'}`
          await enviarVendedor(instancia, conv.vendor_phone, msgVendedor)
        }

        // Google Sheets
        const mensajesTexto = mensajes.map(m => m.texto).join(' | ')
        await escribirEnSheets({
          accion: 'nuevo', telefono: conv.telefono,
          msgInicial: mensajes[0]?.texto || '',
          mensajes: mensajesTexto,
          nombre: clasif.nombre || '', producto: clasif.producto || '',
          perfil: clasif.tipoPreciso, prioridad: clasif.prioridad,
          estado: 'pendiente llamar',
          vendedor: conv.vendor_nombre || '',
          campana: conv.campaign_nombre || ''
        })
      }

      // Marcar NOTIFIED en conversation Y en lead
      await updateConv(prisma, Number(conv.id), {
        state: 'NOTIFIED',
        vendor_notified_at: new Date(),
        vendor_notification_count: Number(conv.vendor_notification_count) + 1
      })
      await prisma.lead.update({
        where: { id: Number(conv.lead_id) },
        data: { estado: 'NOTIFICADO', ultimoMensaje: new Date() }
      }).catch(() => {})

      procesados++
      console.log(`[Followup] NOTIFIED: ${conv.telefono} | ${clasif.tipoPreciso} | ${clasif.prioridad}`)

    } catch (err) {
      console.error(`[Followup] Error conv ${conv.id}:`, err.message)
    }
  }

  // ══════════════════════════════════════════════════════════
  // FASE 2: Reactivaciones con GUARD anti-loop
  // REGLA: max MAX_REACTIVACIONES, esperar MIN_ENTRE_REACTIVA min
  // ══════════════════════════════════════════════════════════
  const convsParaReactivar = await prisma.$queryRawUnsafe(`
    SELECT c.*, l.telefono, l."pasoActual",
           v."whatsappNumber" AS vendor_phone, v.nombre AS vendor_nombre,
           v."instanciaEvolution" AS instancia,
           cam.nombre AS campaign_nombre
    FROM conversations c
    JOIN leads l ON l.id = c.lead_id
    LEFT JOIN vendors v ON v.id = c.vendor_id
    LEFT JOIN campaigns cam ON cam.id = c.campaign_id
    WHERE c.state = 'NOTIFIED'
      AND c.reactivation_count < ${MAX_REACTIVACIONES}
      AND (
        c.last_reactivation_at IS NULL
        OR c.last_reactivation_at < NOW() - INTERVAL '${MIN_ENTRE_REACTIVA} minutes'
      )
      AND c.last_lead_message_at < NOW() - INTERVAL '30 minutes'
  `)

  for (const conv of convsParaReactivar) {
    try {
      const instancia = conv.instancia
      if (!instancia) continue

      const ultimoTs  = conv.last_lead_message_at
        ? new Date(conv.last_lead_message_at).getTime()
        : new Date(conv.created_at).getTime()
      const minutos = Math.floor((ahora - ultimoTs) / 60000)
      const reactCount = Number(conv.reactivation_count)

      // 48h → frío definitivo (no más reactivaciones)
      if (minutos >= 2880) {
        await updateConv(prisma, Number(conv.id), { state: 'CLOSED' })
        await prisma.lead.update({
          where: { id: Number(conv.lead_id) },
          data: { estado: 'CERRADO' }
        }).catch(() => {})
        console.log(`[Followup] CLOSED (frío 48h): ${conv.telefono}`)
        continue
      }

      let msg = null
      let alertVendedor = null

      // 24h → reactivación
      if (minutos >= 1440 && reactCount === 0) {
        msg = `¡Hola! 👋 Qué gusto saber de ti de nuevo.\n\nTenemos nuevas fechas para *Mi Primera Exportación*.\n\n¿Sigues interesado/a? 😊`
        alertVendedor = `🔄 Lead reactivado +24h\n📱 wa.me/${conv.telefono}`
      }
      // 2h → urgencia (solo en reactivación 1)
      else if (minutos >= 120 && minutos < 180 && reactCount === 0) {
        msg = `Hola! 🙏\n\nLamentamos la espera. Ya escalé tu caso como urgente.\n\nUn asesor te llama hoy sin falta. ¿A qué hora te viene mejor? 👇`
        alertVendedor = `⚠️ URGENTE — Lead lleva 2h esperando\n📱 wa.me/${conv.telefono}`
      }
      // 1h → seguimiento suave (solo una vez)
      else if (minutos >= 60 && minutos < 62 && reactCount === 0) {
        msg = `Hola de nuevo! 😊\n\nYa le recordé a tu asesor — te contacta hoy.\n\n¿A qué hora te viene mejor? 👇`
        alertVendedor = `📌 Lead lleva 1h esperando\n📱 wa.me/${conv.telefono}`
      }
      // 30min → alerta silenciosa al vendedor (solo una vez)
      else if (minutos >= 30 && minutos < 32 && reactCount === 0) {
        if (conv.vendor_phone) {
          await enviarVendedor(instancia, conv.vendor_phone, `🔔 Lead lleva 30min esperando tu llamada\n📱 wa.me/${conv.telefono}`)
        }
        await updateConv(prisma, Number(conv.id), {
          reactivation_count: reactCount + 1,
          last_reactivation_at: new Date()
        })
        procesados++
        continue
      }

      if (!msg) continue

      // Enviar mensaje al lead
      await enviarLead(instancia, conv.telefono, msg)
      await guardarMsg(prisma, Number(conv.lead_id), Number(conv.id), msg)

      if (alertVendedor && conv.vendor_phone) {
        await enviarVendedor(instancia, conv.vendor_phone, alertVendedor)
      }

      // Actualizar conversation — incrementar contador, NO resetear current_step
      await updateConv(prisma, Number(conv.id), {
        reactivation_count: reactCount + 1,
        last_reactivation_at: new Date(),
        last_bot_message_at: new Date()
      })

      procesados++
      console.log(`[Followup] Reactivación #${reactCount + 1}: ${conv.telefono}`)

    } catch (err) {
      console.error(`[Followup] Error reactivando ${conv.id}:`, err.message)
    }
  }

  // ══════════════════════════════════════════════════════════
  // FASE 3: FOLLOWUP steps del FlowBuilder
  // ══════════════════════════════════════════════════════════
  const convsFollowup = await prisma.$queryRawUnsafe(`
    SELECT c.*, l.telefono, l."pasoActual", l."nombreDetectado", l."productoDetectado",
           v."whatsappNumber" AS vendor_phone, v.nombre AS vendor_nombre,
           v."instanciaEvolution" AS instancia,
           cam.nombre AS campaign_nombre
    FROM conversations c
    JOIN leads l ON l.id = c.lead_id
    LEFT JOIN vendors v ON v.id = c.vendor_id
    LEFT JOIN campaigns cam ON cam.id = c.campaign_id
    WHERE c.state IN ('ACTIVE', 'REACTIVATED')
  `)

  for (const conv of convsFollowup) {
    try {
      const instancia = conv.instancia
      if (!instancia || !conv.campaign_id) continue

      const campaign = await prisma.campaign.findUnique({
        where: { id: Number(conv.campaign_id) },
        include: { steps: { orderBy: { orden: 'asc' } } }
      })
      if (!campaign) continue

      const ultimoTs = conv.last_lead_message_at
        ? new Date(conv.last_lead_message_at).getTime() : 0
      const horasSilencio = (ahora - ultimoTs) / 3600000
      const pasoActual = Number(conv.current_step) || 0

      const followup = campaign.steps.find(s =>
        s.tipo === 'FOLLOWUP' &&
        s.orden > pasoActual &&
        s.followupHrs &&
        horasSilencio >= s.followupHrs &&
        horasSilencio < s.followupHrs + (2 / 60) // ventana 2 min
      )
      if (!followup) continue

      const vars = {
        nombre:   conv.nombreDetectado || conv.telefono,
        producto: conv.productoDetectado || 'tu producto',
        telefono: conv.telefono,
        vendedor: conv.vendor_nombre || '',
        curso:    conv.campaign_nombre || '',
        historial: ''
      }

      const msgFollowup = interp(followup.mensaje, vars)
      await enviarLead(instancia, conv.telefono, msgFollowup)
      await guardarMsg(prisma, Number(conv.lead_id), Number(conv.id), msgFollowup)
      await updateConv(prisma, Number(conv.id), {
        current_step: followup.orden,
        last_bot_message_at: new Date()
      })
      await prisma.lead.update({
        where: { id: Number(conv.lead_id) },
        data: { pasoActual: followup.orden, ultimoMensaje: new Date() }
      }).catch(() => {})

      procesados++
      console.log(`[Followup] FOLLOWUP ${followup.followupHrs}h: ${conv.telefono}`)
    } catch (err) {
      console.error(`[Followup] Error followup step ${conv.id}:`, err.message)
    }
  }

  console.log(`[Followup] Total procesados: ${procesados}`)
  return { ok: true, procesados, timestamp: ahora.toISOString() }
}
