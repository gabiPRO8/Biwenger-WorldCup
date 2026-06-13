require("dotenv").config();
const express  = require("express");
const { createProxyMiddleware } = require("http-proxy-middleware");
const nodemailer = require("nodemailer");
const path     = require("path");
const fs       = require("fs");
const crypto   = require("crypto");

const app  = express();
const PORT = 8080;

// ── Config (env vars con fallbacks) ──────────────────────────────────────────
const LEAGUE_ID    = process.env.BIWENGER_LEAGUE_ID    || "2057487";
const OWN_USER_ID  = process.env.BIWENGER_OWN_USER_ID  || "13532644";
const ALERT_EMAIL  = process.env.ALERT_EMAIL           || "adderein@adderein.com";
const SMTP_HOST    = process.env.SMTP_HOST             || "smtp.gmail.com";
const SMTP_PORT    = parseInt(process.env.SMTP_PORT    || "587");
const SMTP_USER    = process.env.SMTP_USER             || "";
const SMTP_PASS    = process.env.SMTP_PASS             || "";
const MIN_DISCOUNT = parseFloat(process.env.MIN_DISCOUNT || "0.10"); // 10% por defecto
const MIN_PRICE    = parseInt(process.env.MIN_PRICE    || "1000000"); // 1M mínimo
const CHECK_EVERY  = parseInt(process.env.CHECK_EVERY  || "300000");  // 5 min
const START_BUDGET = 20_000_000;
const OWN_USER_ID_NUM = Number(OWN_USER_ID);

// ── Login: dos contraseñas → dos roles ───────────────────────────────────────
const OWNER_PASSWORD = process.env.OWNER_PASSWORD || "Shemas01";
const GUEST_PASSWORD = process.env.GUEST_PASSWORD || "mongo";
const SESSION_TTL_MS = parseInt(process.env.SESSION_TTL_MS || String(30 * 24 * 60 * 60 * 1000)); // 30 días

// ── Token persistente (guardado por la UI cuando el usuario lo cambia) ────────
const TOKEN_FILE   = path.join(__dirname, ".token");
let cachedToken    = "";
try { cachedToken = fs.readFileSync(TOKEN_FILE, "utf8").trim(); } catch(e) {}
// Fallback: variable de entorno (útil en Render donde .token no persiste)
if (!cachedToken && process.env.BIWENGER_TOKEN) {
  cachedToken = process.env.BIWENGER_TOKEN.trim();
}

// ── Secreto de sesión (firma los tokens de login; nunca al repo) ─────────────
const SESSION_SECRET_FILE = path.join(__dirname, ".session-secret");
let SESSION_SECRET = process.env.SESSION_SECRET || "";
if (!SESSION_SECRET) {
  try { SESSION_SECRET = fs.readFileSync(SESSION_SECRET_FILE, "utf8").trim(); } catch(e) {}
}
if (!SESSION_SECRET) {
  SESSION_SECRET = crypto.randomBytes(32).toString("hex");
  try { fs.writeFileSync(SESSION_SECRET_FILE, SESSION_SECRET, "utf8"); } catch(e) {}
}

// ── Helpers de sesión: token firmado (HMAC), viaja en header X-Biw-Session ────
function timingSafeEqualStr(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufB, bufB); // mantiene el coste constante
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function signSession(role) {
  const exp     = Date.now() + SESSION_TTL_MS;
  const payload = `${role}.${exp}`;
  const sig     = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("hex");
  return `${payload}.${sig}`;
}

function verifySession(token) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [role, exp, sig] = parts;
  if (role !== "owner" && role !== "guest") return null;
  const expected = crypto.createHmac("sha256", SESSION_SECRET).update(`${role}.${exp}`).digest("hex");
  if (!timingSafeEqualStr(sig, expected)) return null;
  if (Date.now() > Number(exp)) return null;
  return role;
}

function requireAuth(role) {
  return (req, res, next) => {
    const r = verifySession(req.headers["x-biw-session"]);
    if (!r) return res.status(401).json({ error: "No autorizado" });
    if (role && r !== role) return res.status(403).json({ error: "Permiso insuficiente" });
    req.role = r;
    next();
  };
}

