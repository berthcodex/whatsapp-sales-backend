// src/webhook/stateEngine.js
// HIDATA — Motor Sprint 3.3
//
// ARQUITECTURA CORRECTA:
// El handler.js ya tiene debounce de 3 segundos por número.
// Esto significa que si el lead manda 3 mensajes en 3 segundos,
// el motor solo se ejecuta UNA vez con el último mensaje.
//
// FLUJO POR PASOS:
// - Lead nuevo     → paso 1 MSG → parar y esperar
// - Lead responde  → siguiente paso MSG → parar y esperar
// - Último paso    → silencio (vendedor ya notificado)
//
// MENSAJE FINAL AL COMPLETAR EL FLUJO:
// Cuando el lead responde al último paso MSG, en vez de silencio
// enviamos: "Perfecto! Un asesor se comunicará contigo hoy. Estamos en contacto!"

import { detectarCursoCampana } from './classifier.js'
import { enviarTexto } from '../whatsapp/sender.js'

const sleep = ms => new Promise(r => setTimeout(r, ms))

// ── Helpers DB ───────────────────────────────────────────────

async function getCampaignConSteps(prisma, slug) {
  return await prisma.campaign.findUnique({
    where: { slug },
    include: { steps: { orderBy: { orden: 'asc' } }, vendor: true }
  })
}

async function getCampaignActiva(prisma) {
  return await prisma.campaign.findFirst({
    where: { activa: true },
    include: { steps: { orderBy: { orden: 'asc' } }, vendor: true }
  })
}

async function guardarMensaje(prisma, { leadId, direccion, texto }) {
  try {
    await prisma.message.create({
      data: { leadId, origen: direccion === 'ENTRANTE' ? 'LEAD' : 'BOT', texto }
    })
  } catch (err) {
    console.error('[Motor] Error guardando mensaje:', err.message)
  }
}

function interpolar(mensaje, lead, vendor) {
  return (mensaje || '')
    .replace(/\{\{telefono\}\}/g, lead.telefono || '')
    .replace(/\{\{nombre\}\}/g,   lead.telefono || '')
    .replace(/\{\{vendedor\}\}/g, vendor?.nombre || '')
    .replace(/\{\{curso\}\}/g,    'Mi Primera Exportación')
}

// ── Enviar paso MSG al lead ──────────────────────────────────
async function enviarPasoMsg({ prisma, instancia, numero, lead, vendor, step }) {
  const texto = interpolar(step.mensaje, lead, vendor)
  await sleep(1000)
  await enviarTexto(instancia, numero, texto)
  await guardarMensaje(prisma, { leadId: lead.id, direccion: 'SALIENTE', texto })
  await prisma.lead.update({
    where: { id: lead.id },
    data: { pasoActual: step.orden, estado: 'EN_FLUJO' }
  })
}

// ── Ejecutar NOTIFYs después de un paso MSG ─────────────────
// El NOTIFY va al vendedor — no interrumpe el flujo del lead
async function ejecutarNotifys({ prisma, instancia, lead, vendor, campaign, stepEjecutado }) {
  try {
    if (!vendor?.whatsappNumber) return
    const idxActual = campaign.steps.findIndex(s => s.id === stepEjecutado.id)
    const siguientes = campaign.steps.slice(idxActual + 1)
    for (const step of siguientes) {
      if (step.tipo === 'NOTIFY') {
        const texto = interpolar(step.mensaje, lead, vendor)
        await enviarTexto(instancia, vendor.whatsappNumber, texto)
      } else {
        break // parar al primer MSG o FOLLOWUP
      }
    }
  } catch (err) {
    console.error('[Motor] Error en NOTIFY:', err.message)
  }
}

// ── Mensaje de cierre al completar el flujo ──────────────────
async function enviarMensajeCierre({ prisma, instancia, numero, lead }) {
  const msg =
    `Perfecto, gracias por contarnos! 🙌\n\n` +
    `Un asesor de nuestro equipo se comunicará contigo hoy para explicarte exactamente cómo podemos ayudarte.\n\n` +
    `Estamos en contacto!`
  await sleep(1000)
  await enviarTexto(instancia, numero, msg)
  await guardarMensaje(prisma, { leadId: lead.id, direccion: 'SALIENTE', texto: msg })
  await prisma.lead.update({
    where: { id: lead.id },
    data: { estado: 'NOTIFICADO' }
  })
}

// ── Notificación genérica al vendedor ───────────────────────
async function notificarVendedorGenerico({ prisma, instancia, lead, vendor, campaignSlug }) {
  try {
    if (!vendor?.whatsappNumber) return
    const mensajes = await prisma.message.findMany({
      where: { leadId: lead.id, origen: 'LEAD' },
      orderBy: { createdAt: 'asc' },
      take: 5
    })
    const historial = mensajes.map(m => `  > "${m.texto.slice(0, 80)}"`).join('\n')
    const msg =
      `🔔 NUEVO LEAD — LLAMA AHORA\n\n` +
      `📱 wa.me/${lead.telefono}\n` +
      `📚 Curso: ${campaignSlug || 'orgánico'}\n` +
      (historial ? `\n💬 Dijo:\n${historial}\n` : '') +
      `\n⚡ Llama antes de que se enfríe!`
    await enviarTexto(instancia, vendor.whatsappNumber, msg)
  } catch (err) {
    console.error('[Motor] Error notificando vendedor:', err.message)
  }
}

