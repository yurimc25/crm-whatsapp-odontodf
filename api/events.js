// api/events.js
// Server-Sent Events — browser escuta; endpoint puxa eventos novos do MongoDB
// Vercel: função normal (não edge) com streaming via res.write()
// O cliente reenvia ?since=<timestamp> a cada reconexão

import { MongoClient } from "mongodb";

let client;
async function getDb() {
  if (!client) {
    client = new MongoClient(process.env.MONGODB_URI);
    await client.connect();
  }
  return client.db("clinica");
}

export const config = { maxDuration: 55 }; // Vercel hobby: max 60s por função

export default async function handler(req, res) {
  // Auth
  const key = req.headers["x-internal-key"] || req.query.key;
  if (key !== process.env.INTERNAL_API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  // SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.flushHeaders?.();

  const since = req.query.since ? new Date(parseInt(req.query.since)) : new Date(Date.now() - 5000);

  function send(event, data) {
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      res.flush?.();
    } catch {}
  }

  // Envia heartbeat imediato
  send("connected", { ts: Date.now() });

  let lastCheck = since;
  let alive = true;

  // Heartbeat a cada 20s para manter conexão viva
  const heartbeat = setInterval(() => {
    try { res.write(`: heartbeat\n\n`); res.flush?.(); } catch { alive = false; }
  }, 20000);

  // Poll MongoDB a cada 1s por eventos novos
  const poll = setInterval(async () => {
    if (!alive) return;
    try {
      const db = await getDb();
      const events = await db.collection("waha_events")
        .find({ createdAt: { $gt: lastCheck } })
        .sort({ createdAt: 1 })
        .limit(50)
        .toArray();

      if (events.length > 0) {
        lastCheck = events[events.length - 1].createdAt;
        for (const ev of events) {
          send(ev.event, { payload: ev.payload, session: ev.session, ts: ev.createdAt.getTime() });
        }
      }
    } catch (e) {
      console.error("[events] poll error:", e.message);
    }
  }, 1000);

  // Limpeza quando cliente desconecta
  req.on("close", () => {
    alive = false;
    clearInterval(heartbeat);
    clearInterval(poll);
  });

  // Encerra após 50s (Vercel cobra timeout de 60s no hobby)
  setTimeout(() => {
    if (alive) {
      send("reconnect", { ts: Date.now() });
      clearInterval(heartbeat);
      clearInterval(poll);
      res.end();
    }
  }, 50000);
}
