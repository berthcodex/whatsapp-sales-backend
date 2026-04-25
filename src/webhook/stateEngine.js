// src/webhook/stateEngine.js — Sprint 5
// FIX VELOCIDAD: respuesta inmediata en webhook, no esperar al cron
// El stateEngine ahora avanza pasos MSG directamente cuando el lead responde
// El cron solo maneja: followups de tiempo, reactivaciones, alertas por silencio

import { detectarCursoCampana } from './classifier.js'
import { enviarTexto } from '../whatsapp/sender.js'

const sleep = ms => new Promise(r => setTimeout(r, ms))

function norm(t) {
  return (t || '').toLowerCase().normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ').trim()
}
function contiene(texto, kws) {
  const n = norm(texto)
  return kws.some(kw => n.includes(norm(kw)))
}

const KW_RECLAMO    = ['no me llamaron','nadie me llamo','no me han llamado','cuando me llaman','no me contactaron']
const KW_HORA       = ['llamame a','a las','pm','am','en la tarde','en la noche','mas tarde','despues']
const KW_PRECIO     = ['cuanto cuesta','precio','costo','cuotas','descuento','inversion','cuanto es']
const KW_INTERES    = ['me interesa','quiero inscribirme','como me inscribo','dale','listo','acepto','si quiero']
const KW_NO_INTERES = ['ya no','no me interesa','gracias igual','olvidalo','no gracias','no quiero']

async function guardarMsg(prisma, leadId, convId, origen, texto) {
  try {
    await prisma.message.create({
      data: { leadId, conversationId: convId || null, origen, texto }
    })
  } catch(e) { console.error('[Motor] guardarMsg:', e.message) }
}

async function getCampaign(prisma, slug) {
  if (slug) {
    const c = await prisma.campaign.findUnique({
      where: { slug },
      include: { vendor: true, steps: { orderBy: { orden: 'asc' } } }
    })
    if (c) return c
  }
  return await prisma.campaign.findFirst({
    where: { activa: true },
    include: { vendor: true, steps: { orderBy: { orden: 'asc' } } }
  })
}

function interp(msg, vars) {
  return (msg || '')
    .replace(/\{\{telefono\}\}/g, vars.telefono || '')
    .replace(/\{\{nombre\}\}/g,   vars.nombre   || '')
    .replace(/\{\{vendedor\}\}/g, vars.vendedor  || '')
    .replace(/\{\{curso\}\}/g,    vars.curso     || '')
}

// ── Avanzar al siguiente paso MSG inmediatamente ──────────────
// Esta función reemplaza al cron para los pasos secuenciales
async function avanzarSiguientePaso(prisma, conv, campaign, vendor, instancia) {
  try {
    const steps    = campaign?.steps || []
    const pasoActual = conv.currentStep || 0
    const pasosSig = steps.filter(s => s.orden > pasoActual)

    let proximoMSG = null
    const notifys  = []

    for (const paso of pasosSig) {
      if (paso.tipo === 'NOTIFY') { notifys.push(paso); continue }
      if (paso.tipo === 'MSG' && !proximoMSG) { proximoMSG = paso; break }
      if (paso.tipo === 'FOLLOWUP') break // FOLLOWUP lo maneja el cron
    }

    if (!proximoMSG) {
      // No hay más pasos MSG → notificar vendedor si no fue notificado
      if (conv.vendorNotificationCount === 0 && vendor?.whatsappNumber) {
        const mensajes = await prisma.message.findMany({
          where: { leadId: conv.leadId, origen: 'LEAD' },
          orderBy: { createdAt: 'asc' }
        })
        const historial = mensajes.map(m => `  > "${m.texto.slice(0, 80)}"`).join('\n')

        // Enviar NOTIFYs del flujo
        for (const n of notifys) {
          await enviarTexto(instancia, vendor.whatsappNumber,
            interp(n.mensaje, { telefono: conv.lead?.telefono || '', vendedor: vendor.nombre || '', curso: campaign?.nombre || '', nombre: conv.lead?.nombreDetectado || '' })
          ).catch(() => {})
        }

        // Notificación default si no hay NOTIFY en el flujo
        if (notifys.length === 0) {
          const msgV = `🟡 NUEVO LEAD\n\n📱 wa.me/${conv.lead?.telefono}\n👤 ${conv.lead?.nombreDetectado || 'Sin nombre'}\n📦 ${conv.lead?.productoDetectado || 'Sin producto'}\n📚 ${campaign?.nombre || 'orgánico'}\n${historial ? `\n💬 Dijo:\n${historial}` : ''}\n\n⚡ Llama hoy`
          await enviarTexto(instancia, vendor.whatsappNumber, msgV).catch(() => {})
        }

        await prisma.conversation.update({
          where: { id: conv.id },
          data: {
            state: 'NOTIFIED',
            vendorNotifiedAt: new Date(),
            vendorNotificationCount: 1
          }
        })
        await prisma.lead.update({
          where: { id: conv.leadId },
          data: { estado: 'NOTIFICADO' }
        }).catch(() => {})

        console.log(`[Motor] NOTIFIED: ${conv.lead?.telefono}`)
      }
      return
    }

    // Hay próximo MSG → enviarlo inmediatamente
    const vars = {
      telefono: conv.lead?.telefono || '',
      nombre:   conv.lead?.nombreDetectado || '',
      vendedor: vendor?.nombre || '',
      curso:    campaign?.nombre || ''
    }

    const msgLead = interp(proximoMSG.mensaje, vars)

    // CRÍTICO: marcar lastBotMessageAt ANTES de enviar
    // Esto evita que el cron dispare el mismo paso mientras enviamos
    await prisma.conversation.update({
      where: { id: conv.id },
      data: { currentStep: proximoMSG.orden, lastBotMessageAt: new Date() }
    })

    await sleep(800) // pequeña pausa natural antes de responder
    await enviarTexto(instancia, conv.lead?.telefono, msgLead)
    await guardarMsg(prisma, conv.leadId, conv.id, 'BOT', msgLead)
    await prisma.lead.update({
      where: { id: conv.leadId },
      data: { pasoActual: proximoMSG.orden, ultimoMensaje: new Date() }
    }).catch(() => {})

    // Enviar NOTIFYs que venían antes del MSG
    for (const n of notifys) {
      if (vendor?.whatsappNumber) {
        await enviarTexto(instancia, vendor.whatsappNumber, interp(n.mensaje, vars)).catch(() => {})
      }
    }

    console.log(`[Motor] Paso ${proximoMSG.orden} inmediato: ${conv.lead?.telefono}`)
  } catch (err) {
    console.error('[Motor] avanzarSiguientePaso:', err.message)
  }
}

