const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

async function main() {
  console.log('🌱 Seeding Hidata Sprint 2...')

  // ─── Vendors ──────────────────────────────────────────────
  const joan = await prisma.vendor.upsert({
    where: { telefono: '51924104066' },
    update: {},
    create: { nombre: 'Joan', telefono: '51924104066', role: 'ADMIN' }
  })

  const cristina = await prisma.vendor.upsert({
    where: { telefono: '51900000002' },
    update: {},
    create: { nombre: 'Cristina', telefono: '51900000002', role: 'VENDOR' }
  })

  const francisco = await prisma.vendor.upsert({
    where: { telefono: '51900000003' },
    update: {},
    create: { nombre: 'Francisco', telefono: '51900000003', role: 'VENDOR' }
  })

  // ─── Campaña MPX — flujo real de Cristina ─────────────────
  const mpx = await prisma.campaign.upsert({
    where: { slug: 'MPX' },
    update: {},
    create: {
      slug: 'MPX',
      nombre: 'Mi Primera Exportación',
      activa: true,
      vendorId: cristina.id,
      triggers: {
        create: [
          { texto: 'mi primera exportacion' },
          { texto: 'mpx' },
          { texto: 'primera expo' },
          { texto: 'quiero exportar' },
          { texto: 'informacion del curso' },
        ]
      },
      steps: {
        create: [
          {
            orden: 1,
            tipo: 'MSG',
            mensaje: `Hola 🙋🏽‍♀️ te saluda Perú Exporta TV 🇵🇪\n\nDéjame tu nombre y edad para poder brindarte mayor información\n¿Tienes algún producto en mente que te gustaría exportar o recién estás explorando? 👇`
          },
          {
            orden: 2,
            tipo: 'MSG',
            mensaje: `Muchas gracias.\nPara orientarte mejor, coméntame:\n\n👉 ¿Ya tienes experiencia exportando o estás empezando desde cero?`
          },
          {
            orden: 3,
            tipo: 'MSG',
            mensaje: `Genial 🙌 entonces este programa es justo para ti.\n\nMI PRIMERA EXPORTACIÓN está pensado para personas que nunca han exportado y quieren hacerlo de forma ordenada, sin improvisar.\n\n📆 Inicio: 14 de Abril 2026 · Duración 3 meses · Online\n⏰ 2 sesiones por semana: martes y jueves\n⏰ Horario: 8:30 pm – 10:00 pm\n📡 Transmisión vía Zoom (todas las sesiones son grabadas)\n\n🔥 Precio de apertura\n💰 INVERSIÓN: 1,500 soles\n\n¿Te gustaría conocer el temario completo?`
          },
          {
            orden: 4,
            tipo: 'NOTIFY',
            mensaje: `🔔 Nuevo lead en MPX\n📱 Teléfono: {{telefono}}\n💬 Historial adjunto\n\nContactar hoy 👆`
          },
          {
            orden: 5,
            tipo: 'FOLLOWUP',
            followupHrs: 2,
            mensaje: `Hola 😊\nPara ayudarte mejor, coméntame:\n¿Tienes algún producto que te gustaría exportar o solo estás explorando la idea?`
          }
        ]
      }
    }
  })

  // ─── Campaña E1K ──────────────────────────────────────────
  const e1k = await prisma.campaign.upsert({
    where: { slug: 'E1K' },
    update: {},
    create: {
      slug: 'E1K',
      nombre: 'Exporta 1K',
      activa: true,
      vendorId: joan.id,
      triggers: {
        create: [
          { texto: 'exporta 1k' },
          { texto: 'e1k' },
          { texto: 'mil dolares exportando' },
        ]
      },
      steps: {
        create: [
          {
            orden: 1,
            tipo: 'MSG',
            mensaje: `¡Hola! 👋 Te saluda Perú Exporta TV 🇵🇪\n\n¿Cuéntame, ya tienes experiencia exportando o estás empezando?`
          },
          {
            orden: 2,
            tipo: 'NOTIFY',
            mensaje: `🔔 Nuevo lead en E1K\n📱 Teléfono: {{telefono}}\n\nContactar hoy 👆`
          },
          {
            orden: 3,
            tipo: 'FOLLOWUP',
            followupHrs: 3,
            mensaje: `Hola 😊 ¿Pudiste revisar la información sobre Exporta 1K?\n¿Tienes alguna consulta?`
          }
        ]
      }
    }
  })

  // ─── Campaña CCI ──────────────────────────────────────────
  const cci = await prisma.campaign.upsert({
    where: { slug: 'CCI' },
    update: {},
    create: {
      slug: 'CCI',
      nombre: 'Comercio Internacional',
      activa: false,
      vendorId: francisco.id,
      triggers: {
        create: [
          { texto: 'comercio internacional' },
          { texto: 'cci' },
        ]
      },
      steps: {
        create: [
          {
            orden: 1,
            tipo: 'MSG',
            mensaje: `Hola 🙋 te saluda Perú Exporta TV 🇵🇪\n\nBienvenido al Curso de Comercio Internacional.\n\n¿Cuéntame, cuál es tu objetivo principal?`
          },
          {
            orden: 2,
            tipo: 'NOTIFY',
            mensaje: `🔔 Nuevo lead en CCI\n📱 Teléfono: {{telefono}}\n\nContactar hoy 👆`
          }
        ]
      }
    }
  })

  console.log(`✅ Vendors: Joan (ADMIN), Cristina, Francisco`)
  console.log(`✅ Campañas: MPX (${mpx.id}), E1K (${e1k.id}), CCI (${cci.id})`)
  console.log(`🌱 Seed completo.`)
}

main()
  .catch(e => { console.error(e); process.exit(1) })
  .finally(() => prisma.$disconnect())
