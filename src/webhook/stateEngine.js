// src/motor/stateEngine.js — v2 HIDATA 100X
// Groq como autoridad única. Código como músculo.
// Arquitectura: Handler → Brain → ActionExecutor → ProfileBuilder

import { detectarCursoCampana } from '../webhook/classifier.js'
import { enviarTexto } from '../whatsapp/sender.js'

const sleep = ms => new Promise(r => setTimeout(r, ms))

// ════════════════════════════════════════════════════════════
// GROQ BRAIN v2 — autoridad única, devuelve JSON estructurado
// ════════════════════════════════════════════════════════════
async function consultarGroq({ historial, textoActual, esImagen, convState, perfilActual, botPrompt, campaignNombre }) {
  try {
    if (!process.env.GROQ_API_KEY) return null

    const promptBase = botPrompt ||
      `Eres Jhon, asesor de ${campaignNombre || 'Peru Exporta'}.
Tu misión es calificar al lead, no venderle. El cierre es por teléfono.
Responde siempre en español, máximo 3 líneas, un emoji por mensaje.
Nunca reveles que eres IA. Si preguntan: "Soy Jhon, asesor de Peru Exporta 😊"
Precio: S/457 hasta el 30 de abril, luego S/757.`

    const systemPrompt = `${promptBase}

CONTEXTO TÉCNICO DEL LEAD (no menciones esto al lead):
- Estado actual: ${convState}
- Perfil recopilado hasta ahora: ${JSON.stringify(perfilActual)}
- Es imagen: ${esImagen}

ANÁLISIS REQUERIDO:
Antes de responder analiza internamente:
1. ¿Qué intención real tiene este mensaje?
2. ¿Qué datos nuevos me dio el lead?
3. ¿Qué acción debe ejecutar el sistema?

RESPONDE ÚNICAMENTE EN JSON VÁLIDO, SIN TEXTO ADICIONAL, SIN MARKDOWN:
{
  "intencion": "FLUJO_NORMAL|RECHAZO|PAGO_DECLARADO|SOLICITA_LLAMADA|REACTIVACION|IMAGEN_PRODUCTO|COMPROBANTE|DESVIO",
  "respuesta": "texto que se envía al lead como Jhon humano",
  "accion": "NINGUNA|CERRAR_LEAD|PEDIR_COMPROBANTE|NOTIFICAR_VENDEDOR|CAMBIAR_ESTADO_PAYMENT",
  "datosExtraidos": {
    "nombre": null,
    "edad": null,
    "producto": null,
    "experiencia": null,
    "tieneEmpresa": null,
    "horarioLlamada": null,
    "conocePrecio": null
  },
  "perfilScore": 0
}`

    const mensajesCtx = historial.slice(-12).map(m => ({
      role: m.origen === 'LEAD' ? 'user' : 'assistant',
      content: m.texto
    }))

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 5000)

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        max_tokens: 400,
        temperature: 0.4,
        messages: [
          { role: 'system', content: systemPrompt },
          ...mensajesCtx,
          { role: 'user', content: esImagen ? '[El lead envió una imagen]' : textoActual }
        ]
      })
    })

    clearTimeout(timeout)
    if (!response.ok) return null

    const data = await response.json()
    const contenido = data.choices[0]?.message?.content?.trim()

    // Parsear JSON — limpieza defensiva
    const limpio = contenido
      .replace(/```json/gi, '')
      .replace(/```/g, '')
      .trim()

    try {
      return JSON.parse(limpio)
    } catch {
      // Groq no devolvió JSON válido → respuesta libre como fallback
      return {
        intencion: 'FLUJO_NORMAL',
        respuesta: contenido,
        accion: 'NINGUNA',
        datosExtraidos: {},
        perfilScore: 0
      }
    }

  } catch (err) {
    console.error('[Brain IA] Groq falló:', err.message)
    return null
  }
}

// ════════════════════════════════════════════════════════════
// PROFILE BUILDER — acumula perfil del lead en Supabase
// ════════════════════════════════════════════════════════════
async function actualizarPerfil(prisma, leadId, datosExtraidos, perfilScore) {
  try {
    const updates = {}
    if (datosExtraidos.nombre)     updates.nombreDetectado   = datosExtraidos.nombre
    if (datosExtraidos.producto)   updates.productoDetectado = datosExtraidos.producto
    if (Object.keys(updates).length > 0) {
      await prisma.lead.update({ where: { id: leadId }, data: updates })
    }
  } catch(e) { console.error('[ProfileBuilder]', e.message) }
}

