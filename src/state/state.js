// src/state/state.js — Hidata v20 (Día 5)
//
// PIPELINE COMPLETO: State + Mode Router + Policy Layer
//
// Pipeline interno:
//   1. Lee lead_state actual (o crea uno si no existe)
//   2. Llama resolveNextState() para decidir transición
//   3. Llama mergeSlots() para actualizar slots
//   4. Escribe lead_state actualizado (transacción)
//   5. Sincroniza lead.pasoActual y campos espejo
//   6. [Día 4] Llama Mode Router para evaluar guards operacionales
//   7. [Día 4] Si Mode Router escaló el mode, persiste el cambio
//   8. [NEW Día 5] Llama Policy Layer para decidir acción
//   9. Actualiza turn_trace.stateAfter + modeRouterDecision + policyDecision
//   10. Devuelve { leadState, transition, mergeResult, modeRouterDecision, policyDecision }
//
// NUNCA crashea — si algo falla, devuelve estado original sin cambios

import prisma from '../db/prisma.js'
import { resolveNextState, STATE_TRANSITIONS_VERSION } from './state-transitions.js'
import { mergeSlots, sanitizeSlots, summarizeMerge, CONTEXT_GRAPH_VERSION } from './context-graph.js'
import {
  STAGES,
  MODES,
  STAGE_TO_PASO_ACTUAL,
  MODE_TO_LEAD_ESTADO,
  SLOT_TO_LEAD_COLUMN,
  SLOTS,
  describeLeadState,
  STATE_DEFINITIONS_VERSION
} from './stage-definitions.js'
import { decideMode, summarizeModeDecision, MODE_ROUTER_VERSION } from '../routing/mode-router.js'
import { decidirPolicy, summarizeFullPolicyDecision, POLICY_VERSION } from '../policy/policy.js'

// ════════════════════════════════════════════════════════
// API PRINCIPAL — actualizarEstado()
// ════════════════════════════════════════════════════════

