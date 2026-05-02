// src/webhook/stateEngine.js — v16 HIDATA 111X
// v16 — M4 determinístico desde BD — Groq solo en M7
// v16 — Extractor de perfil básico en M2 sin LLM
// v15 — M2, M3, M5, M6 determinísticos
// v14 — Briefing dosier de inteligencia comercial
// v14 — detectarMomento M7 robusto
// v14 — Math.max en pasoActual — take:20 historial

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
// EXTRACTOR DE PERFIL BÁSICO — sin LLM, regex puro
// Se ejecuta en M2 para capturar nombre y producto
// ════════════════════════════════════════════════════════════
function extraerPerfilBasico(texto) {
  const datos = {}
  if (!texto) return datos

  // Nombre — "me llamo X", "soy X", "mi nombre es X"
  const nombreMatch = texto.match(
    /(?:me llamo|soy|mi nombre es)\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)/i
  )
  if (nombreMatch) datos.nombre = nombreMatch[1]

  // Producto — "quiero exportar X", "exportar X", "tengo X", "produzco X"
  const productoMatch = texto.match(
    /(?:exportar|quiero exportar|vender|tengo|produzco|mi producto es)\s+([a-záéíóúñ\s]+?)(?:\s*,|\s*\.|\s*y\s|\s*$)/i
  )
  if (productoMatch) datos.producto = productoMatch[1].trim()

  return datos
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
// FECHA LIMA
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
    m.includes('inscripcion anticipada') ||
    m.includes('diseñado para personas en tu situación')
  )

  // ── Detectar si ya preguntamos horario ───────────────────
  const yaPreguntoHorario = botMensajes.some(m =>
    m.includes('a qué hora te viene mejor') ||
    m.includes('a que hora te viene mejor')
  )

  // ── Lead confirmó horario — patrones estrictos ───────────
  const leadConfirmoHorario = yaPreguntoHorario && leadMensajes.some(m => {
    return /\d{1,2}:\d{2}/.test(m)                ||
           /\d{1,2}\s*(am|pm)/i.test(m)           ||
           /a las \d+/i.test(m)                   ||
           /(mañana|manana)\s+a/.test(m)          ||
           /(hoy)\s+a/.test(m)                   ||
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
    m.includes('empresa')     || m.includes('independiente') ||
    m.includes('negocio')     || m.includes('ruc')           ||
    m.includes('constituida') || m.includes('natural')       ||
    m.includes('persona')     || m.includes('no tengo')      ||
    m.includes('trabajo')     || m.includes('casa')          ||
    m.includes('formal')      || m.includes('informal')
  )

  if (leadRespondioEmpresa) return 4
  if (yaPreguntoEmpresa)    return 3

  const yaPreguntoExperiencia = botMensajes.some(m =>
    m.includes('experiencia exportando') ||
    m.includes('empezando desde cero')   ||
    m.includes('primeros pasos')
  )

  const leadRespondioExperiencia = yaPreguntoExperiencia && leadMensajes.some(m =>
    m.includes('primera')         || m.includes('nunca')      ||
    m.includes('experiencia')     || m.includes('exportado')  ||
    m.includes('cero')            || m.includes('antes')      ||
    m.includes('años exportando') || m.includes('ya exporto') ||
    m.includes('ya exporté')      || m.includes('sí exporto')
  )

  if (leadRespondioExperiencia) return 3
  if (yaPreguntoExperiencia)    return 2

  return 2
}