// ════════════════════════════════════════════════════════════
// ACTION EXECUTOR — código puro ejecuta lo que Groq decidió
// ════════════════════════════════════════════════════════════
async function ejecutarAccion({ accion, prisma, lead, conv, instancia, vendor, texto }) {
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
          const perfil = lead.nombreDetectado || 'Sin nombre'
          const producto = lead.productoDetectado || 'Sin producto'
          const briefing = `📞 LEAD SOLICITA LLAMADA\n\n📱 wa.me/${lead.telefono}\n👤 ${perfil}\n📦 ${producto}\n💬 "${texto?.slice(0, 100)}"\n\n⚡ Llama ahora — está esperando`
          await enviarTexto(instancia, vendor.whatsappNumber, briefing).catch(() => {})
        }
        await prisma.conversation.update({
          where: { id: conv.id },
          data: { state: 'NOTIFIED', vendorNotifiedAt: new Date() }
        }).catch(() => {})
        console.log(`[ActionExecutor] NOTIFICAR_VENDEDOR: ${lead.telefono}`)
        break

      case 'PEDIR_COMPROBANTE':
        // Solo registrar estado — la respuesta ya la envió Groq
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
// VENDOR BRIEFING COMPLETO — ficha de calidad YC-level
// ════════════════════════════════════════════════════════════
function construirBriefing({ lead, clasif, historial, campaignNombre }) {
  const score = clasif?.perfilScore || 0
  const emoji = score >= 7 ? '🔴' : score >= 4 ? '🟠' : '🟡'
  const nombre = lead.nombreDetectado || 'Sin nombre'
  const producto = lead.productoDetectado || 'Sin producto'
  const historialTexto = historial
    .filter(m => m.origen === 'LEAD')
    .slice(-5)
    .map(m => `  › "${m.texto.slice(0, 80)}"`)
    .join('\n')

  return `${emoji} LEAD CALIFICADO — SCORE ${score}/10

📱 wa.me/${lead.telefono}
👤 ${nombre}
📦 ${producto}
📊 Perfil: ${score >= 7 ? 'ALTA PRIORIDAD' : score >= 4 ? 'MEDIA' : 'BAJA'}

💬 Últimas respuestas:
${historialTexto}

⚡ Tip de cierre: ${
  producto !== 'Sin producto'
    ? `Pregúntale por la región y volumen de ${producto}. Ya tiene producto concreto.`
    : 'Ayúdalo a identificar su producto primero.'
}

📞 Llama ${score >= 7 ? 'AHORA' : 'hoy'}`
}

