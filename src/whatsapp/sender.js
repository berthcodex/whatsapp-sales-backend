// src/whatsapp/sender.js
const EVOLUTION_URL = process.env.EVOLUTION_URL || 'https://evolution-api-production-717e.up.railway.app'
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || process.env.EVOLUTION_API_KEY_GLOBAL

export async function enviarTexto(instancia, numero, mensaje) {
  try {
    const response = await fetch(
      `${EVOLUTION_URL}/message/sendText/${instancia}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': EVOLUTION_API_KEY
        },
        body: JSON.stringify({ number: numero, text: mensaje })
      }
    )
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

export async function enviarBotones(instancia, numero, titulo, botones) {
  // Los polls y botones interactivos están bloqueados por Meta para conexiones
  // no oficiales (Baileys). Usamos texto numerado que funciona siempre.
  const textoNumerado =
    titulo + '\n\n' +
    botones.map((b, i) => `${i + 1}️⃣ ${b.texto.replace(/^\d️⃣\s*/, '')}`).join('\n') +
    '\n\nResponde con el número de tu opción 👇'

  return await enviarTexto(instancia, numero, textoNumerado)
}

export async function enviarLista(instancia, numero, titulo, descripcion, opciones) {
  // Igual que botones — texto numerado es la solución correcta con Baileys
  const textoNumerado =
    titulo + '\n\n' +
    (descripcion ? descripcion + '\n\n' : '') +
    opciones.map((op, i) => `${i + 1}. ${op.texto}`).join('\n') +
    '\n\nResponde con el número 👇'

  return await enviarTexto(instancia, numero, textoNumerado)
}
