// src/webhook/handler.js
// El corazón del backend
// Recibe mensajes de los 3 números, clasifica, guarda en BD, espeja en Sheets

import { clasificarLead } from './classifier.js'
import { enviarTexto, enviarBotones } from '../whatsapp/sender.js'
import { escribirLeadEnSheet } from '../sheets/mirror.js'

// ============================================
// Mensajes del bot — portados desde Apps Script
// Ahora se cargarán desde BD en la Semana 3
// Por ahora como constantes para arrancar rápido
// ============================================
const MENSAJES = {
  BIENVENIDA: `Hola 🙋 te saluda Perú Exporta TV 🇵🇪

No necesitas tener producto propio para exportar — necesitas saber cómo. Formamos a productores, acopiadores, cooperativas y emprendedores para que exporten por su cuenta.

¿Cómo te llamas y qué producto o rubro quieres exportar? 👇`,

  REVISANDO: 'Gracias! Déjame revisar tu información... 👀',

  ASESOR_A: `Perfecto, gracias por contarnos! 🙌

Un asesor de nuestro equipo se comunicará contigo hoy para explicarte cómo podemos ayudarte. ¡Estate atento al teléfono! 📲`,

  ASESOR_B: `Perfecto, gracias por contarnos! 🙌

Un asesor de nuestro equipo se comunicará contigo en los próximos minutos. ¡Estate atento al teléfono! 📲`,

  REACTIVACION_1H: `Hola 👋 por si no viste nuestro mensaje — estamos aquí para ayudarte a dar el paso a la exportación.

¿Pudiste ver la información? 😊`,

  REACTIVACION_24H: `Hola, entendemos que estás ocupado 🙏

Si en algún momento quieres saber cómo exportar tu producto, aquí estamos. 🇵🇪`,
}

// Botones de calificación — reemplazan el texto libre
const BOTONES_ETAPA = [
  { id: 'tipo_a_inicio', texto: '🌱 Estoy empezando desde cero' },
  { id: 'tipo_b_producto', texto: '📦 Ya tengo producto o negocio' },
  { id: 'tipo_b_vende', texto: '🚀 Ya vendo, quiero exportar' }
]

// ============================================
// Mapeo instancia Evolution → vendedor en BD
// Se consulta a la BD en tiempo real
// ============================================
async function getVendedorPorInstancia(prisma, instancia) {
  return await prisma.vendedor.findFirst({
    where: { instanciaEvolution: instancia, activo: true },
    include: { tenant: true }
  })
}

// ============================================
// HANDLER PRINCIPAL
// ============================================
export async function handleWebhook(request, reply, prisma) {
  try {
    const body = request.body

    // Validar evento — solo procesar mensajes nuevos
    if (body.event !== 'messages.upsert' || !body.data) {
      return reply.send({ status: 'ignored', reason: 'not_message_upsert' })
    }

    const msg = body.data
    const instancia = body.instance

    // Ignorar mensajes propios del bot
    if (msg.key?.fromMe) {
      return reply.send({ status: 'ignored', reason: 'own_message' })
    }

    // Extraer datos básicos del mensaje
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

    // Responder rápido a WhatsApp — procesar en background
    reply.send({ status: 'received' })

    // Procesar en background sin bloquear
    procesarMensaje({ prisma, instancia, numero, texto, tieneImagen, msg })
      .catch(err => console.error('[Webhook] Error procesando mensaje:', err))

  } catch (error) {
    console.error('[Webhook] Error en handler:', error)
    reply.status(500).send({ error: 'Internal server error' })
  }
}

// ============================================
// PROCESAMIENTO PRINCIPAL — en background
// ============================================
async function procesarMensaje({ prisma, instancia, numero, texto, tieneImagen, msg }) {
  // 1. Obtener vendedor por instancia
  const vendedor = await getVendedorPorInstancia(prisma, instancia)
  if (!vendedor) {
    console.error(`[Webhook] Instancia no reconocida: ${instancia}`)
    return
  }

  const { tenantId, id: vendedorId } = vendedor

  // 2. Buscar si el lead ya existe
  const leadExistente = await prisma.lead.findFirst({
    where: { numero, vendedorId }
  })

  // 3. CASO: imagen recibida → posible comprobante de pago
  if (tieneImagen && leadExistente) {
    await manejarImagenRecibida({ prisma, instancia, numero, leadExistente })
    return
  }

  // 4. CASO: lead nuevo
  if (!leadExistente) {
    await manejarLeadNuevo({ prisma, instancia, numero, texto, tenantId, vendedorId })
    return
  }

  // 5. CASO: respuesta de botón de calificación
  if (esBtnCalificacion(texto)) {
    await manejarRespuestaBoton({ prisma, instancia, numero, texto, leadExistente })
    return
  }

  // 6. CASO: lead existente escribe algo más
  await manejarMensajeAdicional({ prisma, instancia, numero, texto, leadExistente })
}

