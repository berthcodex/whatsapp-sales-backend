// src/webhook/stateEngine.js
// HIDATA — Motor de Estados Conversacional
// Reescritura limpia — Sprint 1 completo
//
// FLUJO:
// BIENVENIDA → PRODUCTO → EXPERIENCIA → PRESENTACION
//                                           ↓
//                              OBJECION ← respuesta
//                                  ↓
//                             URGENCIA → HANDOFF

import {
  extraerNombre,
  extraerProducto,
  clasificarConScoring,
  clasificarConIA,
  detectarCursoCampana
} from './classifier.js'

import { enviarTexto } from '../whatsapp/sender.js'

// ================================================================
// KEYWORDS
// ================================================================

const KEYWORDS_HANDOFF_INMEDIATO = [
  'hablar con', 'hablar a',
  'asesor', 'vendedor', 'persona', 'humano', 'quiero hablar',
  'precio final'
]

const KEYWORDS_TIENE_PRODUCTO = [
  'tengo', 'produzco', 'cosecho', 'siembro', 'vendo', 'trabajo con',
  'mi empresa', 'mi negocio', 'somos', 'exportamos', 'fabricamos',
  'elaboramos', 'criamos', 'cultivo', 'cultiva', 'parcela', 'chacra',
  'hectarea', 'cooperativa', 'asociacion'
]

const KEYWORDS_EXPLORANDO = [
  'empezando', 'empezar', 'desde cero', 'sin experiencia',
  'no se', 'no se', 'aprender', 'curiosidad', 'explorar',
  'quiero saber', 'primera vez', 'nunca he'
]

const KEYWORDS_PRECIO = [
  'caro', 'precio', 'cuesta', 'cuanto', 'costo',
  'barato', 'rebaja', 'no tengo',
  'no puedo', 'complicado', 'dificil', 'lo pienso',
  'pensarlo', 'consultarlo', 'despues', 'luego', 'mas adelante'
]

// IMPORTANTE: 'si' y 'ok' solo se usan en contextos específicos
// no como keywords globales para evitar falsos positivos
const KEYWORDS_INTERES_CONFIRMADO = [
  'me interesa', 'quiero inscribirme',
  'como me inscribo', 'quiero participar',
  'cuando empieza', 'me anoto', 'me apunto',
  'voy a inscribirme', 'quiero el curso', 'quiero el programa',
  'dale', 'listo', 'acepto', 'de acuerdo'
]

const KEYWORDS_PERDIO_INTERES = [
  'ya no', 'no me interesa', 'gracias igual', 'dejalo',
  'olvidalo', 'no gracias', 'cancel', 'no quiero'
]

const KEYWORDS_HORA = [
  'llamame a', 'llama a las', 'a las', 'pm', 'am',
  'manana', 'tarde', 'noche', 'despues',
  'en la tarde', 'en la manana', 'al rato', 'mas tarde',
  'ahora no', 'no ahora', 'ahorita no'
]

const KEYWORDS_RECLAMO = [
  'no me llamaron', 'nadie me llamo',
  'no me han llamado', 'siguen sin llamar', 'todavia no',
  'cuando me llaman', 'no me contactaron', 'llevo esperando'
]

// ================================================================
// UTILIDADES
// ================================================================

