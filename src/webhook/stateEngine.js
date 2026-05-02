// src/webhook/stateEngine.js — v19 HIDATA
// v19 — Recupera determinístico M2 y M4 con interceptor de señales
// v19 — Groq en M3, M5, M7 donde el contexto es genuinamente variable
// v18 — Groq encima en M3, M5, M7
// v17 — 13 escapes: fecha, capitalización, país, género neutral
// v16 — Extractor perfil básico, calcularCita fuente única

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
// NORMALIZACIÓN
// ════════════════════════════════════════════════════════════
function capitalizar(texto) {
  if (!texto) return ''
  return texto.trim().charAt(0).toUpperCase() +
         texto.trim().slice(1).toLowerCase()
}

// ════════════════════════════════════════════════════════════
// EXTRACTOR DE HORA SOLA
// ════════════════════════════════════════════════════════════
function extraerHoraSola(texto) {
  if (!texto) return null
  const patterns = [
    /(\d{1,2}:\d{2}\s*(?:am|pm))/i,
    /(\d{1,2}\s*(?:am|pm))/i,
    /(\d{1,2}:\d{2})/,
    /a\s+las\s+(\d{1,2}(?::\d{2})?)/i,
  ]
  for (const p of patterns) {
    const m = texto.match(p)
    if (m) return m[1].trim()
  }
  return null
}

// ════════════════════════════════════════════════════════════
// CALCULAR CITA — fuente única fecha y hora
// ════════════════════════════════════════════════════════════
function calcularCita(mensajeActual) {
  const mencionaManana = /mañana|manana/i.test(mensajeActual)
  const mencionaHoy    = /\bhoy\b/i.test(mensajeActual)
  const hora           = extraerHoraSola(mensajeActual)

  const fechaRef = new Date()
  if (mencionaManana) fechaRef.setDate(fechaRef.getDate() + 1)

  const fechaTexto = (mencionaManana || mencionaHoy)
    ? fechaRef.toLocaleDateString('es-PE', {
        timeZone: 'America/Lima',
        weekday:  'long',
        day:      'numeric',
        month:    'long',
        year:     'numeric'
      })
    : null

  const confirmacion = fechaTexto && hora
    ? `el ${fechaTexto} a las ${hora}`
    : fechaTexto
      ? `el ${fechaTexto}`
      : hora
        ? `a las ${hora}`
        : 'en el horario acordado'

  const citaBriefing = fechaTexto && hora
    ? `${fechaTexto} · ${hora}`
    : fechaTexto || hora || 'horario por confirmar'

  return { confirmacion, citaBriefing, hora, fechaTexto }
}

// ════════════════════════════════════════════════════════════
// EXTRACTOR DE PAÍS
// ════════════════════════════════════════════════════════════
function extraerPais(texto) {
  if (!texto) return null
  const paises = [
    'españa','estados unidos','usa','eeuu','chile','colombia',
    'méxico','mexico','argentina','brasil','brazil','canada',
    'alemania','francia','italia','china','japón','japon',
    'reino unido','australia','holanda','países bajos','panama',
    'ecuador','bolivia','uruguay','paraguay','costa rica',
    'miami','nueva york','new york','europa','asia'
  ]
  const t = texto.toLowerCase()
  for (const p of paises) {
    if (t.includes(p)) return capitalizar(p)
  }
  return null
}

// ════════════════════════════════════════════════════════════
// EXTRACTOR DE PERFIL BÁSICO — M2 sin LLM
// ════════════════════════════════════════════════════════════
function extraerPerfilBasico(texto) {
  const datos = {}
  if (!texto) return datos

  const nombreMatch = texto.match(
    /(?:me llamo|soy|mi nombre es)\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)/i
  )
  if (nombreMatch) datos.nombre = capitalizar(nombreMatch[1])

  const productoMatch = texto.match(
    /(?:exportar|quiero exportar|vender|tengo|produzco|mi producto es)\s+([a-záéíóúñ\s]+?)(?:\s*,|\s*\.|\s*y\s|\s*$)/i
  )
  if (productoMatch) datos.producto = capitalizar(productoMatch[1].trim())

  return datos
}

