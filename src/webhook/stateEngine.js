// src/webhook/stateEngine.js
// HIDATA — Motor del Bot Sprint 3
//
// CAMBIO CLAVE vs Sprint 1-2:
// El motor ahora lee los FlowSteps de DB (creados en FlowBuilder)
// en lugar de mensajes hardcodeados en bot_config.
// Flujo: Lead escribe → detectar campaña → buscar steps activos → ejecutar paso 1 → notificar vendedor

import { detectarCursoCampana } from './classifier.js'
import { enviarTexto } from '../whatsapp/sender.js'

const sleep = ms => new Promise(r => setTimeout(r, ms))

// ── Helpers DB ──────────────────────────────────────────────

async function getCampaignConSteps(prisma, slug) {
  return await prisma.campaign.findUnique({
    where: { slug },
    include: {
      steps: { orderBy: { orden: 'asc' } },
      vendor: true
    }
  })
}

async function getCampaignActiva(prisma) {
  // Fallback: primera campaña activa si no hay slug detectado
  return await prisma.campaign.findFirst({
    where: { activa: true },
    include: {
      steps: { orderBy: { orden: 'asc' } },
      vendor: true
    }
  })
}

async function guardarMensaje(prisma, { leadId, vendorId, direccion, texto }) {
  try {
    await prisma.message.create({
      data: { leadId, origen: direccion === 'ENTRANTE' ? 'LEAD' : 'BOT', texto }
    })
  } catch (err) {
    console.error('[Motor] Error guardando mensaje:', err.message)
  }
}

