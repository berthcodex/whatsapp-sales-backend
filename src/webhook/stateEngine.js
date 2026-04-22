// src/webhook/stateEngine.js
// HIDATA — Motor Sprint 3.5 — ARQUITECTURA DEFINITIVA
//
// 3 BLOQUES EN FLOWBUILDER:
//   Bloque 1 — MSG orden 1:    Bienvenida (se envía inmediato al llegar el lead)
//   Bloque 2 — MSG orden 2+:   Cierre (se envía después de 15s de silencio)
//   Bloque 3 — NOTIFY:         Notificación al vendedor (se envía junto al cierre)
//
// VARIABLES DISPONIBLES EN CUALQUIER BLOQUE:
//   {{nombre}}   — nombre detectado del lead (o su número si no se detectó)
//   {{producto}} — producto detectado del lead
//   {{telefono}} — número de teléfono del lead
//   {{vendedor}} — nombre del vendedor asignado
//   {{curso}}    — nombre de la campaña
//   {{historial}} — todo lo que escribió el lead (solo útil en NOTIFY)
//
// CASUÍSTICAS POST-CIERRE (cuando el lead vuelve a escribir):
//   < 1h   → tranquilizador
//   1-2h   → seguimiento + alerta vendedor
//   2-24h  → urgencia + alerta urgente
//   +24h   → reactivación total
//   reclamo, hora, precio, interés, no interés → respuestas específicas

import { detectarCursoCampana, extraerNombre, extraerProducto } from './classifier.js'
import { enviarTexto } from '../whatsapp/sender.js'

const sleep = ms => new Promise(r => setTimeout(r, ms))

// ── Cooldown map en memoria ──────────────────────────────────
const ultimoMensajeMap = new Map()

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

const KW_RECLAMO   = ['no me llamaron','nadie me llamo','no me han llamado','siguen sin llamar','cuando me llaman','no me contactaron','nunca me llamaron']
const KW_HORA      = ['llamame a','a las','pm','am','en la tarde','en la noche','en la mañana','mas tarde','despues','al rato']
const KW_PRECIO    = ['cuanto cuesta','precio','costo','caro','cuotas','descuento','inversion','cuanto es']
const KW_INTERES   = ['me interesa','quiero inscribirme','como me inscribo','quiero participar','dale','listo','acepto','si quiero','quiero el curso']
const KW_NO_INTERES= ['ya no','no me interesa','gracias igual','olvidalo','no gracias','no quiero']

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

async function getHistorialLead(prisma, leadId) {
  const mensajes = await prisma.message.findMany({
    where: { leadId, origen: 'LEAD' },
    orderBy: { createdAt: 'asc' }
  })
  return mensajes.map(m => `  > "${m.texto.slice(0, 100)}"`).join('\n')
}

// ── Interpolación de variables ───────────────────────────────
function interpolar(mensaje, { lead, vendor, campaign, historial }) {
  const nombre   = lead.nombreDetectado || lead.telefono || ''
  const producto = lead.productoDetectado || 'tu producto'
  const telefono = lead.telefono || ''
  const vendedor = vendor?.nombre || ''
  const curso    = campaign?.nombre || 'Mi Primera Exportación'

  return (mensaje || '')
    .replace(/\{\{nombre\}\}/g,    nombre)
    .replace(/\{\{producto\}\}/g,  producto)
    .replace(/\{\{telefono\}\}/g,  telefono)
    .replace(/\{\{vendedor\}\}/g,  vendedor)
    .replace(/\{\{curso\}\}/g,     curso)
    .replace(/\{\{historial\}\}/g, historial || '')
}

