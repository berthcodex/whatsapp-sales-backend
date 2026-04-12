# WhatsApp Sales Backend

Modular WhatsApp sales automation backend.
Multi-tenant, zero cost, open source. Built for Hidata.

## Stack

- **Runtime:** Node.js 20+
- **Framework:** Fastify
- **ORM:** Prisma
- **Base de datos:** PostgreSQL (Railway)
- **WhatsApp:** Evolution API
- **IA Clasificador:** Groq + Llama 3.3 (gratis)
- **Espejo:** Google Sheets API
- **Deploy:** Railway (automático desde GitHub)

**Costo total: $0**

---

## Setup en 5 pasos

### Paso 1 — Configurar

```bash
cp .env.example .env
npm install
```

### Paso 2 — Variables de entorno

Edita `.env` con tus claves:

```
DATABASE_URL       → Railway te la da automáticamente
EVOLUTION_URL      → URL de tu instancia Evolution API
EVOLUTION_API_KEY  → tu clave de Evolution API
GROQ_API_KEY       → crear en groq.com (gratis)
GOOGLE_SERVICE_ACCOUNT_JSON → ver instrucciones abajo
SHEET_ID_JOAN      → ID del Google Sheet del vendedor
```

### Paso 3 — Base de datos

```bash
npm run db:push      # Crea las tablas en PostgreSQL
npm run db:seed      # Carga tenant, vendedores y flujos base
```

### Paso 4 — Desarrollo local

```bash
npm run dev
# Servidor en http://localhost:3000
# Health check: http://localhost:3000/health
```

### Paso 5 — Deploy en Railway

1. Crear nuevo servicio en Railway
2. Conectar con este repo de GitHub
3. Agregar las variables de entorno del `.env.example`
4. Railway despliega automáticamente en cada push a main

---

## Configurar Google Sheets API

1. Ir a [Google Cloud Console](https://console.cloud.google.com)
2. Crear proyecto → Habilitar Google Sheets API
3. Crear Service Account → Descargar JSON
4. Pegar el JSON completo en `GOOGLE_SERVICE_ACCOUNT_JSON`
5. Compartir cada Google Sheet con el email del service account

---

## Configurar Groq (Llama 3 gratis)

1. Registrarse en [groq.com](https://groq.com)
2. API Keys → Create API Key
3. Pegar en `GROQ_API_KEY`
4. Free tier: 30 requests/minuto

---

## Conectar Evolution API

En el panel de Evolution API, configurar el webhook de cada instancia apuntando a:

```
https://tu-backend.railway.app/webhook
```

Todas las instancias apuntan al mismo endpoint.
El backend las diferencia automáticamente por `instance` en el body.

---

## Estructura del proyecto

```
src/
  server.js              # Fastify app principal
  webhook/
    handler.js           # Recibe mensajes de WhatsApp
    classifier.js        # Stemming + scoring + Groq/Llama
  whatsapp/
    sender.js            # Envía mensajes y botones
  sheets/
    mirror.js            # Espejo automático en Google Sheets
prisma/
  schema.prisma          # Definición de BD
  seed.js                # Datos iniciales
```

---

## Endpoints

| Método | Ruta | Estado | Descripción |
|--------|------|--------|-------------|
| GET | /health | ✅ Semana 1 | Health check |
| POST | /webhook | ✅ Semana 1 | Recibe mensajes WhatsApp |
| GET | /leads | 🔄 Semana 2 | Lista de leads |
| PUT | /leads/:id | 🔄 Semana 2 | Actualizar estado |
| GET | /reportes | 🔄 Semana 2 | Métricas |

---

## Multi-tenant

Cada cliente es un tenant independiente.
Los datos nunca se mezclan — `tenant_id` en todas las tablas.
Agregar un cliente nuevo = crear un registro en BD + configurar Evolution API.