async function notificarVendedor({ prisma, instancia, lead, vendor, campaignSlug }) {
  try {
    if (!vendor?.whatsappNumber) {
      console.warn('[Motor] Vendedor sin whatsappNumber — no se puede notificar')
      return
    }

    const mins = lead.createdAt
      ? Math.floor((Date.now() - new Date(lead.createdAt).getTime()) / 60000)
      : 0
    const tiempoStr = mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)}h ${mins % 60}m`

    // Buscar historial de mensajes del lead
    const mensajes = await prisma.message.findMany({
      where: { leadId: lead.id, origen: 'LEAD' },
      orderBy: { createdAt: 'asc' },
      take: 5
    })
    const historial = mensajes.map(m => `  > "${m.texto.slice(0, 80)}"`).join('\n')

    const msg =
      `🔔 NUEVO LEAD — LLAMA AHORA\n\n` +
      `📱 Número: wa.me/${lead.telefono}\n` +
      `📚 Curso: ${campaignSlug || 'orgánico'}\n` +
      `⏱ En sistema: ${tiempoStr}\n` +
      (historial ? `\n💬 Dijo:\n${historial}\n` : '') +
      `\n⚡ Llama antes de que se enfríe!`

    await enviarTexto(instancia, vendor.whatsappNumber, msg)
  } catch (err) {
    console.error('[Motor] Error notificando vendedor:', err.message)
  }
}

// ── Interpolación de variables en mensajes ───────────────────
function interpolar(mensaje, lead, vendor) {
  return mensaje
    .replace(/\{\{telefono\}\}/g, lead.telefono || '')
    .replace(/\{\{nombre\}\}/g, lead.telefono || '')
    .replace(/\{\{vendedor\}\}/g, vendor?.nombre || '')
    .replace(/\{\{curso\}\}/g, lead.campaignId ? '' : 'orgánico')
}

// ── Motor principal ──────────────────────────────────────────
export async function procesarConMotor({ prisma, instancia, numero, texto, tieneImagen, vendor }) {
  try {
    // 1. ¿Lead ya existe?
    let lead = await prisma.lead.findUnique({ where: { telefono: numero } })

    if (lead) {
      // Lead existente — guardar mensaje entrante
      await guardarMensaje(prisma, {
        leadId: lead.id, vendorId: vendor.id,
        direccion: 'ENTRANTE', texto: texto || '[imagen]'
      })

      // Si mandó imagen → notificar vendedor (posible comprobante de pago)
      if (tieneImagen) {
        const msgImg = `✅ Recibimos tu imagen. Un asesor validará tu pago y te dará los accesos en breve.`
        await sleep(800)
        await enviarTexto(instancia, numero, msgImg)
        await guardarMensaje(prisma, { leadId: lead.id, vendorId: vendor.id, direccion: 'SALIENTE', texto: msgImg })

        // Obtener campaign para notificar al vendedor correcto
        const campaign = lead.campaignId
          ? await prisma.campaign.findUnique({ where: { id: lead.campaignId }, include: { vendor: true } })
          : null
        await notificarVendedor({ prisma, instancia, lead, vendor: campaign?.vendor || vendor, campaignSlug: campaign?.slug })
      }
      return
    }

    // 2. Lead nuevo — detectar campaña desde el primer mensaje
    const cursoCampana = detectarCursoCampana(texto)

    let campaign = null
    if (cursoCampana?.slug) {
      campaign = await getCampaignConSteps(prisma, cursoCampana.slug)
    }
    // Si no hay campaña detectada o no tiene steps, buscar campaña activa como fallback
    if (!campaign || !campaign.steps?.length) {
      campaign = await getCampaignActiva(prisma)
    }

    // 3. Crear lead en DB con vendorId directo (Bug 1 fix)
    lead = await prisma.lead.create({
      data: {
        telefono: numero,
        campaignId: campaign?.id || null,
        vendorId: vendor.id,          // FK directo al vendedor de la instancia
        pasoActual: 0,
        estado: 'NUEVO',
        ultimoMensaje: new Date()
      }
    })

    await guardarMensaje(prisma, {
      leadId: lead.id, vendorId: vendor.id,
      direccion: 'ENTRANTE', texto
    })

    // 4. Ejecutar paso 1 del flujo (tipo MSG)
    //    Si no hay flujo → mensaje genérico de fallback
    const vendorNotificar = campaign?.vendor || vendor
    let respondio = false

    if (campaign?.steps?.length) {
      // Buscar el primer paso MSG del flujo (puede haber un NOTIFY antes)
      const pasosMsg = campaign.steps.filter(s => s.tipo === 'MSG')
      const primerMsg = pasosMsg[0]

      if (primerMsg) {
        const msgTexto = interpolar(primerMsg.mensaje, lead, vendorNotificar)
        await sleep(1000)
        await enviarTexto(instancia, numero, msgTexto)
        await guardarMensaje(prisma, {
          leadId: lead.id, vendorId: vendor.id,
          direccion: 'SALIENTE', texto: msgTexto
        })
        respondio = true

        // Actualizar paso actual del lead
        await prisma.lead.update({
          where: { id: lead.id },
          data: { pasoActual: primerMsg.orden, estado: 'EN_FLUJO' }
        })
      }

      // Ejecutar pasos NOTIFY del flujo (notificaciones al vendedor)
      const pasosNotify = campaign.steps.filter(s => s.tipo === 'NOTIFY')
      if (pasosNotify.length > 0) {
        // Usar el mensaje del NOTIFY del FlowBuilder si existe
        const notifyMsg = interpolar(pasosNotify[0].mensaje, lead, vendorNotificar)
        await enviarTexto(instancia, vendorNotificar.whatsappNumber || '', notifyMsg)
      } else {
        // Fallback: notificación genérica
        await notificarVendedor({
          prisma, instancia, lead,
          vendor: vendorNotificar,
          campaignSlug: campaign?.slug
        })
      }
    }

    // Si no hubo ningún paso MSG → mensaje genérico
    if (!respondio) {
      const msgFallback =
        `Hola! Soy del equipo de *Perú Exporta TV* 🇵🇪\n\n` +
        `Recibimos tu mensaje. Un asesor te contactará muy pronto.\n\n` +
        `¿Cuéntanos: qué producto tienes en mente para exportar?`
      await sleep(1000)
      await enviarTexto(instancia, numero, msgFallback)
      await guardarMensaje(prisma, {
        leadId: lead.id, vendorId: vendor.id,
        direccion: 'SALIENTE', texto: msgFallback
      })
      await notificarVendedor({ prisma, instancia, lead, vendor: vendorNotificar, campaignSlug: null })
    }

  } catch (err) {
    console.error('[Motor] Error:', err.message)
    console.error(err.stack)
  }
}
