// src/whatsapp/sender.js
// Fix Bug 1: leer EVOLUTION_API_URL (nombre correcto en Render)
// con fallback a EVOLUTION_URL para retrocompatibilidad

const EVOLUTION_URL = (
  process.env.EVOLUTION_API_URL ||
  process.env.EVOLUTION_URL ||
  ''
).replace(/\/$/, '') // quitar barra final siempre

const EVOLUTION_API_KEY = (
  process.env.EVOLUTION_API_KEY ||
  process.env.EVOLUTION_API_KEY_GLOBAL ||
  ''
)

export async function enviarTexto(instancia, numero, mensaje) {
  try {
    const url = `${EVOLUTION_URL}/message/sendText/${instancia}`
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': EVOLUTION_API_KEY
      },
      body: JSON.stringify({ number: numero, text: mensaje })
    })
    if (!response.ok) {
      const error = await response.text()
      throw new Error(`Evolution API error ${response.status}: ${error}`)
    }
    return await response.json()
  } catch (error) {
    console.error(`[WhatsApp] Error enviando texto a ${numero}:`, error.message)
    throw error
  }
}

// Botones → texto numerado (Meta bloquea botones interactivos en Baileys)
export async function enviarBotones(instancia, numero, titulo, botones) {
  const texto =
    titulo + '\n\n' +
    botones.map((b, i) => `${i + 1}️⃣ ${b.texto.replace(/^\d️⃣\s*/, '')}`).join('\n') +
    '\n\nResponde con el número de tu opción 👇'
  return await enviarTexto(instancia, numero, texto)
}

export async function enviarLista(instancia, numero, titulo, descripcion, opciones) {
  const texto =
    titulo + '\n\n' +
    (descripcion ? descripcion + '\n\n' : '') +
    opciones.map((op, i) => `${i + 1}. ${op.texto}`).join('\n') +
    '\n\nResponde con el número 👇'
  return await enviarTexto(instancia, numero, texto)
}