async function manejarNotificado({ prisma, instancia, numero, lead, conv, vendor, texto }) {
  if (conv?.id) {
    await prisma.conversation.update({
      where: { id: conv.id },
      data: { lastLeadMessageAt: new Date() }
    }).catch(() => {})
  }

  const enviar = async (msg) => {
    await enviarTexto(instancia, numero, msg)
    await guardarMsg(prisma, lead.id, conv?.id, 'BOT', msg)
  }
  const alertar = async (motivo) => {
    if (vendor?.whatsappNumber)
      await enviarTexto(instancia, vendor.whatsappNumber, `${motivo}\n📱 wa.me/${lead.telefono}`).catch(() => {})
  }

  if (contiene(texto, KW_NO_INTERES)) {
    await enviar(`Entendido 😊\n\nSi cambias de opinión, aquí estaremos.\n\n¡Mucho éxito!`)
    await prisma.lead.update({ where: { id: lead.id }, data: { estado: 'CERRADO' } }).catch(() => {})
    if (conv?.id) await prisma.conversation.update({ where: { id: conv.id }, data: { state: 'CLOSED' } }).catch(() => {})
    return
  }
  if (contiene(texto, KW_RECLAMO)) {
    await enviar(`Mil disculpas 🙏\n\nYa envié alerta urgente a tu asesor — te llama en minutos.`)
    await alertar('⚠️ URGENTE — Lead reclama que nadie lo llamó')
    return
  }
  if (contiene(texto, KW_HORA)) {
    await enviar(`Perfecto! 📅\n\nLe aviso a tu asesor para que te llame en ese horario.`)
    await alertar(`📌 Lead pidió hora: "${texto.slice(0, 60)}"`)
    return
  }
  if (contiene(texto, KW_PRECIO)) {
    await enviar(`¡Claro! 💰\n\nTenemos facilidades de pago en cuotas.\n\nTu asesor te explica todo cuando te llame hoy 😊`)
    return
  }
  if (contiene(texto, KW_INTERES)) {
    await enviar(`¡Genial! 🎉\n\nYa avisé a tu asesor — te llama muy pronto.\n\n¡Estate atento!`)
    await alertar('🔄 Lead reconfirmó interés')
    return
  }
  // Default — cualquier otra respuesta del lead
  await enviar(`Con gusto 😊\n\n¿Tienes alguna pregunta sobre el programa o el precio? Un asesor de nuestro equipo te contactará pronto para orientarte.`)
}

