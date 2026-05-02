// src/webhook/stateEngine.js — v14 HIDATA 111X
// v14 — Cortocircuito M5/M6: código genera respuesta, Groq no participa
// Briefing como dosier de inteligencia comercial
// detectarMomento M7 — detección robusta basada en mensaje real
// leadConfirmoHorario — patrones estrictos, sin falsos positivos
// Math.max en pasoActual — Groq no puede hacer regresión
// take: 20 en historial — contexto más largo para M7

import prisma from '../db/prisma.js'
import { resolverCampaign } from './routerInteligente.js'
import { enviarTexto } from '../whatsapp/sender.js'
import { Redis } from '@upstash/redis'

const sleep = ms => new Promise(r => setTimeout(r, ms))

const redis = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
})

// ════════════════════════════════════════════════════════════
// REDIS LOCK
// ════════════════════════════════════════════════════════════
async function adquirirLock(telefono) {
  try {
    const result = await redis.set(`lock:${telefono}`, '1', { nx: true, ex: 15 })
    return result === 'OK'
  } catch(e) {
    console.error('[Lock] Redis error:', e.message)
    return true
  }
}

async function liberarLock(telefono) {
  try {
    await redis.del(`lock:${telefono}`)
  } catch(e) {
    console.error('[Lock] Redis error liberar:', e.message)
  }
}

// ════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════
async function guardarMsg(leadId, convId, origen, texto) {
  try {
    await prisma.message.create({
      data: { leadId, conversationId: convId || null, origen, texto }
    })
  } catch(e) { console.error('[Motor] guardarMsg:', e.message) }
}

function interp(msg, vars) {
  return (msg || '')
    .replace(/\{\{telefono\}\}/g, vars.telefono || '')
    .replace(/\{\{nombre\}\}/g,   vars.nombre   || '')
    .replace(/\{\{vendedor\}\}/g, vars.vendedor  || '')
    .replace(/\{\{curso\}\}/g,    vars.curso     || '')
}

