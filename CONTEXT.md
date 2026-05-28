# CONTEXT.md — Biwenger Intel Project
> Este archivo es el briefing completo para cualquier LLM (Claude Code, Codex, GPT-4, Gemini, etc.)
> que continúe el desarrollo. Léelo antes de tocar cualquier archivo.

---

## 1. Qué es este proyecto

Dashboard de inteligencia para una liga de **Biwenger Fantasy World Cup** (fútbol fantasy).
El objetivo es obtener información que Biwenger no muestra nativamente:
- **Saldo estimado de rivales** (Biwenger oculta el saldo ajeno)
- **Historial completo de operaciones** del mercado
- **Mapeo de jugadores** id → nombre → estadísticas externas
- **Inteligencia de mercado**: quién vende, a qué precio, si puedo comprarlo

La app es un **single-file HTML** (`biwenger-intel.html`) con React + Babel cargados via CDN.
No hay build step. Se sirve con un servidor HTTP local para evitar restricciones CORS de `file://`.

---

## 2. Contexto de negocio

| Campo | Valor |
|-------|-------|
| Liga | CAFELITOS MUNDIAL |
| ID liga | `2057487` |
| Competición | `world-cup` |
| Tipo | `premium`, `league`, `marketMode: normal` |
| Usuario propio | `GabiPRO` (ID `13532644`) |
| Presupuesto inicial (todos) | `20,000,000` (20M) |
| Sin comisiones de venta | ✓ |
| Sin bonificaciones por puntos | ✓ (no aplica al saldo) |
| scoreID de la liga | `3` |

---

## 3. Autenticación

La API de Biwenger usa **JWT Bearer token** + headers custom:

```
Authorization: Bearer eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9...
Content-Type:  application/json
X-League:      2057487
X-Version:     630
```

- El token actual está hardcodeado en `biwenger-intel.html` como `DEFAULT_TOKEN`
- El JWT contiene `{ iss: <userId>, iat: <timestamp> }` — expira con el tiempo
- Para renovar: F12 en biwenger.as.com → Network → XHR → header Authorization
- La app tiene un input de token en la UI para cambiarlo sin tocar el código

Opcional: usar `credentials: "include"` para aprovechar cookies de sesión del browser.

---

## 4. API Endpoints documentados

Base URL: `https://biwenger.as.com`

### 4.1 Cuenta propia
```
GET /api/v2/account
```
Response relevante:
```json
{
  "data": {
    "id": 3370353,
    "name": "Gabriel Iniesta Jovani",
    "email": "...",
    "status": "valid",
    "credits": 0,
    "leagues": [
      { "id": 2057487, "name": "CAFELITOS MUNDIAL", "competition": "world-cup",
        "user": { "id": 13532644, "name": "GabiPRO", "balance": 24515700 } }
    ]
  }
}
```

### 4.2 Home / standings
```
GET /api/v2/home
```
Devuelve datos de la liga activa incluyendo posiblemente standings con balances.

### 4.3 Tablón (paginado) ← FUENTE PRINCIPAL DE SALDOS
```
GET /api/v2/league/2057487/board?offset=0&limit=16
```
- Paginar incrementando `offset` de 16 en 16 hasta recibir array vacío
- Ordenar cronológicamente (campo `date`, Unix timestamp)

**Tipos de eventos en `board[]`:**

#### type: "transfer" — traspaso entre managers
```json
{
  "type": "transfer",
  "date": 1779863510,
  "content": [
    {
      "player": 28476,
      "amount": 3500000,
      "type": "clause",
      "from": { "id": 13444234, "name": "Carbónicos Puteros", "icon": "..." },
      "to":   { "id": 13532950, "name": "Nuncamusulmana",    "icon": "..." }
    }
  ]
}
```
- `from` = VENDEDOR (gana dinero — el jugador salió de su plantilla)
- `to`   = COMPRADOR (pierde dinero — el jugador llegó a su plantilla)
- Si no hay `to` = vendido al mercado libre (solo `from` gana, jugador vuelve al pool)
- **NOTA VERIFICADA**: semántica estándar de fútbol: "from" = origen del jugador (vendedor), "to" = destino (comprador)
- `type: "clause"` = activó cláusula | `type: "offer"` = oferta aceptada

#### type: "market" — compra desde el pool de mercado
```json
{
  "type": "market",
  "date": 1779764873,
  "content": [
    { "player": 40889, "amount": 5120000, "to": { "id": 13532644, "name": "GabiPRO" } }
  ]
}
```
- `to` = COMPRADOR (pierde dinero)
- No hay vendedor (jugador venía del mercado)

#### type: "playerMovements" — cambios en plantillas reales
```json
{
  "type": "playerMovements",
  "content": [
    { "type": "join",  "player": 41171, "team": {...} },
    { "type": "leave", "player": 14509, "from": {...} }
  ]
}
```
- **No afecta al saldo** — ignorar para el cálculo de balance

### 4.4 Mercado activo
```
GET /api/v2/market
```
Response:
```json
{
  "data": {
    "status": { "balance": 24515700 },
    "sales": [
      {
        "date":  1779851293,
        "until": 1779937200,
        "price": 3760000,
        "player": { "id": 718 },
        "user": null
      }
    ],
    "offers": [...]
  }
}
```
- `sales[].user = null` → jugador del mercado libre
- `sales[].user = <id>` → jugador puesto en venta por ese manager

