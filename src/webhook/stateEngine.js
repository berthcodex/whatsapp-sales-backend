// src/webhook/stateEngine.js
// HIDATA — Motor Sprint 3.4 — DISEÑO CORRECTO
//
// FILOSOFÍA: Simple beats complex. Siempre.
//
// DOS FASES SOLAMENTE:
//
// FASE 1 — NUEVO: Lead llega → bot saluda con pregunta abierta → espera
// FASE 2 — EN_FLUJO: Lead responde → bot acumula en silencio → 
//           después de 15s sin respuesta → bot cierra → notifica vendedor
//
// El debounce de 3s del handler.js filtra múltiples enters rápidos.
// El cooldown de 15s del stateEngine filtra pausas entre mensajes.
// Juntos garantizan que el bot solo responde cuando el lead terminó de escribir.

import { detectarCursoCampana } from './classifier.js'
import { enviarTexto } from '../whatsapp/sender.js'

const sleep = ms => new Promise(r => setTimeout(r, ms))

// ── Cooldown map — número → timestamp del último mensaje ─────
// Persiste en memoria del proceso (se resetea si Render reinicia)
// Suficiente para el caso de uso — 45 leads/día
const ultimoMensajeMap = new Map()

// ── Helpers DB ───────────────────────────────────────────────

async function guardarMensaje(prisma, { leadId, direccion, texto }) {
  try {
    await prisma.message.create({
      data: { leadId, origen: direccion === 'ENTRANTE' ? 'LEAD' : 'BOT', texto }
    })
  } catch (err) {
    console.error('[Motor] Error guardando mensaje:', err.message)
  }
}

async function getCampaignActiva(prisma, slug) {
  if (slug) {
    const c = await prisma.campaign.findUnique({
      where: { slug },
      include: { vendor: true }
    })
    if (c) return c
  }
  return await prisma.campaign.findFirst({
    where: { activa: true },
    include: { vendor: true }
  })
}

// ── Mensaje de bienvenida desde FlowBuilder ──────────────────
async function getMsgBienvenida(prisma, campaignId) {
  if (!campaignId) return null
  const steps = await prisma.flowStep.findMany({
    where: { campaignId, tipo: 'MSG' },
    orderBy: { orden: 'asc' },
    take: 1
  })
  return steps[0]?.mensaje || null
}

// ── Notificar vendedor con historial completo ────────────────
async function notificarVendedor({ prisma, instancia, lead, vendor, campaignSlug }) {
  try {
    if (!vendor?.whatsappNumber) {
      console.warn('[Motor] vendor sin whatsappNumber')
      return
    }

    const mensajes = await prisma.message.findMany({
      where: { leadId: lead.id, origen: 'LEAD' },
      orderBy: { createdAt: 'asc' }
    })

    const historial = mensajes
      .map(m => `  > "${m.texto.slice(0, 100)}"`)
      .join('\n')

    const msg =
      `🔔 LEAD LISTO — LLAMA AHORA\n\n` +
      `📱 wa.me/${lead.telefono}\n` +
      `📚 Curso: ${campaignSlug || 'orgánico'}\n` +
      (historial ? `\n💬 Lo que dijo:\n${historial}\n` : '') +
      `\n⚡ Llama antes de que se enfríe!`

    await enviarTexto(instancia, vendor.whatsappNumber, msg)
  } catch (err) {
    console.error('[Motor] Error notificando vendedor:', err.message)
  }
}

