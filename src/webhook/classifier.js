// src/webhook/classifier.js
// Clasificador de leads — portado y mejorado desde Apps Script
// 3 capas: stemming + scoring ponderado + Groq/Llama como fallback

// ============================================
// STEMMING — raíces de palabras
// Una raíz captura todas las variantes
// "acopi" → acopiador, acopiamos, acopio, acopiadora
// ============================================

// Keywords Tipo B con stems y scoring ponderado
const KEYWORDS_TIPO_B = [
  // Score 10 — señal muy fuerte de operador/broker
  { stem: "export",      score: 10 }, // exporto, exportas, exportamos, exportador
  { stem: "acopi",       score: 10 }, // acopiador, acopio, acopiamos
  { stem: "tonelad",     score: 10 }, // tonelada, toneladas
  { stem: "cooperativ",  score: 10 }, // cooperativa, cooperativas
  { stem: "volumen",     score: 10 }, // tengo volumen, vendo volumen
  
  // Score 8 — señal fuerte
  { stem: "product",     score: 8  }, // productor, productora, producimos, producción
  { stem: "distribu",    score: 8  }, // distribuidor, distribuimos, distribución
  { stem: "hectar",      score: 8  }, // hectárea, hectáreas
  { stem: "cosech",      score: 8  }, // cosecha, cosecho, cosechamos
  { stem: "ruc",         score: 8  }, // tengo RUC, con RUC
  { stem: "factur",      score: 8  }, // facturamos, emitimos factura
  { stem: "quintal",     score: 8  }, // quintal, quintales
  { stem: "kilo",        score: 8  }, // kilos, kilogramos

  // Score 6 — señal media
  { stem: "intermedi",   score: 6  }, // intermediario, intermediaria
  { stem: "proveedor",   score: 6  }, // proveedor, proveedora
  { stem: "chacra",      score: 6  }, // chacra, chacras
  { stem: "siembr",      score: 6  }, // siembro, sembramos, siembra
  { stem: "asociaci",    score: 6  }, // asociación, asociaciones
  { stem: "empresa",     score: 6  }, // mi empresa, nuestra empresa
  { stem: "negocio",     score: 6  }, // mi negocio, nuestro negocio
  { stem: "parcela",     score: 6  }, // parcela, parcelas
  { stem: "terreno",     score: 6  }, // terreno, terrenos
  { stem: "finca",       score: 6  }, // finca, fincas
  { stem: "gerente",     score: 6  }, // gerente, director
  { stem: "socio",       score: 6  }, // socio, socios
  
  // Score 5 — señal débil
  { stem: "stock",       score: 5  }, // stock, tengo stock
  { stem: "almacen",     score: 5  }, // almacén, almacenamos
  { stem: "lote",        score: 5  }, // lote, lotes
  { stem: "carga",       score: 5  }, // carga, tengo carga
  { stem: "cliente",     score: 5  }, // clientes fijos, compradores
  { stem: "pedido",      score: 5  }, // pedido, pedidos
  { stem: "inversionis", score: 5  }, // inversionista
  { stem: "capital",     score: 5  }, // capital, inversión
  { stem: "mercader",    score: 5  }, // mercadería
  { stem: "supermercad", score: 5  }, // supermercado, tottus, wong
  { stem: "mayorist",    score: 5  }, // mercado mayorista
]

// Keywords Tipo A con scoring
const KEYWORDS_TIPO_A = [
  { stem: "aprender",    score: 10 }, // quiero aprender, aprender a exportar
  { stem: "sin experienc", score: 10 }, // sin experiencia
  { stem: "como export", score: 10 }, // cómo exportar, cómo se exporta
  { stem: "primer",      score: 8  }, // primera vez, mi primera exportación
  { stem: "no se como",  score: 8  }, // no sé cómo
  { stem: "no sé",       score: 7  }, // no sé por dónde empezar
  { stem: "empezar",     score: 6  }, // quiero empezar, cómo empiezo
  { stem: "informaci",   score: 6  }, // información del curso
  { stem: "curso",       score: 6  }, // el curso, qué cursos
  { stem: "pequeñ",      score: 5  }, // pequeño productor, en pequeño
  { stem: "curiosid",    score: 5  }, // curiosidad, curioso
  { stem: "recien",      score: 5  }, // recién empezando
]

