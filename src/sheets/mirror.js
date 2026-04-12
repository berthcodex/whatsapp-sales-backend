// src/sheets/mirror.js
// Espejo automático en Google Sheets
// El equipo sigue viendo exactamente lo mismo — transición invisible

import { google } from 'googleapis'

// ============================================
// Autenticación con Google Sheets API
// Usa service account — gratis, sin OAuth
// ============================================
function getAuthClient() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '{}')
  
  return new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  })
}

// ============================================
// Mapeo de instancia Evolution → Sheet ID
// Cada vendedor tiene su propio Sheet
// ============================================
const SHEETS_POR_VENDEDOR = {
  'peru-exporta-joan':      process.env.SHEET_ID_JOAN,
  'peru-exporta-cristina':  process.env.SHEET_ID_CRISTINA,
  'peru-exporta-francisco': process.env.SHEET_ID_FRANCISCO,
}

// ============================================
// Escribir lead nuevo en el Sheet del vendedor
// Mantiene el mismo formato de 14 columnas que ya usan
// ============================================
export async function escribirLeadEnSheet(instancia, lead, clasificacion) {
  try {
    const sheetId = SHEETS_POR_VENDEDOR[instancia]
    if (!sheetId) {
      console.warn(`[Sheets] No hay Sheet configurado para instancia: ${instancia}`)
      return
    }

    const auth = getAuthClient()
    const sheets = google.sheets({ version: 'v4', auth })

    const ahora = new Date()
    const fecha = ahora.toLocaleDateString('es-PE')
    const hora = ahora.toLocaleTimeString('es-PE')

    // Formato de 14 columnas — igual al Sheet actual
    const fila = [
      `${fecha} ${hora}`,              // 1. Fecha
      lead.numero,                      // 2. Teléfono
      lead.primerMensaje || '',         // 3. Msg inicial
      lead.todosLosMensajes || '',      // 4. Mensajes brutos
      ahora.toISOString(),              // 5. Último timestamp
      clasificacion.nombre || '',       // 6. Nombre
      clasificacion.producto || '',     // 7. Producto
      '',                               // 8. Nivel local (se completa después)
      '',                               // 9. Exporta
      clasificacion.tipoPreciso || '',  // 10. Perfil
      clasificacion.prioridad || '',    // 11. Prioridad
      'pendiente llamar',               // 12. Estado
      '',                               // 13. Fecha llamada
      ''                                // 14. Resultado
    ]

    await sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: 'Leads!A:N',
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [fila] }
    })

    console.log(`[Sheets] Lead ${lead.numero} escrito en Sheet de ${instancia}`)
  } catch (error) {
    // El espejo de Sheets nunca debe romper el flujo principal
    console.error('[Sheets] Error escribiendo en Sheet:', error.message)
  }
}

// ============================================
// Actualizar estado de un lead en el Sheet
// Se llama cuando el vendedor mueve el lead en el CRM
// ============================================
export async function actualizarEstadoEnSheet(instancia, numero, estado) {
  try {
    const sheetId = SHEETS_POR_VENDEDOR[instancia]
    if (!sheetId) return

    const auth = getAuthClient()
    const sheets = google.sheets({ version: 'v4', auth })

    // Buscar la fila del lead por número
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: 'Leads!B:B' // columna de teléfono
    })

    const filas = response.data.values || []
    const indice = filas.findIndex(f => f[0] === numero)

    if (indice === -1) return

    // Actualizar columna de estado (columna L = índice 11, base 1 = columna 12)
    const filaNum = indice + 1 // Sheets es 1-indexed
    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: `Leads!L${filaNum}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[estado]] }
    })

    console.log(`[Sheets] Estado de ${numero} actualizado a "${estado}"`)
  } catch (error) {
    console.error('[Sheets] Error actualizando estado:', error.message)
  }
}
