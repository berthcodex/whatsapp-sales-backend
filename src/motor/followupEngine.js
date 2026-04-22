// src/motor/followupEngine.js
// HIDATA — Motor de Seguimiento DEFINITIVO v2.0
//
// FILOSOFÍA: El FlowBuilder manda. El motor obedece.
// Cada paso del FlowBuilder se ejecuta en orden.
// El cron es el director de orquesta.
//
// ESTRUCTURA DE PASOS EN FLOWBUILDER:
//   MSG      → mensaje al lead (se envía cuando el lead responde)
//   NOTIFY   → mensaje al vendedor (se envía junto al último MSG)
//   FOLLOWUP → mensaje al lead si no responde en X horas
//
// FLUJO COMPLETO MPX (ejemplo):
//   Paso 1 MSG      → bienvenida (enviado por stateEngine al llegar)
//   Paso 2 MSG      → orientación (cron lo envía cuando lead responde paso 1)
//   Paso 3 MSG      → presentación (cron lo envía cuando lead responde paso 2)
//   Paso 4 NOTIFY   → notificación vendedor (cron lo envía tras paso 3)
//   Paso 5 FOLLOWUP → si no responde en 2h → cron lo envía
//
// REGLA DE CIERRE:
//   20s de silencio → cron avanza al siguiente paso MSG
//   Si no hay más pasos MSG → cron envía NOTIFY → lead queda NOTIFICADO
//
// REACTIVACIONES POST-NOTIFICADO:
//   30 min → alerta al vendedor
//   1 hora → mensaje suave al lead
//   2 horas → urgencia
//   24 horas → reactivación total
//   48 horas → frío

import { enviarTexto } from '../whatsapp/sender.js'
import {
  extraerNombre,
  extraerProducto,
  clasificarConScoring,
  clasificarConIA
} from '../webhook/classifier.js'


// ── Mirror a Google Sheets ───────────────────────────────────
async function escribirEnSheets({ telefono, msgInicial, mensajes, nombre, producto, perfil, prioridad, estado, vendedor, campana, accion = 'nuevo' }) {
  const url = process.env.SHEETS_WEBHOOK_URL
  if (!url) { console.log('[Sheets] SHEETS_WEBHOOK_URL no configurada'); return }
  console.log('[Sheets] Enviando a:', url.slice(0, 60))
  try {
    // Google Apps Script requiere form-urlencoded, no JSON
    const params = new URLSearchParams({
      accion, telefono,
      msgInicial: msgInicial || '',
      mensajes:   mensajes   || '',
      nombre:     nombre     || '',
      producto:   producto   || '',
      perfil:     perfil     || '',
      prioridad:  prioridad  || '',
      estado:     estado     || '',
      vendedor:   vendedor   || '',
      campana:    campana    || ''
    })
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
      redirect: 'follow',
      signal: AbortSignal.timeout(8000)
    })
  } catch (err) {
    console.error('[Sheets] Error escribiendo:', err.message, err.cause?.message || '')
  }
}

const SEG_SILENCIO       = 20
const MIN_ALERTA_VENDOR  = 30
const MIN_REACTIVA_1     = 60
const MIN_REACTIVA_2     = 120
const MIN_REACTIVA_3     = 1440
const MIN_FRIO           = 2880

// ── Clasificar texto acumulado ───────────────────────────────
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
  return {
    nombre,
    producto,
    tipo:        clasif.tipo        || 'A',
    tipoPreciso: clasif.tipoPreciso || 'Tipo A — formación',
    prioridad:   clasif.prioridad   || 'MEDIA',
    confianza:   clasif.confianza   || 'baja'
  }
}

// ── Interpolar variables ─────────────────────────────────────
function interp(msg, vars) {
  return (msg || '')
    .replace(/\{\{nombre\}\}/g,    vars.nombre    || vars.telefono || '')
    .replace(/\{\{producto\}\}/g,  vars.producto  || 'tu producto')
    .replace(/\{\{telefono\}\}/g,  vars.telefono  || '')
    .replace(/\{\{vendedor\}\}/g,  vars.vendedor  || '')
    .replace(/\{\{curso\}\}/g,     vars.curso     || 'Mi Primera Exportación')
    .replace(/\{\{historial\}\}/g, vars.historial || '')
}

