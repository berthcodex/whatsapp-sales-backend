// src/routes/auth.js — Sprint 3
// POST /auth/login — Login con PIN de 4 dígitos
// Sin JWT por ahora — el CRM guarda el vendedor en localStorage
// Seguridad suficiente para un sistema interno de 3 personas

export async function loginVendor(request, reply, prisma) {
  try {
    const { nombre, pin } = request.body

    if (!nombre || !pin) {
      return reply.status(400).send({ error: 'nombre y pin son requeridos' })
    }

    const vendor = await prisma.vendor.findFirst({
      where: { nombre, pin: String(pin), activo: true }
    })

    if (!vendor) {
      return reply.status(401).send({ error: 'PIN incorrecto o vendedor no encontrado' })
    }

    // Nunca devolver el PIN al cliente
    const { pin: _, ...vendorSafe } = vendor

    return reply.send({
      ok: true,
      vendor: {
        ...vendorSafe,
        // Campos compatibles con el CRM existente
        id: vendor.id,
        nombre: vendor.nombre,
        rol: vendor.role,          // ADMIN | VENDOR
        role: vendor.role,
        instancia: vendor.instanciaEvolution || '',
        whatsappNumber: vendor.whatsappNumber || '',
        initials: vendor.nombre.substring(0, 2).toUpperCase(),
        color: getColorPorNombre(vendor.nombre),
      }
    })
  } catch (error) {
    console.error('[Auth] Error en login:', error.message)
    return reply.status(500).send({ error: 'Error interno' })
  }
}

// GET /auth/vendors — lista pública de nombres para la pantalla de login
// No devuelve PINs ni datos sensibles
export async function getVendorNames(request, reply, prisma) {
  try {
    const vendors = await prisma.vendor.findMany({
      where: { activo: true },
      select: { id: true, nombre: true, role: true },
      orderBy: { id: 'asc' }
    })

    return reply.send(vendors.map(v => ({
      id: v.id,
      nombre: v.nombre,
      role: v.role,
      initials: v.nombre.substring(0, 2).toUpperCase(),
      color: getColorPorNombre(v.nombre),
    })))
  } catch (error) {
    console.error('[Auth] Error en getVendorNames:', error.message)
    return reply.status(500).send({ error: 'Error interno' })
  }
}

// Colores determinísticos por nombre — mismo que config.js del CRM
function getColorPorNombre(nombre) {
  const colores = ['#ff6b35','#7c3aed','#16a34a','#0ea5e9','#f59e0b','#ef4444','#8b5cf6','#06b6d4']
  const i = nombre.charCodeAt(0) % colores.length
  return colores[i]
}