// ============================================
// CURSOS DE PERU EXPORTA — detección de campaña
// Si el lead menciona esto en su PRIMER mensaje
// → viene de un Ad → saltamos directo a PRESENTACION
//
// Curso A (formación básica):  "Exporta con 1,000 Soles"
// Curso B (operadores):        "Contacta Compradores Internacionales"
// ============================================

export const CURSOS_PERU_EXPORTA = [
  // ── Curso A: Exporta con 1,000 Soles ──────────────────────
  { stem: 'exporta con 1',           curso: 'A', nombre: 'Exporta con 1,000 Soles' },
  { stem: 'exporta con mil',         curso: 'A', nombre: 'Exporta con 1,000 Soles' },
  { stem: 'exporta con 1000',        curso: 'A', nombre: 'Exporta con 1,000 Soles' },
  { stem: '1000 soles',              curso: 'A', nombre: 'Exporta con 1,000 Soles' },
  { stem: '1,000 soles',             curso: 'A', nombre: 'Exporta con 1,000 Soles' },
  { stem: 'mil soles',               curso: 'A', nombre: 'Exporta con 1,000 Soles' },
  { stem: 'exporta con poco',        curso: 'A', nombre: 'Exporta con 1,000 Soles' },
  { stem: 'primera exportacion',     curso: 'A', nombre: 'Exporta con 1,000 Soles' },
  { stem: 'primera exportación',     curso: 'A', nombre: 'Exporta con 1,000 Soles' },
  { stem: 'mi primera exporta',      curso: 'A', nombre: 'Exporta con 1,000 Soles' },
  { stem: 'curso basico',            curso: 'A', nombre: 'Exporta con 1,000 Soles' },
  { stem: 'curso básico',            curso: 'A', nombre: 'Exporta con 1,000 Soles' },
  { stem: 'taller exporta',          curso: 'A', nombre: 'Exporta con 1,000 Soles' },

  // ── Curso B: Contacta Compradores Internacionales ──────────
  { stem: 'contacta compradores',    curso: 'B', nombre: 'Contacta Compradores Internacionales' },
  { stem: 'compradores internacion', curso: 'B', nombre: 'Contacta Compradores Internacionales' },
  { stem: 'contactar compradores',   curso: 'B', nombre: 'Contacta Compradores Internacionales' },
  { stem: 'curso compradores',       curso: 'B', nombre: 'Contacta Compradores Internacionales' },
  { stem: 'compradores reales',      curso: 'B', nombre: 'Contacta Compradores Internacionales' },
  { stem: 'clientes internacion',    curso: 'B', nombre: 'Contacta Compradores Internacionales' },
  { stem: 'curso avanzado',          curso: 'B', nombre: 'Contacta Compradores Internacionales' },
  { stem: 'contacta clientes',       curso: 'B', nombre: 'Contacta Compradores Internacionales' },
]

// Detecta si el primer mensaje menciona un curso específico.
// Retorna { curso: 'A'|'B', nombre } o null si es lead orgánico.
export function detectarCursoCampana(texto) {
  const norm = texto
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  for (const c of CURSOS_PERU_EXPORTA) {
    const stemNorm = c.stem
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
    if (norm.includes(stemNorm)) {
      return { curso: c.curso, nombre: c.nombre }
    }
  }
  return null  // lead orgánico → flujo normal
}

