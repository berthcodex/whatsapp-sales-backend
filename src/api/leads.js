// src/api/leads.js — Sprint 2 Final
// Tabla leads limpia — schema correcto

export async function getLeads(request, reply, prisma) {
  try {
    const leads = await prisma.lead.findMany({
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: {
        campaign: {
          select: {
            slug: true,
            nombre: true,
            vendor: { select: { nombre: true, telefono: true } }
          }
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
      estado: mapEstado(lead.estado),
      prioridad: 'normal',
      scoreTotal: 0,
      creadoEn: lead.createdAt,
      ultimoTimestamp: lead.ultimoMensaje || lead.createdAt,
      primerMensaje: '',
      vendedor: lead.campaign?.vendor?.nombre || '',
      instancia: '',
      fecha: lead.createdAt,
      urgente: lead.estado === 'NUEVO' || lead.estado === 'EN_FLUJO'
    }))

    return reply.send(formateados)
  } catch (error) {
    console.error('[API/leads] Error en getLeads:', error.message)
    return reply.status(500).send({ error: 'Error al obtener leads' })
  }
}

function mapEstado(estado) {
  const mapa = {
    'NUEVO':      'nuevo',
    'EN_FLUJO':   'pendiente llamar',
    'NOTIFICADO': 'por_llamar',
    'CERRADO':    'cerrado',
  }
  return mapa[estado] || 'nuevo'
}

export async function updateLead(request, reply, prisma) {
  try {
    const id = Number(request.params.id)
    const { estado } = request.body

    const estadoInverso = {
      'nuevo':            'NUEVO',
      'pendiente llamar': 'EN_FLUJO',
      'por_llamar':       'NOTIFICADO',
      'no_contesto':      'EN_FLUJO',
      'agendado':         'EN_FLUJO',
      'mat_enviado':      'NOTIFICADO',
      'cerrado':          'CERRADO',
    }

    const nuevoEstado = estadoInverso[estado] || 'NUEVO'
    await prisma.lead.update({
      where: { id },
      data: { estado: nuevoEstado, updatedAt: new Date() }
    })
    return reply.send({ ok: true })
  } catch (error) {
    console.error('[API/leads] Error en updateLead:', error.message)
    return reply.status(500).send({ error: 'Error al actualizar lead' })
  }
}

export async function sendMensaje(request, reply, prisma) {
  try {
    const id = Number(request.params.id)
    const { contenido } = request.body
    if (!contenido) return reply.status(400).send({ error: 'contenido requerido' })
    await prisma.message.create({
      data: { leadId: id, origen: 'VENDEDOR', texto: contenido }
    })
    return reply.send({ ok: true })
  } catch (error) {
    console.error('[API/leads] Error en sendMensaje:', error.message)
    return reply.status(500).send({ error: 'Error al enviar mensaje' })
  }
}

export async function doAccion(request, reply, prisma) {
  try {
    const id = Number(request.params.id)
    const { accion } = request.body

    const estadoMap = {
      'material':   'NOTIFICADO',
      'nocontesto': 'EN_FLUJO',
      'agendar':    'EN_FLUJO',
      'cerrado':    'CERRADO',
    }

    const nuevoEstado = estadoMap[accion] || 'EN_FLUJO'
    await prisma.lead.update({
      where: { id },
      data: { estado: nuevoEstado, updatedAt: new Date() }
    })
    return reply.send({ ok: true, estado: nuevoEstado })
  } catch (error) {
    console.error('[API/leads] Error en doAccion:', error.message)
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
    return reply.send({
      total,
      cerrados,
      porLlamar: enFlujo,
      nuevos,
      conversion,
      periodo: 'todos'
    })
  } catch (error) {
    console.error('[API/leads] Error en getReportes:', error.message)
    return reply.status(500).send({ error: 'Error al obtener reportes' })
  }
}
