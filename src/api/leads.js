// src/api/leads.js
// Endpoints REST completos para el CRM
// GET /leads · PUT /leads/:id · POST /leads/:id/mensaje · POST /leads/:id/accion

import { enviarTexto } from '../whatsapp/sender.js'
import { actualizarEstadoEnSheet } from '../sheets/mirror.js'

export async function getLeads(request, reply, prisma) {
  try {
    const { vendedor, estado, limit = 200 } = request.query

    const where = {}
    where.tenantId = 'hidata'

    if (vendedor) {
      const vendedorObj = await prisma.vendedor.findFirst({
        where: {
          tenantId: 'hidata',
          OR: [
            { nombre: { contains: vendedor, mode: 'insensitive' } },
            { instanciaEvolution: { contains: vendedor, mode: 'insensitive' } }
          ]
        }
      })
      if (vendedorObj) where.vendedorId = vendedorObj.id
    }

    if (estado) where.estado = estado

    const leads = await prisma.lead.findMany({
      where,
      orderBy: { creadoEn: 'desc' },
      take: parseInt(limit),
      include: {
        vendedor: {
          select: { nombre: true, instanciaEvolution: true }
        }
      }
    })

    const leadsFormateados = leads.map(lead => ({
      id: lead.id,
      nombre: lead.nombre || 'Sin nombre',
      numero: lead.numero,
      producto: lead.producto || '',
      tipo: lead.tipoPreciso || `Tipo ${lead.tipo}`,
      estado: lead.estado,
      prioridad: lead.prioridad,
      scoreTotal: lead.scoreTotal,
      creadoEn: lead.creadoEn,
      ultimoTimestamp: lead.ultimoTimestamp,
      primerMensaje: lead.primerMensaje || '',
      vendedor: lead.vendedor?.nombre || '',
      instancia: lead.vendedor?.instanciaEvolution || '',
      fecha: lead.creadoEn,
      phone: lead.numero,
      fila: lead.id,
    }))

    return reply.send(leadsFormateados)
  } catch (error) {
    console.error('[API/leads] Error en getLeads:', error)
    return reply.status(500).send({ error: 'Error al obtener leads' })
  }
}

export async function updateLead(request, reply, prisma) {
  try {
    const { id } = request.params
    const { estado, prioridad, nombre, producto, resultado, fechaLlamada } = request.body

    const leadExistente = await prisma.lead.findUnique({ where: { id } })
    if (!leadExistente) {
      return reply.status(404).send({ error: 'Lead no encontrado' })
    }

    const data = { actualizadoEn: new Date() }
    if (estado)       data.estado = estado
    if (prioridad)    data.prioridad = prioridad
    if (nombre)       data.nombre = nombre
    if (producto)     data.producto = producto
    if (resultado)    data.resultado = resultado
    if (fechaLlamada) data.fechaLlamada = new Date(fechaLlamada)

    const lead = await prisma.lead.update({
      where: { id },
      data,
      include: {
        vendedor: { select: { instanciaEvolution: true } }
      }
    })

    if (estado && lead.vendedor?.instanciaEvolution) {
      actualizarEstadoEnSheet(
        lead.vendedor.instanciaEvolution,
        lead.numero,
        estado
      ).catch(err => console.error('[Sheets] Error actualizando estado:', err))
    }

    return reply.send({ ok: true, lead })
  } catch (error) {
    console.error('[API/leads] Error en updateLead:', error)
    return reply.status(500).send({ error: 'Error al actualizar lead' })
  }
}

export async function sendMensaje(request, reply, prisma) {
  try {
    const { id } = request.params
    const { contenido } = request.body

    if (!contenido) {
      return reply.status(400).send({ error: 'contenido es requerido' })
    }

    const lead = await prisma.lead.findUnique({
      where: { id },
      include: { vendedor: { select: { instanciaEvolution: true } } }
    })

    if (!lead) return reply.status(404).send({ error: 'Lead no encontrado' })

    await enviarTexto(
      lead.vendedor.instanciaEvolution,
      lead.numero,
      contenido
    )

    await prisma.mensaje.create({
      data: {
        leadId: lead.id,
        tenantId: lead.tenantId,
        direccion: 'saliente',
        contenido,
        tipo: 'texto'
      }
    })

    return reply.send({ ok: true })
  } catch (error) {
    console.error('[API/leads] Error en sendMensaje:', error)
    return reply.status(500).send({ error: 'Error al enviar mensaje' })
  }
}

export async function doAccion(request, reply, prisma) {
  try {
    const { id } = request.params
    const { accion, hora, mensaje } = request.body

    const lead = await prisma.lead.findUnique({
      where: { id },
      include: { vendedor: { select: { instanciaEvolution: true, nombre: true } } }
    })

    if (!lead) return reply.status(404).send({ error: 'Lead no encontrado' })

    switch (accion) {
      case 'enviar_material': {
        await prisma.lead.update({
          where: { id },
          data: { estado: 'mat_enviado', actualizadoEn: new Date() }
        })
        return reply.send({ ok: true, estado: 'mat_enviado' })
      }
      case 'no_contesto': {
        await prisma.lead.update({
          where: { id },
          data: { estado: 'no_contesto', actualizadoEn: new Date() }
        })
        return reply.send({ ok: true, estado: 'no_contesto' })
      }
      case 'agendar': {
        await prisma.lead.update({
          where: { id },
          data: {
            estado: 'agendado',
            actualizadoEn: new Date(),
            fechaLlamada: hora ? new Date(hora) : null
          }
        })
        return reply.send({ ok: true, estado: 'agendado' })
      }
      case 'cerrar': {
        await prisma.lead.update({
          where: { id },
          data: { estado: 'cerrado', actualizadoEn: new Date() }
        })
        return reply.send({ ok: true, estado: 'cerrado' })
      }
      default:
        return reply.status(400).send({ error: `Acción desconocida: ${accion}` })
    }
  } catch (error) {
    console.error('[API/leads] Error en doAccion:', error)
    return reply.status(500).send({ error: 'Error en acción' })
  }
}

export async function getReportes(request, reply, prisma) {
  try {
    const { vendedor } = request.query
    const tenantId = 'hidata'

    const where = { tenantId }
    if (vendedor) {
      const v = await prisma.vendedor.findFirst({
        where: { tenantId, nombre: { contains: vendedor, mode: 'insensitive' } }
      })
      if (v) where.vendedorId = v.id
    }

    const [total, cerrados, porLlamar, nuevos] = await Promise.all([
      prisma.lead.count({ where }),
      prisma.lead.count({ where: { ...where, estado: 'cerrado' } }),
      prisma.lead.count({ where: { ...where, estado: 'por_llamar' } }),
      prisma.lead.count({ where: { ...where, estado: 'nuevo' } }),
    ])

    const conversion = total > 0 ? Math.round((cerrados / total) * 100) : 0

    return reply.send({ total, cerrados, porLlamar, nuevos, conversion, periodo: 'todos' })
  } catch (error) {
    console.error('[API/leads] Error en getReportes:', error)
    return reply.status(500).send({ error: 'Error al obtener reportes' })
  }
}
