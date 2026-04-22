// src/webhook/stateEngine.js
// HIDATA — Motor Sprint 4.0 — ARQUITECTURA DEFINITIVA
//
// RESPONSABILIDAD ÚNICA: procesar mensajes entrantes.
// NO hace timers. NO hace sleeps largos. NO cierra flujos.
// El cierre y reactivación los hace followupEngine.js via cron.
//
// FLUJO WEBHOOK:
// Lead nuevo   → bienvenida (paso 1 del FlowBuilder) → EN_FLUJO
// Lead existente EN_FLUJO → acumula en DB → actualiza timestamp
// Lead existente NOTIFICADO → casuísticas (reclamo, hora, precio, interés)
// Lead existente CERRADO → silencio

import { detectarCursoCampana } from './classifier.js'
import { enviarTexto } from '../whatsapp/sender.js'

const sleep = ms => new Promise(r => setTimeout(r, ms))

// ── Keywords ─────────────────────────────────────────────────
function norm(t) {
  return (t || '').toLowerCase().normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ').trim()
}
function contiene(texto, kws) {
  const n = norm(texto)
  return kws.some(kw => n.includes(norm(kw)))
}

const KW_RECLAMO    = ['no me llamaron','nadie me llamo','no me han llamado','siguen sin llamar','cuando me llaman','no me contactaron','nunca me llamaron']
const KW_HORA       = ['llamame a','a las','pm','am','en la tarde','en la noche','en la mañana','mas tarde','despues','al rato','por la tarde','por la mañana']
const KW_PRECIO     = ['cuanto cuesta','precio','costo','caro','cuotas','descuento','inversion','cuanto es','cuanto vale']
const KW_INTERES    = ['me interesa','quiero inscribirme','como me inscribo','quiero participar','dale','listo','acepto','si quiero','quiero el curso','inscribirme']
const KW_NO_INTERES = ['ya no','no me interesa','gracias igual','olvidalo','no gracias','no quiero']

