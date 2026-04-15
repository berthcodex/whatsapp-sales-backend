// src/webhook/handler.js
import { clasificarLead } from './classifier.js'
import { enviarTexto, enviarBotones } from '../whatsapp/sender.js'
import { escribirLeadEnSheet } from '../sheets/mirror.js'

const BOTONES_ETAPA = [
  { id: 'tipo_a_inicio', texto: '🌱 Estoy empezando desde cero' },
  { id: 'tipo_b_producto', texto: '📦 Ya tengo producto o negocio' },
  { id: 'tipo_b_vende', texto: '🚀 Ya vendo, quiero exportar' }
]

// ============================================
// Leer flujo de la BD — con fallback al texto hardcodeado
// ============================================
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

    if (msg.key?.fromMe) {
      return reply.send({ status: 'ignored', reason: 'own_message' })
    }

    const numero = msg.key?.remoteJid?.replace('@s.whatsapp.net', '')
    if (!numero || numero.includes('@g.us')) {
      return reply.send({ status: 'ignored', reason: 'no_number_or_group' })
    }

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
    console.error(`[Webhook] Instancia no reconocida: ${instancia}`)
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

  if (esBtnCalificacion(texto)) {
    await manejarRespuestaBoton({ prisma, instancia, numero, texto, leadExistente, tenantId })
    return
  }

  await manejarMensajeAdicional({ prisma, instancia, numero, texto, leadExistente })
}

async function manejarMensajeAdicional({ prisma, instancia, numero, texto, leadExistente }) {
  // Acumular mensajes
  const todosLosMensajes = (leadExistente.todosLosMensajes || '') + ' | ' + texto
  
  await prisma.lead.update({
    where: { id: leadExistente.id },
    data: {
      todosLosMensajes,
      ultimoTimestamp: new Date()
    }
  })

  await prisma.mensaje.create({
    data: {
      leadId: leadExistente.id,
      tenantId: leadExistente.tenantId,
      direccion: 'entrante',
      contenido: texto,
      tipo: 'texto'
    }
  })

  // Reclasificar si aún no tiene clasificación firme
  if (leadExistente.scoreTotal < 8) {
    const clasificacion = await clasificarLead(todosLosMensajes)
    
    if (clasificacion.scoreTotal >= 8 || clasificacion.usóIA) {
      await prisma.lead.update({
        where: { id: leadExistente.id },
        data: {
          tipo: clasificacion.tipo,
          tipoPreciso: clasificacion.tipoPreciso,
          scoreTotal: clasificacion.scoreTotal,
          scoreB: clasificacion.scoreB,
          scoreA: clasificacion.scoreA,
          clasificadoPorIA: clasificacion.usóIA,
          prioridad: clasificacion.prioridad,
          nombre: clasificacion.nombre || leadExistente.nombre,
          producto: clasificacion.producto || leadExistente.producto,
        }
      })
      console.log(`[Webhook] Lead ${numero} reclasificado: ${clasificacion.tipoPreciso} | Score: ${clasificacion.scoreTotal}`)
    }
  }

  // Si el lead está en estado nuevo, re-enviar botones
  if (leadExistente.estado === 'nuevo') {
    await enviarBotones(instancia, numero, '¿En qué etapa estás ahora mismo?', BOTONES_ETAPA)
  }
}

async function manejarRespuestaBoton({ prisma, instancia, numero, texto, leadExistente, tenantId }) {
  let tipo = 'A'
  let tipoPreciso = 'Tipo A — formación'
  let prioridad = 'MEDIA'

  if (texto.includes('Ya tengo producto') || texto.includes('Ya vendo')) {
    tipo = 'B'
    tipoPreciso = 'Tipo B — broker'
    prioridad = 'ALTA'
  }

  await prisma.lead.update({
    where: { id: leadExistente.id },
    data: { tipo, tipoPreciso, prioridad, estado: 'por_llamar', ultimoTimestamp: new Date() }
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

  console.log(`[Webhook] Lead ${numero} clasificado por botón: ${tipoPreciso}`)
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
  await prisma.lead.update({
    where: { id: leadExistente.id },
    data: {
      todosLosMensajes: (leadExistente.todosLosMensajes || '') + ' | ' + texto,
      ultimoTimestamp: new Date()
    }
  })

  await prisma.mensaje.create({
    data: {
      leadId: leadExistente.id,
      tenantId: leadExistente.tenantId,
      direccion: 'entrante',
      contenido: texto,
      tipo: 'texto'
    }
  })

  if (leadExistente.estado === 'nuevo') {
    await enviarBotones(instancia, numero, '¿En qué etapa estás ahora mismo?', BOTONES_ETAPA)
  }
}

async function notificarVendedor(instancia, vendedor, lead, clasificacion) {
  const numeroVendedor = process.env[`NUMERO_${vendedor.nombre.toUpperCase()}`]
  if (!numeroVendedor) return

  const msg = `🔥 LEAD URGENTE\n\nNombre: ${clasificacion.nombre || 'Sin nombre'}\nNúmero: ${lead.numero}\nProducto: ${clasificacion.producto || 'Sin producto'}\nTipo: ${clasificacion.tipoPreciso}\nScore: ${clasificacion.scoreTotal} pts\n\n¡Llama ahora! 📞`

  await enviarTexto(instancia, numeroVendedor, msg)
}

function esBtnCalificacion(texto) {
  return texto.includes('empezando desde cero') ||
         texto.includes('Ya tengo producto') ||
         texto.includes('Ya vendo') ||
         ['tipo_a_inicio', 'tipo_b_producto', 'tipo_b_vende'].includes(texto)
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