// Productos de exportación peruana — con stems
const PRODUCTOS_STEMS = [
  // Frutas
  { stem: "palt",     nombre: "Palta" },
  { stem: "aguacat",  nombre: "Palta" },
  { stem: "avocado",  nombre: "Palta" },
  { stem: "mang",     nombre: "Mango" },
  { stem: "uv",       nombre: "Uva" },
  { stem: "grape",    nombre: "Uva" },
  { stem: "arandano", nombre: "Arándano" },
  { stem: "blueberr", nombre: "Arándano" },
  { stem: "esparrag", nombre: "Espárrago" },
  { stem: "asparagus",nombre: "Espárrago" },
  { stem: "granad",   nombre: "Granada" },
  { stem: "maracuy",  nombre: "Maracuyá" },
  { stem: "chirimoy", nombre: "Chirimoya" },
  { stem: "lucum",    nombre: "Lúcuma" },
  { stem: "papay",    nombre: "Papaya" },
  { stem: "piñ",      nombre: "Piña" },
  { stem: "platan",   nombre: "Plátano" },
  { stem: "fres",     nombre: "Fresa" },
  { stem: "frambuesa",nombre: "Frambuesa" },
  { stem: "guanaban", nombre: "Guanábana" },
  { stem: "camote",   nombre: "Camote" },
  { stem: "yuc",      nombre: "Yuca" },
  { stem: "zapall",   nombre: "Zapallo" },
  // Granos y superalimentos
  { stem: "quinua",   nombre: "Quinua" },
  { stem: "quinoa",   nombre: "Quinua" },
  { stem: "kiwich",   nombre: "Kiwicha" },
  { stem: "amarant",  nombre: "Amaranto" },
  { stem: "sacha inchi", nombre: "Sacha Inchi" },
  { stem: "chia",     nombre: "Chía" },
  { stem: "maca",     nombre: "Maca" },
  { stem: "yacon",    nombre: "Yacón" },
  { stem: "maiz morad",nombre:"Maíz Morado" },
  // Especias y condimentos
  { stem: "cafe",     nombre: "Café" },
  { stem: "coffee",   nombre: "Café" },
  { stem: "cacao",    nombre: "Cacao" },
  { stem: "cocoa",    nombre: "Cacao" },
  { stem: "jengibre", nombre: "Jengibre" },
  { stem: "ginger",   nombre: "Jengibre" },
  { stem: "curcum",   nombre: "Cúrcuma" },
  { stem: "oregano",  nombre: "Orégano" },
  { stem: "paprik",   nombre: "Páprika" },
  { stem: "pimient",  nombre: "Pimiento" },
  { stem: "ceboll",   nombre: "Cebolla" },
  { stem: "aj",       nombre: "Ajo" },
  { stem: "brocol",   nombre: "Brócoli" },
  { stem: "alcachof", nombre: "Alcachofa" },
  { stem: "tara",     nombre: "Tara" },
  { stem: "miel",     nombre: "Miel" },
  { stem: "honey",    nombre: "Miel" },
  // Textiles y artesanías
  { stem: "alpack",   nombre: "Alpaca" },
  { stem: "vicun",    nombre: "Vicuña" },
  { stem: "algodon",  nombre: "Algodón" },
  { stem: "cotton",   nombre: "Algodón" },
  { stem: "pima",     nombre: "Algodón Pima" },
  { stem: "artesani", nombre: "Artesanía" },
  { stem: "textil",   nombre: "Textil" },
  // Productos del mar
  { stem: "pescad",   nombre: "Pescado" },
  { stem: "anchov",   nombre: "Anchoveta" },
  { stem: "langostin",nombre: "Langostino" },
  { stem: "trucha",   nombre: "Trucha" },
  { stem: "paiche",   nombre: "Paiche" },
  { stem: "calamar",  nombre: "Calamar" },
  // Otros
  { stem: "madera",   nombre: "Madera" },
  { stem: "flor",     nombre: "Flores" },
  { stem: "aceite",   nombre: "Aceite" },
  { stem: "mermelad", nombre: "Mermelada" },
  { stem: "conserv",  nombre: "Conservas" },
  { stem: "joyer",    nombre: "Joyería" },
  { stem: "ceram",    nombre: "Cerámica" },
  { stem: "cuer",     nombre: "Cuero" },
  { stem: "leather",  nombre: "Cuero" },
  { stem: "cochinill",nombre: "Cochinilla" },
  { stem: "superaliment", nombre: "Superalimento" },
]

