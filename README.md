# Biwenger Intel 🏆

Dashboard de inteligencia para la liga **CAFELITOS MUNDIAL** (Biwenger Fantasy World Cup).  
Analiza saldos estimados de rivales, historial completo del tablón, mercado activo, mapeo de ~1300 jugadores y sistema de alertas por email.

## Estructura del proyecto

```
Biwenger/
├── biwenger-intel-proxy.html  ← App principal (React 18 + Babel CDN, single-file SPA)
├── server.js                  ← Servidor Express: proxy anti-CORS + alertas de mercado
├── architecture.html          ← Diagramas Mermaid del sistema
├── CONTEXT.md                 ← Briefing completo para LLMs
├── package.json
├── .env.example               ← Plantilla de configuración (renombrar a .env)
└── .gitignore
```

## Requisitos

- Node.js >= 18
- Cuenta en biwenger.as.com con la liga activa
- Bearer token válido (se obtiene de DevTools → Network → Authorization)

## Instalación

```bash
npm install
cp .env.example .env      # Editar con tus credenciales SMTP
npm start
# → http://localhost:8080/biwenger-intel-proxy.html
# → http://localhost:8080/architecture.html
```

## Configuración del token

El token JWT expira periódicamente. Para renovarlo:
1. Abre biwenger.as.com → F12 → Network → XHR → cualquier request
2. Copia el header `Authorization`
3. Pégalo en el campo Token de la app (se sincroniza automáticamente con el servidor)

## Configuración de alertas por email (`.env`)

```env
ALERT_EMAIL=tu@email.com

SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=tu.cuenta@gmail.com
SMTP_PASS=xxxx xxxx xxxx xxxx   # App Password de Google

MIN_DISCOUNT=0.10    # Alerta si precio_venta <= valor_mercado * 0.90
MIN_PRICE=1000000    # Solo jugadores con valor > 1M
CHECK_EVERY=300000   # Intervalo en ms (300000 = 5 min)
```

Para Gmail, genera un App Password en: https://myaccount.google.com/apppasswords

## Features

| Tab | Descripción |
|-----|-------------|
| 💰 Saldos | Saldo estimado de cada manager con trazabilidad de operaciones |
| 📋 Tablón | Feed completo de traspasos y compras de mercado |
| 🏪 Mercado | Jugadores en venta, precio vs valor de mercado, ¿puedo comprarlo? |
| ⚽ Jugadores | Mapa id→nombre→equipo extraído de cf.biwenger.com (~1300 jugadores) |
| 📊 Stats | Actividad por manager, totales gastados/ingresados |

## Sistema de alertas automáticas

El servidor comprueba el mercado cada 5 min y envía email cuando:
- 🇪🇸 **Jugador español** aparece en venta (cualquier precio)
- 🔥 **Chollo**: jugador con valor > 1M vendido con ≥10% de descuento

El botón **"📧 Test alerta"** en la app lanza un check inmediato.

## API endpoints utilizados

| Endpoint | Datos |
|----------|-------|
| `GET biwenger.as.com/api/v2/account` | Saldo real propio |
| `GET biwenger.as.com/api/v2/league?include=all` | 20 managers + standings |
| `GET biwenger.as.com/api/v2/league/2057487/board?offset=N` | Eventos paginados |
| `GET biwenger.as.com/api/v2/market` | Jugadores en venta |
| `GET cf.biwenger.com/api/v2/competitions/world-cup/data` | Mapa jugadores (JSONP) |