// ── Helpers ──────────────────────────────────────────────────
async function guardarMsg(prisma, leadId, texto) {
  try { await prisma.message.create({ data: { leadId, origen: 'BOT', texto } }) } catch {}
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
// FUNCIÓN PRINCIPAL
// ════════════════════════════════════════════════════════════
export async function ejecutarFollowup(prisma) {
  const ahora = new Date()
  let procesados = 0

  // ══════════════════════════════════════════════════════════
  // FASE 1: Avanzar leads EN_FLUJO con 20s de silencio
  //
  // LÓGICA DE PASOS:
  // - pasoActual = orden del último MSG enviado (1 = bienvenida ya enviada)
  // - Buscar el siguiente paso en el flujo
  // - Si es MSG → enviarlo al lead → actualizar pasoActual
  // - Si es NOTIFY → enviarlo al vendedor → continuar buscando
  // - Si no hay más pasos MSG → clasificar → NOTIFICADO
  // ══════════════════════════════════════════════════════════
  const leadsCierre = await prisma.lead.findMany({
    where: {
      estado: 'EN_FLUJO',
      ultimoMensaje: { lte: new Date(ahora - SEG_SILENCIO * 1000) }
    },
    include: {
      campaign: {
        include: { vendor: true, steps: { orderBy: { orden: 'asc' } } }
      },
      vendor: true
    }
  })

  for (const lead of leadsCierre) {
    try {
      const vendor    = lead.campaign?.vendor || lead.vendor
      const campaign  = lead.campaign
      const instancia = vendor?.instanciaEvolution
      if (!instancia) continue

      // Recopilar historial completo del lead
      const mensajes = await prisma.message.findMany({
        where: { leadId: lead.id, origen: 'LEAD' },
        orderBy: { createdAt: 'asc' }
      })
      const textoAcumulado = mensajes.map(m => m.texto).join(' ')
      const historial      = mensajes.map(m => `  > "${m.texto.slice(0, 100)}"`).join('\n')

      // Clasificar lead con todo lo que escribió
      const clasif = await clasificar(textoAcumulado)

      // Guardar clasificación en DB
      await prisma.lead.update({
        where: { id: lead.id },
        data: {
          nombreDetectado:   clasif.nombre   || null,
          productoDetectado: clasif.producto || null,
        }
      }).catch(() => {})

      const vars = {
        nombre:    clasif.nombre   || lead.telefono,
        producto:  clasif.producto || 'tu producto',
        telefono:  lead.telefono,
        vendedor:  vendor?.nombre  || '',
        curso:     campaign?.nombre|| 'Mi Primera Exportación',
        historial
      }

      // ── Buscar el siguiente paso a ejecutar ──────────────
      const steps = campaign?.steps || []
      const pasoActual = lead.pasoActual || 0

      // Todos los pasos después del actual
      const pasosSiguientes = steps.filter(s => s.orden > pasoActual)

      // Separar el próximo MSG y todos los NOTIFYs que vienen antes del siguiente MSG
      let proximoMSG = null
      const notifysAhora = []
      let proximoFOLLOWUP = null

      for (const paso of pasosSiguientes) {
        if (paso.tipo === 'MSG' && !proximoMSG) {
          proximoMSG = paso
          break // Parar — esperar respuesta del lead antes del siguiente MSG
        }
        if (paso.tipo === 'NOTIFY') {
          notifysAhora.push(paso)
        }
        if (paso.tipo === 'FOLLOWUP' && !proximoFOLLOWUP) {
          proximoFOLLOWUP = paso
        }
      }

      // Si hay un próximo MSG → enviarlo y esperar respuesta
      if (proximoMSG) {
        // Primero ejecutar NOTIFYs que estaban antes del MSG
        for (const notify of notifysAhora) {
          if (vendor?.whatsappNumber) {
            const msgNotify = interp(notify.mensaje, vars)
            await enviarVendedor(instancia, vendor.whatsappNumber, msgNotify)
          }
        }

        // Enviar el siguiente MSG al lead
        const msgLead = interp(proximoMSG.mensaje, vars)
        await enviarLead(instancia, lead.telefono, msgLead)
        await guardarMsg(prisma, lead.id, msgLead)

        // Actualizar pasoActual → esperar respuesta del lead
        await prisma.lead.update({
          where: { id: lead.id },
          data: {
            pasoActual: proximoMSG.orden,
            ultimoMensaje: new Date()  // resetear para volver a esperar 20s
          }
        })

        procesados++
        console.log(`[Followup] Avanzó paso ${proximoMSG.orden}: ${lead.telefono}`)
        continue
      }

      // No hay más MSGs → ejecutar NOTIFYs finales → NOTIFICADO
      for (const notify of notifysAhora) {
        if (vendor?.whatsappNumber) {
          const msgNotify = interp(notify.mensaje, vars)
          await enviarVendedor(instancia, vendor.whatsappNumber, msgNotify)
        }
      }

      // Si no había NOTIFY en el flujo → notificación genérica con clasificación
      if (notifysAhora.length === 0 && vendor?.whatsappNumber) {
        const prioEmoji = clasif.prioridad === 'URGENTE' ? '🔴' :
                          clasif.prioridad === 'ALTA'    ? '🟠' : '🟡'
        const msgVendedor =
          `${prioEmoji} NUEVO LEAD — ${clasif.prioridad}\n\n` +
          `📱 wa.me/${lead.telefono}\n` +
          `👤 ${clasif.nombre   || 'Sin nombre'}\n` +
          `📦 ${clasif.producto || 'Sin producto'}\n` +
          `🎯 ${clasif.tipoPreciso}\n` +
          `📚 ${campaign?.nombre || 'orgánico'}\n` +
          (historial ? `\n💬 Dijo:\n${historial}\n` : '') +
          `\n⚡ ${clasif.prioridad === 'URGENTE' ? '¡Llama AHORA!' : 'Llama hoy'}`
        await enviarVendedor(instancia, vendor.whatsappNumber, msgVendedor)
      }

      // Mirror a Google Sheets
      const mensajesTexto = mensajes.map(m => m.texto).join(' | ')
      const msgInicial = mensajes[0]?.texto || ''
      await escribirEnSheets({
        accion:    'nuevo',
        telefono:  lead.telefono,
        msgInicial,
        mensajes:  mensajesTexto,
        nombre:    clasif.nombre   || '',
        producto:  clasif.producto || '',
        perfil:    clasif.tipoPreciso,
        prioridad: clasif.prioridad,
        estado:    'pendiente llamar',
        vendedor:  vendor?.nombre  || '',
        campana:   campaign?.nombre|| ''
      })

      // Marcar como NOTIFICADO
      await prisma.lead.update({
        where: { id: lead.id },
        data: { estado: 'NOTIFICADO', ultimoMensaje: new Date() }
      })

      procesados++
      console.log(`[Followup] Cerrado: ${lead.telefono} | ${clasif.tipoPreciso} | ${clasif.prioridad}`)

    } catch (err) {
      console.error(`[Followup] Error lead ${lead.telefono}:`, err.message)
    }
  }

  // ══════════════════════════════════════════════════════════
  // FASE 2: FOLLOWUP pasos — si lead no respondió en X horas
  // El FOLLOWUP del FlowBuilder se envía si el lead lleva
  // X horas sin responder DESDE que recibió el último MSG
  // ══════════════════════════════════════════════════════════
  const leadsEnFlujoConFollowup = await prisma.lead.findMany({
    where: { estado: 'EN_FLUJO' },
    include: {
      campaign: {
        include: { vendor: true, steps: { orderBy: { orden: 'asc' } } }
      },
      vendor: true
    }
  })

  for (const lead of leadsEnFlujoConFollowup) {
    try {
      const vendor    = lead.campaign?.vendor || lead.vendor
      const instancia = vendor?.instanciaEvolution
      if (!instancia) continue

      const steps      = lead.campaign?.steps || []
      const pasoActual = lead.pasoActual || 0
      const ultimoTs   = lead.ultimoMensaje ? new Date(lead.ultimoMensaje).getTime() : 0
      const horasSilencio = (ahora - ultimoTs) / 3600000

      // Buscar FOLLOWUP que aplique según horas de silencio
      const followup = steps.find(s =>
        s.tipo === 'FOLLOWUP' &&
        s.orden > pasoActual &&
        s.followupHrs &&
        horasSilencio >= s.followupHrs &&
        horasSilencio < s.followupHrs + (1/60) // ventana de 1 minuto
      )

      if (!followup) continue

      const mensajes = await prisma.message.findMany({
        where: { leadId: lead.id, origen: 'LEAD' },
        orderBy: { createdAt: 'asc' }
      })
      const vars = {
        nombre:   lead.nombreDetectado || lead.telefono,
        producto: lead.productoDetectado || 'tu producto',
        telefono: lead.telefono,
        vendedor: vendor?.nombre || '',
        curso:    lead.campaign?.nombre || '',
        historial: mensajes.map(m => `  > "${m.texto.slice(0, 80)}"`).join('\n')
      }

      const msgFollowup = interp(followup.mensaje, vars)
      await enviarLead(instancia, lead.telefono, msgFollowup)
      await guardarMsg(prisma, lead.id, msgFollowup)
      await prisma.lead.update({
        where: { id: lead.id },
        data: { pasoActual: followup.orden, ultimoMensaje: new Date() }
      })

      procesados++
      console.log(`[Followup] FOLLOWUP ${followup.followupHrs}h: ${lead.telefono}`)

    } catch (err) {
      console.error(`[Followup] Error followup ${lead.telefono}:`, err.message)
    }
  }

  // ══════════════════════════════════════════════════════════
  // FASE 3: Reactivaciones post-NOTIFICADO
  // ══════════════════════════════════════════════════════════
  const leadsNotificados = await prisma.lead.findMany({
    where: { estado: 'NOTIFICADO' },
    include: {
      campaign: { include: { vendor: true } },
      vendor: true
    }
  })

  for (const lead of leadsNotificados) {
    try {
      const vendor    = lead.campaign?.vendor || lead.vendor
      const instancia = vendor?.instanciaEvolution
      if (!instancia) continue

      const ultimoTs = lead.ultimoMensaje
        ? new Date(lead.ultimoMensaje).getTime()
        : new Date(lead.createdAt).getTime()
      const minutos = Math.floor((ahora - ultimoTs) / 60000)

      // 48h → frío
      if (minutos >= MIN_FRIO) {
        await prisma.lead.update({ where: { id: lead.id }, data: { estado: 'CERRADO' } })
        console.log(`[Followup] Frío: ${lead.telefono}`)
        continue
      }

      const enVentana = (umbral) => minutos >= umbral && minutos < umbral + 2

      // 24h → reactivación total
      if (enVentana(MIN_REACTIVA_3)) {
        const msg = `¡Hola! 👋 Qué gusto saber de ti de nuevo.\n\nTenemos nuevas fechas para *Mi Primera Exportación*.\n\n¿Sigues interesado/a? 😊`
        await enviarLead(instancia, lead.telefono, msg)
        await guardarMsg(prisma, lead.id, msg)
        if (vendor?.whatsappNumber) await enviarVendedor(instancia, vendor.whatsappNumber, `🔄 Lead reactivado +24h\n📱 wa.me/${lead.telefono}`)
        await prisma.lead.update({ where: { id: lead.id }, data: { estado: 'EN_FLUJO', ultimoMensaje: new Date(), pasoActual: 0 } })
        procesados++; continue
      }

      // 2h → urgencia
      if (enVentana(MIN_REACTIVA_2)) {
        const msg = `Hola! 🙏\n\nLamentamos la espera. Ya escalé tu caso como URGENTE.\n\nUn asesor te llama hoy sin falta. ¿A qué hora te viene mejor? 👇`
        await enviarLead(instancia, lead.telefono, msg)
        await guardarMsg(prisma, lead.id, msg)
        if (vendor?.whatsappNumber) await enviarVendedor(instancia, vendor.whatsappNumber, `⚠️ URGENTE — Lead lleva 2h esperando\n📱 wa.me/${lead.telefono}`)
        await prisma.lead.update({ where: { id: lead.id }, data: { ultimoMensaje: new Date() } })
        procesados++; continue
      }

      // 1h → seguimiento suave
      if (enVentana(MIN_REACTIVA_1)) {
        const msg = `Hola de nuevo! 😊\n\nYa le recordé a tu asesor — te contacta hoy.\n\n¿A qué hora te viene mejor? 👇`
        await enviarLead(instancia, lead.telefono, msg)
        await guardarMsg(prisma, lead.id, msg)
        if (vendor?.whatsappNumber) await enviarVendedor(instancia, vendor.whatsappNumber, `📌 Lead lleva 1h esperando\n📱 wa.me/${lead.telefono}`)
        await prisma.lead.update({ where: { id: lead.id }, data: { ultimoMensaje: new Date() } })
        procesados++; continue
      }

      // 30min → alerta silenciosa al vendedor
      if (enVentana(MIN_ALERTA_VENDOR)) {
        if (vendor?.whatsappNumber) await enviarVendedor(instancia, vendor.whatsappNumber, `🔔 Lead lleva 30min esperando tu llamada\n📱 wa.me/${lead.telefono}`)
        procesados++
      }

    } catch (err) {
      console.error(`[Followup] Error reactivando ${lead.telefono}:`, err.message)
    }
  }

  console.log(`[Followup] Total procesados: ${procesados}`)
  return { ok: true, procesados, timestamp: ahora.toISOString() }
}
