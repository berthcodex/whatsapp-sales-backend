// src/webhook/routerInteligente.js
// Campaign Router 2 capas — Hidata 111X
// Capa 1: trigger exact match desde BD (modelo Trigger, campo texto)
// Capa 2: Groq árbitro único para leads orgánicos
// Sin stemming. Sin arrays hardcodeados. Groq decide.

function normalizar(texto) {
  return texto
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// ── CAPA 1: Trigger exact match desde BD ────────────────────
async function matchTrigger(mensaje, prisma) {
  const triggers = await prisma.trigger.findMany({
    include: {
      campaign: {
        include: { steps: { orderBy: { orden: 'asc' } } }
      }
    }
  })

  const msgNorm = normalizar(mensaje)

  for (const trigger of triggers) {
    if (!trigger.texto) continue
    const kwNorm = normalizar(trigger.texto)
    if (msgNorm.includes(kwNorm)) {
      console.log(`[Router] Capa 1 — Trigger match: "${trigger.texto}" → ${trigger.campaign.slug}`)
      return trigger.campaign
    }
  }

  return null
}

// ── CAPA 2: Groq árbitro único ───────────────────────────────
async function groqArbitro(mensaje, campañasActivas) {
  try {
    if (!process.env.GROQ_API_KEY) return null

    const menuCampanas = campañasActivas
      .map(c => `- ${c.slug}: "${c.nombre}"`)
      .join('\n')

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
        model: 'llama-3.3-70b-versatile',
        max_tokens: 80,
        temperature: 0,
        messages: [
          {
            role: 'system',
            content:
`Eres el router de un sistema de ventas por WhatsApp.
Tu única función es decidir qué campaña asignar a un lead según su primer mensaje.

CAMPAÑAS DISPONIBLES:
${menuCampanas}

REGLAS:
1. Si el mensaje es saludo genérico, pregunta vaga, o sin señal clara → asigna ${campañasActivas[0].slug} (la primera, es el default)
2. Si hay señal clara de intención → asigna la campaña más relevante
3. USA SOLO los slugs de la lista — nunca inventes uno nuevo

Responde ÚNICAMENTE con este JSON sin explicación ni markdown:
{"slug":"AQUI_EL_SLUG","razon":"maximo 8 palabras"}`
          },
          {
            role: 'user',
            content: `Primer mensaje del lead: "${mensaje}"`
          }
        ]
      })
    })

    clearTimeout(timeout)
    if (!response.ok) {
      console.error('[Router Groq] HTTP error:', response.status)
      return null
    }

    const data = await response.json()
    const contenido = data.choices[0]?.message?.content?.trim()
    const limpio = contenido.replace(/```json|```/g, '').trim()
    const parsed = JSON.parse(limpio)

    console.log(`[Router] Capa 2 — Groq: ${parsed.slug} | razón: ${parsed.razon}`)
    return parsed.slug || null

  } catch (err) {
    console.error('[Router Groq] Falló:', err.message)
    return null
  }
}

// ── ENTRY POINT ──────────────────────────────────────────────
export async function resolverCampaign(mensaje, prisma) {

  // Capa 1 — trigger exact match
  const campaignPorTrigger = await matchTrigger(mensaje, prisma)
  if (campaignPorTrigger) return campaignPorTrigger

  // Capa 2 — Groq árbitro
  const campañasActivas = await prisma.campaign.findMany({
    where: { activa: true },
    include: { steps: { orderBy: { orden: 'asc' } } },
    orderBy: { id: 'asc' }
  })

  if (campañasActivas.length === 0) {
    console.error('[Router] No hay campañas activas en BD')
    return null
  }

  const slugDecidido = await groqArbitro(mensaje, campañasActivas)

  if (slugDecidido) {
    const campaign = campañasActivas.find(c => c.slug === slugDecidido)
    if (campaign) return campaign
  }

  // Fallback — primera campaña activa por id (MPX = id 1)
  console.log(`[Router] Fallback — ${campañasActivas[0].slug}`)
  return campañasActivas[0]
}