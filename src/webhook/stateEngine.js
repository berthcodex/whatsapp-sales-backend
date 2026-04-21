// src/webhook/stateEngine.js
// ================================================================
// HIDATA — Motor de Estados Conversacional
// Sprint 1 — 20 Abril 2026
//
// ARQUITECTURA:
// Este archivo es el CEREBRO del bot. Decide qué hacer en cada
// momento basándose en 3 cosas:
//   1. En qué estado está el lead (EstadoBot)
//   2. Qué datos ya tenemos del lead
//   3. Qué dijo el lead ahora mismo
//
// El classifier.js es la HERRAMIENTA que usa este motor.
// El handler.js llama a este motor — ya no tiene lógica propia.
//
// FLUJO DE ESTADOS:
// BIENVENIDA → PRODUCTO → EXPERIENCIA → PRESENTACION
//                                           ↓
//                              OBJECION ← (silencio/precio)
//                                  ↓
//                             URGENCIA → HANDOFF
// ================================================================

import {
  extraerNombre,
  extraerProducto,
  clasificarConScoring,
  clasificarConIA,
  detectarCursoCampana
} from './classifier.js'

import { enviarTexto } from '../whatsapp/sender.js'

// ================================================================
// KEYWORDS — detección de intención sin IA
// ================================================================

// Señales de que el lead quiere hablar con humano YA
const KEYWORDS_HANDOFF_INMEDIATO = [
  'hablar con', 'hablar a', 'me llamen', 'llamarme', 'llamame',
  'asesor', 'vendedor', 'persona', 'humano', 'quiero hablar',
  'precio final', 'descuento', 'oferta', 'promocion', 'promo'
]

// Señales de que ya tiene producto / es Tipo B
const KEYWORDS_TIENE_PRODUCTO = [
  'tengo', 'produzco', 'cosecho', 'siembro', 'vendo', 'trabajo con',
  'mi empresa', 'mi negocio', 'somos', 'exportamos', 'fabricamos',
  'elaboramos', 'criamos', 'cultivo', 'cultiva', 'parcela', 'chacra',
  'hectarea', 'cooperativa', 'asociacion'
]

// Señales de que está explorando / es Tipo A
const KEYWORDS_EXPLORANDO = [
  'empezando', 'empezar', 'desde cero', 'sin experiencia',
  'no se', 'no sé', 'aprender', 'curiosidad', 'explorar',
  'informacion', 'información', 'interesado', 'interesada',
  'quiero saber', 'primer', 'primera vez', 'nunca he'
]

// Señales de objeción por precio
const KEYWORDS_PRECIO = [
  'caro', 'precio', 'cuesta', 'cuánto', 'cuanto', 'costo',
  'barato', 'descuento', 'rebaja', 'oferta', 'no tengo',
  'no puedo', 'complicado', 'difícil', 'dificil', 'lo pienso',
  'pensarlo', 'consultarlo', 'después', 'luego', 'más adelante'
]

// Señales de interés confirmado → listo para handoff
const KEYWORDS_INTERES_CONFIRMADO = [
  'me interesa', 'si quiero', 'sí quiero', 'quiero inscribirme',
  'como me inscribo', 'cómo me inscribo', 'quiero participar',
  'cuándo empieza', 'cuando empieza', 'me anoto', 'me apunto',
  'voy a inscribirme', 'quiero el curso', 'quiero el programa',
  'si', 'sí', 'dale', 'listo', 'acepto', 'de acuerdo', 'ok'
]

// ================================================================
// NORMALIZACIÓN
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

// ================================================================
// EXTRACCIÓN INTELIGENTE DE DATOS
// Analiza el mensaje y extrae TODO lo que pueda de una vez.
// No hace preguntas redundantes sobre lo que ya sabe.
// ================================================================
async function extraerDatosDelMensaje(texto, leadActual) {
  const datos = {}

  // Nombre — solo si no lo tenemos
  if (!leadActual.nombre) {
    const nombre = extraerNombre(texto)
    if (nombre) datos.nombre = nombre
  }

  // Producto — solo si no lo tenemos
  if (!leadActual.producto) {
    const producto = extraerProducto(texto)
    if (producto) datos.producto = producto
  }

  // Tipo (A/B) — solo si no está clasificado con confianza
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
    } else if (scoring.confianza === 'baja') {
      // Keywords simples como fallback antes de llamar a Groq
      if (contieneAlguna(texto, KEYWORDS_TIENE_PRODUCTO)) {
        datos.tipo = 'B'
        datos.tipoPreciso = 'Tipo B — broker'
        datos.prioridad = 'ALTA'
        datos.confianza = 'media'
      } else if (contieneAlguna(texto, KEYWORDS_EXPLORANDO)) {
        datos.tipo = 'A'
        datos.tipoPreciso = 'Tipo A — formación'
        datos.prioridad = 'MEDIA'
        datos.confianza = 'media'
      } else {
        // Último recurso: Groq
        try {
          const ia = await clasificarConIA(texto)
          datos.tipo = ia.tipo
          datos.tipoPreciso = ia.tipoPreciso
          datos.prioridad = ia.prioridad
          datos.confianza = 'media'
          datos.clasificadoPorIA = true
        } catch {
          // Groq falló → default A, el sistema sigue
        }
      }
    }
  }

  return datos
}

