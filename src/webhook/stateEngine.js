// src/webhook/stateEngine.js — Sprint 5 DEFINITIVO
// Groq presente en TODA la conversación:
// - ACTIVE: protege el FlowBuilder, regresa leads desviados
// - NOTIFIED: responde inteligentemente precio/horarios/dudas
// FlowBuilder sigue siendo el esqueleto — Groq es el cerebro

import { detectarCursoCampana } from './classifier.js'
import { enviarTexto } from '../whatsapp/sender.js'

const sleep = ms => new Promise(r => setTimeout(r, ms))

function norm(t) {
  return (t || '').toLowerCase().normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ').trim()
}
function contiene(texto, kws) {
  return kws.some(kw => norm(texto).includes(norm(kw)))
}

const KW_NO_INTERES = ['ya no','no me interesa','gracias igual','olvidalo','no gracias','no quiero']
const KW_LLAMADA   = ['llamame','llámame','me llama','llame','mañana','hoy a','esta tarde','a las']

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
// GROQ — cerebro de toda la conversación
// Decide si el lead avanzó el flujo o se desvió
// ════════════════════════════════════════════════════════════
async function consultarGroq({ historial, textoActual, pasoActual, campaign, modo }) {
  try {
    if (!process.env.GROQ_API_KEY) return null

    const promptBase = campaign?.botPrompt ||
      `Eres un asesor de ventas de ${campaign?.nombre || 'Perú Exporta TV'}.
Tu objetivo es que el lead se inscriba al curso de exportación.
Responde siempre en español, de forma amable y directa.
Máximo 3 líneas por respuesta.
Si el lead pregunta precio: S/457 hasta el 30 de abril, luego S/757.
Si el lead pregunta horarios: sábados 8-10am, online por Zoom.
Si el lead pregunta certificado: sí, certificado ESCEX reconocido.
Si el lead quiere que lo llamen: confirma que su asesor lo contactará pronto.
Siempre termina con una pregunta o invitación a inscribirse.`

    const mensajesCtx = historial.slice(-10).map(m => ({
      role: m.origen === 'LEAD' ? 'user' : 'assistant',
      content: m.texto
    }))

    let systemPrompt = promptBase

    // En modo ACTIVE: Groq decide si el lead respondió el paso o se desvió
    if (modo === 'ACTIVE' && pasoActual) {
      systemPrompt += `\n\nPASO ACTUAL DEL FLUJO: "${pasoActual}"
Si el mensaje del lead ES una respuesta a esta pregunta → responde SOLO con: {"avanzar": true}
Si el mensaje del lead NO es una respuesta (pregunta otra cosa, se desvía) → responde con una respuesta natural que conteste su duda Y lo regrese al paso actual. Formato: {"avanzar": false, "respuesta": "tu mensaje aquí"}`
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 4000)

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        max_tokens: 250,
        temperature: 0.6,
        messages: [
          { role: 'system', content: systemPrompt },
          ...mensajesCtx,
          { role: 'user', content: textoActual }
        ]
      })
    })

    clearTimeout(timeout)
    if (!response.ok) return null

    const data = await response.json()
    const contenido = data.choices[0]?.message?.content?.trim()

    // Intentar parsear JSON (modo ACTIVE)
    if (modo === 'ACTIVE') {
      try {
        const parsed = JSON.parse(contenido)
        return parsed
      } catch {
        // Si Groq no devolvió JSON → tratar como respuesta libre
        return { avanzar: false, respuesta: contenido }
      }
    }

    return { respuesta: contenido }

  } catch (err) {
    console.error('[Brain IA] Groq falló:', err.message)
    return null
  }
}

