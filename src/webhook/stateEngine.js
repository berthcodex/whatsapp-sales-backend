// src/webhook/stateEngine.js
// HIDATA — Motor Sprint 5.0 — CON CONVERSATIONS OBJECT
//
// FIX DEFINITIVO del bug de mensajes repetidos:
// - Antes: el motor miraba lead.estado (puede ser stale)
// - Ahora: el motor busca conversation.state (fuente de verdad)
// - Si ya existe una conversation NOTIFIED/CLOSED → silencio total
// - Si ya existe ACTIVE → acumula mensajes, no manda nada
// - Solo si no existe conversation → lead nuevo → crea conversation + envía bienvenida

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
        conversation_id: conversationId || null,
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

async function renotificarVendedor({ instancia, lead, vendor, motivo }) {
  try {
    if (!vendor?.whatsappNumber) return
    const msg = `⚠️ ${motivo}\n\n📱 wa.me/${lead.telefono}\nAcción requerida — llama ahora`
    await enviarTexto(instancia, vendor.whatsappNumber, msg)
  } catch (err) {
    console.error('[Motor] renotificarVendedor:', err.message)
  }
}

// Manejar mensajes cuando conversation está NOTIFIED
async function manejarNotificado({ prisma, instancia, numero, lead, conv, vendor, texto }) {
  // Actualizar timestamp del último mensaje del lead en la conversation
  await prisma.$executeRawUnsafe(
    `UPDATE conversations SET last_lead_message_at = NOW(), updated_at = NOW() WHERE id = $1`,
    conv.id
  ).catch(() => {})

  if (contiene(texto, KW_NO_INTERES)) {
    const msg = `Entendido, no hay problema 😊\n\nSi en algún momento cambias de opinión, aquí estaremos.\n\n¡Mucho éxito!`
    await enviarTexto(instancia, numero, msg)
    await guardarMensaje(prisma, { leadId: lead.id, conversationId: conv.id, direccion: 'SALIENTE', texto: msg })
    // Cerrar AMBOS: lead y conversation
    await prisma.lead.update({ where: { id: lead.id }, data: { estado: 'CERRADO' } })
    await prisma.$executeRawUnsafe(
      `UPDATE conversations SET state = 'CLOSED', updated_at = NOW() WHERE id = $1`, conv.id
    ).catch(() => {})
    return
  }

  if (contiene(texto, KW_RECLAMO)) {
    const msg = `Mil disculpas, eso no debería pasar 🙏\n\nYa envié una alerta urgente a tu asesor — te llama en los próximos minutos.\n\n¡Gracias por tu paciencia!`
    await enviarTexto(instancia, numero, msg)
    await guardarMensaje(prisma, { leadId: lead.id, conversationId: conv.id, direccion: 'SALIENTE', texto: msg })
    await renotificarVendedor({ instancia, lead, vendor, motivo: `URGENTE — Lead reclama que nadie lo llamó` })
    return
  }

  if (contiene(texto, KW_HORA)) {
    const msg = `Perfecto! 📅\n\nLe aviso a tu asesor que te llame en ese horario.\n\n¡Estate pendiente al teléfono!`
    await enviarTexto(instancia, numero, msg)
    await guardarMensaje(prisma, { leadId: lead.id, conversationId: conv.id, direccion: 'SALIENTE', texto: msg })
    await renotificarVendedor({ instancia, lead, vendor, motivo: `Lead pidió hora: "${texto.slice(0, 80)}"` })
    return
  }

  if (contiene(texto, KW_PRECIO)) {
    const msg = `La inversión en el programa es de S/ 1,500 💰\n\nTambién tenemos facilidades de pago en cuotas.\n\nTu asesor te explicará todos los detalles cuando te llame — ¡que es hoy! 😊`
    await enviarTexto(instancia, numero, msg)
    await guardarMensaje(prisma, { leadId: lead.id, conversationId: conv.id, direccion: 'SALIENTE', texto: msg })
    return
  }

  if (contiene(texto, KW_INTERES)) {
    const msg = `¡Genial! 🎉\n\nYa avisé a tu asesor — te llama muy pronto.\n\n¡Estate atento al teléfono!`
    await enviarTexto(instancia, numero, msg)
    await guardarMensaje(prisma, { leadId: lead.id, conversationId: conv.id, direccion: 'SALIENTE', texto: msg })
    await renotificarVendedor({ instancia, lead, vendor, motivo: `Lead reconfirmó interés` })
    return
  }

  // Default
  const msg = `¡Hola! 👋\n\nTu asesor ya está al tanto y te llama muy pronto.\n\n¡Estate pendiente al teléfono!`
  await enviarTexto(instancia, numero, msg)
  await guardarMensaje(prisma, { leadId: lead.id, conversationId: conv.id, direccion: 'SALIENTE', texto: msg })
}