### 4.5 Endpoints de jugadores (PENDIENTE DE CONFIRMAR)
Los siguientes devuelven 403 desde servidor externo pero pueden funcionar desde browser:
```
GET /api/v2/players/[ID]
GET /api/v2/players?competition=world-cup&limit=500
GET /api/v2/league/2057487/players
GET /api/v2/competitions/world-cup/players
```
**Estrategia actual de mapeo (en orden de prioridad):**
1. Extraer `{ id, name, position, price }` de eventos del board (cuando `player` es objeto, no solo ID)
2. Extraer de `market.sales[].player`
3. Intentar endpoints de jugadores en el browser
4. IDs sin resolver se muestran como `#[ID]`

---

## 5. Lógica de cálculo de saldo

```javascript
// Todos empiezan con 20M
balanceMap[userId] = 20_000_000  for each member

// Procesar board en orden cronológico
for each event in board (sorted by date ASC):
  if event.type === "transfer":
    buyer  (from.id) -= amount
    seller (to.id)   += amount   // si existe to
  
  if event.type === "market":
    buyer  (to.id)   -= amount

// Sobrescribir con valores reales si disponibles
balanceMap[OWN_USER_ID] = real balance from /account
```

---

## 6. Estructura del archivo principal

`biwenger-intel.html` es React 18 + Babel Standalone (CDN), todo en un `<script type="text/babel">`.

```
App()
├── State: token, tab, loading, error
├── State: ownBalance, members{}, playerMap{}, board[], balances{}, marketData
├── makeApi(token)           → fetch wrapper con headers correctos
├── fetchPlayerMap(api)      → prueba múltiples endpoints, merge resultado
├── fetchBoard()             → pagina /board hasta vacío, ordena cronológico
├── extractPlayersFromBoard  → extrae {id,name} cuando player es objeto
├── calcBalances(events)     → algoritmo del punto 5
└── Tabs: Saldos | Tablón | Mercado | Jugadores | Stats
```

---

## 7. Problema CORS

La app no puede correr directamente desde `file://` porque biwenger.as.com
no incluye `Access-Control-Allow-Origin: *`.

**Soluciones implementadas / documentadas:**
1. `npm start` → `npx serve .` en localhost (origin `http://localhost:8080`)
2. `python -m http.server 8080` → equivalente
3. Extensión de browser que inyecta headers CORS
4. Abrir desde consola de DevTools en biwenger.as.com (same-origin)

---

## 8. Roadmap y tareas pendientes

### 🔴 Alta prioridad
- [ ] **Confirmar endpoint de jugadores** — ejecutar desde consola de biwenger.as.com:
  ```javascript
  fetch('/api/v2/players?competition=world-cup&limit=500',
    {headers:{'X-League':'2057487','X-Version':'630'}})
    .then(r=>r.json()).then(console.log)
  ```
- [ ] **Mapeo completo** — una vez confirmado el endpoint, cargar todos los jugadores al inicio

### 🟡 Media prioridad
- [ ] **Enriquecimiento SofaScore** — una vez con nombres:
  - `GET https://www.sofascore.com/api/v1/search/players?q=[nombre]` → obtener sofascore ID
  - `GET https://www.sofascore.com/api/v1/player/[id]/statistics/season/[id]` → stats
- [ ] **Squad estimado por rival** — reconstruir plantilla de cada manager a partir del board
  (jugadores comprados - jugadores vendidos)
- [ ] **Alertas de mercado** — notificar si jugador en venta está por debajo de su valor de mercado

### 🟢 Baja prioridad
- [ ] Convertir a Vite + React project (si se necesita escalar)
- [ ] Persistencia local (localStorage) para cachear board entre sesiones
- [ ] Export CSV de datos

---

## 9. Suppliers / contexto empresa

Este proyecto es parte del trabajo en **ADDEREIN**. El usuario principal es alumno de máster
en prácticas. No relacionado con proyectos de ingeniería (Jerusalem light rail) — es uso personal
de Claude para un fantasy de fútbol.

---

## 10. Snippets útiles para la consola de biwenger.as.com

Ejecutar en DevTools → Consola estando en biwenger.as.com para investigar endpoints:

```javascript
// Ver todos los jugadores del mundial
const r = await fetch('/api/v2/players?competition=world-cup&limit=500', {
  headers: { 'X-League': '2057487', 'X-Version': '630', 'Content-Type': 'application/json' }
});
const d = await r.json();
console.log(d);

// Ver jugador específico por ID
const p = await fetch('/api/v2/players/718', {
  headers: { 'X-League': '2057487', 'X-Version': '630' }
});
console.log(await p.json());

// Ver tablón completo
const b = await fetch('/api/v2/league/2057487/board?offset=0&limit=16', {
  headers: { 'X-League': '2057487', 'X-Version': '630' }
});
console.log(await b.json());
```

---

*Última actualización: 27 Mayo 2026 | Generado con Claude Sonnet 4.6*