// ================================================================
// DATOS FALTANTES
// Dice exactamente qué le falta al lead para avanzar de estado
// ================================================================
function datosFaltantes(lead) {
  const falta = []
  if (!lead.nombre) falta.push('nombre')
  if (!lead.producto) falta.push('producto')
  if (!lead.tipo) falta.push('tipo')
  return falta
}

// ================================================================
// MENSAJE INTELIGENTE DE PREGUNTA
// Solo pregunta lo que no sabe — nunca repite lo que ya sabe
// ================================================================
function construirPreguntaFaltante(falta, nombre) {
  const saludo = nombre ? `${nombre}, ` : ''

  if (falta.includes('nombre') && falta.includes('producto')) {
    return `¿Cómo te llamas y qué producto tienes en mente para exportar? 👇`
  }

  if (falta.includes('nombre') && falta.includes('tipo')) {
    return `¿Cómo te llamas? Y cuéntame, ¿ya tienes un producto o estás explorando la idea? 👇`
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
// OBTENER BOT CONFIG ACTIVA
// ================================================================
async function getBotConfig(prisma, tenantId) {
  try {
    return await prisma.botConfig.findFirst({
      where: { tenantId, activo: true }
    })
  } catch {
    return null
  }
}

// ================================================================
// SLEEP
// ================================================================
const sleep = ms => new Promise(r => setTimeout(r, ms))

// ================================================================
// NOTIFICAR VENDEDOR — alerta cuando lead llega a HANDOFF
// ================================================================
async function notificarVendedor({ prisma, instancia, lead, vendedor }) {
  try {
    // Buscar número del vendedor desde la DB
    const v = await prisma.vendedor.findUnique({
      where: { id: vendedor.id }
    })
    if (!v?.whatsappNumber) return

    const tiempoEnSistema = lead.creadoEn
      ? Math.floor((Date.now() - new Date(lead.creadoEn).getTime()) / 60000)
      : null
    const tiempoStr = tiempoEnSistema !== null
      ? tiempoEnSistema < 60
        ? `${tiempoEnSistema} min`
        : `${Math.floor(tiempoEnSistema / 60)}h ${tiempoEnSistema % 60}m`
      : ''
    const primerMsg = lead.primerMensaje
      ? `"${lead.primerMensaje.slice(0, 80)}${lead.primerMensaje.length > 80 ? '...' : ''}"`
      : null
    const msg =
      `🔥 *LEAD CALIENTE — LISTO PARA LLAMAR*\n\n` +
      `👤 *Nombre:* ${lead.nombre || 'Sin nombre'}\n` +
      `📱 *Número:* ${lead.numero}\n` +
      `📦 *Producto:* ${lead.producto || 'Sin producto'}\n` +
      `🎯 *Perfil:* ${lead.tipoPreciso || lead.tipo}\n` +
      `⚡ *Prioridad:* ${lead.prioridad}\n` +
      (tiempoStr ? `⏱ *En sistema:* ${tiempoStr}\n` : '') +
      (primerMsg ? `💬 *Dijo:* ${primerMsg}\n` : '') +
      `\n📞 *¡Llama ahora antes de que se enfríe!*`

    await enviarTexto(instancia, v.whatsappNumber, msg)
  } catch (err) {
    console.error('[StateEngine] Error notificando vendedor:', err.message)
  }
}

// ================================================================
// GUARDAR MENSAJE EN DB
// ================================================================
async function guardarMensaje(prisma, { leadId, tenantId, vendedorId, direccion, contenido, estadoBot }) {
  try {
    await prisma.mensaje.create({
      data: {
        leadId,
        tenantId,
        vendedorId: vendedorId || null,
        direccion,
        contenido,
        estadoBot,
        tipo: 'texto'
      }
    })
  } catch (err) {
    console.error('[StateEngine] Error guardando mensaje:', err.message)
  }
}

// ================================================================
// MOTOR PRINCIPAL
// Punto de entrada único — handler.js solo llama esto
// ================================================================
export async function procesarConMotor({
  prisma,
  instancia,
  numero,
  texto,
  tieneImagen,
  vendedor
}) {
  const { id: vendedorId, tenantId } = vendedor

  console.log(`[Motor] Procesando: ${numero} | Texto: "${texto}"`)

  // ── 1. BUSCAR LEAD EXISTENTE (deduplicación por tenant) ───────
  let lead = await prisma.lead.findFirst({
    where: { numero, tenantId }
  })
  console.log(`[Motor] Lead encontrado: ${lead ? lead.estadoBot : 'NUEVO'}`)

  // ── 2. GUARDAR MENSAJE ENTRANTE ───────────────────────────────
  if (lead) {
    await guardarMensaje(prisma, {
      leadId: lead.id,
      tenantId,
      vendedorId,
      direccion: 'ENTRANTE',
      contenido: texto,
      estadoBot: lead.estadoBot
    })
  }

  // ── 3. IMAGEN = posible pago ──────────────────────────────────
  if (tieneImagen && lead) {
    await manejarPosiblePago({ prisma, instancia, numero, lead, tenantId, vendedor })
    return
  }

  console.log(`[Motor] TenantId: ${tenantId} | VendedorId: ${vendedorId}`)

  // ── 4. HANDOFF INMEDIATO por keyword ─────────────────────────
  if (lead && contieneAlguna(texto, KEYWORDS_HANDOFF_INMEDIATO)) {
    if (lead.estadoBot !== 'HANDOFF') {
      await escalarAHandoff({ prisma, instancia, numero, lead, tenantId, vendedor, motivo: 'keyword_handoff' })
    }
    return
  }

  // ── 5. EXTRAER DATOS DEL MENSAJE ─────────────────────────────
  const datosNuevos = await extraerDatosDelMensaje(texto, lead || {})

  // ── 6. LEAD NUEVO ─────────────────────────────────────────────
  if (!lead) {
    // Detectar si el primer mensaje menciona un curso de campaña.
    // Esto diferencia al lead de Ad (ya sabe qué quiere) del orgánico.
    const cursoCampana = detectarCursoCampana(texto)

    // Si viene de campaña, prefijar el tipo según el curso detectado.
    // El curso A → tipo A (formación). El curso B → tipo B (operador).
    if (cursoCampana && !datosNuevos.tipo) {
      datosNuevos.tipo = cursoCampana.curso
      datosNuevos.tipoPreciso = cursoCampana.curso === 'B'
        ? 'Tipo B — broker'
        : 'Tipo A — formación'
      datosNuevos.prioridad = 'ALTA'
      datosNuevos.confianza = 'alta'
    }

    lead = await prisma.lead.create({
      data: {
        tenantId,
        vendedorId,
        numero,
        nombre:          datosNuevos.nombre || null,
        producto:        datosNuevos.producto || null,
        tipo:            datosNuevos.tipo || 'A',
        tipoPreciso:     datosNuevos.tipoPreciso || 'Tipo A — formación',
        scoreTotal:      datosNuevos.scoreTotal || 0,
        scoreB:          datosNuevos.scoreB || 0,
        scoreA:          datosNuevos.scoreA || 0,
        clasificadoPorIA: datosNuevos.clasificadoPorIA || false,
        prioridad:       datosNuevos.prioridad || 'MEDIA',
        // Si detectamos curso de campaña → arrancamos en PRESENTACION directo
        estadoBot:       cursoCampana ? 'PRESENTACION' : 'BIENVENIDA',
        primerMensaje:   texto,
        ultimoTimestamp: new Date()
      }
    })

    await guardarMensaje(prisma, {
      leadId: lead.id,
      tenantId,
      vendedorId,
      direccion: 'ENTRANTE',
      contenido: texto,
      estadoBot: 'BIENVENIDA'
    })

    await ejecutarEstado({ prisma, instancia, numero, lead, tenantId, vendedor, datosNuevos, texto })
    return
  }

  // ── 7. LEAD EXISTENTE — actualizar datos si hay nuevos ────────
  // Solo pasar campos que existen en el schema de Prisma
  if (Object.keys(datosNuevos).length > 0) {
    const datosLimpios = {}
    if (datosNuevos.nombre)       datosLimpios.nombre       = datosNuevos.nombre
    if (datosNuevos.producto)     datosLimpios.producto     = datosNuevos.producto
    if (datosNuevos.tipo)         datosLimpios.tipo         = datosNuevos.tipo
    if (datosNuevos.tipoPreciso)  datosLimpios.tipoPreciso  = datosNuevos.tipoPreciso
    if (datosNuevos.scoreTotal)   datosLimpios.scoreTotal   = datosNuevos.scoreTotal
    if (datosNuevos.scoreB)       datosLimpios.scoreB       = datosNuevos.scoreB
    if (datosNuevos.scoreA)       datosLimpios.scoreA       = datosNuevos.scoreA
    if (datosNuevos.prioridad)    datosLimpios.prioridad    = datosNuevos.prioridad
    if (datosNuevos.clasificadoPorIA !== undefined) datosLimpios.clasificadoPorIA = datosNuevos.clasificadoPorIA
    datosLimpios.ultimoTimestamp = new Date()
    console.log(`[Motor] Actualizando lead con:`, JSON.stringify(datosLimpios))
    try {
      lead = await prisma.lead.update({
        where: { id: lead.id },
        data: datosLimpios
      })
    } catch (err) {
      console.error('[Motor] Error actualizando lead:', err.message)
    }
  }

  // ── 8. EJECUTAR LÓGICA DEL ESTADO ACTUAL ─────────────────────
  console.log(`[Motor] Llamando ejecutarEstado — estado: ${lead.estadoBot}`)
  await ejecutarEstado({ prisma, instancia, numero, lead, tenantId, vendedor, datosNuevos, texto })
}

// ================================================================
// EJECUTAR ESTADO
// Decide qué hacer según el estado actual del lead
// ================================================================
async function ejecutarEstado({ prisma, instancia, numero, lead, tenantId, vendedor, datosNuevos, texto }) {
  console.log(`[Motor] ejecutarEstado — estado: ${lead.estadoBot} | número: ${numero}`)
  try {
  const config = await getBotConfig(prisma, tenantId)
  const estado = lead.estadoBot

  switch (estado) {

    // ──────────────────────────────────────────────────────────
    case 'BIENVENIDA': {
      // Mensaje de bienvenida
      const msgBienvenida = config?.msgBienvenida ||
        `Hola 🙋 te saluda *Perú Exporta TV* 🇵🇪\n\nNo necesitas tener producto propio para exportar — necesitas saber cómo.\n\n`

      await enviarTexto(instancia, numero, msgBienvenida)
      await sleep(1500)

      // Revisar si ya tenemos suficiente del primer mensaje
      const falta = datosFaltantes(lead)

      if (falta.length === 0) {
        // Tenemos nombre, producto y tipo — pero SIEMPRE preguntamos experiencia.
        // La experiencia no la puede inferir el classifier — es una respuesta
        // del lead que el vendedor necesita para preparar la llamada.
        // Nunca saltamos de BIENVENIDA directo a PRESENTACION.
        await avanzarEstado(prisma, lead, 'EXPERIENCIA')
        lead.estadoBot = 'EXPERIENCIA'
        await ejecutarEstado({ prisma, instancia, numero, lead, tenantId, vendedor, datosNuevos, texto })
        return
      }

      // Preguntar solo lo que falta
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

    // ──────────────────────────────────────────────────────────
    case 'PRODUCTO': {
      const falta = datosFaltantes(lead)

      if (falta.length === 0) {
        // Tenemos nombre, producto y tipo → ir a EXPERIENCIA siempre
        // Nunca saltar a PRESENTACION desde aquí
        await avanzarEstado(prisma, lead, 'EXPERIENCIA')
        lead.estadoBot = 'EXPERIENCIA'
        await ejecutarEstado({ prisma, instancia, numero, lead, tenantId, vendedor, datosNuevos, texto })
        return
      }

      // Solo preguntar lo que falta
      const pregunta = construirPreguntaFaltante(falta, lead.nombre)
      if (pregunta) {
        await sleep(1000)
        await enviarTexto(instancia, numero, pregunta)
        await guardarMensaje(prisma, {
          leadId: lead.id, tenantId, vendedorId: vendedor.id,
          direccion: 'SALIENTE', contenido: pregunta,
          estadoBot: 'PRODUCTO'
        })
      }
      break
    }

    // ──────────────────────────────────────────────────────────
    case 'EXPERIENCIA': {
      // En este estado ya tenemos nombre y producto.
      // Solo falta confirmar si ya exportó antes.
      const yaExporto = contieneAlguna(texto, [
        'ya exporté', 'ya exporto', 'tengo experiencia', 'si he exportado',
        'exporto actualmente', 'ya exporté antes', 'exporté antes',
        '1️⃣', 'opcion 1', 'opción 1', 'numero 1', 'número 1'
      ]) || norm(texto).trim() === '1'
      const desdesCero = contieneAlguna(texto, [
        ...KEYWORDS_EXPLORANDO,
        '2️⃣', 'opcion 2', 'opción 2', 'numero 2', 'número 2'
      ]) || norm(texto).trim() === '2'

      if (yaExporto || desdesCero) {
        // El lead respondió explícitamente sobre su experiencia → ir a PRESENTACION
        await avanzarEstado(prisma, lead, 'PRESENTACION')
        lead.estadoBot = 'PRESENTACION'
        await ejecutarEstado({ prisma, instancia, numero, lead, tenantId, vendedor, datosNuevos, texto })
        return
      }

      // Siempre preguntar experiencia — el classifier no puede saberlo
      // El vendedor necesita esta información para preparar la llamada
      const nombre = lead.nombre ? `${lead.nombre}` : ''
      const msg = config?.msgExperiencia ||
        `${nombre ? nombre + ', ' : ''}¿ya tienes experiencia exportando o vas desde cero? 👇\n\n1️⃣ Ya exporté antes\n2️⃣ Voy desde cero`

      await sleep(1000)
      await enviarTexto(instancia, numero, msg)
      await guardarMensaje(prisma, {
        leadId: lead.id, tenantId, vendedorId: vendedor.id,
        direccion: 'SALIENTE', contenido: msg,
        estadoBot: 'EXPERIENCIA'
      })
      break
    }

    // ──────────────────────────────────────────────────────────
    case 'PRESENTACION': {
      const nombre = lead.nombre || ''
      const producto = lead.producto || 'tu producto'
      const tipo = lead.tipo || 'A'

      // Seleccionar curso según tipo
      let msgProducto
      if (tipo === 'B') {
        msgProducto = config?.msgProducto ||
          `Perfecto ${nombre} 🙌 Con *${producto}* tienes mucho potencial.\n\n` +
          `👉 *Curso: CONTACTA COMPRADORES INTERNACIONALES*\n` +
          `📆 Inicio: próxima convocatoria\n` +
          `⏰ 2 sesiones/semana — Zoom (grabadas)\n` +
          `💰 Precio regular: S/ 1,857\n` +
          `🔥 Precio anticipado: S/ 957\n\n` +
          `El objetivo: que contactes compradores reales en 2 meses. 🌍`
      } else {
        msgProducto = config?.msgProducto ||
          `Perfecto ${nombre} 🙌\n\n` +
          `👉 *Curso Taller: EXPORTA CON 1,000 SOLES* 🌍\n` +
          `📆 Sábados — Zoom (grabadas)\n` +
          `💰 Precio regular: S/ 757\n` +
          `🔥 Precio preventa: S/ 497\n\n` +
          `Aprenderás a hacer tus primeras exportaciones con inversión mínima. 🚀`
      }

      await sleep(1500)
      await enviarTexto(instancia, numero, msgProducto)
      await guardarMensaje(prisma, {
        leadId: lead.id, tenantId, vendedorId: vendedor.id,
        direccion: 'SALIENTE', contenido: msgProducto,
        estadoBot: 'PRESENTACION'
      })

      await sleep(2000)

      // Pregunta de cierre suave
      const msgCierre = `¿Tienes alguna pregunta o te gustaría inscribirte? 👇`
      await enviarTexto(instancia, numero, msgCierre)

      await avanzarEstado(prisma, lead, 'OBJECION')
      break
    }

    // ──────────────────────────────────────────────────────────
    case 'OBJECION': {
      // ¿El lead muestra interés confirmado?
      if (contieneAlguna(texto, KEYWORDS_INTERES_CONFIRMADO)) {
        await escalarAHandoff({ prisma, instancia, numero, lead, tenantId, vendedor, motivo: 'interes_confirmado' })
        return
      }

      // ¿El lead objeta por precio?
      const objeta = contieneAlguna(texto, KEYWORDS_PRECIO)

      const msgObjecion = config?.msgObjecion ||
        (objeta
          ? `Entiendo 🙏 Por eso tenemos facilidades de pago.\n\n` +
            `💳 *En 2 cuotas sin intereses:*\n` +
            `Primera: S/ 257 hoy\n` +
            `Segunda: S/ 240 en 2 semanas\n\n` +
            `¿Te funciona esa opción? 👇`
          : `¿Tienes alguna duda sobre el programa? Cuéntame, estoy aquí para ayudarte 🙋`)

      await sleep(1000)
      await enviarTexto(instancia, numero, msgObjecion)
      await guardarMensaje(prisma, {
        leadId: lead.id, tenantId, vendedorId: vendedor.id,
        direccion: 'SALIENTE', contenido: msgObjecion,
        estadoBot: 'OBJECION'
      })

      await avanzarEstado(prisma, lead, 'URGENCIA')
      break
    }

    // ──────────────────────────────────────────────────────────
    case 'URGENCIA': {
      if (contieneAlguna(texto, KEYWORDS_INTERES_CONFIRMADO)) {
        await escalarAHandoff({ prisma, instancia, numero, lead, tenantId, vendedor, motivo: 'interes_confirmado' })
        return
      }

      const msgUrgencia = config?.msgUrgencia ||
        `⏰ *Solo por hoy* se activó un bono especial de S/ 40 de descuento por tu inscripción.\n\n` +
        `Escribe *PROMO* si quieres tomarlo 🔥\n\n` +
        `(La oferta vence hoy a medianoche)`

      await sleep(1000)
      await enviarTexto(instancia, numero, msgUrgencia)
      await guardarMensaje(prisma, {
        leadId: lead.id, tenantId, vendedorId: vendedor.id,
        direccion: 'SALIENTE', contenido: msgUrgencia,
        estadoBot: 'URGENCIA'
      })

      await avanzarEstado(prisma, lead, 'HANDOFF')
      break
    }

    // ──────────────────────────────────────────────────────────
    case 'HANDOFF': {
      console.log(`[Motor] Entrando a HANDOFF — número: ${numero} | texto: "${texto}"`)
      console.log(`[Motor] handoffEn: ${lead.handoffEn} | minutosDesdeHandoff calculando...`)
      // ================================================================
      // HANDOFF INTELIGENTE — 6 casuísticas del lead que regresa
      //
      // El lead llegó a HANDOFF pero el vendedor no lo llamó todavía,
      // o lo llamó y el lead volvió a escribir. El bot no puede ignorar
      // estos mensajes — cada uno tiene una respuesta diferente.
      // ================================================================

      const minutosDesdeHandoff = lead.handoffEn
        ? Math.floor((Date.now() - new Date(lead.handoffEn).getTime()) / 60000)
        : 999
      console.log(`[Motor] minutosDesdeHandoff: ${minutosDesdeHandoff}`)

      // ── CASUÍSTICA 1: Lead manda voucher/imagen ───────────────────
      // Ya manejado antes en el flujo principal (tieneImagen)
      // No llega aquí — se intercepta antes.

      console.log(`[Motor] Evaluando casuísticas HANDOFF...`)
      // ── CASUÍSTICA 2: Lead perdió interés ─────────────────────────
      const KEYWORDS_PERDIO_INTERES = [
        'ya no', 'no me interesa', 'gracias igual', 'dejalo',
        'olvídalo', 'olvidalo', 'no gracias', 'cancel', 'no quiero'
      ]
      if (contieneAlguna(texto, KEYWORDS_PERDIO_INTERES)) {
        await prisma.lead.update({
          where: { id: lead.id },
          data: { resultado: 'perdido', ultimoTimestamp: new Date() }
        })
        const msg = `Entendido 🙏 No hay problema. Si en algún momento quieres retomar, aquí estaremos.

¡Mucho éxito! 🇵🇪`
        await enviarTexto(instancia, numero, msg)
        await guardarMensaje(prisma, {
          leadId: lead.id, tenantId, vendedorId: vendedor.id,
          direccion: 'SALIENTE', contenido: msg, estadoBot: 'HANDOFF'
        })
        break
      }

      // ── CASUÍSTICA 3: Lead agenda hora específica ─────────────────
      // Detecta horas como "8pm", "8:00pm", "las 3", "mañana", "tarde"
      const KEYWORDS_HORA = [
        'llámame a', 'llamame a', 'llama a las', 'a las', 'pm', 'am',
        'mañana', 'manana', 'tarde', 'noche', 'después', 'despues',
        'en la tarde', 'en la mañana', 'al rato', 'más tarde', 'mas tarde',
        'en un momento', 'ahora no', 'no ahora', 'ahorita no'
      ]
      if (contieneAlguna(texto, KEYWORDS_HORA)) {
        // Guardar la hora preferida en el resultado del lead
        await prisma.lead.update({
          where: { id: lead.id },
          data: {
            resultado: `hora_solicitada: ${texto.slice(0, 100)}`,
            ultimoTimestamp: new Date()
          }
        })
        // Confirmar al lead
        const msg = `Perfecto 👍 Le aviso a tu asesor que te llame en ese horario.

¡Estate pendiente al teléfono! 📲`
        await enviarTexto(instancia, numero, msg)
        await guardarMensaje(prisma, {
          leadId: lead.id, tenantId, vendedorId: vendedor.id,
          direccion: 'SALIENTE', contenido: msg, estadoBot: 'HANDOFF'
        })
        // Re-notificar al vendedor con la hora solicitada
        await renotificarVendedor({
          prisma, instancia, lead, vendedor,
          motivo: `⏰ El lead pidió que lo llamen: "${texto.slice(0, 80)}"`
        })
        break
      }

      // ── CASUÍSTICA 4: Lead reclama que no lo llamaron ─────────────
      const KEYWORDS_RECLAMO = [
        'no me llamaron', 'nadie me llamó', 'nadie me llamo',
        'no me han llamado', 'siguen sin llamar', 'todavía no',
        'todavia no', 'cuándo me llaman', 'cuando me llaman',
        'no me contactaron', 'esperando', 'llevo esperando'
      ]
      if (contieneAlguna(texto, KEYWORDS_RECLAMO)) {
        const msg = `Mil disculpas 🙏 Eso no debería pasar.

Ya le mandé una alerta urgente a tu asesor — te llama en los próximos minutos.

¡Gracias por tu paciencia! 💪`
        await enviarTexto(instancia, numero, msg)
        await guardarMensaje(prisma, {
          leadId: lead.id, tenantId, vendedorId: vendedor.id,
          direccion: 'SALIENTE', contenido: msg, estadoBot: 'HANDOFF'
        })
        await renotificarVendedor({
          prisma, instancia, lead, vendedor,
          motivo: `🚨 URGENTE — El lead reclama que nadie lo llamó: "${texto.slice(0, 80)}"`
        })
        break
      }

      // ── CASUÍSTICA 5: Lead muestra interés renovado ───────────────
      if (contieneAlguna(texto, KEYWORDS_INTERES_CONFIRMADO)) {
        await renotificarVendedor({
          prisma, instancia, lead, vendedor,
          motivo: `🔥 Lead reconfirmó interés: "${texto.slice(0, 80)}"`
        })
        const msg = `¡Perfecto! 🙌 Ya avisé a tu asesor — te llama muy pronto.

📲 ¡Estate atento!`
        await enviarTexto(instancia, numero, msg)
        await guardarMensaje(prisma, {
          leadId: lead.id, tenantId, vendedorId: vendedor.id,
          direccion: 'SALIENTE', contenido: msg, estadoBot: 'HANDOFF'
        })
        break
      }

      // ── CASUÍSTICA 6: Lead pregunta por precio u otra info ────────
      if (contieneAlguna(texto, KEYWORDS_PRECIO)) {
        const msg =
          `El precio del programa es *S/ 497* en preventa 🔥

` +
          `💳 También puedes pagarlo en 2 cuotas:
` +
          `• Primera: S/ 257 hoy
` +
          `• Segunda: S/ 240 en 2 semanas

` +
          `Tu asesor te dará todos los detalles cuando te llame 📲`
        await enviarTexto(instancia, numero, msg)
        await guardarMensaje(prisma, {
          leadId: lead.id, tenantId, vendedorId: vendedor.id,
          direccion: 'SALIENTE', contenido: msg, estadoBot: 'HANDOFF'
        })
        break
      }

      // ── CASUÍSTICA DEFAULT: Lead escribe cualquier otra cosa ──────
      // Lógica según tiempo transcurrido desde el handoff
      let msgDefault
      let debeRenotificar = false

      if (minutosDesdeHandoff < 30) {
        // Menos de 30 min — vendedor probablemente en camino
        msgDefault = `Tu asesor ya está al tanto y te llama en breve 🙏

¡Estate pendiente al teléfono! 📲`
      } else if (minutosDesdeHandoff < 120) {
        // 30 min a 2h — algo falló, re-notificar
        msgDefault = `Disculpa la espera 🙏 Ya le recordé a tu asesor — te contacta hoy mismo.

Si prefieres, dime a qué hora te viene mejor y coordino 👇`
        debeRenotificar = true
      } else if (minutosDesdeHandoff < 1440) {
        // 2h a 24h — urgente
        msgDefault = `Lamentamos la demora 😔 No es lo que queremos para ti.

Ya escalé tu caso como *URGENTE* — un asesor te llama hoy.

¿A qué hora te viene mejor? 👇`
        debeRenotificar = true
      } else {
        // Más de 24h — lead frío, reactivar
        msgDefault =
          `¡Hola de nuevo! 👋 Nos alegra que vuelvas.

` +
          `Tenemos el programa *Exporta con 1,000 Soles* disponible ahora mismo.

` +
          `¿Sigues interesado/a? 👇`
        // Reactivar el lead a PRESENTACION
        await avanzarEstado(prisma, lead, 'PRESENTACION')
        debeRenotificar = true
      }

      await enviarTexto(instancia, numero, msgDefault)
      await guardarMensaje(prisma, {
        leadId: lead.id, tenantId, vendedorId: vendedor.id,
        direccion: 'SALIENTE', contenido: msgDefault, estadoBot: 'HANDOFF'
      })

      if (debeRenotificar) {
        await renotificarVendedor({
          prisma, instancia, lead, vendedor,
          motivo: `⚠️ Lead inactivo ${minutosDesdeHandoff}min volvió a escribir: "${texto.slice(0, 80)}"`
        })
      }
      break
    }
  }
  } catch (err) {
    console.error(`[Motor] ERROR en estado ${lead?.estadoBot}:`, err.message)
    console.error(err.stack)
  }
}

// ================================================================
// RE-NOTIFICAR VENDEDOR — cuando el lead vuelve a escribir en HANDOFF
// Diferente a notificarVendedor — incluye el motivo específico
// ================================================================
async function renotificarVendedor({ prisma, instancia, lead, vendedor, motivo }) {
  try {
    const v = await prisma.vendedor.findUnique({ where: { id: vendedor.id } })
    if (!v?.whatsappNumber) return

    const msg =
      `${motivo}

` +
      `👤 *Nombre:* ${lead.nombre || 'Sin nombre'}
` +
      `📱 *Número:* ${lead.numero}
` +
      `📦 *Producto:* ${lead.producto || 'Sin producto'}
` +
      `🎯 *Perfil:* ${lead.tipoPreciso || lead.tipo}

` +
      `📞 *Acción requerida — llama ahora*`

    await enviarTexto(instancia, v.whatsappNumber, msg)
  } catch (err) {
    console.error('[StateEngine] Error re-notificando vendedor:', err.message)
  }
}

// ================================================================
// AVANZAR ESTADO
// ================================================================
async function avanzarEstado(prisma, lead, nuevoEstado) {
  try {
    await prisma.lead.update({
      where: { id: lead.id },
      data: {
        estadoBotAnterior: lead.estadoBot,
        estadoBot: nuevoEstado,
        ultimoTimestamp: new Date()
      }
    })
    lead.estadoBot = nuevoEstado
  } catch (err) {
    console.error('[StateEngine] Error avanzando estado:', err.message)
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

  // Notificar vendedor
  await notificarVendedor({ prisma, instancia, lead, vendedor })

  // Mensaje al lead
  const msg =
    `¡Genial! 🙌 Un asesor de *Perú Exporta TV* se comunicará contigo muy pronto.\n\n` +
    `📲 ¡Estate atento al teléfono!`

  await enviarTexto(instancia, numero, msg)
  await guardarMensaje(prisma, {
    leadId: lead.id, tenantId, vendedorId: vendedor.id,
    direccion: 'SALIENTE', contenido: msg,
    estadoBot: 'HANDOFF'
  })

  console.log(`[StateEngine] Lead ${numero} → HANDOFF | Motivo: ${motivo}`)
}

// ================================================================
// MANEJAR POSIBLE PAGO (imagen recibida)
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
    `¡Bienvenido/a a *Perú Exporta TV*! 🎉🇵🇪\n\n` +
    `Recibimos tu imagen. Un asesor validará tu pago y te dará los accesos en breve.\n\n` +
    `¡Prepárate para exportar! 🚀`

  await enviarTexto(instancia, numero, msg)
  await guardarMensaje(prisma, {
    leadId: lead.id, tenantId, vendedorId: vendedor.id,
    direccion: 'SALIENTE', contenido: msg,
    estadoBot: 'HANDOFF'
  })

  await notificarVendedor({ prisma, instancia, lead, vendedor })
  console.log(`[StateEngine] Posible pago recibido de ${numero}`)
}