export async function actualizarEstado({ perception, leadId, telefono, contextFlags = {} }) {
  const startTime = Date.now()
  const errors = []

  if (!leadId) {
    return {
      ok: false,
      errors: [{ phase: 'validation', message: 'leadId is required' }],
      leadState: null, transition: null, mergeResult: null, 
      modeRouterDecision: null, policyDecision: null
    }
  }

  if (!perception) {
    return {
      ok: false,
      errors: [{ phase: 'validation', message: 'perception is required' }],
      leadState: null, transition: null, mergeResult: null, 
      modeRouterDecision: null, policyDecision: null
    }
  }

  try {
    // ─── 1. Leer o crear lead_state ───
    const currentLeadState = await getOrCreateLeadState(leadId)
    const stateBefore = serializeStateBefore(currentLeadState)

    // ─── 2. Calcular transición (función pura) ───
    const transition = resolveNextState({
      perception,
      currentState: currentLeadState,
      flags: contextFlags
    })

    // ─── 3. Mergear slots ───
    const mergeResult = mergeSlots(
      currentLeadState.slotsFilled || {},
      sanitizeSlots(transition.slots_to_merge || {})
    )

    // ─── 4. Construir lead_state actualizado ───
    const updates = buildLeadStateUpdates({
      transition, mergeResult, currentLeadState, contextFlags
    })

    // ─── 5. Escribir lead_state y lead en transacción ───
    let updatedLeadState
    
    updatedLeadState = await prisma.$transaction(async (tx) => {
      const newLeadState = await tx.leadState.update({
        where: { leadId },
        data: updates
      })

      const leadUpdates = buildLeadSyncUpdates({ transition, mergeResult })
      if (Object.keys(leadUpdates).length > 0) {
        await tx.lead.update({
          where: { id: leadId },
          data: leadUpdates
        }).catch(err => {
          console.error('[State] Error syncing lead:', err.message)
          errors.push({ phase: 'sync_lead', message: err.message })
        })
      }

      return newLeadState
    })

    // ════════════════════════════════════════════════════════
    // ─── 6. [Día 4] Llamar Mode Router ───
    // ════════════════════════════════════════════════════════
    let modeRouterDecision = null
    let finalLeadState = updatedLeadState
    
    try {
      const [tenantSettings, vendorActivo] = await Promise.all([
        loadTenantSettings(perception?.meta?.tenant_id || 'peru_exporta'),
        loadVendorActivo(updatedLeadState.vendorActiveId)
      ])

      modeRouterDecision = decideMode({
        leadState: updatedLeadState,
        perception,
        context: contextFlags,
        tenantSettings,
        vendorActivo
      })

      // ─── 7. [Día 4] Si Mode Router escaló, persistir ───
      if (modeRouterDecision.decision.overrode_state) {
        const newMode = modeRouterDecision.decision.final_mode
        
        const newEstado = MODE_TO_LEAD_ESTADO[newMode]
        const additionalLeadUpdates = {}
        if (newEstado !== null && newEstado !== undefined) {
          additionalLeadUpdates.estado = newEstado
        }

        finalLeadState = await prisma.$transaction(async (tx) => {
          const updatedAgain = await tx.leadState.update({
            where: { leadId },
            data: {
              currentMode: newMode,
              modeEnteredAt: new Date()
            }
          })

          if (Object.keys(additionalLeadUpdates).length > 0) {
            await tx.lead.update({
              where: { id: leadId },
              data: additionalLeadUpdates
            }).catch(err => {
              console.error('[State] Error syncing lead after router:', err.message)
              errors.push({ phase: 'sync_lead_after_router', message: err.message })
            })
          }

          return updatedAgain
        })

        console.log(`[State] Mode Router escaló: ${summarizeModeDecision(modeRouterDecision)}`)
      }

    } catch (err) {
      console.error('[State] Mode Router failed:', err.message)
      errors.push({ phase: 'mode_router', message: err.message })
    }

    // ════════════════════════════════════════════════════════
    // ─── 8. [NEW Día 5] Llamar Policy Layer ───
    // ════════════════════════════════════════════════════════
    let policyDecision = null
    
    try {
      policyDecision = decidirPolicy({
        leadState: finalLeadState,
        perception,
        context: contextFlags
      })

      console.log(`[State] Policy decidió: ${summarizeFullPolicyDecision(policyDecision)}`)

    } catch (err) {
      console.error('[State] Policy Layer failed:', err.message)
      errors.push({ phase: 'policy', message: err.message })
      // Policy NUNCA crashea (tiene fallback interno), pero por si acaso
    }

    // ════════════════════════════════════════════════════════
    // ─── 9. Actualizar turn_trace con TODO ───
    // ════════════════════════════════════════════════════════
    const turnId = perception?.meta?.turn_id
    if (turnId) {
      const stateAfter = serializeStateAfter({
        newLeadState: finalLeadState,
        transition,
        mergeResult,
        modeRouterDecision,
        policyDecision
      })

      await prisma.turnTrace.update({
        where: { turnId },
        data: {
          stateAfter,
          modeRouterDecision: modeRouterDecision || {},
          policyDecision: policyDecision || {},
          policyVersion: POLICY_VERSION,
          guardrailsEvaluated: policyDecision?.guardrails?.evaluated || []
        }
      }).catch(err => {
        console.error('[State] Error updating turn_trace:', err.message)
        errors.push({ phase: 'update_trace', message: err.message })
      })
    }

    const latencyMs = Date.now() - startTime
    
    // Log resumen completo
    console.log(
      `[State] ${telefono || `lead_${leadId}`} | ` +
      `${describeLeadState(currentLeadState)} → ${describeLeadState(finalLeadState)} | ` +
      `${transition.transition_reason} | ` +
      `${summarizeMerge(mergeResult)} | ` +
      `router: ${modeRouterDecision ? summarizeModeDecision(modeRouterDecision) : 'skipped'} | ` +
      `policy: ${policyDecision ? summarizeFullPolicyDecision(policyDecision) : 'skipped'} | ` +
      `${latencyMs}ms`
    )

    return {
      ok: true,
      leadState: finalLeadState,
      transition,
      mergeResult,
      modeRouterDecision,
      policyDecision,
      errors,
      latency_ms: latencyMs,
      stateBefore
    }

  } catch (err) {
    console.error('[State] Fatal error:', err.message)
    errors.push({ phase: 'fatal', message: err.message, stack: err.stack?.split('\n').slice(0, 3) })
    
    return {
      ok: false,
      errors,
      leadState: null,
      transition: null,
      mergeResult: null,
      modeRouterDecision: null,
      policyDecision: null,
      latency_ms: Date.now() - startTime
    }
  }
}

// ════════════════════════════════════════════════════════
// LOADERS — para Mode Router
// ════════════════════════════════════════════════════════

async function loadTenantSettings(tenantId) {
  try {
    return await prisma.tenantSettings.findUnique({
      where: { tenantId }
    })
  } catch (err) {
    console.error('[State] Error loading tenantSettings:', err.message)
    return null
  }
}

async function loadVendorActivo(vendorId) {
  if (!vendorId) return null
  try {
    return await prisma.vendor.findUnique({
      where: { id: vendorId },
      select: { id: true, nombre: true, activo: true, instanciaEvolution: true, whatsappNumber: true }
    })
  } catch (err) {
    console.error('[State] Error loading vendor:', err.message)
    return null
  }
}

// ════════════════════════════════════════════════════════
// getOrCreateLeadState
// ════════════════════════════════════════════════════════

async function getOrCreateLeadState(leadId) {
  const existing = await prisma.leadState.findUnique({
    where: { leadId }
  })

  if (existing) return existing

  console.log(`[State] Creating lead_state for lead ${leadId} (first time)`)
  
  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    select: { estado: true, pasoActual: true, nombreDetectado: true, productoDetectado: true, vendorId: true }
  })

  const inferredStage = inferStageFromV19({
    estado: lead?.estado,
    pasoActual: lead?.pasoActual
  })

  const initialSlots = {}
  if (lead?.nombreDetectado)   initialSlots[SLOTS.NOMBRE]   = lead.nombreDetectado
  if (lead?.productoDetectado) initialSlots[SLOTS.PRODUCTO] = lead.productoDetectado

  const newLeadState = await prisma.leadState.create({
    data: {
      leadId,
      currentMode:  MODES.AUTO_CONSULTIVO,
      currentStage: inferredStage,
      slotsFilled:  initialSlots,
      slotsPending: [],
      intentosPorSlot: {},
      vendorActiveId: lead?.vendorId || null,
      returningLeadFlag: false
    }
  })

  return newLeadState
}