// ════════════════════════════════════════════════════════════
// MOTOR PRINCIPAL
// ════════════════════════════════════════════════════════════
export async function procesarConMotor({ prisma, instancia, numero, texto, tieneImagen, vendor }) {
  try {
    const lead = await prisma.lead.findUnique({ where: { telefono: numero } })

    // ── LEAD EXISTENTE ────────────────────────────────────────
    if (lead) {
      const conv = await prisma.conversation.findFirst({
        where: { leadId: lead.id },
        orderBy: { createdAt: 'desc' },
        include: { lead: true }
      })

      await guardarMsg(prisma, lead.id, conv?.id || null, 'LEAD', texto || '[imagen]')

      if (conv?.id) {
        await prisma.conversation.update({
          where: { id: conv.id },
          data: { lastLeadMessageAt: new Date() }
        }).catch(() => {})
      }

      // Imagen → comprobante de pago
      if (tieneImagen) {
        const msg = `✅ Recibimos tu imagen.\n\nUn asesor validará tu pago y te dará los accesos.`
        await sleep(800)
        await enviarTexto(instancia, numero, msg)
        await guardarMsg(prisma, lead.id, conv?.id, 'BOT', msg)
        return
      }

      const convState = conv?.state || 'ACTIVE'
      if (convState === 'CLOSED' || lead.estado === 'CERRADO') return

      if (convState === 'NOTIFIED' || lead.estado === 'NOTIFICADO') {
        const cam = lead.campaignId
          ? await prisma.campaign.findUnique({ where: { id: lead.campaignId }, include: { vendor: true } })
          : null
        await manejarNotificado({
          prisma, instancia, numero, lead,
          conv: conv || null,
          vendor: cam?.vendor || vendor,
          texto
        })
        return
      }

      // ACTIVE → avanzar siguiente paso INMEDIATAMENTE
      // No esperar al cron — respuesta en tiempo real
      if (conv?.id) {
        const campaign = lead.campaignId
          ? await prisma.campaign.findUnique({
              where: { id: lead.campaignId },
              include: { steps: { orderBy: { orden: 'asc' } } }
            })
          : null

        await avanzarSiguientePaso(
          prisma,
          { ...conv, lead },
          campaign,
          vendor,
          instancia
        )
      }

      await prisma.lead.update({
        where: { id: lead.id },
        data: { ultimoMensaje: new Date() }
      }).catch(() => {})
      return
    }

    // ── LEAD NUEVO ────────────────────────────────────────────
    const cursoCampana = detectarCursoCampana(texto)
    const campaign = await getCampaign(prisma, cursoCampana?.slug)

    const newLead = await prisma.lead.create({
      data: {
        telefono: numero,
        campaignId: campaign?.id || null,
        vendorId: vendor.id,
        pasoActual: 0,
        estado: 'EN_FLUJO',
        ultimoMensaje: new Date()
      }
    })

    const conv = await prisma.conversation.create({
      data: {
        leadId: newLead.id,
        campaignId: campaign?.id || null,
        vendorId: vendor.id,
        state: 'ACTIVE',
        currentStep: 0,
        lastLeadMessageAt: new Date()
      }
    }).catch(async () => {
      return await prisma.conversation.findFirst({ where: { leadId: newLead.id } })
    })

    await guardarMsg(prisma, newLead.id, conv?.id || null, 'LEAD', texto)

    // Enviar bienvenida (paso 1)
    const pasos = campaign?.steps?.filter(s => s.tipo === 'MSG') || []
    const paso1 = pasos[0]

    const msgBienvenida = paso1?.mensaje
      ? interp(paso1.mensaje, {
          telefono: numero,
          vendedor: vendor?.nombre || '',
          curso: campaign?.nombre || '',
          nombre: ''
        })
      : `Hola 👋 te saluda *Perú Exporta TV* 🇵🇪\n\nCuéntame: ¿cómo te llamas y qué producto tienes en mente para exportar? 👇`

    await sleep(1000)
    await enviarTexto(instancia, numero, msgBienvenida)
    await guardarMsg(prisma, newLead.id, conv?.id || null, 'BOT', msgBienvenida)

    if (conv?.id) {
      await prisma.conversation.update({
        where: { id: conv.id },
        data: { currentStep: paso1?.orden || 1, lastBotMessageAt: new Date() }
      })
    }

    await prisma.lead.update({
      where: { id: newLead.id },
      data: { pasoActual: paso1?.orden || 1 }
    })

    console.log(`[Motor] Lead nuevo: ${numero} | ${campaign?.slug || 'orgánico'}`)

  } catch (err) {
    console.error('[Motor] Error:', err.message)
  }
}