// ════════════════════════════════════════════════════════════
// MOTOR PRINCIPAL
// ════════════════════════════════════════════════════════════
export async function procesarConMotor({ prisma, instancia, numero, texto, tieneImagen, vendor }) {
  try {
    const lead = await prisma.lead.findUnique({ where: { telefono: numero } })

    // ── LEAD EXISTENTE ────────────────────────────────────────
    if (lead) {
      const conv = await prisma.conversation.findFirst({
        where: { leadId: lead.id },
        orderBy: { createdAt: 'desc' }
      })

      await guardarMsg(prisma, lead.id, conv?.id || null, 'LEAD', texto || '[imagen]')

      if (conv?.id) {
        await prisma.conversation.update({
          where: { id: conv.id },
          data: { lastLeadMessageAt: new Date() }
        }).catch(() => {})
      }

      // Imagen → comprobante de pago
      if (tieneImagen) {
        const msg = `✅ Recibimos tu imagen.\n\nUn asesor validará tu pago y te dará los accesos.`
        await sleep(800)
        await enviarTexto(instancia, numero, msg)
        await guardarMsg(prisma, lead.id, conv?.id, 'BOT', msg)
        return
      }

      const convState = conv?.state || 'ACTIVE'
      if (convState === 'CLOSED' || lead.estado === 'CERRADO') return

      // ── NOTIFIED → Groq responde con contexto completo ──────
      if (convState === 'NOTIFIED' || lead.estado === 'NOTIFICADO') {

        // Lead no quiere → cerrar
        if (contiene(texto, KW_NO_INTERES)) {
          const msg = `Entendido 😊\n\nSi cambias de opinión, aquí estaremos. ¡Mucho éxito!`
          await enviarTexto(instancia, numero, msg)
          await guardarMsg(prisma, lead.id, conv?.id, 'BOT', msg)
          await prisma.lead.update({ where: { id: lead.id }, data: { estado: 'CERRADO' } }).catch(() => {})
          if (conv?.id) await prisma.conversation.update({ where: { id: conv.id }, data: { state: 'CLOSED' } }).catch(() => {})
          return
        }

        // Alerta al vendedor si pide llamada
        if (contiene(texto, KW_LLAMADA) && vendor?.whatsappNumber) {
          await enviarTexto(instancia, vendor.whatsappNumber,
            `📞 Lead pide llamada\n📱 wa.me/${lead.telefono}\n💬 "${texto.slice(0, 100)}"`
          ).catch(() => {})
        }

        const cam = lead.campaignId
          ? await prisma.campaign.findUnique({ where: { id: lead.campaignId } })
          : null

        const historial = await prisma.message.findMany({
          where: { leadId: lead.id },
          orderBy: { createdAt: 'asc' },
          take: 20
        })

        const resultado = await consultarGroq({
          historial, textoActual: texto,
          campaign: cam, modo: 'NOTIFIED'
        })

        const msgFinal = resultado?.respuesta ||
          `Un asesor de nuestro equipo te contactará muy pronto 😊\n¿Tienes alguna otra consulta sobre el programa?`

        await enviarTexto(instancia, numero, msgFinal)
        await guardarMsg(prisma, lead.id, conv?.id, 'BOT', msgFinal)
        console.log(`[Brain IA] NOTIFIED: ${numero}`)
        return
      }

      // ── ACTIVE → Groq evalúa si el lead respondió el paso ───
      // Solo si hay GROQ_API_KEY — si no, solo actualizar timestamp
      if (process.env.GROQ_API_KEY && conv?.id) {
        const cam = lead.campaignId
          ? await prisma.campaign.findUnique({
              where: { id: lead.campaignId },
              include: { steps: { orderBy: { orden: 'asc' } } }
            })
          : null

        // pasoActual = el último paso MSG que el bot envió (del que está esperando respuesta)
        const pasoActualStep = cam?.steps?.find(s => s.orden === (conv.currentStep || 0))
        const pasoSiguiente  = cam?.steps?.find(s => s.orden > (conv.currentStep || 0) && s.tipo === 'MSG')

        // Groq evalúa siempre que haya un paso actual del que esperar respuesta
        if (pasoActualStep) {
          const historial = await prisma.message.findMany({
            where: { leadId: lead.id },
            orderBy: { createdAt: 'asc' },
            take: 10
          })

          const resultado = await consultarGroq({
            historial,
            textoActual: texto,
            pasoActual: pasoActualStep.mensaje,
            campaign: cam,
            modo: 'ACTIVE'
          })

          if (resultado && resultado.avanzar === false && resultado.respuesta) {
            // Lead se desvió → marcar lastBotMessageAt PRIMERO para bloquear followupEngine
            await prisma.conversation.update({
              where: { id: conv.id },
              data: { lastBotMessageAt: new Date() }
            }).catch(() => {})
            await sleep(800)
            await enviarTexto(instancia, numero, resultado.respuesta)
            await guardarMsg(prisma, lead.id, conv.id, 'BOT', resultado.respuesta)
            console.log(`[Brain IA] ACTIVE desvío corregido: ${numero}`)
            return
          }
          // Si avanzar === true → dejar que followupEngine avance el paso normalmente
        }
      }

      // ACTIVE sin Groq o lead respondió correctamente → actualizar timestamp
      await prisma.lead.update({
        where: { id: lead.id },
        data: { ultimoMensaje: new Date() }
      }).catch(() => {})
      return
    }

    // ── LEAD NUEVO ────────────────────────────────────────────
    const cursoCampana = detectarCursoCampana(texto)
    const campaign = await getCampaign(prisma, cursoCampana?.slug)

    const newLead = await prisma.lead.create({
      data: {
        telefono: numero,
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

    await guardarMsg(prisma, newLead.id, conv?.id || null, 'LEAD', texto)

    const pasos = campaign?.steps?.filter(s => s.tipo === 'MSG') || []
    const paso1 = pasos[0]

    const msgBienvenida = paso1?.mensaje
      ? interp(paso1.mensaje, {
          telefono: numero, vendedor: vendor?.nombre || '',
          curso: campaign?.nombre || '', nombre: ''
        })
      : `Hola 👋 te saluda *Perú Exporta TV* 🇵🇪\n\nCuéntame: ¿cómo te llamas y qué producto tienes en mente para exportar? 👇`

    await sleep(1000)
    await enviarTexto(instancia, numero, msgBienvenida)
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

    console.log(`[Motor] Lead nuevo: ${numero} | ${campaign?.slug || 'orgánico'}`)

  } catch (err) {
    console.error('[Motor] Error:', err.message)
  }
}
