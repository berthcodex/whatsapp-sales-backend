// src/webhook/stateEngine.js — v4 HIDATA 111X
// Arquitectura: Handler → Brain → ActionExecutor → ProfileBuilder
// Multi-vendor ready + Guard de propiedad de leads
// Router inteligente 2 capas — Groq como autoridad única
// Fix: sanitización de botPrompt "" → "
// Guard anti-ruido ELIMINADO — debounce + idempotencia en handler cubren todos los casos
// Joan, Cristina, Francisco — sin conflictos

import prisma from '../db/prisma.js'
import { resolverCampaign } from './routerInteligente.js'
import { enviarTexto } from '../whatsapp/sender.js'

const sleep = ms => new Promise(r => setTimeout(r, ms))

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
// GROQ BRAIN v3 — autoridad única, devuelve JSON estructurado
// Cerebro decide. Código ejecuta. Nunca al revés.
// Fix: botPrompt sanitizado — "" → " antes de enviar a Groq
// ════════════════════════════════════════════════════════════
async function consultarGroq({ historial, textoActual, esImagen, convState, perfilActual, botPrompt, campaignNombre }) {
  try {
    if (!process.env.GROQ_API_KEY) return null

    const promptBase = botPrompt
      ? botPrompt.replace(/""/g, '"')
      : `Eres Jhon, asesor de ${campaignNombre || 'Peru Exporta'}.
Tu misión es calificar al lead, no venderle. El cierre es por teléfono.
Responde siempre en español, máximo 3 líneas, un emoji por mensaje.
Nunca reveles que eres IA. Si preguntan: "Soy Jhon, asesor de Peru Exporta 😊"
Precio: S/457 hasta el 30 de abril, luego S/757.`

    const systemPrompt =
`${promptBase}

CONTEXTO TÉCNICO DEL LEAD (nunca lo menciones al lead):
- Estado actual de la conversación: ${convState}
- Perfil recopilado hasta ahora: ${JSON.stringify(perfilActual)}
- Recibió imagen: ${esImagen}

ANTES DE RESPONDER analiza internamente:
1. ¿Qué intención real tiene este mensaje?
2. ¿Qué datos nuevos me dio el lead?
3. ¿Qué acción debe ejecutar el sistema?

RESPONDE ÚNICAMENTE EN JSON VÁLIDO — SIN TEXTO ADICIONAL, SIN MARKDOWN, SIN BACKTICKS:
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
    if (!response.ok) {
      console.error('[Brain IA] Groq HTTP error:', response.status)
      return null
    }

    const data = await response.json()
    const contenido = data.choices[0]?.message?.content?.trim()

    const limpio = contenido
      .replace(/```json/gi, '')
      .replace(/```/g, '')
      .trim()

    try {
      return JSON.parse(limpio)
    } catch {
      console.error('[Brain IA] JSON parse falló, contenido raw:', contenido?.slice(0, 200))
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
// Solo escribe campos que Groq extrajo — nunca sobreescribe con null
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
// ACTION EXECUTOR — código puro ejecuta lo que Groq decidió
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
`${emoji} LEAD SOLICITA LLAMADA

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
// ENTRY POINT — llamado desde handler.js
// ════════════════════════════════════════════════════════════
export async function processIncoming({ telefono, mensaje, esImagen, instancia }) {
  try {

    // ── Vendor por instancia ─────────────────────────────────
    const vendor = await prisma.vendor.findFirst({
      where: { instanciaEvolution: instancia, activo: true }
    })

    if (!vendor) {
      console.error(`[Motor] Vendor no encontrado para instancia: ${instancia}`)
      return
    }

    // ── Lead existente ───────────────────────────────────────
    const lead = await prisma.lead.findUnique({ where: { telefono } })

    // ════════════════════════════════════════════════════════
    // LEAD EXISTENTE
    // ════════════════════════════════════════════════════════
    if (lead) {

      // ── GUARD DE PROPIEDAD — multi-vendor ─────────────────
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

      const perfilActual = {
        nombre:   lead.nombreDetectado   || null,
        producto: lead.productoDetectado || null,
        estado:   lead.estado            || null
      }

      const historial = await prisma.message.findMany({
        where: { leadId: lead.id },
        orderBy: { createdAt: 'asc' },
        take: 15
      })

      const cam = lead.campaignId
        ? await prisma.campaign.findUnique({
            where: { id: lead.campaignId }
          })
        : null

      // ── GROQ — autoridad única ───────────────────────────
      const resultado = await consultarGroq({
        historial,
        textoActual: mensaje,
        esImagen,
        convState,
        perfilActual,
        botPrompt:      cam?.botPrompt || null,
        campaignNombre: cam?.nombre    || 'Peru Exporta'
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

      if (resultado?.accion && resultado.accion !== 'NINGUNA' && conv?.id) {
        await ejecutarAccion({
          accion:    resultado.accion,
          lead, conv,
          instancia: instanciaActiva,
          vendor:    vendorActivo,
          texto:     mensaje
        })
      }

      console.log(`[Brain IA] ${convState} → ${resultado?.intencion || 'FLUJO_NORMAL'} | accion: ${resultado?.accion || 'NINGUNA'} | vendor: ${vendorActivo.nombre} | ${telefono}`)
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
        pasoActual:    0,
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
        currentStep:       0,
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
      : `Hola 👋 te saluda Peru Exporta\n\n¿Cómo te llamas y qué producto tienes en mente para exportar? 👇`

    await sleep(1000)
    await enviarTexto(instancia, telefono, msgBienvenida)
    await guardarMsg(newLead.id, conv?.id || null, 'BOT', msgBienvenida)

    if (conv?.id) {
      await prisma.conversation.update({
        where: { id: conv.id },
        data: {
          currentStep:      paso1?.orden || 1,
          lastBotMessageAt: new Date()
        }
      })
    }

    await prisma.lead.update({
      where: { id: newLead.id },
      data: { pasoActual: paso1?.orden || 1 }
    })

    console.log(`[Motor] Lead nuevo: ${telefono} | vendor: ${vendor.nombre} | campaign: ${campaign?.slug || 'sin campaña'}`)

  } catch (err) {
    console.error('[Motor] Error crítico:', err.message)
  }
}