// Patrones regex para extracción de nombre — portados desde Apps Script
const PATRONES_NOMBRE = [
  /(?:soy|me llamo|mi nombre es|mi nombre:)\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+){0,3})/i,
  /(?:buenos\s+d[ií]as|buenas\s+tardes|buenas\s+noches|buenas)[,.]?\s+(?:soy|me llamo)\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)*)/i,
  /^([A-ZÁÉÍÓÚÑ][a-záéíóúñ]{2,}(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]{2,})?),\s/,
  /mi nombre\s*[:\-]?\s*([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)*)/i,
  /^([A-ZÁÉÍÓÚÑ]{2,}(?:\s+[A-ZÁÉÍÓÚÑ]{2,})+)/,
  /^([A-ZÁÉÍÓÚÑ][a-záéíóúñ]{2,}\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]{2,})(?:\s|,|\.)/,
  /(?:habla|llama|escribe)\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)*)/i,
  /(?:el señor|la señora|don|doña)?\s*([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)*)/i,
]

// ============================================
// NORMALIZACIÓN — prepara el texto para buscar
// Minúsculas + sin tildes + sin caracteres especiales
// ============================================
function normalizar(texto) {
  return texto
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // quita tildes
    .replace(/[^a-z0-9\s]/g, ' ')   // quita especiales
    .replace(/\s+/g, ' ')            // normaliza espacios
    .trim()
}

// ============================================
// CAPA 1 — Extracción de nombre
// ============================================
export function extraerNombre(texto) {
  for (const patron of PATRONES_NOMBRE) {
    const match = texto.match(patron)
    if (match && match[1] && match[1].split(' ').length <= 4) {
      return match[1].trim()
    }
  }
  return null
}

// ============================================
// CAPA 2 — Extracción de producto con stems
// ============================================
export function extraerProducto(texto) {
  const normalizado = normalizar(texto)
  for (const prod of PRODUCTOS_STEMS) {
    if (normalizado.includes(prod.stem)) {
      return prod.nombre
    }
  }
  return null
}

// ============================================
// CAPA 3 — Clasificación con scoring ponderado
// Devuelve { tipo, scoreB, scoreA, confianza, keywords }
// ============================================
export function clasificarConScoring(texto) {
  const normalizado = normalizar(texto)
  let scoreB = 0
  let scoreA = 0
  const keywordsEncontradas = []

  for (const kw of KEYWORDS_TIPO_B) {
    if (normalizado.includes(kw.stem)) {
      scoreB += kw.score
      keywordsEncontradas.push({ palabra: kw.stem, tipo: 'B', score: kw.score })
    }
  }

  for (const kw of KEYWORDS_TIPO_A) {
    if (normalizado.includes(kw.stem)) {
      scoreA += kw.score
      keywordsEncontradas.push({ palabra: kw.stem, tipo: 'A', score: kw.score })
    }
  }

  const UMBRAL_ALTA_CONFIANZA = 8

  if (scoreB >= UMBRAL_ALTA_CONFIANZA && scoreB > scoreA) {
    return {
      tipo: 'B',
      tipoPreciso: 'Tipo B — broker',
      scoreB,
      scoreA,
      scoreTotal: scoreB,
      confianza: 'alta',
      usóIA: false,
      keywords: keywordsEncontradas,
      prioridad: scoreB >= 16 ? 'URGENTE' : 'ALTA'
    }
  }

  if (scoreA >= UMBRAL_ALTA_CONFIANZA && scoreA > scoreB) {
    return {
      tipo: 'A',
      tipoPreciso: 'Tipo A — formación',
      scoreB,
      scoreA,
      scoreTotal: scoreA,
      confianza: 'alta',
      usóIA: false,
      keywords: keywordsEncontradas,
      prioridad: 'MEDIA'
    }
  }

  // Score insuficiente en ambos → ambiguo → necesita Llama
  return {
    tipo: null,
    tipoPreciso: null,
    scoreB,
    scoreA,
    scoreTotal: Math.max(scoreB, scoreA),
    confianza: 'baja',
    usóIA: false,
    keywords: keywordsEncontradas,
    prioridad: 'MEDIA'
  }
}