// ── MOTOR PRINCIPAL ──────────────────────────────────────────
export async function procesarConMotor({ prisma, instancia, numero, texto, tieneImagen, vendor }) {
  try {
    let lead = await prisma.lead.findUnique({ where: { telefono: numero } })

    // ════════════════════════════════════════════════════════
    // LEAD EXISTENTE
    // ════════════════════════════════════════════════════════
    if (lead) {
      await guardarMensaje(prisma, {
        leadId: lead.id,
        direccion: 'ENTRANTE',
        texto: texto || '[imagen]'
      })

      // Imagen → posible comprobante de pago
      if (tieneImagen) {
        const msgImg =
          `✅ Recibimos tu imagen.\n\n` +
          `Un asesor validará tu pago y te dará los accesos en breve.`
        await sleep(800)
        await enviarTexto(instancia, numero, msgImg)
        await guardarMensaje(prisma, { leadId: lead.id, direccion: 'SALIENTE', texto: msgImg })
        await notificarVendedorGenerico({ prisma, instancia, lead, vendor, campaignSlug: null })
        return
      }

      // Lead ya notificado → silencio
      // El vendedor ya recibió la alerta, él debe llamar
      if (lead.estado === 'NOTIFICADO' || lead.estado === 'CERRADO') {
        return
      }

      // Sin campaña → silencio
      if (!lead.campaignId) return

      const campaign = await prisma.campaign.findUnique({
        where: { id: lead.campaignId },
        include: { steps: { orderBy: { orden: 'asc' } }, vendor: true }
      })
      if (!campaign?.steps?.length) return

      const vendorCampaign = campaign.vendor || vendor
      const pasosMsg = campaign.steps.filter(s => s.tipo === 'MSG')

      // Siguiente paso MSG no ejecutado aún
      const siguientePaso = pasosMsg.find(s => s.orden > lead.pasoActual)

      if (!siguientePaso) {
        // Lead completó todos los pasos → mensaje de cierre
        await enviarMensajeCierre({ prisma, instancia, numero, lead })
        // Notificar al vendedor que el lead completó el flujo
        await notificarVendedorGenerico({
          prisma, instancia, lead,
          vendor: vendorCampaign,
          campaignSlug: campaign.slug
        })
        return
      }

      // Enviar el siguiente paso MSG
      await enviarPasoMsg({
        prisma, instancia, numero, lead,
        vendor: vendorCampaign,
        step: siguientePaso
      })

      // Ejecutar NOTIFYs que vengan después de este paso
      await ejecutarNotifys({
        prisma, instancia, lead,
        vendor: vendorCampaign,
        campaign,
        stepEjecutado: siguientePaso
      })

      return
    }

    // ════════════════════════════════════════════════════════
    // LEAD NUEVO
    // ════════════════════════════════════════════════════════
    const cursoCampana = detectarCursoCampana(texto)

    let campaign = null
    if (cursoCampana?.slug) {
      campaign = await getCampaignConSteps(prisma, cursoCampana.slug)
    }
    if (!campaign || !campaign.steps?.length) {
      campaign = await getCampaignActiva(prisma)
    }

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

    if (!campaign?.steps?.length) {
      const msgFallback =
        `Hola! Soy del equipo de *Perú Exporta TV* 🇵🇪\n\n` +
        `Recibimos tu mensaje. Un asesor te contactará muy pronto.\n\n` +
        `¿Cuéntanos: qué producto tienes en mente para exportar?`
      await sleep(1000)
      await enviarTexto(instancia, numero, msgFallback)
      await guardarMensaje(prisma, { leadId: lead.id, direccion: 'SALIENTE', texto: msgFallback })
      await notificarVendedorGenerico({ prisma, instancia, lead, vendor, campaignSlug: null })
      return
    }

    const vendorCampaign = campaign.vendor || vendor

    // Ejecutar SOLO el primer paso MSG
    const pasosMsg = campaign.steps.filter(s => s.tipo === 'MSG')
    const primerPaso = pasosMsg[0]

    if (!primerPaso) {
      await notificarVendedorGenerico({
        prisma, instancia, lead,
        vendor: vendorCampaign,
        campaignSlug: campaign.slug
      })
      return
    }

    await enviarPasoMsg({
      prisma, instancia, numero, lead,
      vendor: vendorCampaign,
      step: primerPaso
    })

    // NOTIFYs después del paso 1
    await ejecutarNotifys({
      prisma, instancia, lead,
      vendor: vendorCampaign,
      campaign,
      stepEjecutado: primerPaso
    })

  } catch (err) {
    console.error('[Motor] Error:', err.message)
    console.error(err.stack)
  }
}
