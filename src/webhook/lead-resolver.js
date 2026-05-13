// src/webhook/lead-resolver.js — Hidata v20 Día 7
//
// LEAD RESOLVER
//
// Resuelve el leadId a partir del número de WhatsApp (remoteJid de Evolution).
// Si el lead no existe en BD, lo crea automáticamente.
//
// Pipeline interno:
//   1. Extraer número desde remoteJid (quita @s.whatsapp.net, espacios, +, etc)
//   2. Buscar lead por telefono en BD
//   3. Si existe → return leadId + metadata
//   4. Si NO existe → crear con vendor asignado a la instancia
//   5. Si BD falla → return error, NO crash
//
// Vendor assignment para leads nuevos:
//   - Busca vendor activo con la misma instanciaEvolution del payload
//   - Si no encuentra, fallback a vendor con role=ADMIN
//   - Si tampoco, fallback a vendor_id=1 (Joan, default)

import prisma from '../db/prisma.js'

// ════════════════════════════════════════════════════════
// CONFIGURACIÓN
// ════════════════════════════════════════════════════════
const DEFAULT_TENANT_ID = 'peru_exporta'
const DEFAULT_CAMPAIGN_SLUG = 'MPX'
const FALLBACK_VENDOR_ID = 1                  // Joan, por defecto si nada más funciona

// ════════════════════════════════════════════════════════
// API PÚBLICA — resolveLead()
// ════════════════════════════════════════════════════════

/**
 * Resuelve o crea un lead a partir del payload de Evolution.
 * 
 * @param {object} params
 * @param {string} params.remoteJid - Ej: "51938188585@s.whatsapp.net"
 * @param {string} params.instanceName - Nombre de instancia Evolution (ej: "peru-exporta-test")
 * @param {string} params.pushName - Nombre público del WhatsApp (opcional)
 * @param {string} params.tenantId - Tenant ID (default: peru_exporta)
 * @returns {object} {
 *   ok, leadId, telefono, vendorId, vendorNombre, 
 *   isNew, tenantId, errors
 * }
 */
export async function resolveLead({
  remoteJid,
  instanceName,
  pushName = null,
  tenantId = DEFAULT_TENANT_ID
}) {
  const startTime = Date.now()

  // ─── 1. Validación de input ───
  if (!remoteJid || typeof remoteJid !== 'string') {
    return buildErrorResponse('remoteJid_missing', startTime)
  }

  // ─── 2. Detectar y rechazar grupos ───
  if (isGroupJid(remoteJid)) {
    return buildErrorResponse('group_jid_not_supported', startTime, {
      jid: remoteJid
    })
  }

  // ─── 3. Normalizar número ───
  const telefono = normalizePhone(remoteJid)
  
  if (!telefono || telefono.length < 9) {
    return buildErrorResponse('invalid_phone_number', startTime, {
      originalJid: remoteJid,
      normalized: telefono
    })
  }

  try {
    // ─── 4. Resolver vendor para la instancia ───
    const vendor = await resolveVendor(instanceName)

    // ─── 5. Upsert atómico del lead ───
    const lead = await prisma.lead.upsert({
      where: { telefono },
      update: {
        ultimoMensaje: new Date()
        // NO actualizamos otros campos aquí (lead ya existe, su data es válida)
      },
      create: {
        telefono,
        nombreDetectado: pushName || null,
        estado: 'EN_FLUJO',
        pasoActual: 1,
        campaignSlug: DEFAULT_CAMPAIGN_SLUG,
        vendorId: vendor.id,
        ultimoMensaje: new Date()
      },
      select: {
        id: true,
        telefono: true,
        vendorId: true,
        estado: true,
        pasoActual: true,
        nombreDetectado: true,
        productoDetectado: true,
        createdAt: true,
        archived: true
      }
    })

    // ─── 6. Detectar si es nuevo (createdAt reciente = hace < 5 segundos) ───
    const ageMs = Date.now() - new Date(lead.createdAt).getTime()
    const isNew = ageMs < 5000

    if (isNew) {
      console.log(`[LeadResolver] NEW lead created: ${telefono} (id: ${lead.id}, vendor: ${vendor.nombre})`)
    } else {
      console.log(`[LeadResolver] Existing lead: ${telefono} (id: ${lead.id}, vendor: ${vendor.nombre})`)
    }

    // ─── 7. Devolver resultado exitoso ───
    return {
      ok: true,
      leadId: lead.id,
      telefono: lead.telefono,
      vendorId: lead.vendorId,
      vendorNombre: vendor.nombre,
      isNew,
      tenantId,
      isArchived: lead.archived || false,
      leadEstado: lead.estado,
      nombreDetectado: lead.nombreDetectado,
      productoDetectado: lead.productoDetectado,
      latency_ms: Date.now() - startTime,
      errors: []
    }

  } catch (err) {
    console.error('[LeadResolver] Error:', err.message)
    return buildErrorResponse('database_error', startTime, {
      message: err.message,
      stack: err.stack?.split('\n').slice(0, 3)
    })
  }
}

