// src/perception/perception-context-builder.js — Hidata v20
//
// Construye el "contexto" que recibe Perception ANTES de llamar a Gemini
// 
// SEPARACIÓN DE RESPONSABILIDADES:
//   - Este módulo lee BD (NO llama a LLM)
//   - Devuelve flags calculables por código (is_returning_lead, days_since_last_msg)
//   - Perception (Gemini) recibe el contexto como ground truth
//
// Resuelve el Hallazgo 1 del análisis forense:
//   "Sistema NO reconoce leads que vuelven después de 30+ días"
//
// COSTO: 0 tokens. Cero llamadas externas. Solo queries Postgres.

import prisma from '../db/prisma.js'

// ════════════════════════════════════════════════════════
// CONSTANTES
// ════════════════════════════════════════════════════════
const HISTORIAL_TURNS = 5  // Últimos N turnos del historial corto

// Umbrales para is_returning_lead (Hallazgo 1)
const RETURNING_LEAD_DAYS_THRESHOLD = 30   // <30 días = no es returning
const RETURNING_LEAD_DORMANT_THRESHOLD = 180 // >180 días = dormant largo

// ════════════════════════════════════════════════════════
// API PRINCIPAL
// ════════════════════════════════════════════════════════
export async function buildPerceptionContext({
  telefono,
  mensaje,
  tenantId = 'peru_exporta',
  instanciaEvolution = null
}) {
  if (!telefono) {
    throw new Error('telefono is required to build context')
  }

  // ─── 1. Buscar lead por teléfono ───
  const lead = await prisma.lead.findUnique({
    where: { telefono },
    include: {
      leadState: true,
      campaign: { select: { slug: true, nombre: true } },
      vendor:   { select: { id: true, nombre: true } }
    }
  })

  // ─── 2. Verificar si es teléfono de prueba ───
  const testPhone = await prisma.testPhone.findUnique({
    where: { telefono }
  })
  const isTestPhone = !!testPhone

  // ─── 3. CASO A: lead nuevo (no existe en BD) ───
  if (!lead) {
    return {
      mensaje,
      contexto: {
        tenant_id: tenantId,
        lead_id: null,
        historial_corto: [],
        perfil_actual: {
          nombre: null,
          producto: null,
          stage: 'first_contact',
          mode: 'AUTO_CONSULTIVO'
        },
        flags: {
          is_returning_lead: false,
          days_since_last_msg: null,
          reset_generation: 1,
          is_test_phone: isTestPhone,
          is_first_turn: true,
          current_stage: 'first_contact',
          current_mode: 'AUTO_CONSULTIVO',
          campaign_slug: null,
          turn_number: 1
        }
      }
    }
  }

  // ─── 4. CASO B: lead existe — calcular flags ───
  const ahora = new Date()
  const ultimoMensaje = lead.ultimoMensaje || lead.createdAt
  const msSinUltimoMsg = ahora - new Date(ultimoMensaje)
  const daysSinceLastMsg = Math.floor(msSinUltimoMsg / (1000 * 60 * 60 * 24))

  // Flag is_returning_lead: lead que vuelve después de 30+ días
  const isReturningLead = daysSinceLastMsg >= RETURNING_LEAD_DAYS_THRESHOLD
  const isDormantLong = daysSinceLastMsg >= RETURNING_LEAD_DORMANT_THRESHOLD

  // ─── 5. Cargar historial corto (últimos N turnos) ───
  const historialRaw = await prisma.message.findMany({
    where: { leadId: lead.id },
    orderBy: { createdAt: 'desc' },
    take: HISTORIAL_TURNS
  })

  const historial_corto = historialRaw
    .reverse()  // oldest first
    .map(m => ({
      role: m.origen === 'LEAD' ? 'lead' : 'bot',
      text: m.texto,
      timestamp: m.createdAt.toISOString()
    }))

  // ─── 6. Estado conversacional v20 (si existe) ───
  const leadState = lead.leadState
  const currentStage = leadState?.currentStage || 'first_contact'
  const currentMode = leadState?.currentMode || 'AUTO_CONSULTIVO'
  const resetGeneration = 1  // por ahora siempre 1, se actualizará en Día 3

  // ─── 7. Conteo total de turnos del lead ───
  const totalTurns = await prisma.message.count({
    where: { leadId: lead.id }
  })

  // ─── 8. Armar perfil_actual con lo que sabemos ───
  const perfil_actual = {
    nombre: lead.nombreDetectado || null,
    producto: lead.productoDetectado || null,
    stage: currentStage,
    mode: currentMode
  }

  // ─── 9. Devolver contexto completo ───
  return {
    mensaje,
    contexto: {
      tenant_id: tenantId,
      lead_id: lead.id,
      historial_corto,
      perfil_actual,
      flags: {
        is_returning_lead: isReturningLead,
        is_dormant_long: isDormantLong,
        days_since_last_msg: daysSinceLastMsg,
        reset_generation: resetGeneration,
        is_test_phone: isTestPhone,
        is_first_turn: totalTurns === 0,
        current_stage: currentStage,
        current_mode: currentMode,
        campaign_slug: lead.campaign?.slug || null,
        vendor_id: lead.vendor?.id || null,
        vendor_nombre: lead.vendor?.nombre || null,
        turn_number: totalTurns + 1,
        archived: !!lead.archivedAt
      }
    }
  }
}

// ════════════════════════════════════════════════════════
// HELPER — para debugging del context builder
// Devuelve un resumen humano del contexto construido
// ════════════════════════════════════════════════════════
export function summarizeContext(builtContext) {
  const ctx = builtContext.contexto
  const lines = [
    `── Context summary ──`,
    `Tenant: ${ctx.tenant_id}`,
    `Lead ID: ${ctx.lead_id ?? 'NUEVO'}`,
    `Test phone: ${ctx.flags.is_test_phone ? 'sí' : 'no'}`,
    `Turn #: ${ctx.flags.turn_number}`,
    `Returning: ${ctx.flags.is_returning_lead ? `sí (${ctx.flags.days_since_last_msg}d)` : 'no'}`,
    `Stage: ${ctx.flags.current_stage} | Mode: ${ctx.flags.current_mode}`,
    `Historial: ${ctx.historial_corto.length} turnos`,
    `Perfil: nombre=${ctx.perfil_actual.nombre ?? '∅'}, producto=${ctx.perfil_actual.producto ?? '∅'}`
  ]
  return lines.join('\n')
}