// ============================================
// CAPA 4 — Groq + Llama 3 para el 5% ambiguo
// Solo se llama cuando scoring < 8 en ambos tipos
// ============================================
export async function clasificarConIA(texto) {
  try {
    const prompt = `Eres un clasificador de leads para un programa de exportación peruano.

Analiza este mensaje de WhatsApp de un potencial lead y clasifícalo:

MENSAJE: "${texto}"

TIPOS:
- Tipo B (broker/operador): tiene producto, opera, vende, tiene volumen, hectáreas, empresa, cooperativa, ya está en el negocio
- Tipo A (formación): quiere aprender, sin experiencia, curioso, emprendedor sin operación previa

Responde SOLO con este JSON, sin explicación:
{"tipo": "A" o "B", "razon": "máximo 10 palabras", "prioridad": "ALTA" o "MEDIA"}`

    // Timeout de 3 segundos — si Groq no responde, usamos default
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 3000)

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 100,
        temperature: 0,
        messages: [{ role: 'user', content: prompt }]
      })
    })

    clearTimeout(timeout)
    if (!response.ok) throw new Error(`Groq error: ${response.status}`)

    const data = await response.json()
    const contenido = data.choices[0]?.message?.content?.trim()
    const parsed = JSON.parse(contenido)

    return {
      tipo: parsed.tipo,
      tipoPreciso: parsed.tipo === 'B' ? 'Tipo B — broker' : 'Tipo A — formación',
      razonIA: parsed.razon,
      prioridad: parsed.prioridad || 'MEDIA',
      usóIA: true,
      confianza: 'media'
    }
  } catch (error) {
    // Si Groq falla → default Tipo A, el sistema sigue funcionando
    console.error('[Classifier] Groq falló, usando default:', error.message)
    return {
      tipo: 'A',
      tipoPreciso: 'Tipo A — formación',
      razonIA: 'fallback por error IA',
      prioridad: 'MEDIA',
      usóIA: false,
      confianza: 'baja'
    }
  }
}

// ============================================
// CLASIFICADOR PRINCIPAL — orquesta las 4 capas
// ============================================
export async function clasificarLead(texto) {
  // Capa 1: nombre
  const nombre = extraerNombre(texto)
  
  // Capa 2: producto
  const producto = extraerProducto(texto)
  
  // Capa 3: scoring ponderado
  const scoring = clasificarConScoring(texto)
  
  let clasificacion = scoring
  
  // Capa 4: solo si scoring fue ambiguo
  if (scoring.confianza === 'baja') {
    const iaResult = await clasificarConIA(texto)
    clasificacion = {
      ...scoring,
      ...iaResult,
      scoreB: scoring.scoreB,
      scoreA: scoring.scoreA
    }
  }

  return {
    nombre,
    producto,
    tipo: clasificacion.tipo || 'A',
    tipoPreciso: clasificacion.tipoPreciso || 'Tipo A — formación',
    scoreB: clasificacion.scoreB,
    scoreA: clasificacion.scoreA,
    scoreTotal: clasificacion.scoreTotal,
    confianza: clasificacion.confianza,
    prioridad: clasificacion.prioridad || 'MEDIA',
    usóIA: clasificacion.usóIA,
    keywords: clasificacion.keywords || []
  }
}
