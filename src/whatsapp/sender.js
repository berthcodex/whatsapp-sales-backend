// src/whatsapp/sender.js
const EVOLUTION_URL = process.env.EVOLUTION_URL || 'https://evolution-api-production-f1e7.up.railway.app'
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY

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

export async function enviarBotones(instancia, numero, titulo, botones, footer = 'Peru Exporta TV') {
  try {
    const payload = {
      number: numero,
      options: { delay: 1200 },
      buttonsMessage: {
        text: titulo,
        footer: footer,
        buttons: botones.map((btn, i) => ({
          buttonId: btn.id || `btn_${i}`,
          buttonText: { displayText: btn.texto },
          type: 1
        })),
        headerType: 1
      }
    }

    console.log('[WhatsApp] Enviando buttonsMessage payload:', JSON.stringify(payload))

    const response = await fetch(
      `${EVOLUTION_URL}/message/sendMessage/${instancia}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': EVOLUTION_API_KEY
        },
        body: JSON.stringify(payload)
      }
    )

    const responseText = await response.text()
    console.log('[WhatsApp] Respuesta botones:', response.status, responseText)

    if (!response.ok) {
      console.warn('[WhatsApp] Botones fallaron, usando texto plano')
      const textoAlternativo = titulo + '\n\n' + botones.map(b => `• ${b.texto}`).join('\n')
      return await enviarTexto(instancia, numero, textoAlternativo)
    }

    return JSON.parse(responseText)
  } catch (error) {
    console.error(`[WhatsApp] Error enviando botones a ${numero}:`, error.message)
    const textoAlternativo = titulo + '\n\n' + botones.map(b => `• ${b.texto}`).join('\n')
    return await enviarTexto(instancia, numero, textoAlternativo)
  }
}

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
