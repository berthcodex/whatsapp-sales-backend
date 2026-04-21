// src/api/config.js
// Endpoints de configuración del sistema Hidata
//
// ARQUITECTURA — por qué un archivo separado:
// leads.js maneja el pipeline de ventas (datos que cambian a diario).
// config.js maneja la configuración del sistema (datos que cambian ocasionalmente).
// Separar responsabilidades hace el código mantenible — si algo falla en
// la configuración, no toca el pipeline de ventas.
//
// ENDPOINTS:
//   GET  /config/bot                      → leer los 7 mensajes del bot
//   PUT  /config/bot                      → guardar los 7 mensajes editados
//   GET  /config/vendedores               → listar vendedores del tenant
//   POST /config/vendedores               → agregar vendedor nuevo
//   PUT  /config/vendedores/:id           → editar datos de vendedor
//   PUT  /config/vendedores/:id/desactivar → desactivar sin borrar

const TENANT_ID = 'hidata'

// ============================================================
// BOT CONFIG — Leer
// Retorna la configuración activa del bot.
// El CRM usa esto para pre-llenar el formulario de edición.
// ============================================================
export async function getBotConfig(request, reply, prisma) {
  try {
    const config = await prisma.botConfig.findFirst({
      where: { tenantId: TENANT_ID, activo: true }
    })

    if (!config) {
      return reply.status(404).send({ error: 'No hay configuración activa' })
    }

    return reply.send(config)
  } catch (error) {
    console.error('[API/config] Error en getBotConfig:', error)
    return reply.status(500).send({ error: 'Error al obtener configuración' })
  }
}

// ============================================================
// BOT CONFIG — Guardar
// Recibe los 7 mensajes editados desde el CRM y los persiste.
//
// Por qué no borramos y recreamos:
// Usamos UPDATE sobre el registro activo existente. Así conservamos
// el historial de cuándo se creó la config y no rompemos referencias.
// ============================================================
export async function updateBotConfig(request, reply, prisma) {
  try {
    const {
      msgBienvenida,
      msgProducto,
      msgExperiencia,
      msgPresentacion,
      msgObjecion,
      msgUrgencia,
      msgHandoff,
      nombreEmpresa,
      nombreProducto
    } = request.body

    // Encontrar config activa del tenant
    const configActual = await prisma.botConfig.findFirst({
      where: { tenantId: TENANT_ID, activo: true }
    })

    if (!configActual) {
      return reply.status(404).send({ error: 'No hay configuración activa para actualizar' })
    }

    // Solo actualizar los campos que vinieron en el body
    // Si un campo no viene → conservar el valor actual
    const data = { updatedEn: new Date() }
    if (msgBienvenida   !== undefined) data.msgBienvenida   = msgBienvenida
    if (msgProducto     !== undefined) data.msgProducto     = msgProducto
    if (msgExperiencia  !== undefined) data.msgExperiencia  = msgExperiencia
    if (msgPresentacion !== undefined) data.msgPresentacion = msgPresentacion
    if (msgObjecion     !== undefined) data.msgObjecion     = msgObjecion
    if (msgUrgencia     !== undefined) data.msgUrgencia     = msgUrgencia
    if (msgHandoff      !== undefined) data.msgHandoff      = msgHandoff
    if (nombreEmpresa   !== undefined) data.nombreEmpresa   = nombreEmpresa
    if (nombreProducto  !== undefined) data.nombreProducto  = nombreProducto

    const config = await prisma.botConfig.update({
      where: { id: configActual.id },
      data
    })

    console.log(`[API/config] BotConfig actualizada — tenant: ${TENANT_ID}`)
    return reply.send({ ok: true, config })
  } catch (error) {
    console.error('[API/config] Error en updateBotConfig:', error)
    return reply.status(500).send({ error: 'Error al guardar configuración' })
  }
}

// ============================================================
// VENDEDORES — Listar
// Retorna todos los vendedores del tenant (activos e inactivos).
// El CRM muestra activos y permite ver/reactivar inactivos.
// ============================================================
export async function getVendedores(request, reply, prisma) {
  try {
    const vendedores = await prisma.vendedor.findMany({
      where: { tenantId: TENANT_ID },
      orderBy: { creadoEn: 'asc' },
      select: {
        id: true,
        nombre: true,
        email: true,
        rol: true,
        whatsappNumber: true,
        instanciaEvolution: true,
        activo: true,
        creadoEn: true,
        // Incluir conteo de leads asignados — útil para el CRM
        _count: { select: { leads: true } }
      }
    })

    // Formatear para el CRM — aplanar el _count
    const formateados = vendedores.map(v => ({
      id: v.id,
      nombre: v.nombre,
      email: v.email || '',
      rol: v.rol,
      whatsappNumber: v.whatsappNumber,
      instanciaEvolution: v.instanciaEvolution || '',
      activo: v.activo,
      creadoEn: v.creadoEn,
      totalLeads: v._count.leads
    }))

    return reply.send(formateados)
  } catch (error) {
    console.error('[API/config] Error en getVendedores:', error)
    return reply.status(500).send({ error: 'Error al obtener vendedores' })
  }
}

