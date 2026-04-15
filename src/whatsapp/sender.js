// src/whatsapp/sender.js
// Envía mensajes a WhatsApp vía Evolution API
// Soporta texto simple y botones interactivos

const EVOLUTION_URL = process.env.EVOLUTION_URL || 'https://evolution-api-production-f1e7.up.railway.app'
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY

// ============================================
// Enviar mensaje de texto simple
// ============================================
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
        body: JSON.stringify({
          number: numero,
          text: mensaje
        })
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

// ============================================
// Enviar botones interactivos (máx 3 botones)
// El lead toca un botón → llega como texto al webhook
// ============================================
export async function enviarBotones(instancia, numero, titulo, botones, footer = 'Peru Exporta TV') {
  try {
    const response = await fetch(
      `${EVOLUTION_URL}/message/sendButtons/${instancia}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': EVOLUTION_API_KEY
        },
        body: JSON.stringify({
          number: numero,
          buttons: botones.map((btn, i) => ({
            type: 'reply',
            reply: {
              id: btn.id || `btn_${i}`,
              title: btn.texto
            }
          })),
          body: { text: titulo },
          footer: { text: footer },
          header: {
            type: 'text',
            text: 'Perú Exporta TV 🇵🇪'
          }
        })
      }
    )

    if (!response.ok) {
      console.warn('[WhatsApp] Botones no disponibles, usando texto plano')
      const textoAlternativo = titulo + '\n\n' + botones.map(b => `• ${b.texto}`).join('\n')
      return await enviarTexto(instancia, numero, textoAlternativo)
    }

    return await response.json()
  } catch (error) {
    console.error(`[WhatsApp] Error enviando botones a ${numero}:`, error.message)
    const textoAlternativo = titulo + '\n\n' + botones.map(b => `• ${b.texto}`).join('\n')
    return await enviarTexto(instancia, numero, textoAlternativo)
  }
}

// ============================================
// Enviar lista de opciones (máx 10 items)
// Ideal para seleccionar productos
// ============================================
export async function enviarLista(instancia, numero, titulo, descripcion, opciones) {
  try {
    const response = await fetch(
      `${EVOLUTION_URL}/message/sendList/${instancia}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': EVOLUTION_API_KEY
        },
        body: JSON.stringify({
          number: numero,
          listMessage: {
            title: titulo,
            description: descripcion,
            buttonText: 'Ver opciones',
            footerText: 'Peru Exporta TV',
            sections: [{
              title: 'Selecciona una opción',
              rows: opciones.map((op, i) => ({
                rowId: op.id || `op_${i}`,
                title: op.texto,
                description: op.descripcion || ''
              }))
            }]
          }
        })
      }
    )

    if (!response.ok) {
      // Fallback a texto plano numerado
      const textoAlternativo = titulo + '\n\n' + opciones.map((op, i) => `${i+1}. ${op.texto}`).join('\n')
      return await enviarTexto(instancia, numero, textoAlternativo)
    }

    return await response.json()
  } catch (error) {
    console.error(`[WhatsApp] Error enviando lista a ${numero}:`, error.message)
    const textoAlternativo = titulo + '\n\n' + opciones.map((op, i) => `${i+1}. ${op.texto}`).join('\n')
    return await enviarTexto(instancia, numero, textoAlternativo)
  }
}