// ════════════════════════════════════════════════════════════
// EXTRACTOR DE HORARIO
// ════════════════════════════════════════════════════════════
function extraerHorario(texto) {
  if (!texto) return null
  const patterns = [
    /(\d{1,2}:\d{2}\s*(?:am|pm)?)/i,
    /(\d{1,2}\s*(?:am|pm))/i,
    /(mañana\s+a\s+las\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/i,
    /(hoy\s+a\s+las\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/i,
    /(mañana|hoy|tarde|noche|mediodía)/i,
  ]
  for (const p of patterns) {
    const m = texto.match(p)
    if (m) return m[1]
  }
  return texto.slice(0, 30)
}

// ════════════════════════════════════════════════════════════
// FECHA LIMA — para briefing
// ════════════════════════════════════════════════════════════
function fechaLima() {
  return new Date().toLocaleString('es-PE', {
    timeZone: 'America/Lima',
    day:      '2-digit',
    month:    '2-digit',
    year:     'numeric',
    hour:     '2-digit',
    minute:   '2-digit'
  })
}

function fechaLlamaLima(horarioRaw) {
  const ahora = new Date().toLocaleDateString('es-PE', {
    timeZone: 'America/Lima',
    day:      '2-digit',
    month:    'long',
    year:     'numeric'
  })
  return `${ahora} · ${horarioRaw}`
}

// ════════════════════════════════════════════════════════════
// DETECTOR DE MOMENTO — el código decide, no Groq
// ════════════════════════════════════════════════════════════
function detectarMomento(lead, historial) {
  const botMensajes  = historial.filter(m => m.origen === 'BOT').map(m => m.texto.toLowerCase())
  const leadMensajes = historial.filter(m => m.origen === 'LEAD').map(m => m.texto.toLowerCase())

  // ── Momento 7 — bot ya hizo cierre ───────────────────────
  const yaHizoCierre = botMensajes.some(m =>
    m.includes('te llamo y vemos todo') ||
    m.includes('nos hablamos') ||
    m.includes('hablamos pronto')
  )
  if (yaHizoCierre) return 7

  // ── Detectar si ya presentamos el programa ───────────────
  const yaPresento = botMensajes.some(m =>
    m.includes('exporta con 1,000') ||
    m.includes('curso taller') ||
    m.includes('inscripción anticipada') ||
    m.includes('inscripcion anticipada')
  )

  // ── Detectar si ya preguntamos horario ───────────────────
  const yaPreguntoHorario = botMensajes.some(m =>
    m.includes('a qué hora te viene mejor') ||
    m.includes('a que hora te viene mejor')
  )

  // ── Lead confirmó horario — patrones estrictos ───────────
  const leadConfirmoHorario = yaPreguntoHorario && leadMensajes.some(m => {
    return /\d{1,2}:\d{2}/.test(m)           ||
           /\d{1,2}\s*(am|pm)/i.test(m)      ||
           /a las \d+/i.test(m)              ||
           /(mañana|manana)\s+a/.test(m)     ||
           /(hoy)\s+a/.test(m)              ||
           /^(mañana|manana|hoy)$/.test(m.trim()) ||
           /^(tarde|noche)$/.test(m.trim())
  })

  if (leadConfirmoHorario) return 6
  if (yaPresento)          return 5

  const yaPreguntoEmpresa = botMensajes.some(m =>
    m.includes('empresa constituida') ||
    m.includes('independiente')
  )

  const leadRespondioEmpresa = yaPreguntoEmpresa && leadMensajes.some(m =>
    m.includes('empresa')       || m.includes('independiente') ||
    m.includes('negocio')       || m.includes('ruc')           ||
    m.includes('constituida')   || m.includes('natural')       ||
    m.includes('persona')       || m.includes('no tengo')      ||
    m.includes('trabajo')       || m.includes('casa')          ||
    m.includes('formal')        || m.includes('informal')
  )

  if (leadRespondioEmpresa) return 4
  if (yaPreguntoEmpresa)    return 3

  const yaPreguntoExperiencia = botMensajes.some(m =>
    m.includes('experiencia exportando') ||
    m.includes('empezando desde cero')
  )

  const leadRespondioExperiencia = yaPreguntoExperiencia && leadMensajes.some(m =>
    m.includes('primera')        || m.includes('nunca')       ||
    m.includes('experiencia')    || m.includes('exportado')   ||
    m.includes('cero')           || m.includes('antes')       ||
    m.includes('años exportando')|| m.includes('ya exporto')  ||
    m.includes('ya exporté')     || m.includes('sí exporto')
  )

  if (leadRespondioExperiencia) return 3
  if (yaPreguntoExperiencia)    return 2

  return 2
}

// ════════════════════════════════════════════════════════════
// GENERADOR DETERMINÍSTICO — M5 y M6 sin Groq
// ════════════════════════════════════════════════════════════
function generarRespuestaDeterministica(momentoActual, nombre, producto, mensajeActual) {
  const n = nombre   ? ` ${nombre}`  : ''
  const p = producto || 'tu producto'

  if (momentoActual === 5) {
    return `¿A qué hora te viene mejor que te llame${n}? ¿Hoy o mañana? 📞`
  }

  if (momentoActual === 6) {
    const horario = extraerHorario(mensajeActual) || 'en el horario acordado'
    return `Listo${n} 😊 ${horario} te llamo y vemos todo juntos. Ah, y cuéntame — ¿a qué país te gustaría llevar tu ${p}? 🌍 Así voy preparado para tu caso.`
  }

  return null
}

// ════════════════════════════════════════════════════════════
// GROQ BRAIN v14
// ════════════════════════════════════════════════════════════
async function consultarGroq({
  historial, textoActual, esImagen, convState,
  perfilActual, botPrompt, campaignNombre,
  pasosVendedor, momentoActual, nombreVendedor
}) {
  try {
    if (!process.env.GROQ_API_KEY) return null

    const promptBase = botPrompt
      ? botPrompt
          .replace(/""/g, '"')
          .replace(/\[NOMBRE_ASESOR\]/g, nombreVendedor)
      : `Eres ${nombreVendedor}, asesor de ${campaignNombre || 'Peru Exporta TV'}.
Tu misión es calificar al lead, no venderle. El cierre es por teléfono.
Responde siempre en español, máximo 3 líneas, un emoji por mensaje.
Nunca reveles que eres IA.`

    const pasosCtx = pasosVendedor?.length
      ? `
════════════════════════════════════════
PASOS_DEL_VENDEDOR — CONTENIDO EXACTO
════════════════════════════════════════
${pasosVendedor
  .filter(p => p.tipo === 'MSG')
  .map(p => `PASO ${p.orden}:\n${p.mensaje}`)
  .join('\n\n---\n\n')}
`
      : ''

    const nombre   = perfilActual.nombre  || ''
    const producto = perfilActual.producto || ''

    const convStateParaGroq = momentoActual === 7 ? 'POST_CIERRE' : convState

    const instruccionMomento = `
════════════════════════════════════════
INSTRUCCIÓN DEL SISTEMA — OBLIGATORIA
════════════════════════════════════════
El sistema detectó MOMENTO ${momentoActual}.
Tu ÚNICA tarea es ejecutar el MOMENTO ${momentoActual}.

${momentoActual === 2 ? `
MOMENTO 2 — EXPERIENCIA:
Pregunta si tiene experiencia exportando.
Usa el PASO 2 del vendedor como base.
Potencialo con nombre="${nombre}" y producto="${producto}".
` : ''}

${momentoActual === 3 ? `
MOMENTO 3 — SITUACIÓN EMPRESARIAL:
Pregunta si tiene empresa o trabaja independiente.
Mensaje: "Entiendo 😊 Y cuéntame ${nombre}, ¿tienes empresa constituida o por ahora trabajas de manera independiente?"
` : ''}

${momentoActual === 4 ? `
MOMENTO 4 — PRESENTAR PROGRAMA COMPLETO:
OBLIGATORIO: Copia el PASO 3 del vendedor COMPLETO, palabra por palabra, sin resumir ni acortar.
1. Primero: "Mira ${nombre}, justamente tenemos un programa diseñado para personas en tu situación. Te cuento:"
2. Copia el PASO 3 COMPLETO
3. Al final: "¿Qué te parece ${nombre}? ¿Tienes alguna duda o consulta?"
` : ''}

${momentoActual === 7 ? `
MOMENTO 7 — POST CIERRE:
La cita ya está confirmada. El bot ya se despidió.
El lead está respondiendo después del cierre — está caliente.
Tu tarea:
1. Responde de forma natural, breve y cálida.
2. Recoge cualquier información nueva en datosExtraidos.
3. Mantén la conversación caliente hasta la llamada.
4. Máximo 2 líneas. Un emoji.
5. NO vuelvas a preguntar el horario.
6. NO vuelvas a presentar el programa.
7. NO vuelvas a despedirte.
accion DEBE ser NINGUNA — salvo que:
- El lead rechace explícitamente → accion: CERRAR_LEAD
- El lead declare pago → accion: PEDIR_COMPROBANTE
` : ''}

ADEMÁS — para TODOS los momentos — extrae en datosExtraidos:
- inteligenciaComercial: string de 1 línea que describa el perfil del lead
  Ejemplo: "novato motivado con producto real — tiene el activo, le falta el camino"
- palancierre: string de 1 línea con la palanca de cierre específica para este lead
  Ejemplo: "no atacar precio · atacar el costo de cada mes sin exportar"
- anguloEntrada: string de 1 línea con cómo abrir la llamada
  Ejemplo: "empieza por su país destino · no por el temario"
`

    const botYaHablo = historial.some(m => m.origen === 'BOT')

    const systemPrompt =
`${promptBase}

${pasosCtx}

CONTEXTO TÉCNICO (nunca lo menciones al lead):
- Perfil: ${JSON.stringify(perfilActual)}
- Estado conversación: ${convStateParaGroq}
- Bot ya habló: ${botYaHablo}
- Recibió imagen: ${esImagen}
${botYaHablo ? `- CRÍTICO: Ya te presentaste como ${nombreVendedor}. NO vuelvas a saludar.` : ''}

${instruccionMomento}

INSTRUCCIÓN CRÍTICA DE FORMATO:
Tu respuesta COMPLETA debe ser ÚNICAMENTE JSON válido.
Sin texto antes. Sin texto después. Sin markdown. Sin backticks.
Primer carácter { — Último carácter }

{
  "intencion": "FLUJO_NORMAL|RECHAZO|PAGO_DECLARADO|SOLICITA_LLAMADA|REACTIVACION|IMAGEN_PRODUCTO|COMPROBANTE|DESVIO|PREGUNTA_INFO",
  "respuesta": "texto que se envía al lead",
  "accion": "NINGUNA|CERRAR_LEAD|PEDIR_COMPROBANTE|NOTIFICAR_VENDEDOR|CAMBIAR_ESTADO_PAYMENT",
  "pasoActual": ${momentoActual},
  "datosExtraidos": {
    "nombre": null,
    "edad": null,
    "producto": null,
    "experiencia": null,
    "tieneEmpresa": null,
    "horarioLlamada": null,
    "conocePrecio": null,
    "consultaConOtro": null,
    "inteligenciaComercial": null,
    "palancierre": null,
    "anguloEntrada": null
  },
  "perfilScore": 0
}`

    const mensajesCtx = historial.slice(-12).map(m => ({
      role: m.origen === 'LEAD' ? 'user' : 'assistant',
      content: m.texto
    }))

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 8000)

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model:       'llama-3.3-70b-versatile',
        max_tokens:  1200,
        temperature: 0.3,
        messages: [
          { role: 'system', content: systemPrompt },
          ...mensajesCtx,
          { role: 'user', content: esImagen ? '[El lead envió una imagen]' : textoActual }
        ]
      })
    })

    clearTimeout(timeout)
    if (!response.ok) {
      console.error('[Brain IA] Groq HTTP error:', response.status)
      return null
    }

    const data     = await response.json()
    const contenido = data.choices[0]?.message?.content?.trim()

    const limpio = (() => {
      const match = contenido.match(/\{[\s\S]*\}/)
      return match ? match[0] : contenido
    })()

    try {
      return JSON.parse(limpio)
    } catch {
      console.error('[Brain IA] JSON parse falló:', contenido?.slice(0, 200))
      return {
        intencion:       'FLUJO_NORMAL',
        respuesta:       contenido,
        accion:          'NINGUNA',
        datosExtraidos:  {},
        perfilScore:     0,
        pasoActual:      momentoActual
      }
    }

  } catch (err) {
    console.error('[Brain IA] Groq falló:', err.message)
    return null
  }
}