// ============================================================
// VENDEDORES — Agregar
// Crea un vendedor nuevo desde el CRM.
//
// Por qué instanciaEvolution es importante:
// Es el identificador que Evolution API usa para saber a qué
// número de WhatsApp pertenece cada instancia. Sin esto,
// el bot no sabe a qué vendedor asignar el lead entrante.
// ============================================================
export async function createVendedor(request, reply, prisma) {
  try {
    const { nombre, email, whatsappNumber, rol } = request.body

    if (!nombre || !whatsappNumber) {
      return reply.status(400).send({ error: 'nombre y whatsappNumber son requeridos' })
    }

    // Limpiar el número — quitar +, espacios, guiones
    const numeroLimpio = whatsappNumber.replace(/[^0-9]/g, '')

    // Verificar que el número no exista ya
    const existente = await prisma.vendedor.findFirst({
      where: { whatsappNumber: numeroLimpio }
    })
    if (existente) {
      return reply.status(409).send({ error: `El número ${numeroLimpio} ya está registrado` })
    }

    // Generar instanciaEvolution automáticamente desde el nombre
    // "María José" → "peru-exporta-maria-jose"
    const slugNombre = nombre
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]/g, '-')
      .replace(/-+/g, '-')
      .trim()
    const instanciaEvolution = `peru-exporta-${slugNombre}`

    const vendedor = await prisma.vendedor.create({
      data: {
        tenantId: TENANT_ID,
        nombre,
        email: email || null,
        rol: rol || 'VENDEDOR',
        whatsappNumber: numeroLimpio,
        instanciaEvolution,
        activo: true
      }
    })

    console.log(`[API/config] Vendedor creado: ${nombre} (${numeroLimpio})`)
    return reply.status(201).send({ ok: true, vendedor })
  } catch (error) {
    console.error('[API/config] Error en createVendedor:', error)
    return reply.status(500).send({ error: 'Error al crear vendedor' })
  }
}

// ============================================================
// VENDEDORES — Editar
// Permite actualizar nombre, email, número WhatsApp o rol.
// No toca instanciaEvolution — eso es el identificador de Evolution API.
// ============================================================
export async function updateVendedor(request, reply, prisma) {
  try {
    const { id } = request.params
    const { nombre, email, whatsappNumber, rol } = request.body

    const vendedorExistente = await prisma.vendedor.findUnique({ where: { id } })
    if (!vendedorExistente) {
      return reply.status(404).send({ error: 'Vendedor no encontrado' })
    }

    const data = { updatedEn: new Date() }
    if (nombre)         data.nombre = nombre
    if (email)          data.email  = email
    if (rol)            data.rol    = rol
    if (whatsappNumber) {
      data.whatsappNumber = whatsappNumber.replace(/[^0-9]/g, '')
    }

    const vendedor = await prisma.vendedor.update({ where: { id }, data })

    console.log(`[API/config] Vendedor actualizado: ${vendedor.nombre}`)
    return reply.send({ ok: true, vendedor })
  } catch (error) {
    console.error('[API/config] Error en updateVendedor:', error)
    return reply.status(500).send({ error: 'Error al actualizar vendedor' })
  }
}

// ============================================================
// VENDEDORES — Desactivar
// Nunca borramos vendedores — tienen leads asignados con historial.
// Desactivar es como "archivar": deja de recibir leads nuevos
// pero su historial y datos quedan intactos.
// ============================================================
export async function desactivarVendedor(request, reply, prisma) {
  try {
    const { id } = request.params

    const vendedor = await prisma.vendedor.findUnique({ where: { id } })
    if (!vendedor) {
      return reply.status(404).send({ error: 'Vendedor no encontrado' })
    }

    // No permitir desactivar al último ADMIN
    if (vendedor.rol === 'ADMIN') {
      const totalAdmins = await prisma.vendedor.count({
        where: { tenantId: TENANT_ID, rol: 'ADMIN', activo: true }
      })
      if (totalAdmins <= 1) {
        return reply.status(400).send({ error: 'No puedes desactivar al único admin del sistema' })
      }
    }

    await prisma.vendedor.update({
      where: { id },
      data: { activo: false, updatedEn: new Date() }
    })

    console.log(`[API/config] Vendedor desactivado: ${vendedor.nombre}`)
    return reply.send({ ok: true, mensaje: `${vendedor.nombre} desactivado correctamente` })
  } catch (error) {
    console.error('[API/config] Error en desactivarVendedor:', error)
    return reply.status(500).send({ error: 'Error al desactivar vendedor' })
  }
}