function inferStageFromV19({ estado, pasoActual }) {
  if (estado === 'CERRADO') return STAGES.POST_CLOSE
  if (estado === 'PAGO_PENDIENTE') return STAGES.POST_CLOSE

  const PASO_TO_STAGE = {
    1: STAGES.FIRST_CONTACT,
    2: STAGES.DISCOVERY,
    3: STAGES.QUALIFYING_EMPRESA,
    4: STAGES.PRESENTING,
    5: STAGES.CALL_SCHEDULING,
    6: STAGES.CALL_CONFIRMED,
    7: STAGES.POST_CLOSE
  }

  return PASO_TO_STAGE[pasoActual || 1] || STAGES.FIRST_CONTACT
}

// ════════════════════════════════════════════════════════
// CONSTRUCCIÓN DE UPDATES
// ════════════════════════════════════════════════════════

function buildLeadStateUpdates({ transition, mergeResult, currentLeadState, contextFlags }) {
  const updates = {
    lastMessageAt: new Date(),
    slotsFilled: mergeResult.merged
  }

  if (transition.nextStage !== currentLeadState.currentStage) {
    updates.currentStage = transition.nextStage
  }

  if (transition.nextMode !== currentLeadState.currentMode) {
    updates.currentMode = transition.nextMode
    updates.modeEnteredAt = new Date()
  }

  if (contextFlags.is_returning_lead && !currentLeadState.returningLeadFlag) {
    updates.returningLeadFlag = true
  }

  return updates
}

function buildLeadSyncUpdates({ transition, mergeResult }) {
  const updates = {}

  const nextPasoActual = STAGE_TO_PASO_ACTUAL[transition.nextStage]
  if (nextPasoActual) {
    updates.pasoActual = nextPasoActual
  }

  const newEstado = MODE_TO_LEAD_ESTADO[transition.nextMode]
  if (newEstado !== null && newEstado !== undefined) {
    updates.estado = newEstado
  }

  for (const [slotKey, leadColumn] of Object.entries(SLOT_TO_LEAD_COLUMN)) {
    if (mergeResult.changes[slotKey]) {
      updates[leadColumn] = mergeResult.changes[slotKey].new
    }
  }

  updates.ultimoMensaje = new Date()

  return updates
}

// ════════════════════════════════════════════════════════
// SERIALIZACIÓN para turn_trace
// ════════════════════════════════════════════════════════

function serializeStateBefore(leadState) {
  return {
    mode: leadState.currentMode,
    stage: leadState.currentStage,
    slots_filled: leadState.slotsFilled,
    returning_lead_flag: leadState.returningLeadFlag,
    last_message_at: leadState.lastMessageAt
  }
}

function serializeStateAfter({ newLeadState, transition, mergeResult, modeRouterDecision, policyDecision }) {
  return {
    mode: newLeadState.currentMode,
    stage: newLeadState.currentStage,
    slots_filled: newLeadState.slotsFilled,
    returning_lead_flag: newLeadState.returningLeadFlag,
    
    transition: {
      from_stage: transition.stayed ? newLeadState.currentStage : 'previous',
      to_stage: transition.nextStage,
      from_mode: transition.stayed ? newLeadState.currentMode : 'previous',
      to_mode: transition.nextMode,
      reason: transition.transition_reason,
      stayed: transition.stayed
    },
    
    merge: {
      change_count: mergeResult.change_count,
      changes: mergeResult.changes
    },
    
    router_summary: modeRouterDecision ? {
      overrode_state: modeRouterDecision.decision.overrode_state,
      final_mode: modeRouterDecision.decision.final_mode,
      reason: modeRouterDecision.decision.reason,
      guards_triggered: modeRouterDecision.guards_triggered
    } : null,

    policy_summary: policyDecision ? {
      action_type: policyDecision.action?.type,
      strategy: policyDecision.action?.strategy,
      bot_should_respond: policyDecision.action?.bot_should_respond,
      rule_matched: policyDecision.rule_matched,
      guardrails_blocking: policyDecision.guardrails?.blocking_names || []
    } : null,
    
    versions: {
      definitions: STATE_DEFINITIONS_VERSION,
      transitions: STATE_TRANSITIONS_VERSION,
      context_graph: CONTEXT_GRAPH_VERSION,
      mode_router: MODE_ROUTER_VERSION,
      policy: POLICY_VERSION
    }
  }
}

// ════════════════════════════════════════════════════════
// VERSIÓN PARA TRACKING
// ════════════════════════════════════════════════════════
export const STATE_VERSION = 'v3_day5'