// ════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════
async function guardarMsg(prisma, leadId, convId, origen, texto) {
  try {
    await prisma.message.create({
      data: { leadId, conversationId: convId || null, origen, texto }
    })
  } catch(e) { console.error('[Motor] guardarMsg:', e.message) }
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

function interp(msg, vars) {
  return (msg || '')
    .replace(/\{\{telefono\}\}/g, vars.telefono || '')
    .replace(/\{\{nombre\}\}/g,   vars.nombre   || '')
    .replace(/\{\{vendedor\}\}/g, vars.vendedor  || '')
    .replace(/\{\{curso\}\}/g,    vars.curso     || '')
}

// ════════════════════════════════════════════════════════════
// ENTRY POINT — llamado desde handler.js
// ════════════════════════════════════════════════════════════
export async function processIncoming({ telefono, mensaje, esImagen, sendMessage, notifyVendor, prisma: prismaExterno }) {
  // prisma se importa aquí para no romper el patrón existente
  const { default: prisma } = prismaExterno
    ? { default: prismaExterno }
    : await import('../db/prisma.js')

  try {
    // ── Buscar vendor por instancia ──────────────────────────
    const vendor = await prisma.vendor.findFirst({
      where: { activo: true, esAdmin: true }
    })
    if (!vendor) return

    const instancia = vendor.instanciaEvolution

    // ── Buscar lead existente ────────────────────────────────
    const lead = await prisma.lead.findUnique({ where: { telefono } })

    // ════════════════════════════════════════════════
    // LEAD EXISTENTE
    // ════════════════════════════════════════════════
    if (lead) {
      const conv = await prisma.conversation.findFirst({
        where: { leadId: lead.id },
        orderBy: { createdAt: 'desc' }
      })

      await guardarMsg(prisma, lead.id, conv?.id || null, 'LEAD', esImagen ? '[imagen]' : mensaje)

      if (conv?.id) {
        await prisma.conversation.update({
          where: { id: conv.id },
          data: { lastLeadMessageAt: new Date() }
        }).catch(() => {})
      }

      const convState = conv?.state || 'ACTIVE'
      if (convState === 'CLOSED' || lead.estado === 'CERRADO') return

      // Perfil actual acumulado
      const perfilActual = {
        nombre: lead.nombreDetectado || null,
        producto: lead.productoDetectado || null
      }

      // Historial de conversación
      const historial = await prisma.message.findMany({
        where: { leadId: lead.id },
        orderBy: { createdAt: 'asc' },
        take: 15
      })

      // Campaign y botPrompt
      const cam = lead.campaignId
        ? await prisma.campaign.findUnique({ where: { id: lead.campaignId } })
        : null

      // ── GROQ como autoridad única ────────────────────────
      const resultado = await consultarGroq({
        historial,
        textoActual: mensaje,
        esImagen,
        convState,
        perfilActual,
        botPrompt: cam?.botPrompt || null,
        campaignNombre: cam?.nombre || 'Peru Exporta'
      })

      // Fallback si Groq falla
      const respuesta = resultado?.respuesta ||
        `Un momento, déjame revisar tu consulta 😊`

      // Marcar lastBotMessageAt ANTES de enviar (anti race condition)
      if (conv?.id) {
        await prisma.conversation.update({
          where: { id: conv.id },
          data: { lastBotMessageAt: new Date() }
        }).catch(() => {})
      }

      await sleep(800)
      await enviarTexto(instancia, telefono, respuesta)
      await guardarMsg(prisma, lead.id, conv?.id || null, 'BOT', respuesta)

      // Profile Builder — acumula datos extraídos por Groq
      if (resultado?.datosExtraidos) {
        await actualizarPerfil(prisma, lead.id, resultado.datosExtraidos, resultado.perfilScore)
      }

      // Action Executor — ejecuta lo que Groq decidió
      if (resultado?.accion && resultado.accion !== 'NINGUNA' && conv?.id) {
        await ejecutarAccion({
          accion: resultado.accion,
          prisma, lead, conv,
          instancia, vendor,
          texto: mensaje
        })
      }

      // Log
      console.log(`[Brain IA] ${convState} → ${resultado?.intencion || 'FLUJO_NORMAL'}: ${telefono}`)
      return
    }

    // ════════════════════════════════════════════════
    // LEAD NUEVO
    // ════════════════════════════════════════════════
    const cursoCampana = detectarCursoCampana(mensaje)
    const campaign = await getCampaign(prisma, cursoCampana?.slug)

    const newLead = await prisma.lead.create({
      data: {
        telefono,
        campaignId: campaign?.id || null,
        vendorId: vendor.id,
        pasoActual: 0,
        estado: 'EN_FLUJO',
        ultimoMensaje: new Date()
      }
    })

    const conv = await prisma.conversation.create({
      data: {
        leadId: newLead.id,
        campaignId: campaign?.id || null,
        vendorId: vendor.id,
        state: 'ACTIVE',
        currentStep: 0,
        lastLeadMessageAt: new Date()
      }
    }).catch(async () => {
      return await prisma.conversation.findFirst({ where: { leadId: newLead.id } })
    })

    await guardarMsg(prisma, newLead.id, conv?.id || null, 'LEAD', mensaje)

    const pasos = campaign?.steps?.filter(s => s.tipo === 'MSG') || []
    const paso1 = pasos[0]

    const msgBienvenida = paso1?.mensaje
      ? interp(paso1.mensaje, {
          telefono, vendedor: vendor?.nombre || '',
          curso: campaign?.nombre || '', nombre: ''
        })
      : `Hola 👋 te saluda Peru Exporta\n\n¿Cómo te llamas y qué producto tienes en mente para exportar? 👇`

    await sleep(1000)
    await enviarTexto(instancia, telefono, msgBienvenida)
    await guardarMsg(prisma, newLead.id, conv?.id || null, 'BOT', msgBienvenida)

    if (conv?.id) {
      await prisma.conversation.update({
        where: { id: conv.id },
        data: { currentStep: paso1?.orden || 1, lastBotMessageAt: new Date() }
      })
    }

    await prisma.lead.update({
      where: { id: newLead.id },
      data: { pasoActual: paso1?.orden || 1 }
    })

    console.log(`[Motor] Lead nuevo: ${telefono} | ${campaign?.slug || 'orgánico'}`)

  } catch (err) {
    console.error('[Motor] Error:', err.message)
  }
}
