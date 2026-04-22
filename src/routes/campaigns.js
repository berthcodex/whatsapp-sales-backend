// src/routes/campaigns.js

function normalize(s) {
  return s.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, '').trim()
}

// GET /campaigns
export async function getCampaigns(req, reply, prisma) {
  const campaigns = await prisma.campaign.findMany({
    include: {
      vendor: { select: { id: true, nombre: true, telefono: true, role: true } },
      triggers: true,
      steps: { orderBy: { orden: 'asc' } },
      _count: { select: { leads: true } }
    },
    orderBy: { createdAt: 'asc' }
  })
  return campaigns
}

// GET /campaigns/:id
export async function getCampaign(req, reply, prisma) {
  const campaign = await prisma.campaign.findUnique({
    where: { id: Number(req.params.id) },
    include: {
      vendor: true,
      triggers: true,
      steps: { orderBy: { orden: 'asc' } }
    }
  })
  if (!campaign) return reply.code(404).send({ error: 'Campaña no encontrada' })
  return campaign
}

// POST /campaigns
export async function createCampaign(req, reply, prisma) {
  const { slug, nombre, vendorId, triggers = [], steps = [] } = req.body

  if (!slug || !nombre || !vendorId) {
    return reply.code(400).send({ error: 'slug, nombre y vendorId son requeridos' })
  }

  const campaign = await prisma.campaign.create({
    data: {
      slug: slug.toUpperCase(),
      nombre,
      vendorId: Number(vendorId),
      triggers: { create: triggers.map(t => ({ texto: t.toLowerCase() })) },
      steps: {
        create: steps.map((s, i) => ({
          orden: i + 1,
          tipo: s.tipo,
          mensaje: s.mensaje,
          followupHrs: s.followupHrs || null
        }))
      }
    },
    include: {
      triggers: true,
      steps: { orderBy: { orden: 'asc' } },
      vendor: true
    }
  })

  return reply.code(201).send(campaign)
}

// PUT /campaigns/:id
export async function updateCampaign(req, reply, prisma) {
  const { nombre, activa, vendorId } = req.body
  const campaign = await prisma.campaign.update({
    where: { id: Number(req.params.id) },
    data: {
      ...(nombre !== undefined && { nombre }),
      ...(activa !== undefined && { activa }),
      ...(vendorId !== undefined && { vendorId: Number(vendorId) })
    },
    include: {
      triggers: true,
      steps: { orderBy: { orden: 'asc' } },
      vendor: true
    }
  })
  return campaign
}

// DELETE /campaigns/:id
export async function deleteCampaign(req, reply, prisma) {
  await prisma.campaign.delete({ where: { id: Number(req.params.id) } })
  return { ok: true }
}

// PUT /campaigns/:id/steps
export async function saveSteps(req, reply, prisma) {
  const campaignId = Number(req.params.id)
  const { steps } = req.body

  if (!Array.isArray(steps)) {
    return reply.code(400).send({ error: 'steps debe ser un array' })
  }

  await prisma.$transaction([
    prisma.flowStep.deleteMany({ where: { campaignId } }),
    prisma.flowStep.createMany({
      data: steps.map((s, i) => ({
        campaignId,
        orden: i + 1,
        tipo: s.tipo,
        mensaje: s.mensaje,
        followupHrs: s.followupHrs || null
      }))
    })
  ])

  const updated = await prisma.flowStep.findMany({
    where: { campaignId },
    orderBy: { orden: 'asc' }
  })

  return updated
}

// POST /campaigns/:id/triggers
export async function addTrigger(req, reply, prisma) {
  const { texto } = req.body
  if (!texto) return reply.code(400).send({ error: 'texto requerido' })
  const trigger = await prisma.trigger.create({
    data: { texto: texto.toLowerCase(), campaignId: Number(req.params.id) }
  })
  return reply.code(201).send(trigger)
}

// DELETE /campaigns/:id/triggers/:tid
export async function deleteTrigger(req, reply, prisma) {
  await prisma.trigger.delete({ where: { id: Number(req.params.tid) } })
  return { ok: true }
}

// POST /campaigns/test-trigger
export async function testTrigger(req, reply, prisma) {
  const { mensaje, campaignId } = req.body

  const campaign = await prisma.campaign.findUnique({
    where: { id: Number(campaignId) },
    include: { triggers: true }
  })

  if (!campaign) return reply.code(404).send({ error: 'Campaña no encontrada' })

  const normalizedMsg = normalize(mensaje)
  const matched = campaign.triggers.find(t =>
    normalizedMsg.includes(normalize(t.texto))
  )

  return {
    match: !!matched,
    trigger: matched?.texto || null,
    campaign: matched ? { slug: campaign.slug, nombre: campaign.nombre } : null
  }
}

// Sprint 3 Bug 4: activar campaña exclusiva en producción
// Pausa todas las campañas del mismo vendedor y activa solo la seleccionada
export async function activarCampaign(req, reply, prisma) {
  const campaignId = Number(req.params.id)

  const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } })
  if (!campaign) return reply.code(404).send({ error: 'Campaña no encontrada' })

  await prisma.$transaction([
    prisma.campaign.updateMany({
      where: { vendorId: campaign.vendorId },
      data: { activa: false }
    }),
    prisma.campaign.update({
      where: { id: campaignId },
      data: { activa: true }
    })
  ])

  const updated = await prisma.campaign.findUnique({
    where: { id: campaignId },
    include: { vendor: true, steps: { orderBy: { orden: 'asc' } }, triggers: true }
  })

  return updated
}