// ── Notificación al vendedor ─────────────────────────────────
async function notificarVendedor({ prisma, instancia, lead, vendor, campaign, motivo }) {
  try {
    if (!vendor?.whatsappNumber) return

    const historial = await getHistorialLead(prisma, lead.id)

    // Buscar paso NOTIFY del FlowBuilder
    const pasoNotify = campaign?.steps?.find(s => s.tipo === 'NOTIFY')

    let msg
    if (pasoNotify?.mensaje) {
      msg = interpolar(pasoNotify.mensaje, { lead, vendor, campaign, historial })
    } else {
      // Fallback genérico
      msg =
        `🔔 LEAD LISTO — LLAMA AHORA\n\n` +
        `📱 wa.me/${lead.telefono}\n` +
        `📚 Curso: ${campaign?.nombre || 'orgánico'}\n` +
        (historial ? `\n💬 Lo que dijo:\n${historial}\n` : '') +
        `\n⚡ Llama antes de que se enfríe!`
    }

    if (motivo) msg = `${motivo}\n\n` + msg
    await enviarTexto(instancia, vendor.whatsappNumber, msg)
  } catch (err) {
    console.error('[Motor] Error notificando vendedor:', err.message)
  }
}

async function renotificarVendedor({ instancia, lead, vendor, motivo }) {
  try {
    if (!vendor?.whatsappNumber) return
    const msg = `⚠️ ${motivo}\n\n📱 wa.me/${lead.telefono}\nAcción requerida — llama ahora`
    await enviarTexto(instancia, vendor.whatsappNumber, msg)
  } catch (err) {
    console.error('[Motor] Error renotificando:', err.message)
  }
}

// ── Cerrar flujo — Bloque 2 (MSG cierre) + Bloque 3 (NOTIFY) ─
async function cerrarFlujo({ prisma, instancia, numero, lead, vendor, campaign }) {
  const historial = await getHistorialLead(prisma, lead.id)

  // Detectar nombre y producto del historial acumulado
  const todosLosMensajes = historial.replace(/  > "/g, '').replace(/"/g, '')
  const nombreDetectado  = extraerNombre(todosLosMensajes)
  const productoDetectado= extraerProducto(todosLosMensajes)

  // Actualizar lead con datos detectados
  if (nombreDetectado || productoDetectado) {
    await prisma.lead.update({
      where: { id: lead.id },
      data: {
        ...(nombreDetectado   && { nombreDetectado }),
        ...(productoDetectado && { productoDetectado })
      }
    }).catch(() => {})
    if (nombreDetectado)   lead.nombreDetectado   = nombreDetectado
    if (productoDetectado) lead.productoDetectado = productoDetectado
  }

  // Bloque 2 — MSG de cierre del FlowBuilder
  const pasosMSG = campaign?.steps?.filter(s => s.tipo === 'MSG') || []
  const pasoCierre = pasosMSG[1] // segundo MSG = cierre

  let msgCierre
  if (pasoCierre?.mensaje) {
    msgCierre = interpolar(pasoCierre.mensaje, { lead, vendor, campaign, historial })
  } else {
    // Fallback
    const nombre = lead.nombreDetectado ? `, ${lead.nombreDetectado}` : ''
    msgCierre =
      `Perfecto${nombre}, gracias por contarnos! 🙌\n\n` +
      `Un asesor de nuestro equipo se comunicará contigo hoy para explicarte exactamente cómo podemos ayudarte.\n\n` +
      `¡Estamos en contacto!`
  }

  await sleep(1000)
  await enviarTexto(instancia, numero, msgCierre)
  await guardarMensaje(prisma, { leadId: lead.id, direccion: 'SALIENTE', texto: msgCierre })

  // Actualizar estado
  await prisma.lead.update({
    where: { id: lead.id },
    data: { estado: 'NOTIFICADO', ultimoMensaje: new Date() }
  })

  // Bloque 3 — NOTIFY al vendedor
  await notificarVendedor({ prisma, instancia, lead, vendor, campaign })

  ultimoMensajeMap.delete(numero)
}