// ── DB Helpers ───────────────────────────────────────────────
async function guardarMensaje(prisma, { leadId, direccion, texto }) {
  try {
    await prisma.message.create({
      data: { leadId, origen: direccion === 'ENTRANTE' ? 'LEAD' : 'BOT', texto }
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

// ── Notificación al vendedor ─────────────────────────────────
async function renotificarVendedor({ instancia, lead, vendor, motivo }) {
  try {
    if (!vendor?.whatsappNumber) return
    const msg = `⚠️ ${motivo}\n\n📱 wa.me/${lead.telefono}\nAcción requerida — llama ahora`
    await enviarTexto(instancia, vendor.whatsappNumber, msg)
  } catch (err) {
    console.error('[Motor] renotificarVendedor:', err.message)
  }
}

// ── Casuísticas post-cierre ──────────────────────────────────
async function manejarPostCierre({ prisma, instancia, numero, lead, vendor, texto }) {
  await prisma.lead.update({
    where: { id: lead.id },
    data: { ultimoMensaje: new Date() }
  }).catch(() => {})

  // Sin interés → cerrar
  if (contiene(texto, KW_NO_INTERES)) {
    const msg = `Entendido, no hay problema 😊\n\nSi en algún momento cambias de opinión, aquí estaremos.\n\n¡Mucho éxito!`
    await enviarTexto(instancia, numero, msg)
    await guardarMensaje(prisma, { leadId: lead.id, direccion: 'SALIENTE', texto: msg })
    await prisma.lead.update({ where: { id: lead.id }, data: { estado: 'CERRADO' } })
    return
  }

  // Reclamo → disculpa + alerta urgente
  if (contiene(texto, KW_RECLAMO)) {
    const msg = `Mil disculpas, eso no debería pasar 🙏\n\nYa envié una alerta urgente a tu asesor — te llama en los próximos minutos.\n\n¡Gracias por tu paciencia!`
    await enviarTexto(instancia, numero, msg)
    await guardarMensaje(prisma, { leadId: lead.id, direccion: 'SALIENTE', texto: msg })
    await renotificarVendedor({ instancia, lead, vendor, motivo: `URGENTE — Lead reclama que nadie lo llamó` })
    return
  }

  // Hora específica → confirma + alerta
  if (contiene(texto, KW_HORA)) {
    const msg = `Perfecto! 📅\n\nLe aviso a tu asesor que te llame en ese horario.\n\n¡Estate pendiente al teléfono!`
    await enviarTexto(instancia, numero, msg)
    await guardarMensaje(prisma, { leadId: lead.id, direccion: 'SALIENTE', texto: msg })
    await renotificarVendedor({ instancia, lead, vendor, motivo: `Lead pidió hora: "${texto.slice(0, 80)}"` })
    return
  }

  // Precio → informa + deriva al vendedor
  if (contiene(texto, KW_PRECIO)) {
    const msg = `La inversión en el programa es de S/ 1,500 💰\n\nTambién tenemos facilidades de pago en cuotas.\n\nTu asesor te explicará todos los detalles cuando te llame — ¡que es hoy! 😊`
    await enviarTexto(instancia, numero, msg)
    await guardarMensaje(prisma, { leadId: lead.id, direccion: 'SALIENTE', texto: msg })
    return
  }

  // Reconfirma interés → renotifica
  if (contiene(texto, KW_INTERES)) {
    const msg = `¡Genial! 🎉\n\nYa avisé a tu asesor — te llama muy pronto.\n\n¡Estate atento al teléfono!`
    await enviarTexto(instancia, numero, msg)
    await guardarMensaje(prisma, { leadId: lead.id, direccion: 'SALIENTE', texto: msg })
    await renotificarVendedor({ instancia, lead, vendor, motivo: `Lead reconfirmó interés` })
    return
  }

  // Default → tranquilizar
  const msg = `¡Hola! 👋\n\nTu asesor ya está al tanto y te llama muy pronto.\n\n¡Estate pendiente al teléfono!`
  await enviarTexto(instancia, numero, msg)
  await guardarMensaje(prisma, { leadId: lead.id, direccion: 'SALIENTE', texto: msg })
}

// ════════════════════════════════════════════════════════════
// MOTOR PRINCIPAL — solo procesa, no cierra
// ════════════════════════════════════════════════════════════
export async function procesarConMotor({ prisma, instancia, numero, texto, tieneImagen, vendor }) {
  try {
    let lead = await prisma.lead.findUnique({ where: { telefono: numero } })

    // ── LEAD EXISTENTE ───────────────────────────────────────
    if (lead) {
      // Guardar mensaje + actualizar timestamp
      await guardarMensaje(prisma, {
        leadId: lead.id,
        direccion: 'ENTRANTE',
        texto: texto || '[imagen]'
      })
      await prisma.lead.update({
        where: { id: lead.id },
        data: { ultimoMensaje: new Date() }
      }).catch(() => {})

      // Imagen → posible pago
      if (tieneImagen) {
        const msg = `✅ Recibimos tu imagen.\n\nUn asesor validará tu pago y te dará los accesos en breve.`
        await sleep(800)
        await enviarTexto(instancia, numero, msg)
        await guardarMensaje(prisma, { leadId: lead.id, direccion: 'SALIENTE', texto: msg })
        return
      }

      // Cerrado → silencio total
      if (lead.estado === 'CERRADO') return

      // Notificado → casuísticas
      if (lead.estado === 'NOTIFICADO') {
        const campaign = lead.campaignId
          ? await prisma.campaign.findUnique({
              where: { id: lead.campaignId },
              include: { vendor: true }
            })
          : null
        await manejarPostCierre({
          prisma, instancia, numero, lead,
          vendor: campaign?.vendor || vendor,
          texto
        })
        return
      }

      // EN_FLUJO → silencio, acumular en DB
      // El followupEngine cierra después de 20s de silencio via cron
      if (lead.estado === 'EN_FLUJO') {
        // Solo acumula — no responde nada
        // El timestamp ya se actualizó arriba
        return
      }

      return
    }

    // ── LEAD NUEVO ───────────────────────────────────────────
    const cursoCampana = detectarCursoCampana(texto)
    const campaign = await getCampaign(prisma, cursoCampana?.slug)

    lead = await prisma.lead.create({
      data: {
        telefono: numero,
        campaignId: campaign?.id || null,
        vendorId: vendor.id,
        pasoActual: 0,
        estado: 'NUEVO',
        ultimoMensaje: new Date()
      }
    })

    await guardarMensaje(prisma, { leadId: lead.id, direccion: 'ENTRANTE', texto })

    // Bienvenida desde FlowBuilder (paso 1 MSG)
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
    await guardarMensaje(prisma, { leadId: lead.id, direccion: 'SALIENTE', texto: msgBienvenida })

    await prisma.lead.update({
      where: { id: lead.id },
      data: { estado: 'EN_FLUJO', pasoActual: 1, ultimoMensaje: new Date() }
    })

  } catch (err) {
    console.error('[Motor] Error:', err.message)
    console.error(err.stack)
  }
}
