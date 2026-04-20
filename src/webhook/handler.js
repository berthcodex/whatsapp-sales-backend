// src/webhook/handler.js
import { clasificarLead } from './classifier.js'
import { enviarTexto, enviarBotones } from '../whatsapp/sender.js'
import { escribirLeadEnSheet } from '../sheets/mirror.js'

// ─── Deduplicación de mensajes ────────────────────────────────────────────────
// Evita procesar el mismo mensaje dos veces si Evolution API dispara el webhook
// múltiples veces (comportamiento conocido con v2.3.7)
const mensajesProcesados = new Set()

function yaFueProcesado(messageId) {
  if (!messageId) return false
  if (mensajesProcesados.has(messageId)) return true
  mensajesProcesados.add(messageId)
  // Limpiar cache cada 1000 mensajes para no acumular memoria
  if (mensajesProcesados.size > 1000) mensajesProcesados.clear()
  return false
}
// ─────────────────────────────────────────────────────────────────────────────

const OPCIONES_ETAPA = [
  { id: 'tipo_a_inicio',   texto: '1️⃣ Estoy empezando desde cero' },
  { id: 'tipo_b_producto', texto: '2️⃣ Ya tengo producto o negocio' },
  { id: 'tipo_b_vende',    texto: '3️⃣ Ya vendo, quiero exportar' }
]

const MENSAJE_ETAPA =
  '¿En qué etapa estás ahora mismo?\n\n' +
  '1️⃣ Estoy empezando desde cero\n' +
  '2️⃣ Ya tengo producto o negocio\n' +
  '3️⃣ Ya vendo, quiero exportar\n\n' +
  'Responde con el número de tu opción 👇'

async function getFlujo(prisma, tenantId, trigger) {
  try {
    const flujo = await prisma.flujo.findFirst({
      where: { tenantId, trigger, activo: true }
    })
    return flujo?.contenido || null
  } catch {
    return null
  }
}

async function getVendedorPorInstancia(prisma, instancia) {
  return await prisma.vendedor.findFirst({
    where: { instanciaEvolution: instancia, activo: true },
    include: { tenant: true }
  })
}

export async function handleWebhook(request, reply, prisma) {
  try {
    const body = request.body

    if (body.event !== 'messages.upsert' || !body.data) {
      return reply.send({ status: 'ignored', reason: 'not_message_upsert' })
    }

    const msg = body.data
    const instancia = body.instance

    // Ignorar mensajes propios del bot
    if (msg.key?.fromMe) {
      return reply.send({ status: 'ignored', reason: 'own_message' })
    }

    // Ignorar grupos
    const numero = msg.key?.remoteJid?.replace('@s.whatsapp.net', '')
    if (!numero || numero.includes('@g.us')) {
      return reply.send({ status: 'ignored', reason: 'no_number_or_group' })
    }

    // ── DEDUPLICACIÓN ──────────────────────────────────────────────────────────
    const messageId = msg.key?.id
    if (yaFueProcesado(messageId)) {
      return reply.send({ status: 'ignored', reason: 'duplicate_message' })
    }
    // ──────────────────────────────────────────────────────────────────────────

    const texto = (
      msg.message?.conversation ||
      msg.message?.extendedTextMessage?.text ||
      msg.message?.buttonsResponseMessage?.selectedDisplayText ||
      msg.message?.listResponseMessage?.title ||
      ''
    ).trim()

    const tieneImagen = !!(
      msg.message?.imageMessage ||
      msg.message?.documentMessage
    )

    // Responder inmediatamente a Evolution API para evitar reintentos
    reply.send({ status: 'received' })

    procesarMensaje({ prisma, instancia, numero, texto, tieneImagen, msg })
      .catch(err => console.error('[Webhook] Error procesando mensaje:', err))

  } catch (error) {
    console.error('[Webhook] Error en handler:', error)
    reply.status(500).send({ error: 'Internal server error' })
  }
}

async function procesarMensaje({ prisma, instancia, numero, texto, tieneImagen, msg }) {
  const vendedor = await getVendedorPorInstancia(prisma, instancia)
  if (!vendedor) {
    console.log(`[Webhook] Instancia no reconocida: ${instancia}`)
    return
  }

  const { tenantId, id: vendedorId } = vendedor

  const leadExistente = await prisma.lead.findFirst({
    where: { numero, vendedorId }
  })

  if (tieneImagen && leadExistente) {
    await manejarImagenRecibida({ prisma, instancia, numero, leadExistente, tenantId })
    return
  }

  if (!leadExistente) {
    await manejarLeadNuevo({ prisma, instancia, numero, texto, tenantId, vendedorId, vendedor })
    return
  }

  if (esRespuestaEtapa(texto)) {
    await manejarRespuestaEtapa({ prisma, instancia, numero, texto, leadExistente, tenantId })
    return
  }

  await manejarMensajeAdicional({ prisma, instancia, numero, texto, leadExistente })
}