// ════════════════════════════════════════════════════════════
// MOTOR PRINCIPAL — con conversations como fuente de verdad
// ════════════════════════════════════════════════════════════
export async function procesarConMotor({ prisma, instancia, numero, texto, tieneImagen, vendor }) {
  try {
    // 1. Buscar lead
    const lead = await prisma.lead.findUnique({ where: { telefono: numero } })

    // ── LEAD EXISTENTE ───────────────────────────────────────
    if (lead) {
      // 2. Buscar conversation activa de este lead
      // Usamos raw query porque conversations es tabla nueva sin modelo Prisma aún
      const convRows = await prisma.$queryRawUnsafe(
        `SELECT * FROM conversations WHERE lead_id = $1 ORDER BY updated_at DESC LIMIT 1`,
        lead.id
      )
      const conv = convRows?.[0] || null

      // Guardar mensaje entrante siempre
      await guardarMensaje(prisma, {
        leadId: lead.id,
        conversationId: conv?.id || null,
        direccion: 'ENTRANTE',
        texto: texto || '[imagen]'
      })

      // Actualizar timestamp en conversation
      if (conv) {
        await prisma.$executeRawUnsafe(
          `UPDATE conversations SET last_lead_message_at = NOW(), updated_at = NOW() WHERE id = $1`,
          conv.id
        ).catch(() => {})
      }

      // Imagen → posible pago (independiente del estado)
      if (tieneImagen) {
        const msg = `✅ Recibimos tu imagen.\n\nUn asesor validará tu pago y te dará los accesos en breve.`
        await sleep(800)
        await enviarTexto(instancia, numero, msg)
        await guardarMensaje(prisma, { leadId: lead.id, conversationId: conv?.id, direccion: 'SALIENTE', texto: msg })
        return
      }

      // ── DECISIÓN POR ESTADO DE CONVERSATION (no de lead) ──
      const convState = conv?.state || lead.estado

      // CERRADO → silencio total
      if (convState === 'CLOSED' || lead.estado === 'CERRADO') return

      // NOTIFIED → casuísticas (responder preguntas del lead)
      if (convState === 'NOTIFIED' || lead.estado === 'NOTIFICADO') {
        const campaignForVendor = lead.campaignId
          ? await prisma.campaign.findUnique({
              where: { id: lead.campaignId },
              include: { vendor: true }
            })
          : null
        await manejarNotificado({
          prisma, instancia, numero, lead,
          conv,
          vendor: campaignForVendor?.vendor || vendor,
          texto
        })
        return
      }

      // ACTIVE (EN_FLUJO) → acumular, el followupEngine avanza pasos
      // Solo actualizamos el lead timestamp — no mandamos nada
      await prisma.lead.update({
        where: { id: lead.id },
        data: { ultimoMensaje: new Date() }
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
        ultimoMensaje: new Date()
      }
    })

    // Crear conversation object inmediatamente
    await prisma.$executeRawUnsafe(`
      INSERT INTO conversations (lead_id, campaign_id, vendor_id, state, current_step, last_lead_message_at)
      VALUES ($1, $2, $3, 'ACTIVE', 0, NOW())
      ON CONFLICT (lead_id, campaign_id) DO NOTHING
    `, newLead.id, campaign?.id || null, vendor.id).catch(err => {
      console.error('[Motor] Error creando conversation:', err.message)
    })

    // Obtener conversation recién creada
    const convRows2 = await prisma.$queryRawUnsafe(
      `SELECT id FROM conversations WHERE lead_id = $1 LIMIT 1`, newLead.id
    )
    const convId = convRows2?.[0]?.id || null

    await guardarMensaje(prisma, {
      leadId: newLead.id,
      conversationId: convId,
      direccion: 'ENTRANTE',
      texto
    })

    // Enviar bienvenida desde FlowBuilder
    const pasosMSG = campaign?.steps?.filter(s => s.tipo === 'MSG') || []
    const pasoBienvenida = pasosMSG[0]

    let msgBienvenida
    if (pasoBienvenida?.mensaje) {
      msgBienvenida = (pasoBienvenida.mensaje || '')
        .replace(/\{\{telefono\}\}/g, numero)
        .replace(/\{\{vendedor\}\}/g, vendor?.nombre || '')
        .replace(/\{\{curso\}\}/g, campaign?.nombre || '')
    } else {
      msgBienvenida =
        `Hola 👋 te saluda *Perú Exporta TV* 🇵🇪\n\n` +
        `Cuéntame: ¿cómo te llamas y qué producto tienes en mente para exportar? 👇`
    }

    await sleep(1000)
    await enviarTexto(instancia, numero, msgBienvenida)
    await guardarMensaje(prisma, {
      leadId: newLead.id,
      conversationId: convId,
      direccion: 'SALIENTE',
      texto: msgBienvenida
    })

    // Actualizar conversation con bot message timestamp y paso
    if (convId) {
      await prisma.$executeRawUnsafe(`
        UPDATE conversations 
        SET current_step = $1, last_bot_message_at = NOW(), updated_at = NOW()
        WHERE id = $2
      `, pasoBienvenida?.orden || 1, convId).catch(() => {})
    }

    await prisma.lead.update({
      where: { id: newLead.id },
      data: { pasoActual: pasoBienvenida?.orden || 1, ultimoMensaje: new Date() }
    })

  } catch (err) {
    console.error('[Motor] Error:', err.message, err.stack)
  }
}