// ════════════════════════════════════════════════════════════
// PROFILE BUILDER
// ════════════════════════════════════════════════════════════
async function actualizarPerfil(leadId, datosExtraidos) {
  try {
    const updates = {}
    if (datosExtraidos?.nombre)   updates.nombreDetectado   = datosExtraidos.nombre
    if (datosExtraidos?.producto) updates.productoDetectado = datosExtraidos.producto
    if (Object.keys(updates).length > 0) {
      await prisma.lead.update({ where: { id: leadId }, data: updates })
      console.log(`[ProfileBuilder] Actualizado: ${JSON.stringify(updates)}`)
    }
  } catch(e) { console.error('[ProfileBuilder]', e.message) }
}

// ════════════════════════════════════════════════════════════
// ACTION EXECUTOR — briefing como dosier de inteligencia
// ════════════════════════════════════════════════════════════
async function ejecutarAccion({ accion, lead, conv, instancia, vendor, texto, cam, datosExtraidos }) {
  try {
    switch (accion) {

      case 'CERRAR_LEAD':
        await prisma.lead.update({
          where: { id: lead.id },
          data:  { estado: 'CERRADO' }
        }).catch(() => {})
        await prisma.conversation.update({
          where: { id: conv.id },
          data:  { state: 'CLOSED' }
        }).catch(() => {})
        console.log(`[ActionExecutor] CERRAR_LEAD: ${lead.telefono}`)
        break

      case 'NOTIFICAR_VENDEDOR':
        if (vendor?.whatsappNumber) {
          const nombre     = lead.nombreDetectado   || 'Sin nombre'
          const producto   = lead.productoDetectado || 'Sin producto'
          const score      = lead.perfilScore        || 0
          const emoji      = score >= 7 ? '🔴' : score >= 4 ? '🟠' : '🟡'
          const horarioRaw = extraerHorario(texto)   || 'horario por confirmar'
          const campNombre = cam?.nombre             || 'MPX'
          const captado    = fechaLima()
          const cita       = fechaLlamaLima(horarioRaw)

          // Inteligencia comercial — generada por Groq o fallback
          const intel    = datosExtraidos?.inteligenciaComercial || 'perfil por evaluar en llamada'
          const palanca  = datosExtraidos?.palancierre           || 'conectar con su motivación principal'
          const angulo   = datosExtraidos?.anguloEntrada         || 'empieza por su producto y su país'
          const pais     = datosExtraidos?.paisDestino           || 'por confirmar en llamada'

          const briefing =
`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${emoji} LEAD CALIFICADO · ${campNombre}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
wa.me/${lead.telefono}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
👤  ${nombre}
📦  ${producto}
🏢  ${datosExtraidos?.tieneEmpresa === false ? 'Independiente · sin empresa constituida' : datosExtraidos?.tieneEmpresa ? 'Tiene empresa constituida' : 'Situación empresarial: por confirmar'}
🌱  ${datosExtraidos?.experiencia ? 'Con experiencia exportando' : 'Sin experiencia · primera vez'}
🌍  País destino: ${pais}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📅  CITA AGENDADA
    ${cita}
    Sé puntual — él ya está esperando
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🧠  INTELIGENCIA COMERCIAL
    ▸ Perfil: ${intel}
    ▸ Ángulo de entrada: ${angulo}
    ▸ Palanca de cierre: ${palanca}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
💬  Con sus propias palabras:
    "${texto?.slice(0, 100)}"
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🕒  Captado: ${captado}
⚡  Lead caliente · no lo dejes enfriar
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`

          await enviarTexto(instancia, vendor.whatsappNumber, briefing).catch(() => {})
        }
        await prisma.conversation.update({
          where: { id: conv.id },
          data:  { state: 'NOTIFIED', vendorNotifiedAt: new Date() }
        }).catch(() => {})
        console.log(`[ActionExecutor] NOTIFICAR_VENDEDOR: ${lead.telefono}`)
        break

      case 'PEDIR_COMPROBANTE':
        console.log(`[ActionExecutor] PEDIR_COMPROBANTE: ${lead.telefono}`)
        break

      case 'CAMBIAR_ESTADO_PAYMENT':
        await prisma.lead.update({
          where: { id: lead.id },
          data:  { estado: 'PAGO_PENDIENTE' }
        }).catch(() => {})
        await prisma.conversation.update({
          where: { id: conv.id },
          data:  { state: 'PAYMENT' }
        }).catch(() => {})
        console.log(`[ActionExecutor] CAMBIAR_ESTADO_PAYMENT: ${lead.telefono}`)
        break

      default:
        break
    }
  } catch(err) {
    console.error('[ActionExecutor] Error:', err.message)
  }
}

