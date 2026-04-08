// relay-server.js
// Servidor local de relay: recebe webhooks do WAHA e distribui via SSE para o browser
// Roda na máquina da clínica (mesma rede dos computadores que acessam o CRM)
//
// Uso: node relay-server.js
// Porta padrão: 3001
// Configurar no WAHA: webhook URL = http://<IP_LOCAL>:3001/webhook
// No .env.local: VITE_RELAY_URL=http://localhost:3001

const http = require("http");

const PORT      = process.env.RELAY_PORT || 3001;
const WAHA_KEY  = process.env.WAHA_API_KEY || "";
const IKEY      = process.env.INTERNAL_API_KEY || "@Deuse10";

// Clientes SSE conectados: Map<id, res>
const clients = new Map();
let clientId = 0;

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const [id, res] of clients) {
    try { res.write(msg); }
    catch { clients.delete(id); }
  }
}

// Eventos relevantes do WAHA
const RELEVANT = new Set(["message", "message.any", "chat.new", "message.revoked"]);

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      try { resolve(JSON.parse(body)); }
      catch { reject(new Error("invalid json")); }
    });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // CORS — permite browser de qualquer origem (Vercel + localhost)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Internal-Key, X-Api-Key");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") { res.writeHead(200); res.end(); return; }

  // ── POST /webhook — recebe eventos do WAHA ─────────────────────
  if (req.method === "POST" && url.pathname === "/webhook") {
    // Valida chave do WAHA (se configurada)
    if (WAHA_KEY) {
      const key = req.headers["x-api-key"] || req.headers["authorization"]?.replace("Bearer ", "");
      if (key !== WAHA_KEY) { res.writeHead(401); res.end("Unauthorized"); return; }
    }

    try {
      const body = await parseBody(req);
      const event = body?.event;
      const payload = body?.payload;

      if (event && payload && RELEVANT.has(event)) {
        broadcast(event, { payload, session: body.session || "default", ts: Date.now() });
        console.log(`[relay] ${event} → ${clients.size} client(s)`);
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(400); res.end(e.message);
    }
    return;
  }

  // ── GET /events — SSE para o browser ───────────────────────────
  if (req.method === "GET" && url.pathname === "/events") {
    // Valida chave interna do CRM
    const key = req.headers["x-internal-key"] || url.searchParams.get("key");
    if (key !== IKEY) { res.writeHead(401); res.end("Unauthorized"); return; }

    const id = ++clientId;
    res.writeHead(200, {
      "Content-Type":  "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection":    "keep-alive",
      "X-Accel-Buffering": "no",
    });

    clients.set(id, res);
    console.log(`[relay] SSE client #${id} connected (total: ${clients.size})`);

    // Heartbeat a cada 25s
    const hb = setInterval(() => {
      try { res.write(": heartbeat\n\n"); }
      catch { clearInterval(hb); clients.delete(id); }
    }, 25000);

    // Envia confirmação de conexão
    res.write(`event: connected\ndata: ${JSON.stringify({ ts: Date.now(), clientId: id })}\n\n`);

    req.on("close", () => {
      clearInterval(hb);
      clients.delete(id);
      console.log(`[relay] SSE client #${id} disconnected (total: ${clients.size})`);
    });
    return;
  }

  // ── GET /status ─────────────────────────────────────────────────
  if (req.method === "GET" && url.pathname === "/status") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, clients: clients.size, uptime: process.uptime() }));
    return;
  }

  res.writeHead(404); res.end("Not found");
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`\n🔗 Relay server rodando em http://0.0.0.0:${PORT}`);
  console.log(`   Webhook WAHA → http://<IP_DA_MAQUINA>:${PORT}/webhook`);
  console.log(`   SSE browser  → http://localhost:${PORT}/events\n`);
});

process.on("uncaughtException", e => console.error("[relay] uncaught:", e.message));
