// src/api/leads.js — Sprint 2
// Usa leads_v2 — tabla limpia sin conflictos con Sprint 1

export async function getLeads(request, reply, prisma) {
  try {
    const leads = await prisma.$queryRaw`
      SELECT 
        l.id,
        l.telefono,
        l.estado,
        l."pasoActual",
        l."notificado",
        l."createdAt",
        l."ultimoMensaje",
        l."campaignId",
        c.slug as campaign_slug,
        c.nombre as campaign_nombre,
        v.nombre as vendor_nombre
      FROM leads_v2 l
      LEFT JOIN campaigns c ON l."campaignId" = c.id
      LEFT JOIN vendors v ON c."vendorId" = v.id
      ORDER BY l."createdAt" DESC
      LIMIT 200
    `

    const formateados = leads.map(lead => ({
      id: Number(lead.id),
      nombre: lead.telefono,
      numero: lead.telefono,
      phone: lead.telefono,
      fila: Number(lead.id),
      producto: lead.campaign_slug || '',
      tipo: lead.campaign_nombre || 'Sin campaña',
      estado: mapEstado(lead.estado),
      prioridad: 'normal',
      scoreTotal: 0,
      creadoEn: lead.createdAt,
      ultimoTimestamp: lead.ultimoMensaje || lead.createdAt,
      primerMensaje: '',
      vendedor: lead.vendor_nombre || '',
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
    await prisma.$executeRaw`
      UPDATE leads_v2 SET estado = ${nuevoEstado}, "updatedAt" = NOW() WHERE id = ${id}
    `
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
    await prisma.$executeRaw`
      UPDATE leads_v2 SET estado = ${nuevoEstado}, "updatedAt" = NOW() WHERE id = ${id}
    `
    return reply.send({ ok: true, estado: nuevoEstado })
  } catch (error) {
    console.error('[API/leads] Error en doAccion:', error.message)
    return reply.status(500).send({ error: 'Error en acción' })
  }
}

export async function getReportes(request, reply, prisma) {
  try {
    const [total, cerrados, enFlujo, nuevos] = await Promise.all([
      prisma.$queryRaw`SELECT COUNT(*) as count FROM leads_v2`,
      prisma.$queryRaw`SELECT COUNT(*) as count FROM leads_v2 WHERE estado = 'CERRADO'`,
      prisma.$queryRaw`SELECT COUNT(*) as count FROM leads_v2 WHERE estado = 'EN_FLUJO'`,
      prisma.$queryRaw`SELECT COUNT(*) as count FROM leads_v2 WHERE estado = 'NUEVO'`,
    ])

    const t = Number(total[0].count)
    const c = Number(cerrados[0].count)
    const conversion = t > 0 ? Math.round((c / t) * 100) : 0

    return reply.send({
      total: t,
      cerrados: c,
      porLlamar: Number(enFlujo[0].count),
      nuevos: Number(nuevos[0].count),
      conversion,
      periodo: 'todos'
    })
  } catch (error) {
    console.error('[API/leads] Error en getReportes:', error.message)
    return reply.status(500).send({ error: 'Error al obtener reportes' })
  }
}