// ════════════════════════════════════════════════════════════
// ENTRY POINT
// ════════════════════════════════════════════════════════════
export async function processIncoming({ telefono, mensaje, esImagen, instancia }) {
  try {

    const vendor = await prisma.vendor.findFirst({
      where: { instanciaEvolution: instancia, activo: true }
    })

    if (!vendor) {
      console.error(`[Motor] Vendor no encontrado: ${instancia}`)
      return
    }

    const nombreVendedor = vendor.nombre
    const lead = await prisma.lead.findUnique({ where: { telefono } })

    // ════════════════════════════════════════════════════════
    // LEAD EXISTENTE
    // ════════════════════════════════════════════════════════
    if (lead) {

      // ── GUARD DE PROPIEDAD ────────────────────────────────
      let vendorActivo    = vendor
      let instanciaActiva = instancia

      if (lead.vendorId && lead.vendorId !== vendor.id) {
        const vendorDueno = await prisma.vendor.findUnique({
          where: { id: lead.vendorId }
        })
        if (vendorDueno?.instanciaEvolution) {
          if (vendorDueno.whatsappNumber) {
            await enviarTexto(
              vendorDueno.instanciaEvolution,
              vendorDueno.whatsappNumber,
              `📌 Tu lead escribió por otro número\n📱 wa.me/${lead.telefono}\n👤 ${lead.nombreDetectado || 'Sin nombre'}\n💬 "${mensaje?.slice(0, 80)}"`
            ).catch(() => {})
          }
          vendorActivo    = vendorDueno
          instanciaActiva = vendorDueno.instanciaEvolution
          console.log(`[Guard] Lead ${telefono} → vendor dueño: ${vendorDueno.nombre}`)
        }
      }

      // ── REDIS LOCK ────────────────────────────────────────
      const lockAdquirido = await adquirirLock(telefono)
      if (!lockAdquirido) {
        console.log(`[Lock] Lead en proceso — ignorado: ${telefono}`)
        return
      }

      try {

        const conv = await prisma.conversation.findFirst({
          where:   { leadId: lead.id },
          orderBy: { createdAt: 'desc' }
        })

        await guardarMsg(lead.id, conv?.id || null, 'LEAD', esImagen ? '[imagen]' : mensaje)

        if (conv?.id) {
          await prisma.conversation.update({
            where: { id: conv.id },
            data:  { lastLeadMessageAt: new Date() }
          }).catch(() => {})
        }

        const convState = conv?.state || 'ACTIVE'

        if (convState === 'CLOSED' || lead.estado === 'CERRADO') {
          console.log(`[Motor] Lead cerrado ignorado: ${telefono}`)
          return
        }

        const historial = await prisma.message.findMany({
          where:   { leadId: lead.id },
          orderBy: { createdAt: 'asc' },
          take:    20
        })

        const perfilActual = {
          nombre:     lead.nombreDetectado   || null,
          producto:   lead.productoDetectado || null,
          estado:     lead.estado            || null,
          pasoActual: lead.pasoActual        || 1
        }

        // ── CÓDIGO DETECTA EL MOMENTO ─────────────────────
        const momentoActual = detectarMomento(lead, historial)
        console.log(`[Flujo] Momento detectado: ${momentoActual} | nombre:${perfilActual.nombre} | producto:${perfilActual.producto}`)

        // ── Campaña + pasos del vendedor ──────────────────
        const cam = lead.campaignId
          ? await prisma.campaign.findUnique({
              where:   { id: lead.campaignId },
              include: { steps: { orderBy: { orden: 'asc' } } }
            })
          : null

        const pasosVendedor = cam?.steps || []

        // ════════════════════════════════════════════════════
        // CORTOCIRCUITO M5 / M6 — Groq no participa
        // ════════════════════════════════════════════════════
        const respuestaDeterministica = generarRespuestaDeterministica(
          momentoActual,
          perfilActual.nombre,
          perfilActual.producto,
          mensaje
        )

        if (respuestaDeterministica) {
          const accionFinal = momentoActual === 6 ? 'NOTIFICAR_VENDEDOR' : 'NINGUNA'

          await sleep(800)
          await enviarTexto(instanciaActiva, telefono, respuestaDeterministica)
          await guardarMsg(lead.id, conv?.id || null, 'BOT', respuestaDeterministica)

          if (conv?.id) {
            await prisma.conversation.update({
              where: { id: conv.id },
              data:  { lastBotMessageAt: new Date() }
            }).catch(() => {})
          }

          if (accionFinal === 'NOTIFICAR_VENDEDOR' && conv?.id) {
            await ejecutarAccion({
              accion:         'NOTIFICAR_VENDEDOR',
              lead, conv,
              instancia:      instanciaActiva,
              vendor:         vendorActivo,
              texto:          mensaje,
              cam,
              datosExtraidos: {}
            })
          }

          console.log(`[Flujo] M${momentoActual} DETERMINÍSTICO | accion: ${accionFinal} | vendor: ${vendorActivo.nombre} | ${telefono}`)
          return
        }

        // ── GROQ — solo M1, M2, M3, M4, M7 ──────────────
        const resultado = await consultarGroq({
          historial,
          textoActual:    mensaje,
          esImagen,
          convState,
          perfilActual,
          botPrompt:      cam?.botPrompt     || null,
          campaignNombre: cam?.nombre        || 'Peru Exporta TV',
          pasosVendedor,
          momentoActual,
          nombreVendedor: vendorActivo.nombre
        })

        const respuesta = resultado?.respuesta || `Un momento, déjame revisar 😊`

        // ── ACCIÓN FINAL ──────────────────────────────────
        const accionFinal = (() => {
          if (momentoActual === 7) {
            const accion = resultado?.accion || 'NINGUNA'
            return accion === 'NOTIFICAR_VENDEDOR' ? 'NINGUNA' : accion
          }
          return resultado?.accion || 'NINGUNA'
        })()

        if (conv?.id) {
          await prisma.conversation.update({
            where: { id: conv.id },
            data:  { lastBotMessageAt: new Date() }
          }).catch(() => {})
        }

        await sleep(800)
        await enviarTexto(instanciaActiva, telefono, respuesta)
        await guardarMsg(lead.id, conv?.id || null, 'BOT', respuesta)

        if (resultado?.datosExtraidos) {
          await actualizarPerfil(lead.id, resultado.datosExtraidos)
        }

        if (resultado?.pasoActual) {
          await prisma.lead.update({
            where: { id: lead.id },
            data: {
              pasoActual: Math.max(lead.pasoActual || 1, resultado.pasoActual)
            }
          }).catch(() => {})
        }

        if (accionFinal !== 'NINGUNA' && conv?.id) {
          await ejecutarAccion({
            accion:         accionFinal,
            lead, conv,
            instancia:      instanciaActiva,
            vendor:         vendorActivo,
            texto:          mensaje,
            cam,
            datosExtraidos: resultado?.datosExtraidos || {}
          })
        }

        console.log(`[Brain IA] momento:${momentoActual} → ${resultado?.intencion || 'FLUJO_NORMAL'} | accion: ${accionFinal} | vendor: ${vendorActivo.nombre} | ${telefono}`)

      } finally {
        await liberarLock(telefono)
      }

      return
    }

    // ════════════════════════════════════════════════════════
    // LEAD NUEVO — Router inteligente 2 capas
    // ════════════════════════════════════════════════════════
    const campaign = await resolverCampaign(mensaje, prisma)

    const newLead = await prisma.lead.create({
      data: {
        telefono,
        campaignId:    campaign?.id || null,
        vendorId:      vendor.id,
        pasoActual:    1,
        estado:        'EN_FLUJO',
        ultimoMensaje: new Date()
      }
    })

    const conv = await prisma.conversation.create({
      data: {
        leadId:            newLead.id,
        campaignId:        campaign?.id || null,
        vendorId:          vendor.id,
        state:             'ACTIVE',
        currentStep:       1,
        lastLeadMessageAt: new Date()
      }
    }).catch(async () => {
      return await prisma.conversation.findFirst({
        where: { leadId: newLead.id }
      })
    })

    await guardarMsg(newLead.id, conv?.id || null, 'LEAD', mensaje)

    const pasos    = campaign?.steps?.filter(s => s.tipo === 'MSG') || []
    const paso1    = pasos[0]

    const msgBienvenida = paso1?.mensaje
      ? interp(paso1.mensaje, {
          telefono,
          vendedor: nombreVendedor,
          curso:    campaign?.nombre || '',
          nombre:   ''
        })
      : `Hola 👋 Soy ${nombreVendedor}, asesor de Peru Exporta TV 😊\n\n¿Cómo te llamas y qué producto tienes en mente para exportar?`

    await sleep(1000)
    await enviarTexto(instancia, telefono, msgBienvenida)
    await guardarMsg(newLead.id, conv?.id || null, 'BOT', msgBienvenida)

    if (conv?.id) {
      await prisma.conversation.update({
        where: { id: conv.id },
        data: {
          currentStep:      1,
          lastBotMessageAt: new Date()
        }
      })
    }

    console.log(`[Motor] Lead nuevo: ${telefono} | vendor: ${nombreVendedor} | campaign: ${campaign?.slug || 'sin campaña'}`)

  } catch (err) {
    console.error('[Motor] Error crítico:', err.message)
  }
}
