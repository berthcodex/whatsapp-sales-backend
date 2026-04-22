// src/api/config.js
// Configuración del sistema Hidata — Sprint 2
// Usa modelos nuevos: vendor (en lugar de vendedor), botConfig simplificado

// ============================================================
// BOT CONFIG — Leer
// ============================================================
export async function getBotConfig(request, reply, prisma) {
  try {
    const config = await prisma.botConfig.findFirst({
      where: { tenantId: 'hidata', activo: true }
    })
    if (!config) {
      // Retornar config vacía en vez de 404 — el CRM maneja esto
      return reply.send({
        msgBienvenida: '', msgProducto: '', msgExperiencia: '',
        msgPresentacion: '', msgObjecion: '', msgUrgencia: '', msgHandoff: '',
        nombreEmpresa: 'Perú Exporta TV', nombreProducto: 'Mi Primera Exportación'
      })
    }
    return reply.send(config)
  } catch (error) {
    console.error('[config] getBotConfig:', error.message)
    // Retornar config vacía en vez de 500
    return reply.send({
      msgBienvenida: '', msgProducto: '', msgExperiencia: '',
      msgPresentacion: '', msgObjecion: '', msgUrgencia: '', msgHandoff: '',
      nombreEmpresa: 'Perú Exporta TV', nombreProducto: 'Mi Primera Exportación'
    })
  }
}

// ============================================================
// BOT CONFIG — Guardar
// ============================================================
export async function updateBotConfig(request, reply, prisma) {
  try {
    const campos = [
      'msgBienvenida','msgProducto','msgExperiencia','msgPresentacion',
      'msgObjecion','msgUrgencia','msgHandoff','nombreEmpresa','nombreProducto'
    ]

    const configActual = await prisma.botConfig.findFirst({
      where: { tenantId: 'hidata', activo: true }
    })

    const data = { updatedEn: new Date() }
    campos.forEach(c => { if (request.body[c] !== undefined) data[c] = request.body[c] })

    if (configActual) {
      await prisma.botConfig.update({ where: { id: configActual.id }, data })
    } else {
      await prisma.botConfig.create({ data: { ...data, tenantId: 'hidata', activo: true } })
    }

    return reply.send({ ok: true })
  } catch (error) {
    console.error('[config] updateBotConfig:', error.message)
    return reply.status(500).send({ error: 'Error al guardar configuración' })
  }
}

// ============================================================
// VENDEDORES — Listar
// Usa tabla vendors (Sprint 2) — compatible con CRM existente
// ============================================================
export async function getVendedores(request, reply, prisma) {
  try {
    const vendors = await prisma.vendor.findMany({
      where: { activo: true },
      orderBy: { createdAt: 'asc' },
      include: { _count: { select: { campaigns: true } } }
    })

    // Formatear para que el CRM existente lo entienda
    const formateados = vendors.map(v => ({
      id: String(v.id),
      nombre: v.nombre,
      email: '',
      rol: v.role === 'ADMIN' ? 'ADMIN' : 'VENDEDOR',
      whatsappNumber: v.telefono,
      instanciaEvolution: `peru-exporta-${v.nombre.toLowerCase()}`,
      activo: v.activo,
      creadoEn: v.createdAt,
      totalLeads: 0
    }))

    return reply.send(formateados)
  } catch (error) {
    console.error('[config] getVendedores:', error.message)
    return reply.status(500).send({ error: 'Error al obtener vendedores' })
  }
}

// ============================================================
// VENDEDORES — Agregar
// ============================================================
export async function createVendedor(request, reply, prisma) {
  try {
    const { nombre, whatsappNumber, rol } = request.body

    if (!nombre || !whatsappNumber) {
      return reply.status(400).send({ error: 'nombre y whatsappNumber son requeridos' })
    }

    const telefono = whatsappNumber.replace(/[^0-9]/g, '')

    const existente = await prisma.vendor.findUnique({ where: { telefono } })
    if (existente) {
      return reply.status(409).send({ error: `El número ${telefono} ya está registrado` })
    }

    const vendor = await prisma.vendor.create({
      data: {
        nombre,
        telefono,
        role: rol === 'ADMIN' ? 'ADMIN' : 'VENDOR',
        activo: true
      }
    })

    return reply.status(201).send({ ok: true, vendedor: vendor })
  } catch (error) {
    console.error('[config] createVendedor:', error.message)
    return reply.status(500).send({ error: 'Error al crear vendedor' })
  }
}

// ============================================================
// VENDEDORES — Editar
// ============================================================
export async function updateVendedor(request, reply, prisma) {
  try {
    const id = Number(request.params.id)
    const { nombre, whatsappNumber, rol } = request.body

    const data = { updatedAt: new Date() }
    if (nombre) data.nombre = nombre
    if (whatsappNumber) data.telefono = whatsappNumber.replace(/[^0-9]/g, '')
    if (rol) data.role = rol === 'ADMIN' ? 'ADMIN' : 'VENDOR'

    const vendor = await prisma.vendor.update({ where: { id }, data })
    return reply.send({ ok: true, vendedor: vendor })
  } catch (error) {
    console.error('[config] updateVendedor:', error.message)
    return reply.status(500).send({ error: 'Error al actualizar vendedor' })
  }
}

// ============================================================
// VENDEDORES — Desactivar
// ============================================================
export async function desactivarVendedor(request, reply, prisma) {
  try {
    const id = Number(request.params.id)

    const vendor = await prisma.vendor.findUnique({ where: { id } })
    if (!vendor) return reply.status(404).send({ error: 'Vendedor no encontrado' })

    if (vendor.role === 'ADMIN') {
      const totalAdmins = await prisma.vendor.count({
        where: { role: 'ADMIN', activo: true }
      })
      if (totalAdmins <= 1) {
        return reply.status(400).send({ error: 'No puedes desactivar al único admin' })
      }
    }

    await prisma.vendor.update({
      where: { id },
      data: { activo: false }
    })

    return reply.send({ ok: true, mensaje: `${vendor.nombre} desactivado correctamente` })
  } catch (error) {
    console.error('[config] desactivarVendedor:', error.message)
    return reply.status(500).send({ error: 'Error al desactivar vendedor' })
  }
}