// ── Cerrar flujo: mensaje al lead + notificación al vendedor ─
async function cerrarFlujo({ prisma, instancia, numero, lead, vendor, campaignSlug }) {
  const msgCierre =
    `Perfecto, gracias por contarnos! 🙌\n\n` +
    `Un asesor de nuestro equipo se comunicará contigo hoy para explicarte exactamente cómo podemos ayudarte.\n\n` +
    `¡Estamos en contacto!`

  await sleep(1000)
  await enviarTexto(instancia, numero, msgCierre)
  await guardarMensaje(prisma, { leadId: lead.id, direccion: 'SALIENTE', texto: msgCierre })

  await prisma.lead.update({
    where: { id: lead.id },
    data: { estado: 'NOTIFICADO', pasoActual: 99 }
  })

  await notificarVendedor({ prisma, instancia, lead, vendor, campaignSlug })
  
  // Limpiar del cooldown map
  ultimoMensajeMap.delete(numero)
}

// ── MOTOR PRINCIPAL ──────────────────────────────────────────
export async function procesarConMotor({ prisma, instancia, numero, texto, tieneImagen, vendor }) {
  try {
    const ahora = Date.now()
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

      // Imagen → posible pago
      if (tieneImagen) {
        const msgImg =
          `✅ Recibimos tu imagen.\n\n` +
          `Un asesor validará tu pago y te dará los accesos en breve.`
        await sleep(800)
        await enviarTexto(instancia, numero, msgImg)
        await guardarMensaje(prisma, { leadId: lead.id, direccion: 'SALIENTE', texto: msgImg })
        await notificarVendedor({ prisma, instancia, lead, vendor, campaignSlug: null })
        ultimoMensajeMap.delete(numero)
        return
      }

      // Lead ya cerrado → silencio total
      if (lead.estado === 'NOTIFICADO' || lead.estado === 'CERRADO') {
        return
      }

      // ── FASE 2: Lead en flujo — acumular y esperar 15s ──────
      if (lead.estado === 'EN_FLUJO') {
        // Registrar timestamp de este mensaje
        ultimoMensajeMap.set(numero, ahora)

        // Esperar 15 segundos
        await sleep(15000)

        // Verificar si llegó otro mensaje después de este
        const tsActual = ultimoMensajeMap.get(numero)
        if (tsActual && tsActual > ahora) {
          // Llegó otro mensaje más reciente — este proceso cede el turno
          console.log(`[Motor] ${numero} — mensaje más reciente detectado, cediendo`)
          return
        }

        // 15s de silencio confirmados — cerrar flujo
        const campaign = lead.campaignId
          ? await prisma.campaign.findUnique({
              where: { id: lead.campaignId },
              include: { vendor: true }
            })
          : null

        await cerrarFlujo({
          prisma, instancia, numero, lead,
          vendor: campaign?.vendor || vendor,
          campaignSlug: campaign?.slug
        })
        return
      }

      return
    }

    // ════════════════════════════════════════════════════════
    // LEAD NUEVO — FASE 1
    // ════════════════════════════════════════════════════════
    const cursoCampana = detectarCursoCampana(texto)
    const campaign = await getCampaignActiva(prisma, cursoCampana?.slug)

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

    // Obtener mensaje de bienvenida del FlowBuilder
    let msgBienvenida = campaign?.id
      ? await getMsgBienvenida(prisma, campaign.id)
      : null

    // Fallback si no hay mensaje en FlowBuilder
    if (!msgBienvenida) {
      msgBienvenida =
        `Hola 👋 te saluda *Perú Exporta TV* 🇵🇪\n\n` +
        `Cuéntame:\n` +
        `¿Cómo te llamas y qué producto tienes en mente para exportar? 👇`
    }

    await sleep(1000)
    await enviarTexto(instancia, numero, msgBienvenida)
    await guardarMensaje(prisma, { leadId: lead.id, direccion: 'SALIENTE', texto: msgBienvenida })

    // Pasar a EN_FLUJO — listo para acumular respuestas
    await prisma.lead.update({
      where: { id: lead.id },
      data: { estado: 'EN_FLUJO', pasoActual: 1 }
    })

    // Registrar timestamp inicial
    ultimoMensajeMap.set(numero, ahora)

  } catch (err) {
    console.error('[Motor] Error:', err.message)
    console.error(err.stack)
  }
}