async function manejarLeadNuevo({ prisma, instancia, numero, texto, tenantId, vendedorId, vendedor }) {
  console.log(`[Webhook] Lead nuevo: ${numero} en ${instancia}`)

  const clasificacion = await clasificarLead(texto)

  const lead = await prisma.lead.create({
    data: {
      tenantId,
      vendedorId,
      numero,
      nombre:           clasificacion.nombre,
      producto:         clasificacion.producto,
      tipo:             clasificacion.tipo,
      tipoPreciso:      clasificacion.tipoPreciso,
      scoreTotal:       clasificacion.scoreTotal,
      scoreB:           clasificacion.scoreB,
      scoreA:           clasificacion.scoreA,
      clasificadoPorIA: clasificacion.usóIA,
      prioridad:        clasificacion.prioridad,
      estado:           'nuevo',
      primerMensaje:    texto,
      todosLosMensajes: texto,
      ultimoTimestamp:  new Date()
    }
  })

  await prisma.mensaje.create({
    data: {
      leadId:    lead.id,
      tenantId,
      direccion: 'entrante',
      contenido: texto,
      tipo:      'texto'
    }
  })

  await escribirLeadEnSheet(instancia, lead, clasificacion)

  // 1. Mensaje de bienvenida
  const msgBienvenida = await getFlujo(prisma, tenantId, 'lead_nuevo') ||
    'Hola 🙋 te saluda Perú Exporta TV 🇵🇪\n\nNo necesitas tener producto propio para exportar — necesitas saber cómo.\n\n¿Cómo te llamas y qué producto o rubro quieres exportar? 👇'

  await enviarTexto(instancia, numero, msgBienvenida)
  await sleep(2000)

  // 2. Pregunta de etapa — texto numerado (funciona siempre, no depende de polls)
  const msgEtapa = await getFlujo(prisma, tenantId, 'pregunta_etapa') || MENSAJE_ETAPA
  await enviarTexto(instancia, numero, msgEtapa)

  // Marcar que ya se envió la pregunta de etapa
  await prisma.lead.update({
    where: { id: lead.id },
    data: { estado: 'esperando_etapa' }
  })

  // 3. Notificar vendedor si es lead urgente
  if (clasificacion.tipo === 'B' && clasificacion.prioridad === 'URGENTE') {
    await notificarVendedor(instancia, vendedor, lead, clasificacion)
  }

  console.log(`[Webhook] Lead nuevo procesado: ${clasificacion.nombre || numero} | ${clasificacion.tipoPreciso} | Score: ${clasificacion.scoreTotal}`)
}

async function manejarRespuestaEtapa({ prisma, instancia, numero, texto, leadExistente, tenantId }) {
  let tipo = 'A'
  let tipoPreciso = 'Tipo A — formación'
  let prioridad = 'MEDIA'

  const textoNorm = texto.toLowerCase()
  if (
    textoNorm.includes('ya tengo') ||
    textoNorm.includes('ya vendo') ||
    texto.includes('2') ||
    texto.includes('3') ||
    texto.includes('tipo_b')
  ) {
    tipo = 'B'
    tipoPreciso = 'Tipo B — broker'
    prioridad = 'ALTA'
  }

  await prisma.lead.update({
    where: { id: leadExistente.id },
    data: {
      tipo,
      tipoPreciso,
      prioridad,
      estado: 'por_llamar',
      ultimoTimestamp: new Date()
    }
  })

  await sleep(1500)

  const msgRevisando = await getFlujo(prisma, tenantId, 'revisando') ||
    'Gracias! Déjame revisar tu información... 👀'
  await enviarTexto(instancia, numero, msgRevisando)
  await sleep(3000)

  const triggerAsesor = tipo === 'B' ? 'asesor_b' : 'asesor_a'
  const msgAsesor = await getFlujo(prisma, tenantId, triggerAsesor) ||
    'Perfecto, gracias por contarnos! 🙌\n\nUn asesor se comunicará contigo pronto. ¡Estate atento al teléfono! 📲'
  await enviarTexto(instancia, numero, msgAsesor)

  console.log(`[Webhook] Lead ${numero} clasificado por etapa: ${tipoPreciso}`)
}

