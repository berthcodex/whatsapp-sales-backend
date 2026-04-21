const prisma = require('../plugins/prisma')

/**
 * stateEngine.js — Motor principal Hidata Sprint 2
 * Lee flujos desde DB. Sin hardcoding.
 */

// Normaliza texto para comparación de triggers
function normalize(text) {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .trim()
}

// Detecta qué campaña activa el mensaje entrante
async function detectCampaign(messageText) {
  const normalizedMsg = normalize(messageText)

  const campaigns = await prisma.campaign.findMany({
    where: { activa: true },
    include: { triggers: true, vendor: true }
  })

  for (const campaign of campaigns) {
    for (const trigger of campaign.triggers) {
      if (normalizedMsg.includes(normalize(trigger.texto))) {
        return campaign
      }
    }
  }
  return null
}

// Obtiene los pasos MSG en orden (excluye FOLLOWUP — esos los maneja followupEngine)
async function getCampaignSteps(campaignId) {
  return prisma.flowStep.findMany({
    where: { campaignId, tipo: { in: ['MSG', 'NOTIFY'] } },
    orderBy: { orden: 'asc' }
  })
}

// Obtiene el followup de una campaña si existe
async function getFollowupStep(campaignId) {
  return prisma.flowStep.findFirst({
    where: { campaignId, tipo: 'FOLLOWUP' }
  })
}

// Procesa mensaje entrante de un lead
async function processIncoming({ telefono, mensaje, sendMessage, notifyVendor }) {
  // 1. Buscar o crear lead
  let lead = await prisma.lead.findUnique({ where: { telefono } })

  // 2. Guardar mensaje del lead en historial
  if (lead) {
    await prisma.message.create({
      data: { leadId: lead.id, origen: 'LEAD', texto: mensaje }
    })
    // Actualizar ultimoMensaje para que el followupEngine no dispare
    await prisma.lead.update({
      where: { id: lead.id },
      data: { ultimoMensaje: new Date() }
    })
  }

  // 3. Si es lead nuevo — detectar campaña y arrancar flujo
  if (!lead) {
    const campaign = await detectCampaign(mensaje)

    lead = await prisma.lead.create({
      data: {
        telefono,
        campaignId: campaign?.id || null,
        pasoActual: 0,
        ultimoMensaje: new Date(),
        estado: campaign ? 'EN_FLUJO' : 'NUEVO'
      }
    })

    await prisma.message.create({
      data: { leadId: lead.id, origen: 'LEAD', texto: mensaje }
    })

    if (!campaign) {
      // Sin campaña detectada — silencio, el vendedor verá el mensaje
      return
    }

    // Arrancar flujo desde paso 1
    return await executeFlujo({ lead, campaign, sendMessage, notifyVendor })
  }

  // 4. Lead existente con campaña — avanzar al siguiente paso
  if (lead.campaignId && lead.estado === 'EN_FLUJO') {
    const campaign = await prisma.campaign.findUnique({
      where: { id: lead.campaignId },
      include: { vendor: true }
    })
    return await executeFlujo({ lead, campaign, sendMessage, notifyVendor })
  }
}

// Ejecuta el siguiente paso del flujo para un lead
async function executeFlujo({ lead, campaign, sendMessage, notifyVendor }) {
  const steps = await getCampaignSteps(campaign.id)
  const nextStep = steps[lead.pasoActual]

  if (!nextStep) return // Flujo terminado

  if (nextStep.tipo === 'MSG') {
    const texto = renderTemplate(nextStep.mensaje, { telefono: lead.telefono })
    await sendMessage(lead.telefono, texto)
    await prisma.message.create({
      data: { leadId: lead.id, origen: 'BOT', texto }
    })
    await prisma.lead.update({
      where: { id: lead.id },
      data: { pasoActual: lead.pasoActual + 1 }
    })

    // Si el siguiente paso también es MSG — esperar respuesta del lead
    // (el lead tiene que responder para avanzar)

  } else if (nextStep.tipo === 'NOTIFY') {
    // Obtener historial completo
    const mensajes = await prisma.message.findMany({
      where: { leadId: lead.id },
      orderBy: { createdAt: 'asc' }
    })

    const historial = mensajes
      .map(m => `[${m.origen}] ${m.texto}`)
      .join('\n')

    const notifTexto = `${renderTemplate(nextStep.mensaje, { telefono: lead.telefono })}\n\n📋 Historial:\n${historial}`

    await notifyVendor(campaign.vendor.telefono, notifTexto)
    await prisma.lead.update({
      where: { id: lead.id },
      data: {
        pasoActual: lead.pasoActual + 1,
        notificado: true,
        estado: 'NOTIFICADO'
      }
    })
  }
}

// Reemplaza variables en el mensaje
function renderTemplate(mensaje, vars = {}) {
  return mensaje
    .replace(/\{\{telefono\}\}/g, vars.telefono || '')
    .replace(/\{\{nombre\}\}/g, vars.nombre || '')
    .replace(/\{\{vendedor\}\}/g, vars.vendedor || '')
    .replace(/\{\{curso\}\}/g, vars.curso || '')
}

module.exports = { processIncoming, detectCampaign, executeFlujo, renderTemplate }
