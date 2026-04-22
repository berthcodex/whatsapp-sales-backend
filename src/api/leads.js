// src/api/leads.js — Sprint 2
// Usa schema nuevo: Lead, Message, Vendor, Campaign

export async function getLeads(request, reply, prisma) {
  try {
    const { vendedor, estado } = request.query

    const where = {}
    if (estado) where.estado = estado

    const leads = await prisma.lead.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: {
        campaign: {
          select: {
            slug: true,
            nombre: true,
            vendor: { select: { nombre: true, telefono: true } }
          }
        },
        mensajes: {
          orderBy: { createdAt: 'desc' },
          take: 1
        }
      }
    })

    const formateados = leads.map(lead => ({
      id: lead.id,
      nombre: lead.telefono,
      numero: lead.telefono,
      phone: lead.telefono,
      fila: lead.id,
      producto: lead.campaign?.slug || '',
      tipo: lead.campaign?.nombre || 'Sin campaña',
      estado: lead.estado || 'NUEVO',
      prioridad: 'normal',
      scoreTotal: 0,
      creadoEn: lead.createdAt,
      ultimoTimestamp: lead.ultimoMensaje || lead.createdAt,
      primerMensaje: '',
      vendedor: lead.campaign?.vendor?.nombre || '',
      instancia: '',
      fecha: lead.createdAt,
    }))

    return reply.send(formateados)
  } catch (error) {
    console.error('[API/leads] Error en getLeads:', error)
    return reply.status(500).send({ error: 'Error al obtener leads' })
  }
}

export async function updateLead(request, reply, prisma) {
  try {
    const id = Number(request.params.id)
    const { estado } = request.body

    const lead = await prisma.lead.findUnique({ where: { id } })
    if (!lead) return reply.status(404).send({ error: 'Lead no encontrado' })

    const data = { updatedAt: new Date() }
    if (estado) data.estado = estado

    const updated = await prisma.lead.update({ where: { id }, data })
    return reply.send({ ok: true, lead: updated })
  } catch (error) {
    console.error('[API/leads] Error en updateLead:', error)
    return reply.status(500).send({ error: 'Error al actualizar lead' })
  }
}

export async function sendMensaje(request, reply, prisma) {
  try {
    const id = Number(request.params.id)
    const { contenido } = request.body

    if (!contenido) return reply.status(400).send({ error: 'contenido requerido' })

    const lead = await prisma.lead.findUnique({ where: { id } })
    if (!lead) return reply.status(404).send({ error: 'Lead no encontrado' })

    await prisma.message.create({
      data: { leadId: id, origen: 'VENDEDOR', texto: contenido }
    })

    return reply.send({ ok: true })
  } catch (error) {
    console.error('[API/leads] Error en sendMensaje:', error)
    return reply.status(500).send({ error: 'Error al enviar mensaje' })
  }
}

export async function doAccion(request, reply, prisma) {
  try {
    const id = Number(request.params.id)
    const { accion } = request.body

    const lead = await prisma.lead.findUnique({ where: { id } })
    if (!lead) return reply.status(404).send({ error: 'Lead no encontrado' })

    const estadoMap = {
      'enviar_material': 'NOTIFICADO',
      'no_contesto':     'EN_FLUJO',
      'agendar':         'EN_FLUJO',
      'cerrar':          'CERRADO',
      'material':        'NOTIFICADO',
      'nocontesto':      'EN_FLUJO',
      'agendar':         'EN_FLUJO',
      'cerrado':         'CERRADO',
    }

    const nuevoEstado = estadoMap[accion] || lead.estado

    await prisma.lead.update({
      where: { id },
      data: { estado: nuevoEstado, updatedAt: new Date() }
    })

    return reply.send({ ok: true, estado: nuevoEstado })
  } catch (error) {
    console.error('[API/leads] Error en doAccion:', error)
    return reply.status(500).send({ error: 'Error en acción' })
  }
}

export async function getReportes(request, reply, prisma) {
  try {
    const [total, cerrados, enFlujo, nuevos] = await Promise.all([
      prisma.lead.count(),
      prisma.lead.count({ where: { estado: 'CERRADO' } }),
      prisma.lead.count({ where: { estado: 'EN_FLUJO' } }),
      prisma.lead.count({ where: { estado: 'NUEVO' } }),
    ])

    const conversion = total > 0 ? Math.round((cerrados / total) * 100) : 0

    return reply.send({ total, cerrados, porLlamar: enFlujo, nuevos, conversion, periodo: 'todos' })
  } catch (error) {
    console.error('[API/leads] Error en getReportes:', error)
    return reply.status(500).send({ error: 'Error al obtener reportes' })
  }
}
