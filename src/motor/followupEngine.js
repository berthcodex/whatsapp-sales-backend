// HIDATA — Google Sheets Bridge v3 FINAL
// Lee JSON del body — compatible con fetch desde Node.js

const SHEET_NAME = 'Leads'

function inicializarHeaders() {
  const ss    = SpreadsheetApp.getActiveSpreadsheet()
  const sheet = ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME)
  if (sheet.getLastRow() === 0) {
    sheet.appendRow([
      'Fecha','Teléfono','Msg inicial','Mensajes brutos',
      'Nombre','Producto','Perfil','Prioridad',
      'Estado','Vendedor','Campaña','Fecha llamada','Resultado'
    ])
    sheet.getRange(1,1,1,13).setFontWeight('bold')
    sheet.setFrozenRows(1)
  }
  return sheet
}

function buscarFila(sheet, telefono) {
  const data = sheet.getDataRange().getValues()
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][1]) === String(telefono)) return i + 1
  }
  return null
}

function doGet(e) {
  return ContentService
    .createTextOutput(JSON.stringify({ ok: true, msg: 'Bridge v3 activo' }))
    .setMimeType(ContentService.MimeType.JSON)
}

function doPost(e) {
  try {
    // Intentar leer JSON primero, luego form params
    let data = {}
    try {
      if (e.postData && e.postData.contents) {
        data = JSON.parse(e.postData.contents)
      }
    } catch(ex) {}
    
    // Si no vino JSON, leer de e.parameter
    if (!data.telefono && e.parameter && e.parameter.telefono) {
      data = e.parameter
    }

    if (!data.telefono) {
      return ContentService
        .createTextOutput(JSON.stringify({ ok: false, error: 'sin telefono' }))
        .setMimeType(ContentService.MimeType.JSON)
    }

    const sheet = inicializarHeaders()
    const fecha = Utilities.formatDate(new Date(), 'America/Lima', 'dd/MM/yyyy HH:mm')
    const fila  = buscarFila(sheet, data.telefono)

    if (!fila) {
      sheet.appendRow([
        fecha,
        data.telefono    || '',
        data.msgInicial  || '',
        data.mensajes    || '',
        data.nombre      || '',
        data.producto    || '',
        data.perfil      || '',
        data.prioridad   || '',
        data.estado      || 'pendiente llamar',
        data.vendedor    || '',
        data.campana     || '',
        '', ''
      ])
    } else {
      const r   = sheet.getRange(fila, 1, 1, 13)
      const row = r.getValues()[0]
      if (data.nombre)    row[4] = data.nombre
      if (data.producto)  row[5] = data.producto
      if (data.perfil)    row[6] = data.perfil
      if (data.prioridad) row[7] = data.prioridad
      if (data.estado)    row[8] = data.estado
      if (data.mensajes)  row[3] = data.mensajes
      r.setValues([row])
    }

    return ContentService
      .createTextOutput(JSON.stringify({ ok: true }))
      .setMimeType(ContentService.MimeType.JSON)

  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: err.message }))
      .setMimeType(ContentService.MimeType.JSON)
  }
}

function testNuevoLead() {
  const result = doPost({
    postData: {
      contents: JSON.stringify({
        telefono:   '51999888777',
        msgInicial: 'Hola quiero info',
        mensajes:   'Joan | palta | desde cero',
        nombre:     'Joan Test',
        producto:   'Palta',
        perfil:     'Tipo A — formación',
        prioridad:  'MEDIA',
        estado:     'pendiente llamar',
        vendedor:   'Joan',
        campana:    'MPX'
      })
    },
    parameter: {}
  })
  Logger.log(result.getContent())
}
