// prisma/seed.js
// Crea los datos iniciales: tenant Peru Exporta + 3 vendedores + flujos base

import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcrypt'

const prisma = new PrismaClient()

async function main() {
  console.log('🌱 Iniciando seed de base de datos...')

  // ============================================
  // TENANT — Peru Exporta
  // ============================================
  const tenant = await prisma.tenant.upsert({
    where: { id: 'peru-exporta-tenant-id' },
    update: {},
    create: {
      id: 'peru-exporta-tenant-id',
      nombre: 'Peru Exporta TV / ESCEX',
      plan: 'pro'
    }
  })
  console.log(`✅ Tenant: ${tenant.nombre}`)

  // ============================================
  // VENDEDORES — Joan, Cristina, Francisco
  // ============================================
  const passwordHash = await bcrypt.hash('peruexporta2024', 10)

  const joan = await prisma.vendedor.upsert({
    where: { instanciaEvolution: 'peru-exporta-joan' },
    update: {},
    create: {
      tenantId: tenant.id,
      nombre: 'Joan',
      email: 'albert.hidata@gmail.com',
      passwordHash,
      rol: 'admin',
      instanciaEvolution: 'peru-exporta-joan'
    }
  })
  console.log(`✅ Vendedor: ${joan.nombre} (admin)`)

  const cristina = await prisma.vendedor.upsert({
    where: { instanciaEvolution: 'peru-exporta-cristina' },
    update: {},
    create: {
      tenantId: tenant.id,
      nombre: 'Cristina',
      passwordHash,
      rol: 'vendedor',
      instanciaEvolution: 'peru-exporta-cristina'
    }
  })
  console.log(`✅ Vendedor: ${cristina.nombre}`)

  const francisco = await prisma.vendedor.upsert({
    where: { instanciaEvolution: 'peru-exporta-francisco' },
    update: {},
    create: {
      tenantId: tenant.id,
      nombre: 'Francisco',
      passwordHash,
      rol: 'vendedor',
      instanciaEvolution: 'peru-exporta-francisco'
    }
  })
  console.log(`✅ Vendedor: ${francisco.nombre}`)

  // ============================================
  // FLUJOS BASE — los 6 flujos del sistema
  // ============================================

  // Flujo 1: Bienvenida
  const flujoBienvenida = await prisma.flujo.upsert({
    where: { id: 'flujo-bienvenida' },
    update: {},
    create: {
      id: 'flujo-bienvenida',
      tenantId: tenant.id,
      nombre: 'bienvenida',
      descripcion: 'Flujo principal de captura y calificación de leads',
      activo: true
    }
  })

  // Pasos del flujo bienvenida
  await prisma.paso.upsert({
    where: { id: 'paso-bienvenida-1' },
    update: {},
    create: {
      id: 'paso-bienvenida-1',
      flujoId: flujoBienvenida.id,
      orden: 1,
      tipo: 'mensaje',
      contenido: `Hola 🙋 te saluda Perú Exporta TV 🇵🇪\n\nNo necesitas tener producto propio para exportar — necesitas saber cómo. Formamos a productores, acopiadores, cooperativas y emprendedores para que exporten por su cuenta.\n\n¿Cómo te llamas y qué producto o rubro quieres exportar? 👇`
    }
  })

  await prisma.paso.upsert({
    where: { id: 'paso-bienvenida-2' },
    update: {},
    create: {
      id: 'paso-bienvenida-2',
      flujoId: flujoBienvenida.id,
      orden: 2,
      tipo: 'pregunta_botones',
      contenido: '¿En qué etapa estás ahora mismo?',
      botones: JSON.stringify([
        { id: 'tipo_a_inicio', texto: '🌱 Estoy empezando desde cero' },
        { id: 'tipo_b_producto', texto: '📦 Ya tengo producto o negocio' },
        { id: 'tipo_b_vende', texto: '🚀 Ya vendo, quiero exportar' }
      ]),
      esperarRespuesta: true
    }
  })

  // Flujo 2: Reactivación 1 hora
  const flujoReact1h = await prisma.flujo.upsert({
    where: { id: 'flujo-reactivacion-1h' },
    update: {},
    create: {
      id: 'flujo-reactivacion-1h',
      tenantId: tenant.id,
      nombre: 'reactivacion_1h',
      descripcion: 'Se activa cuando el lead no responde en 1 hora',
      activo: true
    }
  })

  const pasoReact1h = await prisma.paso.upsert({
    where: { id: 'paso-react-1h-1' },
    update: {},
    create: {
      id: 'paso-react-1h-1',
      flujoId: flujoReact1h.id,
      orden: 1,
      tipo: 'mensaje',
      contenido: `Hola 👋 por si no viste nuestro mensaje — estamos aquí para ayudarte a dar el paso a la exportación.\n\n¿Pudiste ver la información? 😊`
    }
  })

  await prisma.trigger.upsert({
    where: { id: 'trigger-react-1h' },
    update: {},
    create: {
      id: 'trigger-react-1h',
      pasoId: pasoReact1h.id,
      tipo: 'tiempo',
      minutosEspera: 60
    }
  })

  // Flujo 3: Reactivación 24 horas
  const flujoReact24h = await prisma.flujo.upsert({
    where: { id: 'flujo-reactivacion-24h' },
    update: {},
    create: {
      id: 'flujo-reactivacion-24h',
      tenantId: tenant.id,
      nombre: 'reactivacion_24h',
      descripcion: 'Segunda reactivación si sigue sin responder',
      activo: true
    }
  })

  const pasoReact24h = await prisma.paso.upsert({
    where: { id: 'paso-react-24h-1' },
    update: {},
    create: {
      id: 'paso-react-24h-1',
      flujoId: flujoReact24h.id,
      orden: 1,
      tipo: 'mensaje',
      contenido: `Hola, entendemos que estás ocupado 🙏\n\nSi en algún momento quieres saber cómo exportar tu producto, aquí estamos. 🇵🇪`
    }
  })

  await prisma.trigger.upsert({
    where: { id: 'trigger-react-24h' },
    update: {},
    create: {
      id: 'trigger-react-24h',
      pasoId: pasoReact24h.id,
      tipo: 'tiempo',
      minutosEspera: 1440
    }
  })

  // Flujo 4: Objeción precio
  const flujoObjecion = await prisma.flujo.upsert({
    where: { id: 'flujo-objecion-precio' },
    update: {},
    create: {
      id: 'flujo-objecion-precio',
      tenantId: tenant.id,
      nombre: 'objecion_precio',
      descripcion: 'Se activa cuando el lead menciona precio o no tener dinero',
      activo: true
    }
  })

  const pasoObjecion = await prisma.paso.upsert({
    where: { id: 'paso-objecion-1' },
    update: {},
    create: {
      id: 'paso-objecion-1',
      flujoId: flujoObjecion.id,
      orden: 1,
      tipo: 'mensaje',
      contenido: `Entendemos 👋 Por eso queremos que primero conozcas bien qué incluye el programa — muchos de nuestros alumnos nos dijeron lo mismo y hoy ya están exportando. ¿Te cuento más?`
    }
  })

  await prisma.trigger.upsert({
    where: { id: 'trigger-objecion' },
    update: {},
    create: {
      id: 'trigger-objecion',
      pasoId: pasoObjecion.id,
      tipo: 'keyword',
      keywords: JSON.stringify(['caro', 'no tengo', 'precio', 'cuanto', 'costoso', 'no puedo', 'dinero'])
    }
  })

  console.log('✅ Flujos base creados: bienvenida, reactivacion_1h, reactivacion_24h, objecion_precio')
  console.log('\n🎉 Seed completado exitosamente')
  console.log('\n📋 Próximos pasos:')
  console.log('   1. Configura las variables en .env')
  console.log('   2. Ejecuta: npm run db:push')
  console.log('   3. Ejecuta: npm run db:seed')
  console.log('   4. Ejecuta: npm run dev')
  console.log('   5. Configura el webhook en Evolution API → tu URL Railway /webhook')
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect())
