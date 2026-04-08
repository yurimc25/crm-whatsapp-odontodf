// api/webhook.js
// Recebe eventos do WAHA via webhook e persiste no MongoDB para SSE
// WAHA envia: message, message.any, chat.new, session.status, etc.
// TTL: eventos ficam 60s no MongoDB (suficiente para SSE pegar)

import { MongoClient } from "mongodb";

let client;
async function getDb() {
  if (!client) {
    client = new MongoClient(process.env.MONGODB_URI);
    await client.connect();
  }
  return client.db("clinica");
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Api-Key");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).end();

  // Valida chave do WAHA (opcional mas recomendado)
  const wahaKey = process.env.WAHA_API_KEY;
  if (wahaKey) {
    const incoming = req.headers["x-api-key"] || req.headers["authorization"]?.replace("Bearer ", "");
    if (incoming !== wahaKey) return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const body = req.body;
    const event = body?.event;
    const payload = body?.payload;

    if (!event || !payload) return res.status(200).json({ ok: true });

    // Só processa eventos relevantes
    const RELEVANT = ["message", "message.any", "chat.new", "message.revoked"];
    if (!RELEVANT.includes(event)) return res.status(200).json({ ok: true, skipped: event });

    const db = await getDb();
    await db.collection("waha_events").insertOne({
      event,
      payload,
      session: body.session || "default",
      createdAt: new Date(),
      // TTL index deve ser criado: db.waha_events.createIndex({createdAt:1},{expireAfterSeconds:120})
    });

    res.status(200).json({ ok: true });
  } catch (e) {
    console.error("[webhook]", e.message);
    res.status(500).json({ error: e.message });
  }
}