// ════════════════════════════════════════════════════════
// HELPER — Resolver vendor para una instancia
// ════════════════════════════════════════════════════════

/**
 * Encuentra el vendor activo asignado a una instancia Evolution.
 * Cascade fallback:
 *   1. Vendor con instanciaEvolution = instanceName
 *   2. Vendor con role = ADMIN
 *   3. Vendor con id = FALLBACK_VENDOR_ID (Joan, hardcoded)
 *   4. Si nada funciona, lanza error
 */
async function resolveVendor(instanceName) {
  try {
    // Cascade 1: vendor con instancia coincidente
    if (instanceName) {
      const vendorByInstance = await prisma.vendor.findFirst({
        where: {
          instanciaEvolution: instanceName,
          activo: true
        },
        select: {
          id: true,
          nombre: true,
          activo: true,
          role: true,
          instanciaEvolution: true
        }
      })

      if (vendorByInstance) {
        return vendorByInstance
      }
    }

    console.warn(`[LeadResolver] No vendor found for instance "${instanceName}", falling back to ADMIN`)

    // Cascade 2: vendor con role ADMIN
    const adminVendor = await prisma.vendor.findFirst({
      where: {
        role: 'ADMIN',
        activo: true
      },
      select: {
        id: true,
        nombre: true,
        activo: true,
        role: true,
        instanciaEvolution: true
      }
    })

    if (adminVendor) {
      return adminVendor
    }

    console.warn('[LeadResolver] No active ADMIN vendor, falling back to vendor_id=1')

    // Cascade 3: vendor por ID hardcoded (Joan)
    const fallbackVendor = await prisma.vendor.findUnique({
      where: { id: FALLBACK_VENDOR_ID },
      select: {
        id: true,
        nombre: true,
        activo: true,
        role: true,
        instanciaEvolution: true
      }
    })

    if (fallbackVendor) {
      return fallbackVendor
    }

    // Si llegamos aquí, no hay vendor en BD (escenario catastrófico)
    throw new Error('No vendor available in database')

  } catch (err) {
    console.error('[LeadResolver] resolveVendor failed:', err.message)
    throw err
  }
}

// ════════════════════════════════════════════════════════
// HELPERS — Phone normalization & validation
// ════════════════════════════════════════════════════════

/**
 * Extrae solo dígitos de un remoteJid o número de teléfono.
 * 
 * Inputs aceptados:
 *   - "51938188585@s.whatsapp.net" → "51938188585"
 *   - "+51-938-188-585" → "51938188585"
 *   - "whatsapp:+51938188585" → "51938188585"
 * 
 * @param {string} jid - JID o número
 * @returns {string} solo dígitos
 */
export function normalizePhone(jid) {
  if (!jid || typeof jid !== 'string') return ''
  
  // Remover sufijo @s.whatsapp.net si existe
  let cleaned = jid.replace(/@.+$/, '')
  
  // Remover prefijo whatsapp: si existe
  cleaned = cleaned.replace(/^whatsapp:/, '')
  
  // Remover todo lo no-numérico
  cleaned = cleaned.replace(/\D/g, '')
  
  return cleaned
}

/**
 * Detecta si un JID es de un grupo (vs individual).
 * Grupos terminan en "@g.us", individuales en "@s.whatsapp.net"
 */
export function isGroupJid(jid) {
  if (!jid || typeof jid !== 'string') return false
  return jid.endsWith('@g.us')
}

// ════════════════════════════════════════════════════════
// HELPER — Build error response
// ════════════════════════════════════════════════════════

function buildErrorResponse(errorCode, startTime, metadata = {}) {
  console.error(`[LeadResolver] Error: ${errorCode}`, metadata)
  
  return {
    ok: false,
    leadId: null,
    telefono: null,
    vendorId: null,
    vendorNombre: null,
    isNew: false,
    tenantId: null,
    latency_ms: Date.now() - startTime,
    errors: [{
      code: errorCode,
      metadata
    }]
  }
}

// ════════════════════════════════════════════════════════
// HELPER PÚBLICO — Resumen para logs
// ════════════════════════════════════════════════════════

export function summarizeResolution(result) {
  if (!result) return 'no result'
  
  if (!result.ok) {
    return `❌ resolve failed: ${result.errors?.[0]?.code || 'unknown'} (${result.latency_ms}ms)`
  }
  
  const newLabel = result.isNew ? ' [NEW]' : ''
  const archivedLabel = result.isArchived ? ' [ARCHIVED]' : ''
  
  return `✅ lead ${result.leadId} (${result.telefono}) → vendor ${result.vendorNombre}${newLabel}${archivedLabel} (${result.latency_ms}ms)`
}

// ════════════════════════════════════════════════════════
// VERSION TRACKING
// ════════════════════════════════════════════════════════
export const LEAD_RESOLVER_VERSION = 'v1_day7_upsert_with_vendor_cascade'