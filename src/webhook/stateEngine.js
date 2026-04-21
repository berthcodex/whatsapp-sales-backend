// src/webhook/stateEngine.js
// HIDATA — Motor Simplificado Sprint 1
//
// FLUJO MINIMO:
// 1. Lead escribe → bot responde con mensaje del curso
// 2. Bot notifica al vendedor
// 3. Vendedor llama y cierra
// Sin keywords, sin loops, sin estados intermedios.

import { detectarCursoCampana } from './classifier.js'
import { enviarTexto } from '../whatsapp/sender.js'

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function getBotConfig(prisma, tenantId) {
  try {
    return await prisma.botConfig.findFirst({ where: { tenantId, activo: true } })
  } catch { return null }
}

async function guardarMensaje(prisma, { leadId, tenantId, vendedorId, direccion, contenido, estadoBot }) {
  try {
    await prisma.mensaje.create({
      data: { leadId, tenantId, vendedorId: vendedorId || null, direccion, contenido, estadoBot, tipo: 'texto' }
    })
  } catch (err) {
    console.error('[Motor] Error guardando mensaje:', err.message)
  }
}

async function notificarVendedor({ prisma, instancia, lead, vendedor }) {
  try {
    const v = await prisma.vendedor.findUnique({ where: { id: vendedor.id } })
    if (!v?.whatsappNumber) return

    const leadActual = await prisma.lead.findUnique({ where: { id: lead.id } })
    const nombreLead = leadActual?.nombre || lead.nombre || 'Sin nombre'

    const mins = lead.creadoEn
      ? Math.floor((Date.now() - new Date(lead.creadoEn).getTime()) / 60000)
      : null
    const tiempoStr = mins !== null
      ? mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)}h ${mins % 60}m`
      : ''

    const mensajes = await prisma.mensaje.findMany({
      where: { leadId: lead.id, direccion: 'ENTRANTE' },
      orderBy: { enviadoEn: 'asc' },
      take: 5
    })
    const historial = mensajes.length > 0
      ? mensajes.map(m => `  > "${m.contenido.slice(0, 80)}"`).join('\n')
      : ''

    const msg =
      `NUEVO LEAD - LLAMA AHORA\n\n` +
      `Nombre: ${nombreLead}\n` +
      `Numero: wa.me/${lead.numero}\n` +
      `Curso: ${lead.cursoInteres || 'organico'}\n` +
      (tiempoStr ? `En sistema: ${tiempoStr}\n` : '') +
      (historial ? `\nDijo:\n${historial}\n` : '') +
      `\nLlama antes de que se enfrie!`

    await enviarTexto(instancia, v.whatsappNumber, msg)
  } catch (err) {
    console.error('[Motor] Error notificando vendedor:', err.message)
  }
}

export async function procesarConMotor({ prisma, instancia, numero, texto, tieneImagen, vendedor }) {
  const { id: vendedorId, tenantId } = vendedor

  try {
    let lead = await prisma.lead.findFirst({ where: { numero, tenantId } })

    if (lead) {
      await guardarMensaje(prisma, {
        leadId: lead.id, tenantId, vendedorId,
        direccion: 'ENTRANTE', contenido: texto, estadoBot: lead.estadoBot
      })

      if (tieneImagen) {
        const config = await getBotConfig(prisma, tenantId)
        const msg = config?.msgHandoff ||
          `Recibimos tu imagen. Un asesor validara tu pago y te dara los accesos en breve.`
        await enviarTexto(instancia, numero, msg)
        await guardarMensaje(prisma, {
          leadId: lead.id, tenantId, vendedorId,
          direccion: 'SALIENTE', contenido: msg, estadoBot: 'HANDOFF'
        })
        await notificarVendedor({ prisma, instancia, lead, vendedor })
      }
      return
    }

    const cursoCampana = detectarCursoCampana(texto)

    lead = await prisma.lead.create({
      data: {
        tenantId, vendedorId, numero,
        tipo: cursoCampana?.tipo || 'A',
        tipoPreciso: cursoCampana?.tipo === 'B' ? 'Tipo B — broker' : 'Tipo A — formacion',
        cursoInteres: cursoCampana?.slug || null,
        prioridad: 'ALTA',
        estadoBot: 'HANDOFF',
        primerMensaje: texto,
        ultimoTimestamp: new Date()
      }
    })

    await guardarMensaje(prisma, {
      leadId: lead.id, tenantId, vendedorId,
      direccion: 'ENTRANTE', contenido: texto, estadoBot: 'HANDOFF'
    })

    const config = await getBotConfig(prisma, tenantId)
    let msgRespuesta

    if (cursoCampana?.slug === 'MPX') {
      msgRespuesta = config?.msgProductoMPX || config?.msgBienvenida ||
        `Hola! Gracias por tu interes en *Mi Primera Exportacion*.\n\n` +
        `Un asesor de Peru Exporta TV te contactara muy pronto.\n\n` +
        `Estate pendiente al telefono!`
    } else if (cursoCampana?.slug === 'E1K') {
      msgRespuesta = config?.msgProductoA || config?.msgBienvenida ||
        `Hola! Gracias por tu interes en *Exporta con 1,000 Soles*.\n\n` +
        `Un asesor de Peru Exporta TV te contactara muy pronto.\n\n` +
        `Estate pendiente al telefono!`
    } else if (cursoCampana?.slug === 'CCI') {
      msgRespuesta = config?.msgProductoB || config?.msgBienvenida ||
        `Hola! Gracias por tu interes en *Contacta Compradores Internacionales*.\n\n` +
        `Un asesor de Peru Exporta TV te contactara muy pronto.\n\n` +
        `Estate pendiente al telefono!`
    } else {
      msgRespuesta = config?.msgBienvenida ||
        `Hola! Soy del equipo de *Peru Exporta TV*.\n\n` +
        `Vi tu mensaje y quiero ayudarte. Un asesor te contactara muy pronto.\n\n` +
        `Mientras tanto, cuentame: que producto tienes o en que rubro estas?`
    }

    await sleep(1000)
    await enviarTexto(instancia, numero, msgRespuesta)
    await guardarMensaje(prisma, {
      leadId: lead.id, tenantId, vendedorId,
      direccion: 'SALIENTE', contenido: msgRespuesta, estadoBot: 'HANDOFF'
    })

    await notificarVendedor({ prisma, instancia, lead, vendedor })

  } catch (err) {
    console.error('[Motor] Error:', err.message)
    console.error(err.stack)
  }
}
