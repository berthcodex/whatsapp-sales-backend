// src/webhook/stateEngine.js
// HIDATA — Motor Sprint 3.2
//
// REGLA DE ORO:
// Lead nuevo   → ejecutar SOLO paso 1 MSG → parar y esperar
// Lead responde → ejecutar SOLO el siguiente paso MSG → parar y esperar
// NOTIFY       → siempre se ejecuta junto al último MSG enviado
// FOLLOWUP     → lo maneja el followupEngine por separado (cron)

import { detectarCursoCampana } from './classifier.js'
import { enviarTexto } from '../whatsapp/sender.js'

const sleep = ms => new Promise(r => setTimeout(r, ms))

// ── Helpers ──────────────────────────────────────────────────

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

// ── Enviar un paso MSG al lead ───────────────────────────────
async function enviarPasoMsg({ prisma, instancia, numero, lead, vendor, step }) {
  const texto = interpolar(step.mensaje, lead, vendor)
  await sleep(1000)
  await enviarTexto(instancia, numero, texto)
  await guardarMensaje(prisma, { leadId: lead.id, direccion: 'SALIENTE', texto })
  // Registrar que este paso ya fue ejecutado
  await prisma.lead.update({
    where: { id: lead.id },
    data: { pasoActual: step.orden, estado: 'EN_FLUJO' }
  })
}

// ── Ejecutar NOTIFY inmediatamente después de un MSG ────────
// El NOTIFY va al vendedor, no al lead — no rompe la espera
async function ejecutarNotifysSiguientes({ prisma, instancia, lead, vendor, campaign, stepEjecutado }) {
  try {
    if (!vendor?.whatsappNumber) return
    const idxActual = campaign.steps.findIndex(s => s.id === stepEjecutado.id)
    const stepsSiguientes = campaign.steps.slice(idxActual + 1)
    for (const step of stepsSiguientes) {
      if (step.tipo === 'NOTIFY') {
        const texto = interpolar(step.mensaje, lead, vendor)
        await enviarTexto(instancia, vendor.whatsappNumber, texto)
      } else {
        // Al encontrar MSG o FOLLOWUP — parar
        break
      }
    }
  } catch (err) {
    console.error('[Motor] Error en NOTIFY:', err.message)
  }
}

// ── Notificación genérica (cuando no hay paso NOTIFY en flujo) ─
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
    // LEAD EXISTENTE — avanzar al siguiente paso MSG
    // ════════════════════════════════════════════════════════
    if (lead) {
      await guardarMensaje(prisma, { leadId: lead.id, direccion: 'ENTRANTE', texto: texto || '[imagen]' })

      // Imagen → posible pago
      if (tieneImagen) {
        const msgImg = `✅ Recibimos tu imagen. Un asesor validará tu pago y te dará los accesos en breve.`
        await sleep(800)
        await enviarTexto(instancia, numero, msgImg)
        await guardarMensaje(prisma, { leadId: lead.id, direccion: 'SALIENTE', texto: msgImg })
        await notificarVendedorGenerico({ prisma, instancia, lead, vendor, campaignSlug: null })
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

      // Solo pasos MSG — la secuencia conversacional
      const pasosMsg = campaign.steps.filter(s => s.tipo === 'MSG')

      // Buscar el siguiente paso MSG no ejecutado aún
      // pasoActual = orden del último MSG enviado (0 = ninguno ejecutado aún, pero eso no pasa aquí)
      const siguientePaso = pasosMsg.find(s => s.orden > lead.pasoActual)

      if (!siguientePaso) {
        // Lead ya recibió todos los pasos → silencio
        console.log(`[Motor] Lead ${numero} completó todos los pasos — silencio`)
        return
      }

      // Enviar SOLO el siguiente paso MSG
      await enviarPasoMsg({
        prisma, instancia, numero, lead,
        vendor: vendorCampaign,
        step: siguientePaso
      })

      // Ejecutar NOTIFYs que vengan justo después de este paso
      await ejecutarNotifysSiguientes({
        prisma, instancia, lead,
        vendor: vendorCampaign,
        campaign,
        stepEjecutado: siguientePaso
      })

      return
    }

    // ════════════════════════════════════════════════════════
    // LEAD NUEVO — detectar campaña y ejecutar SOLO paso 1
    // ════════════════════════════════════════════════════════
    const cursoCampana = detectarCursoCampana(texto)

    let campaign = null
    if (cursoCampana?.slug) {
      campaign = await getCampaignConSteps(prisma, cursoCampana.slug)
    }
    if (!campaign || !campaign.steps?.length) {
      campaign = await getCampaignActiva(prisma)
    }

    // Crear lead en DB
    lead = await prisma.lead.create({
      data: {
        telefono: numero,
        campaignId: campaign?.id || null,
        vendorId: vendor.id,
        pasoActual: 0,       // ningún paso ejecutado aún
        estado: 'NUEVO',
        ultimoMensaje: new Date()
      }
    })

    await guardarMensaje(prisma, { leadId: lead.id, direccion: 'ENTRANTE', texto })

    if (!campaign?.steps?.length) {
      const msgFallback =
        `Hola! Soy del equipo de *Perú Exporta TV* 🇵🇪\n\n` +
        `Recibimos tu mensaje. Un asesor te contactará muy pronto.`
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
      // No hay pasos MSG → notificar directo
      await notificarVendedorGenerico({ prisma, instancia, lead, vendor: vendorCampaign, campaignSlug: campaign.slug })
      return
    }

    await enviarPasoMsg({
      prisma, instancia, numero, lead,
      vendor: vendorCampaign,
      step: primerPaso
    })

    // Ejecutar NOTIFYs que vengan justo después del paso 1
    await ejecutarNotifysSiguientes({
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
