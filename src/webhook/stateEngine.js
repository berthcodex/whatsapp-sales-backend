// src/webhook/stateEngine.js — v8 HIDATA 111X
// Arquitectura: Handler → Brain → ActionExecutor → ProfileBuilder
// NUEVO: Código controla el flujo. Groq ejecuta. Nunca al revés.
// El momento actual lo decide el código, no Groq.
// Multi-vendor ready + Guard de propiedad de leads
// Router inteligente 2 capas — Groq como autoridad única
// Redis lock — anti doble respuesta
// Joan, Cristina, Francisco — sin conflictos

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
// DETECTOR DE MOMENTO — el código decide, no Groq
// Basado en datos reales del lead en BD
// ════════════════════════════════════════════════════════════
function detectarMomento(lead, historial) {
  const nombre   = lead.nombreDetectado
  const producto = lead.productoDetectado

  // Sin nombre ni producto → Momento 2 (experiencia)
  if (!nombre && !producto) return 2

  // Buscar en historial si ya preguntamos empresa
  const botMensajes = historial.filter(m => m.origen === 'BOT').map(m => m.texto)
  const leadMensajes = historial.filter(m => m.origen === 'LEAD').map(m => m.texto.toLowerCase())

  const yaPreguntoEmpresa = botMensajes.some(m =>
    m.toLowerCase().includes('empresa constituida') ||
    m.toLowerCase().includes('independiente')
  )

  const leadRespondioEmpresa = yaPreguntoEmpresa && leadMensajes.some(m =>
    m.includes('empresa') || m.includes('independiente') ||
    m.includes('negocio') || m.includes('ruc') ||
    m.includes('constituida') || m.includes('natural') ||
    m.includes('persona') || m.includes('no tengo') ||
    m.includes('trabajo') || m.includes('casa')
  )

  // Buscar si ya preguntamos experiencia
  const yaPreguntoExperiencia = botMensajes.some(m =>
    m.toLowerCase().includes('experiencia exportando') ||
    m.toLowerCase().includes('empezando desde cero')
  )

  const leadRespondioExperiencia = yaPreguntoExperiencia && leadMensajes.some(m =>
    m.includes('primera') || m.includes('nunca') ||
    m.includes('experiencia') || m.includes('exportado') ||
    m.includes('cero') || m.includes('antes') ||
    m.includes('si') || m.includes('sí')
  )

  // Buscar si ya presentamos el programa
  const yaPresento = botMensajes.some(m =>
    m.toLowerCase().includes('exporta con 1,000') ||
    m.toLowerCase().includes('curso taller') ||
    m.toLowerCase().includes('inscripción anticipada')
  )

  if (yaPresento) return 5  // Momento 5 — coordinar llamada
  if (leadRespondioEmpresa) return 4  // Momento 4 — presentar programa
  if (yaPreguntoEmpresa && !leadRespondioEmpresa) return 3  // Esperando respuesta empresa
  if (leadRespondioExperiencia) return 3  // Momento 3 — preguntar empresa
  if (yaPreguntoExperiencia) return 2  // Esperando respuesta experiencia
  return 2  // Default — preguntar experiencia
}