// ── Casuísticas post-cierre ──────────────────────────────────
async function manejarPostCierre({ prisma, instancia, numero, lead, vendor, campaign, texto }) {
  const ahora   = Date.now()
  const ultimoMs= lead.ultimoMensaje ? new Date(lead.ultimoMensaje).getTime() : ahora
  const minutos = Math.floor((ahora - ultimoMs) / 60000)

  await prisma.lead.update({
    where: { id: lead.id },
    data: { ultimoMensaje: new Date() }
  }).catch(() => {})

  // Sin interés
  if (contiene(texto, KW_NO_INTERES)) {
    const msg = `Entendido, no hay problema 😊\n\nSi en algún momento cambias de opinión, aquí estaremos.\n\n¡Mucho éxito!`
    await enviarTexto(instancia, numero, msg)
    await guardarMensaje(prisma, { leadId: lead.id, direccion: 'SALIENTE', texto: msg })
    await prisma.lead.update({ where: { id: lead.id }, data: { estado: 'CERRADO' } })
    return
  }

  // Reclamo
  if (contiene(texto, KW_RECLAMO)) {
    const msg = `Mil disculpas, eso no debería pasar 🙏\n\nYa envié una alerta urgente a tu asesor — te llama en los próximos minutos.\n\n¡Gracias por tu paciencia!`
    await enviarTexto(instancia, numero, msg)
    await guardarMensaje(prisma, { leadId: lead.id, direccion: 'SALIENTE', texto: msg })
    await renotificarVendedor({ instancia, lead, vendor, motivo: `URGENTE — El lead reclama que nadie lo llamó` })
    return
  }

  // Hora específica
  if (contiene(texto, KW_HORA)) {
    const msg = `Perfecto! 📅\n\nLe aviso a tu asesor que te llame en ese horario.\n\n¡Estate pendiente al teléfono!`
    await enviarTexto(instancia, numero, msg)
    await guardarMensaje(prisma, { leadId: lead.id, direccion: 'SALIENTE', texto: msg })
    await renotificarVendedor({ instancia, lead, vendor, motivo: `Lead pidió hora: "${texto.slice(0, 80)}"` })
    return
  }

  // Precio
  if (contiene(texto, KW_PRECIO)) {
    const msg = `La inversión en el programa es de S/ 1,500 💰\n\nTambién tenemos facilidades de pago en cuotas.\n\nTu asesor te explicará todos los detalles cuando te llame — ¡que es hoy! 😊`
    await enviarTexto(instancia, numero, msg)
    await guardarMensaje(prisma, { leadId: lead.id, direccion: 'SALIENTE', texto: msg })
    return
  }

  // Reconfirma interés
  if (contiene(texto, KW_INTERES)) {
    const msg = `¡Genial! 🎉\n\nYa avisé a tu asesor — te llama muy pronto.\n\n¡Estate atento al teléfono!`
    await enviarTexto(instancia, numero, msg)
    await guardarMensaje(prisma, { leadId: lead.id, direccion: 'SALIENTE', texto: msg })
    await renotificarVendedor({ instancia, lead, vendor, motivo: `Lead reconfirmó interés` })
    return
  }

  // Reactivación por tiempo
  let msg = null
  if (minutos < 60) {
    msg = `¡Hola! 👋\n\nTu asesor ya está al tanto y te llama en breve.\n\n¡Estate pendiente al teléfono!`
  } else if (minutos < 120) {
    msg = `Hola de nuevo! 😊\n\nSé que llevas un momento esperando — ya le recordé a tu asesor y te contacta hoy.\n\nSi prefieres, dime a qué hora te viene mejor 👇`
    await renotificarVendedor({ instancia, lead, vendor, motivo: `Lead lleva ${minutos} min esperando` })
  } else if (minutos < 1440) {
    msg = `Hola! 🙏\n\nLamentamos la espera — no es nuestro estándar.\n\nYa escalé tu caso como URGENTE. Un asesor te llama hoy sin falta.\n\n¿A qué hora te viene mejor? 👇`
    await renotificarVendedor({ instancia, lead, vendor, motivo: `⚠️ URGENTE — Lead lleva ${Math.floor(minutos/60)}h sin llamada` })
  } else {
    msg = `¡Hola! 👋 Qué gusto saber de ti de nuevo.\n\nTenemos fechas nuevas disponibles para *Mi Primera Exportación*.\n\n¿Sigues interesado/a? 😊`
    await renotificarVendedor({ instancia, lead, vendor, motivo: `Lead reactivado después de +24h` })
    await prisma.lead.update({ where: { id: lead.id }, data: { estado: 'EN_FLUJO', ultimoMensaje: new Date() } })
  }

  if (msg) {
    await enviarTexto(instancia, numero, msg)
    await guardarMensaje(prisma, { leadId: lead.id, direccion: 'SALIENTE', texto: msg })
  }
}