// ════════════════════════════════════════════════════════════
// INTERCEPTOR DE SEÑALES CRÍTICAS
// Detecta cuando el lead se desvía antes del flujo normal
// ════════════════════════════════════════════════════════════
function interceptarSenal(mensaje) {
  const m = mensaje.toLowerCase()

  if (/no me interesa|no quiero|ya no|cancelar|goodbye|chau|hasta luego/i.test(m))
    return 'RECHAZO'

  if (/cuánto cuesta|cuanto cuesta|precio|costo|cuánto es|cuanto es|cuánto vale|cuanto vale|cuánto cobran|cuanto cobran/i.test(m))
    return 'PRECIO'

  if (/quién eres|quien eres|eres bot|eres un bot|eres humano|eres robot|eres una ia|eres inteligencia/i.test(m))
    return 'IDENTIDAD'

  if (/llámame|llamame|llámame ahora|quiero que me llamen|que me llamen|me pueden llamar/i.test(m))
    return 'SOLICITA_LLAMADA'

  return null
}

function respuestaSenal(senal, nombre, nombreVendedor) {
  const n = nombre ? ` ${capitalizar(nombre)}` : ''
  switch(senal) {
    case 'PRECIO':
      return {
        respuesta: `El asesor te da todos los detalles del precio en la llamada${n} 😊 ¿A qué hora te viene mejor que te llame?`,
        accion: 'NINGUNA'
      }
    case 'RECHAZO':
      return {
        respuesta: `Entiendo perfectamente${n} 😊 Si en algún momento quieres retomar, aquí estaremos.`,
        accion: 'CERRAR_LEAD'
      }
    case 'IDENTIDAD':
      return {
        respuesta: `Soy ${nombreVendedor}, tu asesor de Peru Exporta TV 😊 Estoy aquí para ayudarte con tu proceso de exportación.`,
        accion: 'NINGUNA'
      }
    case 'SOLICITA_LLAMADA':
      return {
        respuesta: `Con gusto${n} 😊 ¿A qué hora te viene mejor que te llame hoy o mañana? 📞`,
        accion: 'NINGUNA'
      }
    default:
      return null
  }
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

// ════════════════════════════════════════════════════════════
// DETECTOR DE MOMENTO — código decide, no Groq
// ════════════════════════════════════════════════════════════
function detectarMomento(lead, historial) {
  const botMensajes  = historial.filter(m => m.origen === 'BOT').map(m => m.texto.toLowerCase())
  const leadMensajes = historial.filter(m => m.origen === 'LEAD').map(m => m.texto.toLowerCase())

  const yaHizoCierre = botMensajes.some(m =>
    m.includes('ya te tengo en agenda') ||
    m.includes('te llamo y vemos todo') ||
    m.includes('nos hablamos') ||
    m.includes('hablamos pronto')
  )
  if (yaHizoCierre) return 7

  const yaPresento = botMensajes.some(m =>
    m.includes('exporta con 1,000') ||
    m.includes('curso taller') ||
    m.includes('inscripción anticipada') ||
    m.includes('inscripcion anticipada') ||
    m.includes('diseñado para personas en tu situación')
  )

  const yaPreguntoHorario = botMensajes.some(m =>
    m.includes('a qué hora te viene mejor') ||
    m.includes('a que hora te viene mejor')
  )

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
// GENERADOR DETERMINÍSTICO — M2, M4, M6
// M3, M5, M7 → Groq
// ════════════════════════════════════════════════════════════
function generarRespuestaDeterministica(momentoActual, nombre, producto, mensajeActual, pasosVendedor, nombreVendedor) {
  const n = nombre   ? ` ${capitalizar(nombre)}`  : ''
  const p = producto ? capitalizar(producto)       : null

  // ── Interceptor de señales — aplica en TODOS los momentos ──
  const senal = interceptarSenal(mensajeActual)
  if (senal) {
    const resp = respuestaSenal(senal, nombre, nombreVendedor)
    if (resp) return { texto: resp.respuesta, accion: resp.accion }
  }

  if (momentoActual === 2) {
    const prod = p ? `El ${p} tiene bastante potencial afuera. ` : ''
    return {
      texto: `Muchas gracias${n} 😊 ${prod}Cuéntame, ¿ya tienes experiencia exportando o estás dando tus primeros pasos?`,
      accion: 'NINGUNA'
    }
  }

  if (momentoActual === 4) {
    const paso3  = pasosVendedor?.find(s => s.orden === 3)
    const cuerpo = paso3?.mensaje?.trim() || null
    if (cuerpo) {
      return {
        texto: `Mira${n}, justamente tenemos un programa diseñado para personas en tu situación. Te cuento:\n\n${cuerpo}\n\n¿Qué te parece${n}? ¿Tienes alguna duda o consulta?`,
        accion: 'NINGUNA'
      }
    }
    return {
      texto: `Mira${n}, tenemos un programa diseñado exactamente para tu caso 😊 Dame un momento y te cuento todos los detalles.`,
      accion: 'NINGUNA'
    }
  }

  if (momentoActual === 6) {
    const { confirmacion } = calcularCita(mensajeActual)
    return {
      texto: `Listo${n} 😊 quedamos ${confirmacion}. Ya te tengo en agenda 📋 Por cierto, ¿a qué país te gustaría llevar tu ${p || 'producto'}? 🌍 Así llego preparado para tu caso.`,
      accion: 'NOTIFICAR_VENDEDOR'
    }
  }

  return null
}

// ════════════════════════════════════════════════════════════
// GROQ BRAIN v19 — M3, M5, M7
// ════════════════════════════════════════════════════════════
async function consultarGroq({
  historial, textoActual, esImagen, convState,
  perfilActual, botPrompt, campaignNombre,
  pasosVendedor, momentoActual, nombreVendedor
}) {
  try {
    if (!process.env.GROQ_API_KEY) return null

    const promptBase = botPrompt
      ? botPrompt.replace(/""/g, '"').replace(/\[NOMBRE_ASESOR\]/g, nombreVendedor)
      : `Eres ${nombreVendedor}, asesor de ${campaignNombre || 'Peru Exporta TV'}.
Tu misión es calificar al lead, no venderle. El cierre es por teléfono.
Responde siempre en español, máximo 3 líneas, un emoji por mensaje.
Nunca reveles que eres IA.`

    const pasosCtx = pasosVendedor?.length
      ? `
════════════════════════════════════════
FLUJO DEL VENDEDOR — CONTENIDO EXACTO
════════════════════════════════════════
${pasosVendedor
  .filter(p => p.tipo === 'MSG')
  .map(p => `PASO ${p.orden}:\n${p.mensaje}`)
  .join('\n\n---\n\n')}
`
      : ''

    const nombre   = perfilActual.nombre   ? capitalizar(perfilActual.nombre)   : ''
    const producto = perfilActual.producto ? capitalizar(perfilActual.producto) : ''
    const convStateParaGroq = momentoActual === 7 ? 'POST_CIERRE' : convState
    const botYaHablo = historial.some(m => m.origen === 'BOT')

    const instruccionMomento = `
════════════════════════════════════════
INSTRUCCIÓN DEL SISTEMA — OBLIGATORIA
════════════════════════════════════════
El sistema detectó MOMENTO ${momentoActual}.
Tu tarea: ejecutar el MOMENTO ${momentoActual}.
Si el lead dice algo inesperado — respóndelo brevemente
y redirige al MOMENTO ${momentoActual}.
Nunca ignores lo que dice el lead.

${momentoActual === 3 ? `
MOMENTO 3 — SITUACIÓN EMPRESARIAL:
Pregunta si tiene empresa o trabaja independiente.
Base: "Entiendo 😊 Y cuéntame ${nombre}, ¿tienes empresa
constituida o por ahora trabajas de manera independiente?"
Si pregunta precio → responde brevemente y redirige.
Si dice no le interesa → accion: CERRAR_LEAD
` : ''}

${momentoActual === 5 ? `
MOMENTO 5 — COORDINAR LLAMADA:
Consigue el horario. Solo eso.
Base: "¿A qué hora te viene mejor que te llame${nombre ? ' ' + nombre : ''}?
¿Hoy o mañana? 📞"
Si pregunta precio → "En la llamada te explico todo 😊
¿A qué hora te viene mejor?"
Si dice no le interesa → accion: CERRAR_LEAD
accion DEBE ser NINGUNA salvo rechazo explícito.
` : ''}

${momentoActual === 7 ? `
MOMENTO 7 — POST CIERRE:
La cita está confirmada. El lead sigue escribiendo.
1. Responde natural, breve y cálido.
2. Recoge información nueva en datosExtraidos.
3. Máximo 2 líneas. Un emoji.
4. NO preguntes horario de nuevo.
5. NO presentes el programa de nuevo.
accion DEBE ser NINGUNA — salvo:
- Lead rechaza explícitamente → CERRAR_LEAD
- Lead declara pago → PEDIR_COMPROBANTE
` : ''}

EXTRAE siempre en datosExtraidos:
- paisDestino: país que mencionó si lo dijo
- inteligenciaComercial: 1 línea perfil del lead
- palancierre: 1 línea palanca de cierre
- anguloEntrada: 1 línea cómo abrir la llamada
`

    const systemPrompt =
`${promptBase}

${pasosCtx}

CONTEXTO (nunca menciones esto al lead):
- Nombre: ${nombre}
- Producto: ${producto}
- Estado: ${convStateParaGroq}
- Bot ya habló: ${botYaHablo}
- Recibió imagen: ${esImagen}
${botYaHablo ? `- CRÍTICO: Ya te presentaste como ${nombreVendedor}. NO vuelvas a saludar.` : ''}

${instruccionMomento}

FORMATO — ÚNICAMENTE JSON válido.
Sin texto antes. Sin texto después. Sin markdown. Sin backticks.
{
  "intencion": "FLUJO_NORMAL|RECHAZO|PAGO_DECLARADO|SOLICITA_LLAMADA|DESVIO|PREGUNTA_INFO",
  "respuesta": "texto al lead",
  "accion": "NINGUNA|CERRAR_LEAD|PEDIR_COMPROBANTE|NOTIFICAR_VENDEDOR",
  "pasoActual": ${momentoActual},
  "datosExtraidos": {
    "nombre": null,
    "edad": null,
    "producto": null,
    "experiencia": null,
    "tieneEmpresa": null,
    "horarioLlamada": null,
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
      method:  'POST',
      signal:  controller.signal,
      headers: {
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type':  'application/json'
      },
      body: JSON.stringify({
        model:       'llama-3.3-70b-versatile',
        max_tokens:  800,
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
    const limpio    = (() => {
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
        pasoActual:     momentoActual
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
async function ejecutarAccion({ accion, lead, conv, instancia, vendor, texto, cam, datosExtraidos, citaBriefing }) {
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
          const nombre     = capitalizar(lead.nombreDetectado)   || 'Sin nombre'
          const producto   = capitalizar(lead.productoDetectado) || 'Sin producto'
          const score      = lead.perfilScore || 0
          const emoji      = score >= 7 ? '🔴' : score >= 4 ? '🟠' : '🟡'
          const campNombre = cam?.nombre || 'MPX'
          const captado    = fechaLima()
          const cita       = citaBriefing || 'horario por confirmar'

          const intel   = datosExtraidos?.inteligenciaComercial || `${nombre} · ${producto} · primera vez exportando`
          const palanca = datosExtraidos?.palancierre           || 'conectar con su motivación principal'
          const angulo  = datosExtraidos?.anguloEntrada         || 'pregunta por su mercado destino al abrir'
          const pais    = datosExtraidos?.paisDestino           || 'por confirmar en llamada'

          const empresaLinea = datosExtraidos?.tieneEmpresa === false
            ? 'Independiente · sin empresa constituida'
            : datosExtraidos?.tieneEmpresa
              ? 'Tiene empresa constituida'
              : 'Independiente · sin empresa constituida'

          const expLinea = datosExtraidos?.experiencia
            ? 'Con experiencia exportando'
            : 'Sin experiencia · primera vez'

          const anguloFinal = pais !== 'por confirmar en llamada'
            ? `empieza por ${pais} — ya tiene destino en mente`
            : angulo

          const briefing =
`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${emoji} LEAD CALIFICADO · ${campNombre}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
https://wa.me/${lead.telefono}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
👤  ${nombre}
📦  ${producto}
🏢  ${empresaLinea}
🌱  ${expLinea}
🌍  País destino: ${pais}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📅  CITA AGENDADA
    ${cita}
    Ya están esperando tu llamada
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🧠  INTELIGENCIA COMERCIAL
    ▸ Perfil: ${intel}
    ▸ Ángulo de entrada: ${anguloFinal}
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

      case 'ACTUALIZAR_PAIS_VENDEDOR':
        if (vendor?.whatsappNumber && datosExtraidos?.paisDestino) {
          const nombre = capitalizar(lead.nombreDetectado) || 'El lead'
          await enviarTexto(
            instancia,
            vendor.whatsappNumber,
            `📍 Actualización · ${nombre} confirmó *${datosExtraidos.paisDestino}* como destino para su ${capitalizar(lead.productoDetectado) || 'producto'}`
          ).catch(() => {})
        }
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
              `📌 Tu lead escribió por otro número\nhttps://wa.me/${lead.telefono}\n👤 ${lead.nombreDetectado || 'Sin nombre'}\n💬 "${mensaje?.slice(0, 80)}"`
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

        // Extractor perfil básico en M2 antes de todo
        const momentoActual = detectarMomento(lead, historial)
        console.log(`[Flujo] Momento detectado: ${momentoActual} | nombre:${perfilActual.nombre} | producto:${perfilActual.producto}`)

        if (momentoActual === 2) {
          const extraido = extraerPerfilBasico(mensaje)
          if (extraido.nombre || extraido.producto) {
            await actualizarPerfil(lead.id, extraido)
            if (extraido.nombre)   perfilActual.nombre   = extraido.nombre
            if (extraido.producto) perfilActual.producto = extraido.producto
            console.log(`[Extractor] M2 perfil: ${JSON.stringify(extraido)}`)
          }
        }

        const cam = lead.campaignId
          ? await prisma.campaign.findUnique({
              where:   { id: lead.campaignId },
              include: { steps: { orderBy: { orden: 'asc' } } }
            })
          : null

        const pasosVendedor = cam?.steps || []

        // ════════════════════════════════════════════════════
        // DETERMINÍSTICO — M2, M4, M6 con interceptor
        // ════════════════════════════════════════════════════
        const detResp = generarRespuestaDeterministica(
          momentoActual,
          perfilActual.nombre,
          perfilActual.producto,
          mensaje,
          pasosVendedor,
          nombreVendedor
        )

        if (detResp) {
          await sleep(800)
          await enviarTexto(instanciaActiva, telefono, detResp.texto)
          await guardarMsg(lead.id, conv?.id || null, 'BOT', detResp.texto)

          if (conv?.id) {
            await prisma.conversation.update({
              where: { id: conv.id },
              data:  { lastBotMessageAt: new Date() }
            }).catch(() => {})
          }

          // Ejecutar acción si la hay
          if (detResp.accion !== 'NINGUNA' && conv?.id) {
            if (detResp.accion === 'NOTIFICAR_VENDEDOR') {
              const { citaBriefing } = calcularCita(mensaje)
              const paisM6 = extraerPais(mensaje)
              const inteligenciaM6 = {
                tieneEmpresa:          false,
                experiencia:           false,
                paisDestino:           paisM6 || 'por confirmar en llamada',
                inteligenciaComercial: `${capitalizar(perfilActual.nombre) || 'Lead'} · ${capitalizar(perfilActual.producto) || 'producto'} · primera vez exportando · sin empresa`,
                palancierre:           'no atacar precio · atacar el costo de cada mes sin exportar',
                anguloEntrada:         paisM6
                  ? `empieza por ${paisM6} — ya tiene destino en mente`
                  : 'pregunta por su mercado destino al abrir la llamada'
              }
              await ejecutarAccion({
                accion:         'NOTIFICAR_VENDEDOR',
                lead, conv,
                instancia:      instanciaActiva,
                vendor:         vendorActivo,
                texto:          mensaje,
                cam,
                datosExtraidos: inteligenciaM6,
                citaBriefing
              })
            } else {
              await ejecutarAccion({
                accion:         detResp.accion,
                lead, conv,
                instancia:      instanciaActiva,
                vendor:         vendorActivo,
                texto:          mensaje,
                cam,
                datosExtraidos: {},
                citaBriefing:   null
              })
            }
          }

          console.log(`[Flujo] M${momentoActual} DETERMINÍSTICO | accion: ${detResp.accion} | vendor: ${vendorActivo.nombre} | ${telefono}`)
          return
        }

        // ════════════════════════════════════════════════════
        // GROQ — M3, M5, M7
        // ════════════════════════════════════════════════════
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

        const respuesta = resultado?.respuesta ||
          `Un momento${perfilActual.nombre ? ` ${capitalizar(perfilActual.nombre)}` : ''} 😊 déjame revisar.`

        const accionFinal = (() => {
          const accion = resultado?.accion || 'NINGUNA'
          if (momentoActual === 7 && accion === 'NOTIFICAR_VENDEDOR') return 'NINGUNA'
          return accion
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

        if (momentoActual === 7 && resultado?.datosExtraidos?.paisDestino && conv?.id) {
          await ejecutarAccion({
            accion:         'ACTUALIZAR_PAIS_VENDEDOR',
            lead, conv,
            instancia:      instanciaActiva,
            vendor:         vendorActivo,
            texto:          mensaje,
            cam,
            datosExtraidos: resultado.datosExtraidos,
            citaBriefing:   null
          })
        }

        if (accionFinal !== 'NINGUNA' && conv?.id) {
          await ejecutarAccion({
            accion:         accionFinal,
            lead, conv,
            instancia:      instanciaActiva,
            vendor:         vendorActivo,
            texto:          mensaje,
            cam,
            datosExtraidos: resultado?.datosExtraidos || {},
            citaBriefing:   null
          })
        }

        console.log(`[Brain IA] M${momentoActual} → ${resultado?.intencion || 'FLUJO_NORMAL'} | accion: ${accionFinal} | vendor: ${vendorActivo.nombre} | ${telefono}`)

      } finally {
        await liberarLock(telefono)
      }

      return
    }

    // ════════════════════════════════════════════════════════
    // LEAD NUEVO
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
