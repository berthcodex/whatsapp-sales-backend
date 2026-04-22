// src/webhook/stateEngine.js
// HIDATA — Motor del Bot Sprint 3.1
//
// FIX: avance de pasos secuencial para leads existentes
// Lead nuevo → ejecuta paso 1 (MSG)
// Lead responde → ejecuta siguiente paso MSG en secuencia
// Lead en último paso → silencio (vendedor ya fue notificado)

import { detectarCursoCampana } from './classifier.js'
import { enviarTexto } from '../whatsapp/sender.js'

const sleep = ms => new Promise(r => setTimeout(r, ms))

// ── Helpers DB ───────────────────────────────────────────────

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
  return await prisma.campaign.findFirst({
    where: { activa: true },
    include: {
      steps: { orderBy: { orden: 'asc' } },
      vendor: true
    }
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

// ── Interpolación de variables ───────────────────────────────
function interpolar(mensaje, lead, vendor) {
  return (mensaje || '')
    .replace(/\{\{telefono\}\}/g, lead.telefono || '')
    .replace(/\{\{nombre\}\}/g,   lead.telefono || '')
    .replace(/\{\{vendedor\}\}/g, vendor?.nombre || '')
    .replace(/\{\{curso\}\}/g,    'Mi Primera Exportación')
}

// ── Notificación genérica al vendedor ───────────────────────
async function notificarVendedor({ prisma, instancia, lead, vendor, campaignSlug }) {
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
      `📱 Número: wa.me/${lead.telefono}\n` +
      `📚 Curso: ${campaignSlug || 'orgánico'}\n` +
      (historial ? `\n💬 Dijo:\n${historial}\n` : '') +
      `\n⚡ Llama antes de que se enfríe!`

    await enviarTexto(instancia, vendor.whatsappNumber, msg)
  } catch (err) {
    console.error('[Motor] Error notificando vendedor:', err.message)
  }
}

// ── Ejecutar un paso MSG ─────────────────────────────────────
async function ejecutarPasoMsg({ prisma, instancia, numero, lead, vendor, step }) {
  const texto = interpolar(step.mensaje, lead, vendor)
  await sleep(1000)
  await enviarTexto(instancia, numero, texto)
  await guardarMensaje(prisma, { leadId: lead.id, direccion: 'SALIENTE', texto })
  await prisma.lead.update({
    where: { id: lead.id },
    data: { pasoActual: step.orden, estado: 'EN_FLUJO' }
  })
}

// ── Ejecutar un paso NOTIFY ──────────────────────────────────
async function ejecutarPasoNotify({ prisma, instancia, lead, vendor, step }) {
  try {
    if (!vendor?.whatsappNumber) return
    const texto = interpolar(step.mensaje, lead, vendor)
    await enviarTexto(instancia, vendor.whatsappNumber, texto)
  } catch (err) {
    console.error('[Motor] Error en NOTIFY:', err.message)
  }
}

// ── Motor principal ──────────────────────────────────────────
export async function procesarConMotor({ prisma, instancia, numero, texto, tieneImagen, vendor }) {
  try {
    let lead = await prisma.lead.findUnique({ where: { telefono: numero } })

    // ── LEAD EXISTENTE ───────────────────────────────────────
    if (lead) {
      await guardarMensaje(prisma, { leadId: lead.id, direccion: 'ENTRANTE', texto: texto || '[imagen]' })

      // Imagen → posible pago
      if (tieneImagen) {
        const msgImg = `✅ Recibimos tu imagen. Un asesor validará tu pago y te dará los accesos en breve.`
        await sleep(800)
        await enviarTexto(instancia, numero, msgImg)
        await guardarMensaje(prisma, { leadId: lead.id, direccion: 'SALIENTE', texto: msgImg })
        await notificarVendedor({ prisma, instancia, lead, vendor, campaignSlug: null })
        return
      }

      // Sin campaña → silencio (lead orgánico ya notificado)
      if (!lead.campaignId) return

      // Obtener campaña y pasos
      const campaign = await prisma.campaign.findUnique({
        where: { id: lead.campaignId },
        include: {
          steps: { orderBy: { orden: 'asc' } },
          vendor: true
        }
      })
      if (!campaign?.steps?.length) return

      const vendorCampaign = campaign.vendor || vendor
      const pasosMsg = campaign.steps.filter(s => s.tipo === 'MSG')

      // ¿En qué paso MSG está el lead?
      // pasoActual = orden del último paso ejecutado
      const pasoActualIdx = pasosMsg.findIndex(s => s.orden === lead.pasoActual)
      const siguientePaso = pasosMsg[pasoActualIdx + 1]

      if (!siguientePaso) {
        // Ya está en el último paso MSG — silencio, vendedor ya fue notificado
        console.log(`[Motor] Lead ${numero} ya completó todos los pasos MSG`)
        return
      }

      // Ejecutar el siguiente paso MSG
      await ejecutarPasoMsg({
        prisma, instancia, numero, lead,
        vendor: vendorCampaign,
        step: siguientePaso
      })

      // Si el siguiente paso después de este es NOTIFY → ejecutarlo también
      const idxEnSteps = campaign.steps.findIndex(s => s.id === siguientePaso.id)
      const stepsSiguientes = campaign.steps.slice(idxEnSteps + 1)
      for (const step of stepsSiguientes) {
        if (step.tipo === 'NOTIFY') {
          await ejecutarPasoNotify({ prisma, instancia, lead, vendor: vendorCampaign, step })
        } else if (step.tipo === 'MSG') {
          break // Parar al próximo MSG — esperar respuesta del lead
        }
      }

      return
    }

    // ── LEAD NUEVO ───────────────────────────────────────────
    const cursoCampana = detectarCursoCampana(texto)

    let campaign = null
    if (cursoCampana?.slug) {
      campaign = await getCampaignConSteps(prisma, cursoCampana.slug)
    }
    if (!campaign || !campaign.steps?.length) {
      campaign = await getCampaignActiva(prisma)
    }

    // Crear lead
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
      // Sin flujo → mensaje genérico
      const msgFallback =
        `Hola! Soy del equipo de *Perú Exporta TV* 🇵🇪\n\n` +
        `Recibimos tu mensaje. Un asesor te contactará muy pronto.`
      await sleep(1000)
      await enviarTexto(instancia, numero, msgFallback)
      await guardarMensaje(prisma, { leadId: lead.id, direccion: 'SALIENTE', texto: msgFallback })
      await notificarVendedor({ prisma, instancia, lead, vendor, campaignSlug: null })
      return
    }

    const vendorCampaign = campaign.vendor || vendor

    // Ejecutar paso 1 MSG
    const pasosMsg = campaign.steps.filter(s => s.tipo === 'MSG')
    const primerPaso = pasosMsg[0]

    if (primerPaso) {
      await ejecutarPasoMsg({ prisma, instancia, numero, lead, vendor: vendorCampaign, step: primerPaso })

      // Ejecutar NOTIFYs que vengan justo después del paso 1
      const idxEnSteps = campaign.steps.findIndex(s => s.id === primerPaso.id)
      const stepsSiguientes = campaign.steps.slice(idxEnSteps + 1)
      for (const step of stepsSiguientes) {
        if (step.tipo === 'NOTIFY') {
          await ejecutarPasoNotify({ prisma, instancia, lead, vendor: vendorCampaign, step })
        } else if (step.tipo === 'MSG') {
          break
        }
      }
    } else {
      // No hay pasos MSG — notificar directo
      await notificarVendedor({ prisma, instancia, lead, vendor: vendorCampaign, campaignSlug: campaign.slug })
    }

  } catch (err) {
    console.error('[Motor] Error:', err.message)
    console.error(err.stack)
  }
}