// ════════════════════════════════════════════════════════════
// MOTOR PRINCIPAL
// ════════════════════════════════════════════════════════════
export async function procesarConMotor({ prisma, instancia, numero, texto, tieneImagen, vendor }) {
  try {
    const ahora = Date.now()
    let lead = await prisma.lead.findUnique({ where: { telefono: numero } })

    // ── LEAD EXISTENTE ───────────────────────────────────────
    if (lead) {
      await guardarMensaje(prisma, {
        leadId: lead.id,
        direccion: 'ENTRANTE',
        texto: texto || '[imagen]'
      })

      // Imagen → posible pago
      if (tieneImagen) {
        const msg = `✅ Recibimos tu imagen.\n\nUn asesor validará tu pago y te dará los accesos en breve.`
        await sleep(800)
        await enviarTexto(instancia, numero, msg)
        await guardarMensaje(prisma, { leadId: lead.id, direccion: 'SALIENTE', texto: msg })
        const campaign = lead.campaignId
          ? await prisma.campaign.findUnique({ where: { id: lead.campaignId }, include: { vendor: true, steps: { orderBy: { orden: 'asc' } } } })
          : null
        await notificarVendedor({ prisma, instancia, lead, vendor: campaign?.vendor || vendor, campaign, motivo: '📸 Lead envió imagen — posible pago' })
        ultimoMensajeMap.delete(numero)
        return
      }

      // Cerrado → silencio
      if (lead.estado === 'CERRADO') return

      // Notificado → casuísticas post-cierre
      if (lead.estado === 'NOTIFICADO') {
        const campaign = lead.campaignId
          ? await prisma.campaign.findUnique({ where: { id: lead.campaignId }, include: { vendor: true, steps: { orderBy: { orden: 'asc' } } } })
          : null
        await manejarPostCierre({
          prisma, instancia, numero, lead,
          vendor: campaign?.vendor || vendor,
          campaign, texto
        })
        return
      }

      // EN_FLUJO → acumular 15s y cerrar
      if (lead.estado === 'EN_FLUJO') {
        ultimoMensajeMap.set(numero, ahora)
        await sleep(15000)

        const tsActual = ultimoMensajeMap.get(numero)
        if (tsActual && tsActual > ahora) {
          console.log(`[Motor] ${numero} — cediendo al mensaje más reciente`)
          return
        }

        const campaign = lead.campaignId
          ? await prisma.campaign.findUnique({ where: { id: lead.campaignId }, include: { vendor: true, steps: { orderBy: { orden: 'asc' } } } })
          : null

        await cerrarFlujo({
          prisma, instancia, numero, lead,
          vendor: campaign?.vendor || vendor,
          campaign
        })
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

    // Bloque 1 — Bienvenida desde FlowBuilder (primer MSG)
    const pasosMSG = campaign?.steps?.filter(s => s.tipo === 'MSG') || []
    const pasoBienvenida = pasosMSG[0]

    let msgBienvenida
    if (pasoBienvenida?.mensaje) {
      msgBienvenida = interpolar(pasoBienvenida.mensaje, { lead, vendor: campaign?.vendor || vendor, campaign, historial: '' })
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
      data: { estado: 'EN_FLUJO', pasoActual: 1 }
    })

    ultimoMensajeMap.set(numero, ahora)

  } catch (err) {
    console.error('[Motor] Error:', err.message)
    console.error(err.stack)
  }
}