async function manejarImagenRecibida({ prisma, instancia, numero, leadExistente, tenantId }) {
  await prisma.lead.update({
    where: { id: leadExistente.id },
    data: { estado: 'cerrado', ultimoTimestamp: new Date() }
  })

  const msgBienvenida = await getFlujo(prisma, tenantId, 'pago_recibido') ||
    '¡Bienvenido/a a Perú Exporta! 🎉🇵🇪\n\nYa eres parte de nuestra familia de exportadores. En breve recibirás el acceso al programa.\n\n¡Prepárate para dar el gran paso! 🚀'

  await enviarTexto(instancia, numero, msgBienvenida)
  console.log(`[Webhook] Posible pago recibido de ${numero} — estado: cerrado`)
}

async function manejarMensajeAdicional({ prisma, instancia, numero, texto, leadExistente }) {
  const todosLosMensajes = (leadExistente.todosLosMensajes || '') + ' | ' + texto

  await prisma.lead.update({
    where: { id: leadExistente.id },
    data: { todosLosMensajes, ultimoTimestamp: new Date() }
  })

  await prisma.mensaje.create({
    data: {
      leadId:    leadExistente.id,
      tenantId:  leadExistente.tenantId,
      direccion: 'entrante',
      contenido: texto,
      tipo:      'texto'
    }
  })

  // Reclasificar si aún no tiene clasificación firme
  if (leadExistente.scoreTotal < 8) {
    const clasificacion = await clasificarLead(todosLosMensajes)
    if (clasificacion.scoreTotal >= 8 || clasificacion.usóIA) {
      await prisma.lead.update({
        where: { id: leadExistente.id },
        data: {
          tipo:             clasificacion.tipo,
          tipoPreciso:      clasificacion.tipoPreciso,
          scoreTotal:       clasificacion.scoreTotal,
          scoreB:           clasificacion.scoreB,
          scoreA:           clasificacion.scoreA,
          clasificadoPorIA: clasificacion.usóIA,
          prioridad:        clasificacion.prioridad,
          nombre:           clasificacion.nombre || leadExistente.nombre,
          producto:         clasificacion.producto || leadExistente.producto,
        }
      })
      console.log(`[Webhook] Lead ${numero} reclasificado: ${clasificacion.tipoPreciso} | Score: ${clasificacion.scoreTotal}`)
    }
  }

  // ── CORRECCIÓN CRÍTICA ─────────────────────────────────────────────────────
  // Solo enviar pregunta de etapa si el lead está en estado 'nuevo'
  // Y solo UNA vez — luego cambia a 'esperando_etapa'
  if (leadExistente.estado === 'nuevo') {
    const msgEtapa = MENSAJE_ETAPA
    await enviarTexto(instancia, numero, msgEtapa)
    await prisma.lead.update({
      where: { id: leadExistente.id },
      data: { estado: 'esperando_etapa' }
    })
  }
  // ──────────────────────────────────────────────────────────────────────────
}

async function notificarVendedor(instancia, vendedor, lead, clasificacion) {
  const nombreUpper = vendedor.nombre?.toUpperCase().replace(/\s+/g, '_')
  const numeroVendedor = process.env[`NUMERO_${nombreUpper}`]
  if (!numeroVendedor) return

  const msg =
    `🔥 LEAD URGENTE\n\n` +
    `Nombre: ${clasificacion.nombre || 'Sin nombre'}\n` +
    `Número: ${lead.numero}\n` +
    `Producto: ${clasificacion.producto || 'Sin producto'}\n` +
    `Tipo: ${clasificacion.tipoPreciso}\n` +
    `Score: ${clasificacion.scoreTotal} pts\n\n` +
    `¡Llama ahora! 📞`

  await enviarTexto(instancia, numeroVendedor, msg)
}

function esRespuestaEtapa(texto) {
  const t = texto.toLowerCase().trim()
  return (
    t === '1' || t === '2' || t === '3' ||
    t.includes('empezando desde cero') ||
    t.includes('ya tengo producto') ||
    t.includes('ya vendo') ||
    ['tipo_a_inicio', 'tipo_b_producto', 'tipo_b_vende'].includes(t)
  )
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