// ════════════════════════════════════════════════════════════
// GROQ BRAIN v8 — Código controla el flujo. Groq ejecuta.
// ════════════════════════════════════════════════════════════
async function consultarGroq({
  historial, textoActual, esImagen, convState,
  perfilActual, botPrompt, campaignNombre,
  pasosVendedor, momentoActual
}) {
  try {
    if (!process.env.GROQ_API_KEY) return null

    const promptBase = botPrompt
      ? botPrompt.replace(/""/g, '"')
      : `Eres Jhon, asesor de ${campaignNombre || 'Peru Exporta TV'}.
Tu misión es calificar al lead, no venderle. El cierre es por teléfono.
Responde siempre en español, máximo 3 líneas, un emoji por mensaje.
Nunca reveles que eres IA.`

    // Pasos del vendedor como contexto
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

    // Instrucción de momento — el código manda
    const instruccionMomento = `
════════════════════════════════════════
INSTRUCCIÓN DEL SISTEMA — OBLIGATORIA
════════════════════════════════════════
El sistema detectó que estamos en el MOMENTO ${momentoActual}.
Tu ÚNICA tarea en esta respuesta es ejecutar el MOMENTO ${momentoActual}.
NO puedes avanzar a otro momento. NO puedes saltarte este momento.
El código ya verificó que este es el momento correcto.

${momentoActual === 2 ? `MOMENTO 2: Pregunta experiencia exportando. Usa el PASO 2 del vendedor como base. Potencialo con nombre="${perfilActual.nombre || ''}" y producto="${perfilActual.producto || ''}".` : ''}
${momentoActual === 3 ? `MOMENTO 3: Pregunta si tiene empresa constituida o trabaja independiente. Mensaje natural: "Entiendo 😊 Y cuéntame ${perfilActual.nombre || ''}, ¿tienes empresa constituida o por ahora trabajas de manera independiente?"` : ''}
${momentoActual === 4 ? `MOMENTO 4: Presenta el programa COMPLETO. COPIA el PASO 3 del vendedor PALABRA POR PALABRA sin resumir ni acortar. Antes agrega "Mira ${perfilActual.nombre || ''}, justamente tenemos un programa diseñado para personas en tu situación. Te cuento:" y después agrega "¿Qué te parece ${perfilActual.nombre || ''}? ¿Tienes alguna duda o consulta?"` : ''}
${momentoActual === 5 ? `MOMENTO 5: Consigue el horario para la llamada. "Para que nuestro asesor te explique todo con calma, ¿a qué hora te viene mejor una llamada ${perfilActual.nombre || ''}? ¿Hoy o mañana?"` : ''}
${momentoActual === 6 ? `MOMENTO 6: Cierra calurosamente. "Perfecto ${perfilActual.nombre || ''} 😊 Le paso tu información al asesor ahora mismo. Te contactarán a la hora acordada. Cualquier duda aquí estoy 👋" → accion: NOTIFICAR_VENDEDOR` : ''}
`

    const botYaHablo = historial.some(m => m.origen === 'BOT')

    const systemPrompt =
`${promptBase}

${pasosCtx}

CONTEXTO TÉCNICO (nunca lo menciones al lead):
- Perfil: ${JSON.stringify(perfilActual)}
- Estado conversación: ${convState}
- Bot ya habló: ${botYaHablo}
- Recibió imagen: ${esImagen}
${botYaHablo ? '- CRÍTICO: Ya te presentaste. NO vuelvas a saludar.' : ''}

${instruccionMomento}

INSTRUCCIÓN CRÍTICA DE FORMATO:
Tu respuesta COMPLETA debe ser ÚNICAMENTE JSON válido.
Sin texto antes. Sin texto después. Sin markdown. Sin backticks.
Primer carácter { — Último carácter }

{
  "intencion": "FLUJO_NORMAL|RECHAZO|PAGO_DECLARADO|SOLICITA_LLAMADA|REACTIVACION|IMAGEN_PRODUCTO|COMPROBANTE|DESVIO|PREGUNTA_INFO",
  "respuesta": "texto que se envía al lead como Jhon humano",
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
    "consultaConOtro": null
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
        model: 'llama-3.3-70b-versatile',
        max_tokens: 1200,
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

    const data = await response.json()
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
        intencion: 'FLUJO_NORMAL',
        respuesta: contenido,
        accion: 'NINGUNA',
        datosExtraidos: {},
        perfilScore: 0,
        pasoActual: momentoActual
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
async function ejecutarAccion({ accion, lead, conv, instancia, vendor, texto }) {
  try {
    switch (accion) {

      case 'CERRAR_LEAD':
        await prisma.lead.update({
          where: { id: lead.id },
          data: { estado: 'CERRADO' }
        }).catch(() => {})
        await prisma.conversation.update({
          where: { id: conv.id },
          data: { state: 'CLOSED' }
        }).catch(() => {})
        console.log(`[ActionExecutor] CERRAR_LEAD: ${lead.telefono}`)
        break

      case 'NOTIFICAR_VENDEDOR':
        if (vendor?.whatsappNumber) {
          const nombre   = lead.nombreDetectado  || 'Sin nombre'
          const producto = lead.productoDetectado || 'Sin producto'
          const score    = lead.perfilScore       || 0
          const emoji    = score >= 7 ? '🔴' : score >= 4 ? '🟠' : '🟡'
          const briefing =
`${emoji} LEAD LISTO PARA LLAMADA

📱 wa.me/${lead.telefono}
👤 ${nombre}
📦 ${producto}
💬 "${texto?.slice(0, 100)}"

⚡ ${score >= 7 ? 'Llama AHORA — alta prioridad' : 'Llama hoy'}`
          await enviarTexto(instancia, vendor.whatsappNumber, briefing).catch(() => {})
        }
        await prisma.conversation.update({
          where: { id: conv.id },
          data: { state: 'NOTIFIED', vendorNotifiedAt: new Date() }
        }).catch(() => {})
        console.log(`[ActionExecutor] NOTIFICAR_VENDEDOR: ${lead.telefono}`)
        break

      case 'PEDIR_COMPROBANTE':
        console.log(`[ActionExecutor] PEDIR_COMPROBANTE: ${lead.telefono}`)
        break

      case 'CAMBIAR_ESTADO_PAYMENT':
        await prisma.lead.update({
          where: { id: lead.id },
          data: { estado: 'PAGO_PENDIENTE' }
        }).catch(() => {})
        await prisma.conversation.update({
          where: { id: conv.id },
          data: { state: 'PAYMENT' }
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
          where: { leadId: lead.id },
          orderBy: { createdAt: 'desc' }
        })

        await guardarMsg(lead.id, conv?.id || null, 'LEAD', esImagen ? '[imagen]' : mensaje)

        if (conv?.id) {
          await prisma.conversation.update({
            where: { id: conv.id },
            data: { lastLeadMessageAt: new Date() }
          }).catch(() => {})
        }

        const convState = conv?.state || 'ACTIVE'

        if (convState === 'CLOSED' || lead.estado === 'CERRADO') {
          console.log(`[Motor] Lead cerrado ignorado: ${telefono}`)
          return
        }

        const historial = await prisma.message.findMany({
          where: { leadId: lead.id },
          orderBy: { createdAt: 'asc' },
          take: 15
        })

        const perfilActual = {
          nombre:     lead.nombreDetectado   || null,
          producto:   lead.productoDetectado || null,
          estado:     lead.estado            || null,
          pasoActual: lead.pasoActual        || 1
        }

        // ── CÓDIGO DETECTA EL MOMENTO — no Groq ─────────────
        const momentoActual = detectarMomento(lead, historial)
        console.log(`[Flujo] Momento detectado: ${momentoActual} | nombre:${perfilActual.nombre} | producto:${perfilActual.producto}`)

        // ── Campaña + pasos del vendedor ─────────────────────
        const cam = lead.campaignId
          ? await prisma.campaign.findUnique({
              where: { id: lead.campaignId },
              include: { steps: { orderBy: { orden: 'asc' } } }
            })
          : null

        const pasosVendedor = cam?.steps || []

        // ── GROQ — ejecuta el momento que el código decidió ──
        const resultado = await consultarGroq({
          historial,
          textoActual:    mensaje,
          esImagen,
          convState,
          perfilActual,
          botPrompt:      cam?.botPrompt     || null,
          campaignNombre: cam?.nombre        || 'Peru Exporta TV',
          pasosVendedor,
          momentoActual
        })

        const respuesta = resultado?.respuesta || `Un momento, déjame revisar 😊`

        if (conv?.id) {
          await prisma.conversation.update({
            where: { id: conv.id },
            data: { lastBotMessageAt: new Date() }
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
            data: { pasoActual: resultado.pasoActual }
          }).catch(() => {})
        }

        if (resultado?.accion && resultado.accion !== 'NINGUNA' && conv?.id) {
          await ejecutarAccion({
            accion:    resultado.accion,
            lead, conv,
            instancia: instanciaActiva,
            vendor:    vendorActivo,
            texto:     mensaje
          })
        }

        console.log(`[Brain IA] momento:${momentoActual} → ${resultado?.intencion || 'FLUJO_NORMAL'} | accion: ${resultado?.accion || 'NINGUNA'} | vendor: ${vendorActivo.nombre} | ${telefono}`)

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
          vendedor: vendor?.nombre   || '',
          curso:    campaign?.nombre || '',
          nombre:   ''
        })
      : `Hola 👋 Soy Jhon, asesor de Peru Exporta TV 😊\n\n¿Cómo te llamas y qué producto tienes en mente para exportar?`

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

    console.log(`[Motor] Lead nuevo: ${telefono} | vendor: ${vendor.nombre} | campaign: ${campaign?.slug || 'sin campaña'}`)

  } catch (err) {
    console.error('[Motor] Error crítico:', err.message)
  }
}
