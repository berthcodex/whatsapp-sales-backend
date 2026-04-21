const prisma = require('../plugins/prisma')
const { renderTemplate } = require('./stateEngine')

/**
 * followupEngine.js — Motor de seguimiento por silencio
 * Se ejecuta cada hora via cron.
 * Si el lead no respondió en X horas → manda el mensaje FOLLOWUP de su campaña.
 */

async function runFollowups({ sendMessage }) {
  const ahora = new Date()

  // Leads EN_FLUJO que no han sido notificados aún
  const leads = await prisma.lead.findMany({
    where: {
      estado: 'EN_FLUJO',
      campaignId: { not: null },
      ultimoMensaje: { not: null }
    },
    include: {
      campaign: {
        include: {
          steps: { where: { tipo: 'FOLLOWUP' } }
        }
      }
    }
  })

  for (const lead of leads) {
    const followupStep = lead.campaign?.steps?.[0]
    if (!followupStep || !followupStep.followupHrs) continue

    const horasSinRespuesta = (ahora - new Date(lead.ultimoMensaje)) / (1000 * 60 * 60)

    if (horasSinRespuesta >= followupStep.followupHrs) {
      // Verificar que no se haya mandado followup reciente (evitar spam)
      const yaEnvio = await prisma.message.findFirst({
        where: {
          leadId: lead.id,
          origen: 'BOT',
          texto: { contains: 'explorando' }, // simple check
          createdAt: { gte: new Date(ahora - 24 * 60 * 60 * 1000) }
        }
      })

      if (yaEnvio) continue

      const texto = renderTemplate(followupStep.mensaje, { telefono: lead.telefono })
      await sendMessage(lead.telefono, texto)

      await prisma.message.create({
        data: { leadId: lead.id, origen: 'BOT', texto }
      })

      // Actualizar ultimoMensaje para no volver a disparar
      await prisma.lead.update({
        where: { id: lead.id },
        data: { ultimoMensaje: new Date() }
      })

      console.log(`📤 Followup enviado a ${lead.telefono} (${lead.campaign.slug})`)
    }
  }
}

module.exports = { runFollowups }
