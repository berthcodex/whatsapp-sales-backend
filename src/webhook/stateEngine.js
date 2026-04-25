// src/webhook/stateEngine.js — Sprint 4
// Fix: usa prisma.conversation (modelo real) en vez de $queryRawUnsafe
// Fix: sincroniza conversation.state + lead.estado siempre juntos

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

const KW_RECLAMO    = ['no me llamaron','nadie me llamo','no me han llamado','siguen sin llamar','cuando me llaman','no me contactaron','nunca me llamaron']
const KW_HORA       = ['llamame a','a las','pm','am','en la tarde','en la noche','en la mañana','mas tarde','despues','al rato']
const KW_PRECIO     = ['cuanto cuesta','precio','costo','caro','cuotas','descuento','inversion','cuanto es','cuanto vale']
const KW_INTERES    = ['me interesa','quiero inscribirme','como me inscribo','quiero participar','dale','listo','acepto','si quiero']
const KW_NO_INTERES = ['ya no','no me interesa','gracias igual','olvidalo','no gracias','no quiero']

async function guardarMensaje(prisma, { leadId, conversationId, direccion, texto }) {
  try {
    await prisma.message.create({
      data: {
        leadId,
        conversationId: conversationId || null,
        origen: direccion === 'ENTRANTE' ? 'LEAD' : 'BOT',
        texto
      }
    })
  } catch (err) {
    console.error('[Motor] guardarMensaje:', err.message)
  }
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

async function cerrarConversacion(prisma, conv, lead) {
  await Promise.all([
    prisma.conversation.update({
      where: { id: conv.id },
      data: { state: 'CLOSED', updatedAt: new Date().toISOString() }
    }),
    prisma.lead.update({
      where: { id: lead.id },
      data: { estado: 'CERRADO' }
    })
  ])
}

async function manejarNotificado({ prisma, instancia, numero, lead, conv, vendor, texto }) {
  await prisma.conversation.update({
    where: { id: conv.id },
    data: { lastLeadMessageAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
  })

  if (contiene(texto, KW_NO_INTERES)) {
    const msg = `Entendido, no hay problema 😊\n\nSi en algún momento cambias de opinión, aquí estaremos.\n\n¡Mucho éxito!`
    await enviarTexto(instancia, numero, msg)
    await guardarMensaje(prisma, { leadId: lead.id, conversationId: conv.id, direccion: 'SALIENTE', texto: msg })
    await cerrarConversacion(prisma, conv, lead)
    return
  }

  if (contiene(texto, KW_RECLAMO)) {
    const msg = `Mil disculpas, eso no debería pasar 🙏\n\nYa envié una alerta urgente a tu asesor — te llama en los próximos minutos.\n\n¡Gracias por tu paciencia!`
    await enviarTexto(instancia, numero, msg)
    await guardarMensaje(prisma, { leadId: lead.id, conversationId: conv.id, direccion: 'SALIENTE', texto: msg })
    if (vendor?.whatsappNumber) {
      await enviarTexto(instancia, vendor.whatsappNumber, `⚠️ URGENTE — Lead reclama que nadie lo llamó\n\n📱 wa.me/${lead.telefono}\n¡Llama ahora!`)
    }
    return
  }

  if (contiene(texto, KW_HORA)) {
    const msg = `Perfecto! 📅\n\nLe aviso a tu asesor que te llame en ese horario.\n\n¡Estate pendiente al teléfono!`
    await enviarTexto(instancia, numero, msg)
    await guardarMensaje(prisma, { leadId: lead.id, conversationId: conv.id, direccion: 'SALIENTE', texto: msg })
    if (vendor?.whatsappNumber) {
      await enviarTexto(instancia, vendor.whatsappNumber, `📌 Lead pidió hora específica\n📱 wa.me/${lead.telefono}\nDijo: "${texto.slice(0, 80)}"`)
    }
    return
  }

  if (contiene(texto, KW_PRECIO)) {
    const msg = `¡Claro! 💰\n\nTenemos facilidades de pago en cuotas.\n\nTu asesor te explicará todos los detalles cuando te llame — ¡que es hoy! 😊`
    await enviarTexto(instancia, numero, msg)
    await guardarMensaje(prisma, { leadId: lead.id, conversationId: conv.id, direccion: 'SALIENTE', texto: msg })
    return
  }

  if (contiene(texto, KW_INTERES)) {
    const msg = `¡Genial! 🎉\n\nYa avisé a tu asesor — te llama muy pronto.\n\n¡Estate atento al teléfono!`
    await enviarTexto(instancia, numero, msg)
    await guardarMensaje(prisma, { leadId: lead.id, conversationId: conv.id, direccion: 'SALIENTE', texto: msg })
    if (vendor?.whatsappNumber) {
      await enviarTexto(instancia, vendor.whatsappNumber, `🔄 Lead reconfirmó interés\n📱 wa.me/${lead.telefono}`)
    }
    return
  }

  // Default
  const msg = `¡Hola! 👋\n\nTu asesor ya está al tanto y te llama muy pronto.\n\n¡Estate pendiente al teléfono!`
  await enviarTexto(instancia, numero, msg)
  await guardarMensaje(prisma, { leadId: lead.id, conversationId: conv.id, direccion: 'SALIENTE', texto: msg })
}

// ════════════════════════════════════════════════════════════
// MOTOR PRINCIPAL
// ════════════════════════════════════════════════════════════
export async function procesarConMotor({ prisma, instancia, numero, texto, tieneImagen, vendor }) {
  try {
    const lead = await prisma.lead.findUnique({ where: { telefono: numero } })

    // ── LEAD EXISTENTE ───────────────────────────────────────
    if (lead) {
      const conv = await prisma.conversation.findFirst({
        where: { leadId: lead.id },
        orderBy: { updatedAt: 'desc' }
      })

      await guardarMensaje(prisma, {
        leadId: lead.id,
        conversationId: conv?.id || null,
        direccion: 'ENTRANTE',
        texto: texto || '[imagen]'
      })

      if (conv) {
        await prisma.conversation.update({
          where: { id: conv.id },
          data: { lastLeadMessageAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
        })
      }

      // Imagen → comprobante de pago
      if (tieneImagen) {
        const msg = `✅ Recibimos tu imagen.\n\nUn asesor validará tu pago y te dará los accesos en breve.`
        await sleep(800)
        await enviarTexto(instancia, numero, msg)
        await guardarMensaje(prisma, { leadId: lead.id, conversationId: conv?.id, direccion: 'SALIENTE', texto: msg })
        return
      }

      const convState = conv?.state || 'ACTIVE'

      if (convState === 'CLOSED' || lead.estado === 'CERRADO') return

      if (convState === 'NOTIFIED' || lead.estado === 'NOTIFICADO') {
        const campaignData = lead.campaignId
          ? await prisma.campaign.findUnique({ where: { id: lead.campaignId }, include: { vendor: true } })
          : null
        await manejarNotificado({
          prisma, instancia, numero, lead,
          conv: conv || { id: null },
          vendor: campaignData?.vendor || vendor,
          texto
        })
        return
      }

      // ACTIVE → acumular, el followupEngine avanza
      await prisma.lead.update({
        where: { id: lead.id },
        data: { ultimoMensaje: new Date().toISOString() }
      }).catch(() => {})
      return
    }

    // ── LEAD NUEVO ───────────────────────────────────────────
    const cursoCampana = detectarCursoCampana(texto)
    const campaign = await getCampaign(prisma, cursoCampana?.slug)

    const newLead = await prisma.lead.create({
      data: {
        telefono: numero,
        campaignId: campaign?.id || null,
        vendorId: vendor.id,
        pasoActual: 0,
        estado: 'EN_FLUJO',
        ultimoMensaje: new Date().toISOString()
      }
    })

    // Crear conversation con modelo Prisma real
    const conv = await prisma.conversation.create({
      data: {
        leadId: newLead.id,
        campaignId: campaign?.id || null,
        vendorId: vendor.id,
        state: 'ACTIVE',
        currentStep: 0,
        lastLeadMessageAt: new Date().toISOString()
      }
    }).catch(async (err) => {
      // Si ya existe (race condition), buscarla
      console.error('[Motor] conversation ya existe:', err.message)
      return await prisma.conversation.findFirst({ where: { leadId: newLead.id } })
    })

    await guardarMensaje(prisma, {
      leadId: newLead.id,
      conversationId: conv?.id || null,
      direccion: 'ENTRANTE',
      texto
    })

    // Bienvenida desde FlowBuilder
    const pasosMSG = campaign?.steps?.filter(s => s.tipo === 'MSG') || []
    const pasoBienvenida = pasosMSG[0]

    const msgBienvenida = pasoBienvenida?.mensaje
      ? pasoBienvenida.mensaje
          .replace(/\{\{telefono\}\}/g, numero)
          .replace(/\{\{vendedor\}\}/g, vendor?.nombre || '')
          .replace(/\{\{curso\}\}/g, campaign?.nombre || '')
      : `Hola 👋 te saluda *Perú Exporta TV* 🇵🇪\n\nCuéntame: ¿cómo te llamas y qué producto tienes en mente para exportar? 👇`

    await sleep(1000)
    await enviarTexto(instancia, numero, msgBienvenida)
    await guardarMensaje(prisma, {
      leadId: newLead.id,
      conversationId: conv?.id || null,
      direccion: 'SALIENTE',
      texto: msgBienvenida
    })

    if (conv?.id) {
      await prisma.conversation.update({
        where: { id: conv.id },
        data: {
          currentStep: pasoBienvenida?.orden || 1,
          lastBotMessageAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }
      })
    }

    await prisma.lead.update({
      where: { id: newLead.id },
      data: { pasoActual: pasoBienvenida?.orden || 1 }
    })

    console.log(`[Motor] Lead nuevo: ${numero} | campaña: ${campaign?.slug || 'orgánico'}`)

  } catch (err) {
    console.error('[Motor] Error:', err.message, err.stack)
  }
}
