const prisma = require('../plugins/prisma')

async function campaignRoutes(fastify) {

  // GET /campaigns — lista todas las campañas con pasos y triggers
  fastify.get('/campaigns', async (req, reply) => {
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
  })

  // GET /campaigns/:id
  fastify.get('/campaigns/:id', async (req, reply) => {
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
  })

  // POST /campaigns — crear nueva campaña
  fastify.post('/campaigns', async (req, reply) => {
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
      include: { triggers: true, steps: { orderBy: { orden: 'asc' } }, vendor: true }
    })

    return reply.code(201).send(campaign)
  })

  // PUT /campaigns/:id — editar campaña (nombre, activa, vendorId)
  fastify.put('/campaigns/:id', async (req, reply) => {
    const { nombre, activa, vendorId } = req.body
    const campaign = await prisma.campaign.update({
      where: { id: Number(req.params.id) },
      data: {
        ...(nombre !== undefined && { nombre }),
        ...(activa !== undefined && { activa }),
        ...(vendorId !== undefined && { vendorId: Number(vendorId) })
      },
      include: { triggers: true, steps: { orderBy: { orden: 'asc' } }, vendor: true }
    })
    return campaign
  })

  // DELETE /campaigns/:id
  fastify.delete('/campaigns/:id', async (req, reply) => {
    await prisma.campaign.delete({ where: { id: Number(req.params.id) } })
    return { ok: true }
  })

  // ─── Triggers ──────────────────────────────────────────────

  // POST /campaigns/:id/triggers
  fastify.post('/campaigns/:id/triggers', async (req, reply) => {
    const { texto } = req.body
    if (!texto) return reply.code(400).send({ error: 'texto requerido' })
    const trigger = await prisma.trigger.create({
      data: { texto: texto.toLowerCase(), campaignId: Number(req.params.id) }
    })
    return reply.code(201).send(trigger)
  })

  // DELETE /campaigns/:id/triggers/:triggerId
  fastify.delete('/campaigns/:id/triggers/:triggerId', async (req, reply) => {
    await prisma.trigger.delete({ where: { id: Number(req.params.triggerId) } })
    return { ok: true }
  })

  // ─── Flow Steps ────────────────────────────────────────────

  // PUT /campaigns/:id/steps — reemplaza todos los pasos (save completo)
  fastify.put('/campaigns/:id/steps', async (req, reply) => {
    const campaignId = Number(req.params.id)
    const { steps } = req.body

    if (!Array.isArray(steps)) {
      return reply.code(400).send({ error: 'steps debe ser un array' })
    }

    // Transacción: borrar pasos existentes y recrear
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
  })

  // ─── Test de trigger (simulador) ───────────────────────────

  // POST /campaigns/test-trigger
  fastify.post('/campaigns/test-trigger', async (req, reply) => {
    const { mensaje, campaignId } = req.body

    const campaign = await prisma.campaign.findUnique({
      where: { id: Number(campaignId) },
      include: { triggers: true }
    })

    if (!campaign) return reply.code(404).send({ error: 'Campaña no encontrada' })

    const normalize = (s) => s.toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9\s]/g, '').trim()

    const normalizedMsg = normalize(mensaje)
    const matched = campaign.triggers.find(t =>
      normalizedMsg.includes(normalize(t.texto))
    )

    return {
      match: !!matched,
      trigger: matched?.texto || null,
      campaign: matched ? { slug: campaign.slug, nombre: campaign.nombre } : null
    }
  })
}

module.exports = campaignRoutes