// ============================================
// LEAD NUEVO — primer mensaje
// ============================================
async function manejarLeadNuevo({ prisma, instancia, numero, texto, tenantId, vendedorId }) {
  console.log(`[Webhook] Lead nuevo: ${numero} en ${instancia}`)

  // Clasificar con el sistema de 4 capas
  const clasificacion = await clasificarLead(texto)

  // Guardar en PostgreSQL
  const lead = await prisma.lead.create({
    data: {
      tenantId,
      vendedorId,
      numero,
      nombre: clasificacion.nombre,
      producto: clasificacion.producto,
      tipo: clasificacion.tipo,
      tipoPreciso: clasificacion.tipoPreciso,
      scoreTotal: clasificacion.scoreTotal,
      scoreB: clasificacion.scoreB,
      scoreA: clasificacion.scoreA,
      clasificadoPorIA: clasificacion.usóIA,
      prioridad: clasificacion.prioridad,
      estado: 'nuevo',
      primerMensaje: texto,
      todosLosMensajes: texto,
      ultimoTimestamp: new Date()
    }
  })

  // Guardar mensaje en historial
  await prisma.mensaje.create({
    data: {
      leadId: lead.id,
      tenantId,
      direccion: 'entrante',
      contenido: texto,
      tipo: 'texto'
    }
  })

  // Espejo en Google Sheets — inmediato
  await escribirLeadEnSheet(instancia, lead, clasificacion)

  // Enviar bienvenida
  await enviarTexto(instancia, numero, MENSAJES.BIENVENIDA)
  await sleep(2000)

  // Enviar botones de calificación
  await enviarBotones(
    instancia,
    numero,
    '¿En qué etapa estás ahora mismo?',
    BOTONES_ETAPA
  )

  // Notificar al vendedor si es Tipo B urgente
  if (clasificacion.tipo === 'B' && clasificacion.prioridad === 'URGENTE') {
    await notificarVendedor(instancia, vendedor, lead, clasificacion)
  }

  console.log(`[Webhook] Lead nuevo procesado: ${clasificacion.nombre || numero} | ${clasificacion.tipoPreciso} | Score: ${clasificacion.scoreTotal}`)
}

// ============================================
// RESPUESTA DE BOTÓN — calificación interactiva
// ============================================
async function manejarRespuestaBoton({ prisma, instancia, numero, texto, leadExistente }) {
  // Determinar tipo por botón seleccionado
  let tipo = 'A'
  let tipoPreciso = 'Tipo A — formación'
  let prioridad = 'MEDIA'

  if (texto.includes('Ya tengo producto') || texto.includes('Ya vendo')) {
    tipo = 'B'
    tipoPreciso = 'Tipo B — broker'
    prioridad = 'ALTA'
  }

  // Actualizar lead en BD
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

  // Enviar mensaje según tipo
  await sleep(1500)
  await enviarTexto(
    instancia,
    numero,
    MENSAJES.REVISANDO
  )
  await sleep(3000)

  const msgAsesor = tipo === 'B' ? MENSAJES.ASESOR_B : MENSAJES.ASESOR_A
  await enviarTexto(instancia, numero, msgAsesor)

  console.log(`[Webhook] Lead ${numero} clasificado por botón: ${tipoPreciso}`)
}

// ============================================
// IMAGEN RECIBIDA — posible comprobante
// ============================================
async function manejarImagenRecibida({ prisma, instancia, numero, leadExistente }) {
  // Actualizar estado
  await prisma.lead.update({
    where: { id: leadExistente.id },
    data: { estado: 'cerrado', ultimoTimestamp: new Date() }
  })

  // Mensaje de bienvenida al programa
  const msgBienvenida = `¡Bienvenido/a a Perú Exporta! 🎉🇵🇪

Ya eres parte de nuestra familia de exportadores. En breve recibirás el acceso al programa.

¡Prepárate para dar el gran paso! 🚀`

  await enviarTexto(instancia, numero, msgBienvenida)
  console.log(`[Webhook] Posible pago recibido de ${numero} — estado: cerrado`)
}

// ============================================
// MENSAJE ADICIONAL — lead ya existe
// ============================================
async function manejarMensajeAdicional({ prisma, instancia, numero, texto, leadExistente }) {
  // Acumular mensajes en el historial
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

  // Si el lead está en estado nuevo, re-enviar botones
  if (leadExistente.estado === 'nuevo') {
    await enviarBotones(
      instancia,
      numero,
      '¿En qué etapa estás ahora mismo?',
      BOTONES_ETAPA
    )
  }
}

// ============================================
// NOTIFICACIÓN AL VENDEDOR
// ============================================
async function notificarVendedor(instancia, vendedor, lead, clasificacion) {
  // Por ahora notifica al número del vendedor via WhatsApp
  // En Semana 3 esto se conecta al sistema de triggers
  const numeroVendedor = process.env[`NUMERO_${vendedor.nombre.toUpperCase()}`]
  if (!numeroVendedor) return

  const msg = `🔥 LEAD URGENTE\n\n` +
    `Nombre: ${clasificacion.nombre || 'Sin nombre'}\n` +
    `Número: ${lead.numero}\n` +
    `Producto: ${clasificacion.producto || 'Sin producto'}\n` +
    `Tipo: ${clasificacion.tipoPreciso}\n` +
    `Score: ${clasificacion.scoreTotal} pts\n` +
    `Keywords: ${clasificacion.keywords?.slice(0, 3).map(k => k.palabra).join(', ')}\n\n` +
    `¡Llama ahora! 📞`

  await enviarTexto(instancia, numeroVendedor, msg)
}

// Helpers
function esBtnCalificacion(texto) {
  return texto.includes('empezando desde cero') ||
         texto.includes('Ya tengo producto') ||
         texto.includes('Ya vendo') ||
         ['tipo_a_inicio', 'tipo_b_producto', 'tipo_b_vende'].includes(texto)
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