function norm(texto) {
  return texto
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function contieneAlguna(texto, keywords) {
  const n = norm(texto)
  return keywords.some(kw => n.includes(norm(kw)))
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

// ================================================================
// EXTRACCIÓN DE DATOS
// ================================================================

async function extraerDatosDelMensaje(texto, leadActual, omitirNombre = false) {
  const datos = {}

  // Nombre — nunca del primer mensaje (es el mensaje predeterminado del Ad)
  if (!leadActual.nombre && !omitirNombre) {
    const nombre = extraerNombre(texto)
    if (nombre) datos.nombre = nombre
  }

  // Producto
  if (!leadActual.producto) {
    const producto = extraerProducto(texto)
    if (producto) datos.producto = producto
  }

  // Tipo A/B
  if (!leadActual.tipo || leadActual.scoreTotal < 8) {
    const scoring = clasificarConScoring(texto)
    if (scoring.confianza === 'alta') {
      datos.tipo = scoring.tipo
      datos.tipoPreciso = scoring.tipoPreciso
      datos.scoreB = scoring.scoreB
      datos.scoreA = scoring.scoreA
      datos.scoreTotal = scoring.scoreTotal
      datos.prioridad = scoring.prioridad
      datos.confianza = 'alta'
    } else {
      if (contieneAlguna(texto, KEYWORDS_TIENE_PRODUCTO)) {
        datos.tipo = 'B'
        datos.tipoPreciso = 'Tipo B — broker'
        datos.prioridad = 'ALTA'
        datos.confianza = 'media'
      } else if (contieneAlguna(texto, KEYWORDS_EXPLORANDO)) {
        datos.tipo = 'A'
        datos.tipoPreciso = 'Tipo A — formacion'
        datos.prioridad = 'MEDIA'
        datos.confianza = 'media'
      } else {
        try {
          const ia = await clasificarConIA(texto)
          datos.tipo = ia.tipo
          datos.tipoPreciso = ia.tipoPreciso
          datos.prioridad = ia.prioridad
          datos.confianza = 'media'
          datos.clasificadoPorIA = true
        } catch {
          // Groq fallo — default A
        }
      }
    }
  }

  return datos
}

function datosFaltantes(lead) {
  const falta = []
  if (!lead.nombre) falta.push('nombre')
  if (!lead.producto) falta.push('producto')
  if (!lead.tipo) falta.push('tipo')
  return falta
}

function construirPreguntaFaltante(falta, nombre) {
  const saludo = nombre ? `${nombre}, ` : ''

  if (falta.includes('nombre') && falta.includes('producto')) {
    return `Cuéntame, ¿cómo te llamas y qué producto tienes en mente para exportar? 👇`
  }
  if (falta.includes('nombre') && falta.includes('tipo')) {
    return `¿Cómo te llamas? Y cuéntame, ¿ya tienes un producto o estás explorando? 👇`
  }
  if (falta.includes('nombre')) {
    return `¿Cómo te llamas? 👇`
  }
  if (falta.includes('producto') && falta.includes('tipo')) {
    return `${saludo}¿tienes algún producto en mente o estás explorando? 👇`
  }
  if (falta.includes('producto')) {
    return `${saludo}¿qué producto te gustaría exportar? 👇`
  }
  if (falta.includes('tipo')) {
    return `${saludo}¿ya tienes experiencia exportando o vas desde cero? 👇`
  }
  return null
}

// ================================================================
// DB HELPERS
// ================================================================

async function getBotConfig(prisma, tenantId) {
  try {
    return await prisma.botConfig.findFirst({ where: { tenantId, activo: true } })
  } catch {
    return null
  }
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

async function avanzarEstado(prisma, lead, nuevoEstado) {
  try {
    await prisma.lead.update({
      where: { id: lead.id },
      data: { estadoBotAnterior: lead.estadoBot, estadoBot: nuevoEstado, ultimoTimestamp: new Date() }
    })
    lead.estadoBot = nuevoEstado
  } catch (err) {
    console.error('[Motor] Error avanzando estado:', err.message)
  }
}

// ================================================================
// NOTIFICACIONES
// ================================================================

async function notificarVendedor({ prisma, instancia, lead, vendedor }) {
  try {
    const v = await prisma.vendedor.findUnique({ where: { id: vendedor.id } })
    if (!v?.whatsappNumber) return

    // Nombre actualizado desde DB
    const leadActual = await prisma.lead.findUnique({ where: { id: lead.id } })
    const nombreLead = leadActual?.nombre || lead.nombre || 'Sin nombre'

    // Tiempo en sistema
    const mins = lead.creadoEn
      ? Math.floor((Date.now() - new Date(lead.creadoEn).getTime()) / 60000)
      : null
    const tiempoStr = mins !== null
      ? mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)}h ${mins % 60}m`
      : ''

    // Historial de mensajes
    const mensajes = await prisma.mensaje.findMany({
      where: { leadId: lead.id, direccion: 'ENTRANTE' },
      orderBy: { enviadoEn: 'asc' },
      take: 10
    })
    const historial = mensajes.length > 0
      ? mensajes.map(m => `  > "${m.contenido.slice(0, 100)}${m.contenido.length > 100 ? '...' : ''}"`)
          .join('\n')
      : null

    const msg =
      `LEAD CALIENTE - LISTO PARA LLAMAR\n\n` +
      `Nombre: ${nombreLead}\n` +
      `Numero: wa.me/${lead.numero}\n` +
      `Producto: ${lead.producto || 'Sin producto'}\n` +
      `Perfil: ${lead.tipoPreciso || lead.tipo}\n` +
      `Prioridad: ${lead.prioridad}\n` +
      (tiempoStr ? `En sistema: ${tiempoStr}\n` : '') +
      (historial ? `\nLo que dijo:\n${historial}\n` : '') +
      `\nLlama ahora antes de que se enfrie!`

    await enviarTexto(instancia, v.whatsappNumber, msg)
  } catch (err) {
    console.error('[Motor] Error notificando vendedor:', err.message)
  }
}

async function renotificarVendedor({ prisma, instancia, lead, vendedor, motivo }) {
  try {
    const v = await prisma.vendedor.findUnique({ where: { id: vendedor.id } })
    if (!v?.whatsappNumber) return

    const leadActual = await prisma.lead.findUnique({ where: { id: lead.id } })
    const nombreLead = leadActual?.nombre || lead.nombre || 'Sin nombre'

    const msg =
      `${motivo}\n\n` +
      `Nombre: ${nombreLead}\n` +
      `Numero: wa.me/${lead.numero}\n` +
      `Producto: ${lead.producto || 'Sin producto'}\n` +
      `Perfil: ${lead.tipoPreciso || lead.tipo}\n\n` +
      `Accion requerida - llama ahora`

    await enviarTexto(instancia, v.whatsappNumber, msg)
  } catch (err) {
    console.error('[Motor] Error re-notificando vendedor:', err.message)
  }
}

// ================================================================
// ESCALAR A HANDOFF
// ================================================================

async function escalarAHandoff({ prisma, instancia, numero, lead, tenantId, vendedor, motivo }) {
  await prisma.lead.update({
    where: { id: lead.id },
    data: {
      estadoBotAnterior: lead.estadoBot,
      estadoBot: 'HANDOFF',
      handoffEn: new Date(),
      handoffPor: motivo,
      ultimoTimestamp: new Date()
    }
  })
  lead.estadoBot = 'HANDOFF'

  await notificarVendedor({ prisma, instancia, lead, vendedor })

  const msg =
    `Genial! Un asesor de *Peru Exporta TV* se comunicara contigo muy pronto.\n\n` +
    `Estate atento al telefono!`

  await enviarTexto(instancia, numero, msg)
  await guardarMensaje(prisma, {
    leadId: lead.id, tenantId, vendedorId: vendedor.id,
    direccion: 'SALIENTE', contenido: msg, estadoBot: 'HANDOFF'
  })
}

// ================================================================
// MANEJAR IMAGEN (posible pago)
// ================================================================

async function manejarPosiblePago({ prisma, instancia, numero, lead, tenantId, vendedor }) {
  await prisma.lead.update({
    where: { id: lead.id },
    data: {
      estadoBotAnterior: lead.estadoBot,
      estadoBot: 'HANDOFF',
      handoffEn: new Date(),
      handoffPor: 'imagen_posible_pago',
      ultimoTimestamp: new Date()
    }
  })

  const msg =
    `Bienvenido/a a *Peru Exporta TV*!\n\n` +
    `Recibimos tu imagen. Un asesor validara tu pago y te dara los accesos en breve.\n\n` +
    `Preparate para exportar!`

  await enviarTexto(instancia, numero, msg)
  await guardarMensaje(prisma, {
    leadId: lead.id, tenantId, vendedorId: vendedor.id,
    direccion: 'SALIENTE', contenido: msg, estadoBot: 'HANDOFF'
  })
  await notificarVendedor({ prisma, instancia, lead, vendedor })
}

// ================================================================
// MOTOR PRINCIPAL
// ================================================================

export async function procesarConMotor({ prisma, instancia, numero, texto, tieneImagen, vendedor }) {
  const { id: vendedorId, tenantId } = vendedor

  let lead = await prisma.lead.findFirst({ where: { numero, tenantId } })

  if (lead) {
    await guardarMensaje(prisma, {
      leadId: lead.id, tenantId, vendedorId,
      direccion: 'ENTRANTE', contenido: texto, estadoBot: lead.estadoBot
    })
  }

  if (tieneImagen && lead) {
    await manejarPosiblePago({ prisma, instancia, numero, lead, tenantId, vendedor })
    return
  }

  if (lead && lead.estadoBot !== 'HANDOFF' && contieneAlguna(texto, KEYWORDS_HANDOFF_INMEDIATO)) {
    await escalarAHandoff({ prisma, instancia, numero, lead, tenantId, vendedor, motivo: 'keyword_handoff' })
    return
  }

  const esLeadNuevo = !lead
  const datosNuevos = (lead && lead.estadoBot === 'HANDOFF')
    ? {}
    : await extraerDatosDelMensaje(texto, lead || {}, esLeadNuevo)

  if (!lead) {
    const cursoCampana = detectarCursoCampana(texto)
    if (cursoCampana && !datosNuevos.tipo) {
      datosNuevos.tipo = cursoCampana.curso
      datosNuevos.tipoPreciso = cursoCampana.curso === 'B' ? 'Tipo B — broker' : 'Tipo A — formacion'
      datosNuevos.prioridad = 'ALTA'
    }

    lead = await prisma.lead.create({
      data: {
        tenantId, vendedorId, numero,
        nombre:           datosNuevos.nombre || null,
        producto:         datosNuevos.producto || null,
        tipo:             datosNuevos.tipo || 'A',
        tipoPreciso:      datosNuevos.tipoPreciso || 'Tipo A — formacion',
        scoreTotal:       datosNuevos.scoreTotal || 0,
        scoreB:           datosNuevos.scoreB || 0,
        scoreA:           datosNuevos.scoreA || 0,
        clasificadoPorIA: datosNuevos.clasificadoPorIA || false,
        prioridad:        datosNuevos.prioridad || 'MEDIA',
        estadoBot:        'BIENVENIDA',
        primerMensaje:    texto,
        ultimoTimestamp:  new Date()
      }
    })

    await guardarMensaje(prisma, {
      leadId: lead.id, tenantId, vendedorId,
      direccion: 'ENTRANTE', contenido: texto, estadoBot: 'BIENVENIDA'
    })

    await ejecutarEstado({ prisma, instancia, numero, lead, tenantId, vendedor, datosNuevos, texto })
    return
  }

  if (Object.keys(datosNuevos).length > 0) {
    const datosLimpios = { ultimoTimestamp: new Date() }
    if (datosNuevos.nombre)       datosLimpios.nombre       = datosNuevos.nombre
    if (datosNuevos.producto)     datosLimpios.producto     = datosNuevos.producto
    if (datosNuevos.tipo)         datosLimpios.tipo         = datosNuevos.tipo
    if (datosNuevos.tipoPreciso)  datosLimpios.tipoPreciso  = datosNuevos.tipoPreciso
    if (datosNuevos.scoreTotal)   datosLimpios.scoreTotal   = datosNuevos.scoreTotal
    if (datosNuevos.scoreB)       datosLimpios.scoreB       = datosNuevos.scoreB
    if (datosNuevos.scoreA)       datosLimpios.scoreA       = datosNuevos.scoreA
    if (datosNuevos.prioridad)    datosLimpios.prioridad    = datosNuevos.prioridad
    if (datosNuevos.clasificadoPorIA !== undefined) datosLimpios.clasificadoPorIA = datosNuevos.clasificadoPorIA
    try {
      lead = await prisma.lead.update({ where: { id: lead.id }, data: datosLimpios })
    } catch (err) {
      console.error('[Motor] Error actualizando lead:', err.message)
    }
  }

  await ejecutarEstado({ prisma, instancia, numero, lead, tenantId, vendedor, datosNuevos, texto })
}

// ================================================================
// EJECUTAR ESTADO
// ================================================================

async function ejecutarEstado({ prisma, instancia, numero, lead, tenantId, vendedor, datosNuevos, texto }) {
  try {
    const config = await getBotConfig(prisma, tenantId)
    const estado = lead.estadoBot

    switch (estado) {

      case 'BIENVENIDA': {
        const msgBienvenida = config?.msgBienvenida ||
          `Hola te saluda *Peru Exporta TV*\n\nNo necesitas tener producto propio para exportar — necesitas saber como.\n\n`

        await enviarTexto(instancia, numero, msgBienvenida)
        await sleep(1500)

        const falta = datosFaltantes(lead)

        if (falta.length === 0) {
          // Tiene todo — siempre pasa por EXPERIENCIA antes de PRESENTACION
          await avanzarEstado(prisma, lead, 'EXPERIENCIA')
          lead.estadoBot = 'EXPERIENCIA'
          await ejecutarEstado({ prisma, instancia, numero, lead, tenantId, vendedor, datosNuevos, texto })
          return
        }

        const pregunta = construirPreguntaFaltante(falta, lead.nombre)
        if (pregunta) {
          await enviarTexto(instancia, numero, pregunta)
          await guardarMensaje(prisma, {
            leadId: lead.id, tenantId, vendedorId: vendedor.id,
            direccion: 'SALIENTE', contenido: msgBienvenida + '\n' + pregunta,
            estadoBot: 'BIENVENIDA'
          })
        }

        await avanzarEstado(prisma, lead, 'PRODUCTO')
        break
      }

      case 'PRODUCTO': {
        const falta = datosFaltantes(lead)

        if (falta.length === 0) {
          await avanzarEstado(prisma, lead, 'EXPERIENCIA')
          lead.estadoBot = 'EXPERIENCIA'
          await ejecutarEstado({ prisma, instancia, numero, lead, tenantId, vendedor, datosNuevos, texto })
          return
        }

        const pregunta = construirPreguntaFaltante(falta, lead.nombre)
        if (pregunta) {
          await sleep(1000)
          await enviarTexto(instancia, numero, pregunta)
          await guardarMensaje(prisma, {
            leadId: lead.id, tenantId, vendedorId: vendedor.id,
            direccion: 'SALIENTE', contenido: pregunta, estadoBot: 'PRODUCTO'
          })
        }
        break
      }

      case 'EXPERIENCIA': {
        // Solo interpretar respuesta si ya se envió la pregunta
        const msgsSalientes = await prisma.mensaje.count({
          where: { leadId: lead.id, direccion: 'SALIENTE', estadoBot: 'EXPERIENCIA' }
        })
        const yaRecibioPregunta = msgsSalientes > 0

        const n = norm(texto).trim()

        const yaExporto = yaRecibioPregunta && (
          n === '1' ||
          contieneAlguna(texto, ['ya exporte', 'ya exporto', 'tengo experiencia',
            'si he exportado', 'exporto actualmente', 'exporte antes', 'opcion 1', 'numero 1'])
        )

        const desdesCero = yaRecibioPregunta && (
          n === '2' ||
          contieneAlguna(texto, ['desde cero', 'sin experiencia', 'no he exportado',
            'nunca he exportado', 'primera vez', 'recien empezando',
            'no tengo experiencia', 'opcion 2', 'numero 2'])
        )

        if (yaExporto || desdesCero) {
          await avanzarEstado(prisma, lead, 'PRESENTACION')
          lead.estadoBot = 'PRESENTACION'
          await ejecutarEstado({ prisma, instancia, numero, lead, tenantId, vendedor, datosNuevos, texto })
          return
        }

        const nombre = lead.nombre || ''
        const msg = config?.msgExperiencia ||
          `${nombre ? nombre + ', ' : ''}ya tienes experiencia exportando o vas desde cero?\n\n1 Ya exporte antes\n2 Voy desde cero`

        await sleep(1000)
        await enviarTexto(instancia, numero, msg)
        await guardarMensaje(prisma, {
          leadId: lead.id, tenantId, vendedorId: vendedor.id,
          direccion: 'SALIENTE', contenido: msg, estadoBot: 'EXPERIENCIA'
        })
        break
      }

      case 'PRESENTACION': {
        const nombre = lead.nombre || ''
        const producto = lead.producto || 'tu producto'
        const tipo = lead.tipo || 'A'

        let msgProducto
        if (tipo === 'B') {
          msgProducto = config?.msgProductoB ||
            `Perfecto ${nombre}! Con *${producto}* tienes mucho potencial.\n\n` +
            `Curso: CONTACTA COMPRADORES INTERNACIONALES\n` +
            `2 sesiones por semana — Zoom (grabadas)\n` +
            `Precio regular: S/ 1,857\n` +
            `Precio anticipado: S/ 957\n\n` +
            `El objetivo: que contactes compradores reales en 2 meses.`
        } else {
          msgProducto = config?.msgProductoA ||
            `Perfecto ${nombre}!\n\n` +
            `Curso Taller: MI PRIMERA EXPORTACION\n` +
            `Sabados — Zoom (grabadas)\n` +
            `Precio regular: S/ 757\n` +
            `Precio preventa: S/ 497\n\n` +
            `Aprenderas a hacer tus primeras exportaciones con inversion minima.`
        }

        await sleep(1500)
        await enviarTexto(instancia, numero, msgProducto)
        await guardarMensaje(prisma, {
          leadId: lead.id, tenantId, vendedorId: vendedor.id,
          direccion: 'SALIENTE', contenido: msgProducto, estadoBot: 'PRESENTACION'
        })

        await sleep(2000)
        const msgCierre = `Tienes alguna pregunta o te gustaria inscribirte?`
        await enviarTexto(instancia, numero, msgCierre)

        await avanzarEstado(prisma, lead, 'OBJECION')
        break
      }

      case 'OBJECION': {
        if (contieneAlguna(texto, KEYWORDS_INTERES_CONFIRMADO)) {
          await escalarAHandoff({ prisma, instancia, numero, lead, tenantId, vendedor, motivo: 'interes_confirmado' })
          return
        }

        // "si" solo en OBJECION significa interés si viene solo o con pocas palabras
        const textoNorm = norm(texto).trim()
        if (textoNorm === 'si' || textoNorm === 'si quiero' || textoNorm === 'si me interesa') {
          await escalarAHandoff({ prisma, instancia, numero, lead, tenantId, vendedor, motivo: 'interes_confirmado' })
          return
        }

        const objeta = contieneAlguna(texto, KEYWORDS_PRECIO)

        const msgObjecion = config?.msgObjecion ||
          (objeta
            ? `Entiendo! Por eso tenemos facilidades de pago.\n\n` +
              `En 2 cuotas sin intereses:\n` +
              `Primera: S/ 257 hoy\n` +
              `Segunda: S/ 240 en 2 semanas\n\n` +
              `Te funciona esa opcion?`
            : `Tienes alguna duda sobre el programa? Cuentame, estoy aqui para ayudarte`)

        await sleep(1000)
        await enviarTexto(instancia, numero, msgObjecion)
        await guardarMensaje(prisma, {
          leadId: lead.id, tenantId, vendedorId: vendedor.id,
          direccion: 'SALIENTE', contenido: msgObjecion, estadoBot: 'OBJECION'
        })

        await avanzarEstado(prisma, lead, 'URGENCIA')
        break
      }

      case 'URGENCIA': {
        if (contieneAlguna(texto, KEYWORDS_INTERES_CONFIRMADO)) {
          await escalarAHandoff({ prisma, instancia, numero, lead, tenantId, vendedor, motivo: 'interes_confirmado' })
          return
        }

        const textoNorm = norm(texto).trim()
        if (textoNorm === 'si' || textoNorm === 'promo' || textoNorm === 'si quiero') {
          await escalarAHandoff({ prisma, instancia, numero, lead, tenantId, vendedor, motivo: 'interes_confirmado' })
          return
        }

        const msgUrgencia = config?.msgUrgencia ||
          `Solo por hoy activamos un bono especial de S/ 40 de descuento.\n\n` +
          `Escribe PROMO si quieres tomarlo\n\n` +
          `(La oferta vence hoy a medianoche)`

        await sleep(1000)
        await enviarTexto(instancia, numero, msgUrgencia)
        await guardarMensaje(prisma, {
          leadId: lead.id, tenantId, vendedorId: vendedor.id,
          direccion: 'SALIENTE', contenido: msgUrgencia, estadoBot: 'URGENCIA'
        })

        await avanzarEstado(prisma, lead, 'HANDOFF')
        break
      }

      case 'HANDOFF': {
        const minutosDesdeHandoff = lead.handoffEn
          ? Math.floor((Date.now() - new Date(lead.handoffEn).getTime()) / 60000)
          : 999

        // Escalar si el lead lleva 2+ mensajes sin atención
        const mensajesPostHandoff = await prisma.mensaje.count({
          where: {
            leadId: lead.id,
            direccion: 'ENTRANTE',
            enviadoEn: { gte: lead.handoffEn || new Date() }
          }
        })
        if (mensajesPostHandoff >= 2) {
          await renotificarVendedor({
            prisma, instancia, lead, vendedor,
            motivo: `LEAD PERDIENDO PACIENCIA — ${mensajesPostHandoff} mensajes sin atencion\nLleva ${minutosDesdeHandoff} min esperando`
          })
        }

        // Casuística 1: Perdió interés
        if (contieneAlguna(texto, KEYWORDS_PERDIO_INTERES)) {
          await prisma.lead.update({
            where: { id: lead.id },
            data: { resultado: 'perdido', ultimoTimestamp: new Date() }
          })
          const msg = `Entendido! No hay problema. Si en algun momento quieres retomar, aqui estaremos.\n\nMucho exito!`
          await enviarTexto(instancia, numero, msg)
          await guardarMensaje(prisma, { leadId: lead.id, tenantId, vendedorId: vendedor.id, direccion: 'SALIENTE', contenido: msg, estadoBot: 'HANDOFF' })
          break
        }

        // Casuística 2: Agenda hora
        if (contieneAlguna(texto, KEYWORDS_HORA)) {
          await prisma.lead.update({
            where: { id: lead.id },
            data: { resultado: `hora_solicitada: ${texto.slice(0, 100)}`, ultimoTimestamp: new Date() }
          })
          const msg = `Perfecto! Le aviso a tu asesor que te llame en ese horario.\n\nEstate pendiente al telefono!`
          await enviarTexto(instancia, numero, msg)
          await guardarMensaje(prisma, { leadId: lead.id, tenantId, vendedorId: vendedor.id, direccion: 'SALIENTE', contenido: msg, estadoBot: 'HANDOFF' })
          await renotificarVendedor({ prisma, instancia, lead, vendedor, motivo: `El lead pidio que lo llamen: "${texto.slice(0, 80)}"` })
          break
        }

        // Casuística 3: Reclama que no lo llamaron
        if (contieneAlguna(texto, KEYWORDS_RECLAMO)) {
          const msg = `Mil disculpas! Eso no deberia pasar.\n\nYa le mande una alerta urgente a tu asesor — te llama en los proximos minutos.\n\nGracias por tu paciencia!`
          await enviarTexto(instancia, numero, msg)
          await guardarMensaje(prisma, { leadId: lead.id, tenantId, vendedorId: vendedor.id, direccion: 'SALIENTE', contenido: msg, estadoBot: 'HANDOFF' })
          await renotificarVendedor({ prisma, instancia, lead, vendedor, motivo: `URGENTE — El lead reclama que nadie lo llamo: "${texto.slice(0, 80)}"` })
          break
        }

        // Casuística 4: Reconfirma interés
        if (contieneAlguna(texto, KEYWORDS_INTERES_CONFIRMADO)) {
          await renotificarVendedor({ prisma, instancia, lead, vendedor, motivo: `Lead reconfirmo interes: "${texto.slice(0, 80)}"` })
          const msg = `Perfecto! Ya avise a tu asesor — te llama muy pronto.\n\nEstate atento!`
          await enviarTexto(instancia, numero, msg)
          await guardarMensaje(prisma, { leadId: lead.id, tenantId, vendedorId: vendedor.id, direccion: 'SALIENTE', contenido: msg, estadoBot: 'HANDOFF' })
          break
        }

        // Casuística 5: Pregunta precio
        if (contieneAlguna(texto, KEYWORDS_PRECIO)) {
          const msg =
            `El precio del programa es S/ 497 en preventa\n\n` +
            `Tambien puedes pagarlo en 2 cuotas:\n` +
            `Primera: S/ 257 hoy\n` +
            `Segunda: S/ 240 en 2 semanas\n\n` +
            `Tu asesor te dara todos los detalles cuando te llame`
          await enviarTexto(instancia, numero, msg)
          await guardarMensaje(prisma, { leadId: lead.id, tenantId, vendedorId: vendedor.id, direccion: 'SALIENTE', contenido: msg, estadoBot: 'HANDOFF' })
          break
        }

        // Default: según tiempo transcurrido
        let msgDefault
        let debeRenotificar = false

        if (minutosDesdeHandoff < 30) {
          msgDefault = `Tu asesor ya esta al tanto y te llama en breve!\n\nEstate pendiente al telefono!`
        } else if (minutosDesdeHandoff < 120) {
          msgDefault = `Disculpa la espera! Ya le recorde a tu asesor — te contacta hoy mismo.\n\nSi prefieres, dime a que hora te viene mejor y coordino`
          debeRenotificar = true
        } else if (minutosDesdeHandoff < 1440) {
          msgDefault = `Lamentamos la demora! Ya escale tu caso como URGENTE — un asesor te llama hoy.\n\nA que hora te viene mejor?`
          debeRenotificar = true
        } else {
          msgDefault = `Hola de nuevo! Nos alegra que vuelvas.\n\nTenemos el programa Exporta con 1,000 Soles disponible ahora mismo.\n\nSigues interesado/a?`
          await avanzarEstado(prisma, lead, 'PRESENTACION')
          debeRenotificar = true
        }

        await enviarTexto(instancia, numero, msgDefault)
        await guardarMensaje(prisma, { leadId: lead.id, tenantId, vendedorId: vendedor.id, direccion: 'SALIENTE', contenido: msgDefault, estadoBot: 'HANDOFF' })

        if (debeRenotificar) {
          await renotificarVendedor({ prisma, instancia, lead, vendedor, motivo: `Lead inactivo ${minutosDesdeHandoff}min volvio a escribir: "${texto.slice(0, 80)}"` })
        }
        break
      }
    }
  } catch (err) {
    console.error(`[Motor] ERROR en estado ${lead?.estadoBot}:`, err.message)
    console.error(err.stack)
  }
}