// ── Rate limit básico para /api/login (mitiga fuerza bruta) ──────────────────
const loginAttempts = new Map(); // ip -> { count, resetAt }
function loginRateLimited(ip) {
  const now   = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    loginAttempts.set(ip, { count: 1, resetAt: now + 15 * 60 * 1000 });
    return false;
  }
  entry.count++;
  return entry.count > 10;
}

// ── Alertas ya enviadas (evitar duplicados en la misma sesión) ────────────────
const alertedSet        = new Set(); // chollos: `${playerId}_${price}_${until}`
const spanishAlertedSet = new Set(); // españoles: `${playerId}_${until}`

// ── CORS headers on every response ───────────────────────────────────────────
app.use((req, res, next) => {
  res.set({
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, X-League, X-Version, X-User, X-Biw-Session",
  });
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use(express.json());

// ─────────────────────────────────────────────────────────────────────────────
// LOGIN — dos contraseñas, dos roles (owner = yo, guest = amigos)
// ─────────────────────────────────────────────────────────────────────────────
app.post("/api/login", (req, res) => {
  const ip = req.ip || req.connection?.remoteAddress || "unknown";
  if (loginRateLimited(ip)) {
    return res.status(429).json({ error: "Demasiados intentos. Inténtalo de nuevo en unos minutos." });
  }
  const password = req.body?.password;
  if (typeof password !== "string" || !password) {
    return res.status(400).json({ error: "Falta la contraseña" });
  }
  let role = null;
  if (timingSafeEqualStr(password, OWNER_PASSWORD)) role = "owner";
  else if (timingSafeEqualStr(password, GUEST_PASSWORD)) role = "guest";
  if (!role) return res.status(401).json({ error: "Contraseña incorrecta" });
  res.json({ ok: true, role, session: signSession(role) });
});

// ─────────────────────────────────────────────────────────────────────────────
// DASHBOARD DATA — todo el cálculo de saldos vive en el servidor.
// El token de Biwenger (cachedToken) NUNCA se envía al navegador.
// ─────────────────────────────────────────────────────────────────────────────
async function biwengerFetch(apiPath) {
  if (!cachedToken) throw new Error("NO_TOKEN");
  const res = await fetch(`https://biwenger.as.com${apiPath}`, {
    headers: {
      "Authorization": cachedToken,
      "X-League":      LEAGUE_ID,
      "X-Version":     "630",
      "X-User":        OWN_USER_ID,
      "Content-Type":  "application/json",
      "Origin":        "https://biwenger.as.com",
      "Referer":       "https://biwenger.as.com/",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} en ${apiPath}`);
  const j = await res.json();
  return j?.data !== undefined ? j.data : j;
}

async function fetchFullBoard() {
  const all = [];
  let offset = 0;
  const limit = 50;
  for (let i = 0; i < 60; i++) { // tope de seguridad ~3000 eventos
    const raw   = await biwengerFetch(`/api/v2/league/${LEAGUE_ID}/board?offset=${offset}&limit=${limit}`);
    const items = Array.isArray(raw) ? raw : (raw?.board || raw?.events || []);
    if (!items.length) break;
    all.push(...items);
    if (items.length < limit) break;
    offset += limit;
  }
  return all.sort((a, b) => a.date - b.date);
}

function extractMembersFromBoard(events) {
  const members = {};
  for (const ev of events) {
    if (ev.type === "exchange") {
      const c = ev.content || {};
      if (c.from?.id && c.from?.name) members[c.from.id] = { name: c.from.name, icon: c.from.icon || "" };
      if (c.to?.id   && c.to?.name)   members[c.to.id]   = { name: c.to.name,   icon: c.to.icon   || "" };
      continue;
    }
    if (ev.type !== "transfer" && ev.type !== "market") continue;
    for (const c of (Array.isArray(ev.content) ? ev.content : [])) {
      if (c.from?.id && c.from?.name) members[c.from.id] = { name: c.from.name, icon: c.from.icon || "" };
      if (c.to?.id   && c.to?.name)   members[c.to.id]   = { name: c.to.name,   icon: c.to.icon   || "" };
    }
  }
  return members;
}

function extractPlayersFromBoard(events) {
  const map = {};
  for (const ev of events) {
    for (const c of (Array.isArray(ev.content) ? ev.content : [])) {
      const p = c.player;
      if (p && typeof p === "object" && p.id && p.name) {
        map[p.id] = { name: p.name, position: p.position, price: p.price };
      }
    }
  }
  return map;
}

function calcBalances(events, memberIds) {
  const bal = {};
  for (const id of memberIds) bal[id] = START_BUDGET;
  for (const ev of events) {
    if (ev.type === "transfer") {
      for (const c of (Array.isArray(ev.content) ? ev.content : [])) {
        const amt = c.amount || 0;
        if (c.from?.id != null && bal[c.from.id] !== undefined) bal[c.from.id] += amt;
        if (c.to?.id   != null && bal[c.to.id]   !== undefined) bal[c.to.id]   -= amt;
      }
    } else if (ev.type === "market") {
      for (const c of (Array.isArray(ev.content) ? ev.content : [])) {
        const amt   = c.amount || 0;
        const buyId = c.to?.id;
        if (buyId != null && bal[buyId] !== undefined) bal[buyId] -= amt;
      }
    } else if (ev.type === "exchange") {
      const c      = ev.content || {};
      const amt    = c.amount          || 0;
      const reqAmt = c.requestedAmount || 0;
      if (c.from?.id != null && bal[c.from.id] !== undefined) bal[c.from.id] += reqAmt - amt;
      if (c.to?.id   != null && bal[c.to.id]   !== undefined) bal[c.to.id]   += amt - reqAmt;
    }
  }
  return bal;
}

let dashboardCache = { data: null, fetchedAt: 0 };
const DASHBOARD_TTL_MS = 120_000; // 2 minutos — evita martillear la API por cada visita

async function buildDashboardData() {
  const [home, leagueData, board, market, playerMap] = await Promise.all([
    biwengerFetch("/api/v2/home").catch(() => ({})),
    biwengerFetch(`/api/v2/league?include=all,-lastAccess&fields=*,standings,tournaments,group,settings(description)`).catch(() => null),
    fetchFullBoard(),
    biwengerFetch("/api/v2/market").catch(() => null),
    loadPlayerMap().catch(() => ({})),
  ]);

  const ownUser    = home?.user || {};
  const ownRealBal = ownUser.balance ?? null;

  const memberMap = {};
  const standings = leagueData?.standings || [];
  for (const s of (Array.isArray(standings) ? standings : [])) {
    memberMap[s.id] = {
      name:        s.name || `User ${s.id}`,
      icon:        s.icon || "",
      teamValue:   s.teamValue ?? null,
      realBalance: Number(s.id) === OWN_USER_ID_NUM ? ownRealBal : null,
      position:    s.position ?? null,
    };
  }
  if (!memberMap[OWN_USER_ID_NUM]) {
    memberMap[OWN_USER_ID_NUM] = { name: ownUser.name || "GabiPRO", icon: ownUser.icon || "", realBalance: ownRealBal };
  } else {
    memberMap[OWN_USER_ID_NUM].realBalance = ownRealBal;
  }

  const boardMembers = extractMembersFromBoard(board);
  for (const [uid, m] of Object.entries(boardMembers)) {
    if (!memberMap[uid]) memberMap[uid] = { name: m.name, icon: m.icon, realBalance: null };
  }

  const merged = { ...extractPlayersFromBoard(board), ...playerMap };
  for (const s of (market?.sales || [])) {
    const p = s.player;
    if (p?.id && p?.name) merged[p.id] = { name: p.name, position: p.position, price: p.price, team: merged[p.id]?.team || null };
  }

  const memberIds = Object.keys(memberMap).map(Number);
  const balances  = calcBalances(board, memberIds);

  return { board, members: memberMap, playerMap: merged, balances, marketData: market, ownBalance: ownRealBal, generatedAt: Date.now() };
}

async function getDashboardData(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && dashboardCache.data && (now - dashboardCache.fetchedAt) < DASHBOARD_TTL_MS) {
    return dashboardCache.data;
  }
  const data = await buildDashboardData();
  dashboardCache = { data, fetchedAt: now };
  return data;
}

// ── Enmascarado para invitados: mi saldo nunca sale, ni se puede recalcular ──
function maskForGuest(data) {
  const clone = JSON.parse(JSON.stringify(data));
  if (clone.balances) clone.balances[OWN_USER_ID_NUM] = null;
  if (clone.members?.[OWN_USER_ID_NUM]) clone.members[OWN_USER_ID_NUM].realBalance = null;
  clone.ownBalance = null;

  const involvesOwner = (id) => Number(id) === OWN_USER_ID_NUM;
  for (const ev of (clone.board || [])) {
    if (ev.type === "exchange") {
      const c = ev.content || {};
      if (involvesOwner(c.from?.id) || involvesOwner(c.to?.id)) {
        c.amount = null;
        c.requestedAmount = null;
        c.amountHidden = true;
      }
    } else if (ev.type === "transfer" || ev.type === "market") {
      for (const c of (Array.isArray(ev.content) ? ev.content : [])) {
        if (involvesOwner(c.from?.id) || involvesOwner(c.to?.id)) {
          c.amount = null;
          c.amountHidden = true;
        }
      }
    }
  }
  return clone;
}

app.get("/api/dashboard", requireAuth(), async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === "1" && req.role === "owner";
    const data = await getDashboardData(forceRefresh);
    const out  = req.role === "guest" ? maskForGuest(data) : data;
    res.json({ ok: true, role: req.role, ...out });
  } catch(e) {
    const noToken = e.message === "NO_TOKEN";
    res.status(noToken ? 409 : 502).json({
      error: noToken ? "El propietario aún no ha configurado el token de Biwenger" : "Error obteniendo datos de Biwenger",
      detail: e.message,
    });
  }
});

// ── Endpoint local: recibir token desde la UI (solo propietario) ─────────────
app.post("/api-local/token", requireAuth("owner"), (req, res) => {
  const token = (req.body?.token || "").trim();
  if (!token) return res.status(400).json({ error: "No token" });
  cachedToken = token;
  try { fs.writeFileSync(TOKEN_FILE, token, "utf8"); } catch(e) {}
  dashboardCache = { data: null, fetchedAt: 0 }; // forzar recarga con el nuevo token
  console.log("🔑 Token actualizado desde la UI");
  res.json({ ok: true });
});

// ── Endpoint local: forzar check inmediato desde la UI (solo propietario) ────
app.post("/api-local/check-market", requireAuth("owner"), async (req, res) => {
  res.json({ ok: true, message: "Check iniciado" });
  await checkMarketAlerts(true);
});

// ── Endpoint local: estado del sistema de alertas (solo propietario) ─────────
app.get("/api-local/alert-status", requireAuth("owner"), (req, res) => {
  res.json({
    smtpConfigured: !!(SMTP_USER && SMTP_PASS),
    alertEmail:     ALERT_EMAIL,
    minDiscount:    MIN_DISCOUNT,
    minPrice:       MIN_PRICE,
    checkEveryMs:   CHECK_EVERY,
    hasToken:       !!cachedToken,
    alertedCount:   alertedSet.size,
  });
});

// ── Proxy /api/* → biwenger.as.com ───────────────────────────────────────────
app.use(
  "/api",
  createProxyMiddleware({
    target: "https://biwenger.as.com",
    changeOrigin: true,
    secure: true,
    pathRewrite: (path) => `/api${path}`,
    on: {
      proxyReq: (proxyReq, req) => {
        proxyReq.setHeader("Host",    "biwenger.as.com");
        proxyReq.setHeader("Origin",  "https://biwenger.as.com");
        proxyReq.setHeader("Referer", "https://biwenger.as.com/market");
        proxyReq.setHeader("User-Agent",
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:151.0) Gecko/20100101 Firefox/151.0");
        console.log(`→ ${req.method} ${proxyReq.path}`);
      },
      proxyRes: (proxyRes) => {
        proxyRes.headers["access-control-allow-origin"]  = "*";
        proxyRes.headers["access-control-allow-headers"] =
          "Authorization, Content-Type, X-League, X-Version, X-User";
      },
      error: (err, req, res) => {
        console.error("Proxy error:", err.message);
        res.status(502).json({ error: "Proxy error", detail: err.message });
      },
    },
  })
);

// ── Proxy /cfapi/* → cf.biwenger.com (player data, no auth) ──────────────────
app.use(
  "/cfapi",
  createProxyMiddleware({
    target: "https://cf.biwenger.com",
    changeOrigin: true,
    secure: true,
    pathRewrite: (path) => `/api${path}`,
    on: {
      proxyReq: (proxyReq, req) => {
        proxyReq.setHeader("Host",    "cf.biwenger.com");
        proxyReq.setHeader("Origin",  "https://biwenger.as.com");
        proxyReq.setHeader("Referer", "https://biwenger.as.com/players");
        proxyReq.setHeader("User-Agent",
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:151.0) Gecko/20100101 Firefox/151.0");
        console.log(`→ CF ${req.method} ${proxyReq.path}`);
      },
      proxyRes: (proxyRes) => {
        proxyRes.headers["access-control-allow-origin"] = "*";
      },
      error: (err, req, res) => {
        console.error("CF Proxy error:", err.message);
        res.status(502).json({ error: "CF Proxy error", detail: err.message });
      },
    },
  })
);

// ── Serve static files ────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname)));

// ─────────────────────────────────────────────────────────────────────────────
// SISTEMA DE ALERTAS DE MERCADO
// ─────────────────────────────────────────────────────────────────────────────

async function loadPlayerMap() {
  const res  = await fetch(
    "https://cf.biwenger.com/api/v2/competitions/world-cup/data?lang=es&score=3&callback=BIW_CB"
  );
  const text = await res.text();
  const json = JSON.parse(text.replace(/^[^(]+\(/, "").replace(/\);?\s*$/, ""));
  const raw  = json?.data?.players || json?.players || {};
  const map  = {};
  for (const p of (Array.isArray(raw) ? raw : Object.values(raw))) {
    if (p?.id) map[p.id] = {
      name:  p.name || p.n  || `#${p.id}`,
      price: p.price || p.v || 0,
      team:  p.team?.name || p.t?.n || null,
    };
  }
  return map;
}

async function checkMarketAlerts(forced = false) {
  if (!cachedToken) {
    return console.log("[Alert] Sin token — abre la app y carga los datos primero");
  }

  console.log(`[Alert] Comprobando mercado${forced ? " (manual)" : ""}...`);

  let playerMap, sales;
  try {
    playerMap = await loadPlayerMap();
  } catch(e) {
    return console.error("[Alert] Error cargando playerMap:", e.message);
  }

  try {
    const mktRes = await fetch(`https://biwenger.as.com/api/v2/market`, {
      headers: {
        "Authorization": `Bearer ${cachedToken}`,
        "X-League":      LEAGUE_ID,
        "X-Version":     "630",
        "X-User":        OWN_USER_ID,
        "Content-Type":  "application/json",
        "Origin":        "https://biwenger.as.com",
        "Referer":       "https://biwenger.as.com/market",
      },
    });
    const mkt = await mktRes.json();
    sales = mkt?.data?.sales || mkt?.sales || [];
  } catch(e) {
    return console.error("[Alert] Error cargando mercado:", e.message);
  }

  const bargains = [];
  const spanishPlayers = [];

  for (const s of sales) {
    const pid         = s.player?.id || s.player;
    const info        = playerMap[pid] || {};
    const marketPrice = s.player?.price || info.price || 0;
    const name        = s.player?.name  || info.name  || `#${pid}`;
    const team        = info.team || null;
    const salePrice   = s.price;
    const seller      = s.user ? `User ${s.user}` : "Mercado libre";
    const until       = s.until ? new Date(s.until * 1000).toLocaleString("es-ES") : "—";

    // ── Alerta jugadores españoles (cualquier precio) ──
    const isSpanish = team && /españa|spain/i.test(team);
    if (isSpanish) {
      const spKey = `${pid}_${s.until}`;
      if (!spanishAlertedSet.has(spKey)) {
        spanishAlertedSet.add(spKey);
        spanishPlayers.push({ name, team, salePrice, marketPrice, seller, until });
      }
    }

    // ── Alerta chollos (>1M y descuento ≥ umbral) ──
    if (marketPrice >= MIN_PRICE) {
      const discount = (marketPrice - salePrice) / marketPrice;
      if (discount >= MIN_DISCOUNT) {
        const key = `${pid}_${salePrice}_${s.until}`;
        if (!alertedSet.has(key)) {
          alertedSet.add(key);
          bargains.push({ name, team, salePrice, marketPrice, discount, seller, until });
        }
      }
    }
  }

  console.log(`[Alert] Revisados ${sales.length} jugadores → ${spanishPlayers.length} españoles nuevos, ${bargains.length} chollos nuevos`);

  if (spanishPlayers.length > 0) {
    try { await sendSpanishAlertEmail(spanishPlayers); }
    catch(e) { console.error("[Alert] Error email españoles:", e.message); }
  }
  if (bargains.length > 0) {
    try { await sendAlertEmail(bargains); }
    catch(e) { console.error("[Alert] Error email chollos:", e.message); }
  }
}

async function sendSpanishAlertEmail(players) {
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST, port: SMTP_PORT, secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
  const fmt  = (n) => n ? (n / 1_000_000).toFixed(2) + "M" : "—";
  const rows = players.map(p => `
    <tr>
      <td style="padding:10px 14px;border-bottom:1px solid #fde68a">🇪🇸 <strong>${p.name}</strong></td>
      <td style="padding:10px 14px;border-bottom:1px solid #fde68a;color:#ef4444;font-weight:700">€${fmt(p.salePrice)}</td>
      <td style="padding:10px 14px;border-bottom:1px solid #fde68a;color:#64748b">€${fmt(p.marketPrice)}</td>
      <td style="padding:10px 14px;border-bottom:1px solid #fde68a;font-size:12px;color:#64748b">${p.seller}</td>
      <td style="padding:10px 14px;border-bottom:1px solid #fde68a;font-size:11px;color:#94a3b8">${p.until}</td>
    </tr>`).join("");

  await transporter.sendMail({
    from:    `"Biwenger Intel" <${SMTP_USER}>`,
    to:      ALERT_EMAIL,
    subject: `🇪🇸 ${players.length} jugador${players.length > 1 ? "es" : ""} español${players.length > 1 ? "es" : ""} en el mercado — CAFELITOS MUNDIAL`,
    html: `
      <div style="font-family:sans-serif;max-width:700px;margin:0 auto">
        <h2 style="color:#f59e0b;margin-bottom:4px">🇪🇸 Jugadores españoles en el mercado</h2>
        <p style="color:#64748b;margin-top:0">CAFELITOS MUNDIAL · ${new Date().toLocaleString("es-ES")}</p>
        <table style="border-collapse:collapse;width:100%;background:#fffbeb;border-radius:8px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.1)">
          <thead>
            <tr style="background:#fef3c7">
              <th style="padding:10px 14px;text-align:left">Jugador</th>
              <th style="padding:10px 14px;text-align:left">Precio venta</th>
              <th style="padding:10px 14px;text-align:left">Valor mercado</th>
              <th style="padding:10px 14px;text-align:left">Vendedor</th>
              <th style="padding:10px 14px;text-align:left">Expira</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
        <p style="color:#94a3b8;font-size:11px;margin-top:16px">Biwenger Intel · ADDEREIN</p>
      </div>`,
  });
  console.log(`[Alert] 🇪🇸 Email enviado: ${players.map(p=>p.name).join(", ")}`);
}

async function sendAlertEmail(bargains) {
  const transporter = nodemailer.createTransport({
    host:   SMTP_HOST,
    port:   SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth:   { user: SMTP_USER, pass: SMTP_PASS },
  });

  const fmt  = (n) => (n / 1_000_000).toFixed(2) + "M";
  const rows = bargains.map(b => `
    <tr>
      <td style="padding:10px 14px;border-bottom:1px solid #e2e8f0">
        <strong>${b.name}</strong>
        ${b.team ? `<br><span style="font-size:11px;color:#94a3b8">${b.team}</span>` : ""}
      </td>
      <td style="padding:10px 14px;border-bottom:1px solid #e2e8f0;color:#ef4444;font-weight:700">€${fmt(b.salePrice)}</td>
      <td style="padding:10px 14px;border-bottom:1px solid #e2e8f0;color:#64748b">€${fmt(b.marketPrice)}</td>
      <td style="padding:10px 14px;border-bottom:1px solid #e2e8f0;color:#22c55e;font-weight:700">-${(b.discount * 100).toFixed(0)}%</td>
      <td style="padding:10px 14px;border-bottom:1px solid #e2e8f0;font-size:12px;color:#64748b">${b.seller}</td>
      <td style="padding:10px 14px;border-bottom:1px solid #e2e8f0;font-size:11px;color:#94a3b8">${b.until}</td>
    </tr>`).join("");

  await transporter.sendMail({
    from:    `"Biwenger Intel" <${SMTP_USER}>`,
    to:      ALERT_EMAIL,
    subject: `🔥 ${bargains.length} chollo${bargains.length > 1 ? "s" : ""} en el mercado — CAFELITOS MUNDIAL`,
    html: `
      <div style="font-family:sans-serif;max-width:700px;margin:0 auto">
        <h2 style="color:#f97316;margin-bottom:4px">Biwenger Intel — Alerta de mercado</h2>
        <p style="color:#64748b;margin-top:0">CAFELITOS MUNDIAL · ${new Date().toLocaleString("es-ES")}</p>
        <table style="border-collapse:collapse;width:100%;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.1)">
          <thead>
            <tr style="background:#f8fafc">
              <th style="padding:10px 14px;text-align:left;color:#374151">Jugador</th>
              <th style="padding:10px 14px;text-align:left;color:#374151">Precio venta</th>
              <th style="padding:10px 14px;text-align:left;color:#374151">Valor mercado</th>
              <th style="padding:10px 14px;text-align:left;color:#374151">Descuento</th>
              <th style="padding:10px 14px;text-align:left;color:#374151">Vendedor</th>
              <th style="padding:10px 14px;text-align:left;color:#374151">Expira</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
        <p style="color:#94a3b8;font-size:11px;margin-top:16px">
          Umbral: ≥${(MIN_DISCOUNT * 100).toFixed(0)}% de descuento · jugadores &gt;€${(MIN_PRICE/1e6).toFixed(1)}M<br>
          Biwenger Intel · ADDEREIN
        </p>
      </div>`,
  });
}

// ── Arrancar cron de alertas ──────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log("─────────────────────────────────────────────────────");
  console.log(`  ✅  Biwenger Intel proxy corriendo`);
  console.log(`  👉  http://localhost:${PORT}/biwenger-intel-proxy.html`);
  if (SMTP_USER && SMTP_PASS) {
    console.log(`  📧  Alertas → ${ALERT_EMAIL} (cada ${CHECK_EVERY / 60000} min, descuento ≥${MIN_DISCOUNT * 100}%)`);
    setInterval(checkMarketAlerts, CHECK_EVERY);
    // Primera comprobación tras 30 segundos (para que el token esté disponible)
    setTimeout(checkMarketAlerts, 30_000);
  } else {
    console.log(`  ⚠️  Alertas desactivadas — configura SMTP_USER y SMTP_PASS en .env`);
  }
  console.log("─────────────────────────────────────────────────────");
});
