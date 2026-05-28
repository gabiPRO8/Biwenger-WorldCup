require("dotenv").config();
const express  = require("express");
const { createProxyMiddleware } = require("http-proxy-middleware");
const nodemailer = require("nodemailer");
const path     = require("path");
const fs       = require("fs");

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

// ── Token persistente (guardado por la UI cuando el usuario lo cambia) ────────
const TOKEN_FILE   = path.join(__dirname, ".token");
let cachedToken    = "";
try { cachedToken = fs.readFileSync(TOKEN_FILE, "utf8").trim(); } catch(e) {}

// ── Alertas ya enviadas (evitar duplicados en la misma sesión) ────────────────
const alertedSet        = new Set(); // chollos: `${playerId}_${price}_${until}`
const spanishAlertedSet = new Set(); // españoles: `${playerId}_${until}`

// ── CORS headers on every response ───────────────────────────────────────────
app.use((req, res, next) => {
  res.set({
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, X-League, X-Version, X-User",
  });
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ── Endpoint local: recibir token desde la UI ─────────────────────────────────
app.use(express.json());
app.post("/api-local/token", (req, res) => {
  const token = (req.body?.token || "").trim();
  if (!token) return res.status(400).json({ error: "No token" });
  cachedToken = token;
  try { fs.writeFileSync(TOKEN_FILE, token, "utf8"); } catch(e) {}
  console.log("🔑 Token actualizado desde la UI");
  res.json({ ok: true });
});

// ── Endpoint local: forzar check inmediato desde la UI ───────────────────────
app.post("/api-local/check-market", async (req, res) => {
  res.json({ ok: true, message: "Check iniciado" });
  await checkMarketAlerts(true);
});

// ── Endpoint local: estado del sistema de alertas ────────────────────────────
app.get("/api-local/alert-status", (req, res) => {
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