// ════════════════════════════════════════════════════════════
// GENERADOR DETERMINÍSTICO — M2, M3, M4, M5, M6 sin Groq
// Groq SOLO en M7
// ════════════════════════════════════════════════════════════
function generarRespuestaDeterministica(momentoActual, nombre, producto, mensajeActual, pasosVendedor) {
  const n = nombre   ? ` ${nombre}`  : ''
  const p = producto || 'tu producto'

  if (momentoActual === 2) {
    const prod = producto ? `El ${producto} tiene bastante potencial afuera. ` : ''
    return `Muchas gracias${n} 😊 ${prod}Cuéntame, ¿ya tienes experiencia exportando o estás dando tus primeros pasos?`
  }

  if (momentoActual === 3) {
    return `Entiendo 😊 Y cuéntame${n}, ¿tienes empresa constituida o por ahora trabajas de manera independiente?`
  }

  if (momentoActual === 4) {
    const paso3 = pasosVendedor?.find(p => p.orden === 3)
    const cuerpo = paso3?.mensaje?.trim() || null

    if (cuerpo) {
      return `Mira${n}, justamente tenemos un programa diseñado para personas en tu situación. Te cuento:\n\n${cuerpo}\n\n¿Qué te parece${n}? ¿Tienes alguna duda o consulta?`
    }

    // Fallback digno si no hay paso3 en BD
    return `Mira${n}, tenemos un programa diseñado exactamente para tu caso 😊 Dame un momento y te cuento todos los detalles.`
  }

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
// GROQ BRAIN v16 — SOLO M7
// ════════════════════════════════════════════════════════════
async function consultarGroq({
  historial, textoActual, esImagen, convState,
  perfilActual, botPrompt, campaignNombre,
  nombreVendedor
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

    const nombre   = perfilActual.nombre  || ''
    const producto = perfilActual.producto || ''

    const systemPrompt =
`${promptBase}

CONTEXTO TÉCNICO (nunca lo menciones al lead):
- Nombre: ${nombre}
- Producto: ${producto}
- Estado: POST_CIERRE
- Recibió imagen: ${esImagen}
- CRÍTICO: Ya te presentaste. NO vuelvas a saludar.

════════════════════════════════════════
MOMENTO 7 — POST CIERRE
════════════════════════════════════════
La cita ya está confirmada. El lead sigue escribiendo — está caliente.
Tu tarea:
1. Responde natural, breve y cálido a lo que dice.
2. Recoge información nueva en datosExtraidos.
3. Mantén la conversación caliente hasta la llamada.
4. Máximo 2 líneas. Un emoji.
5. NO vuelvas a preguntar horario.
6. NO vuelvas a presentar el programa.
7. NO vuelvas a despedirte.
accion DEBE ser NINGUNA — salvo:
- Lead rechaza explícitamente → CERRAR_LEAD
- Lead declara pago → PEDIR_COMPROBANTE

ADEMÁS extrae en datosExtraidos:
- inteligenciaComercial: 1 línea perfil del lead
- palancierre: 1 línea palanca de cierre
- anguloEntrada: 1 línea cómo abrir la llamada
- paisDestino: país que mencionó si lo dijo

INSTRUCCIÓN CRÍTICA DE FORMATO:
Respuesta COMPLETA ÚNICAMENTE JSON válido.
Sin texto antes. Sin texto después. Sin markdown. Sin backticks.
Primer carácter { — Último carácter }

{
  "intencion": "FLUJO_NORMAL|RECHAZO|PAGO_DECLARADO|DESVIO",
  "respuesta": "texto que se envía al lead",
  "accion": "NINGUNA|CERRAR_LEAD|PEDIR_COMPROBANTE",
  "pasoActual": 7,
  "datosExtraidos": {
    "nombre": null,
    "producto": null,
    "paisDestino": null,
    "inteligenciaComercial": null,
    "palancierre": null,
    "anguloEntrada": null
  },
  "perfilScore": 0
}`

    const mensajesCtx = historial.slice(-12).map(m => ({
      role:    m.origen === 'LEAD' ? 'user' : 'assistant',
      content: m.texto
    }))

    const controller = new AbortController()
    const timeout    = setTimeout(() => controller.abort(), 8000)

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type':  'application/json'
      },
      body: JSON.stringify({
        model:       'llama-3.3-70b-versatile',
        max_tokens:  600,
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

    const data      = await response.json()
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
        intencion:      'FLUJO_NORMAL',
        respuesta:      contenido,
        accion:         'NINGUNA',
        datosExtraidos: {},
        perfilScore:    0,
        pasoActual:     7
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
// ACTION EXECUTOR
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

          const intel   = datosExtraidos?.inteligenciaComercial || 'perfil por evaluar en llamada'
          const palanca = datosExtraidos?.palancierre           || 'conectar con su motivación principal'
          const angulo  = datosExtraidos?.anguloEntrada         || 'empieza por su producto y su país'
          const pais    = datosExtraidos?.paisDestino           || 'por confirmar en llamada'

          const empresaLinea = datosExtraidos?.tieneEmpresa === false
            ? 'Independiente · sin empresa constituida'
            : datosExtraidos?.tieneEmpresa
              ? 'Tiene empresa constituida'
              : 'Independiente · sin empresa constituida'

          const expLinea = datosExtraidos?.experiencia
            ? 'Con experiencia exportando'
            : 'Sin experiencia · primera vez'

          const briefing =
`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${emoji} LEAD CALIFICADO · ${campNombre}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
wa.me/${lead.telefono}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
👤  ${nombre}
📦  ${producto}
🏢  ${empresaLinea}
🌱  ${expLinea}
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

        const momentoActual = detectarMomento(lead, historial)
        console.log(`[Flujo] Momento detectado: ${momentoActual} | nombre:${perfilActual.nombre} | producto:${perfilActual.producto}`)

        const cam = lead.campaignId
          ? await prisma.campaign.findUnique({
              where:   { id: lead.campaignId },
              include: { steps: { orderBy: { orden: 'asc' } } }
            })
          : null

        const pasosVendedor = cam?.steps || []

        // ════════════════════════════════════════════════════
        // CORTOCIRCUITO M2→M6 — Groq no participa
        // ════════════════════════════════════════════════════
        const respuestaDeterministica = generarRespuestaDeterministica(
          momentoActual,
          perfilActual.nombre,
          perfilActual.producto,
          mensaje,
          pasosVendedor
        )

        if (respuestaDeterministica) {
          const accionFinal = momentoActual === 6 ? 'NOTIFICAR_VENDEDOR' : 'NINGUNA'

          // ── Extractor perfil básico en M2 ────────────────
          if (momentoActual === 2) {
            const extraido = extraerPerfilBasico(mensaje)
            if (extraido.nombre || extraido.producto) {
              await actualizarPerfil(lead.id, extraido)
              if (extraido.nombre)   perfilActual.nombre   = extraido.nombre
              if (extraido.producto) perfilActual.producto = extraido.producto
              console.log(`[Extractor] M2 perfil: ${JSON.stringify(extraido)}`)
            }
          }

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
              datosExtraidos: perfilActual
            })
          }

          console.log(`[Flujo] M${momentoActual} DETERMINÍSTICO | accion: ${accionFinal} | vendor: ${vendorActivo.nombre} | ${telefono}`)
          return
        }

        // ── GROQ — SOLO M7 ────────────────────────────────
        const resultado = await consultarGroq({
          historial,
          textoActual:    mensaje,
          esImagen,
          convState,
          perfilActual,
          botPrompt:      cam?.botPrompt     || null,
          campaignNombre: cam?.nombre        || 'Peru Exporta TV',
          nombreVendedor: vendorActivo.nombre
        })

        // Fallback digno si Groq falla en M7
        const respuesta = resultado?.respuesta ||
          `Perfecto${perfilActual.nombre ? ` ${perfilActual.nombre}` : ''} 😊 Nos vemos en la llamada, cualquier duda me avisas.`

        const accionFinal = (() => {
          const accion = resultado?.accion || 'NINGUNA'
          return accion === 'NOTIFICAR_VENDEDOR' ? 'NINGUNA' : accion
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

        console.log(`[Brain IA] M7 → ${resultado?.intencion || 'FLUJO_NORMAL'} | accion: ${accionFinal} | vendor: ${vendorActivo.nombre} | ${telefono}`)

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

    const pasos = campaign?.steps?.filter(s => s.tipo === 'MSG') || []
    const paso1 = pasos[0]

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
