// api/r2-data.js
// GET /api/r2-data?type=chats              → chats.json
// GET /api/r2-data?type=msgs&chatId=...    → msgs/{chatId}.json
// POST /api/r2-data?type=upload            → faz upload de arquivo e retorna URL pública
//   Body: { filename, mimetype, data }  (data = base64 sem prefixo)

import { r2Get, r2Put } from "./_r2.js";

function chatKey(chatId) {
  return "msgs/" + chatId.replace(/[^a-zA-Z0-9_-]/g, "_") + ".json";
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Internal-Key");
  if (req.method === "OPTIONS") return res.status(200).end();

  const key = req.headers["x-internal-key"];
  if (key !== process.env.INTERNAL_API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { type, chatId } = req.query;

  // ── POST: upload de arquivo para R2 ─────────────────────────────
  if (req.method === "POST" && type === "upload") {
    const publicUrl = process.env.R2_PUBLIC_URL;
    if (!publicUrl) return res.status(500).json({ error: "R2_PUBLIC_URL não configurado" });

    let body;
    try {
      body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    } catch {
      return res.status(400).json({ error: "JSON inválido" });
    }

    const { filename, mimetype, data } = body || {};
    if (!filename || !mimetype || !data) {
      return res.status(400).json({ error: "filename, mimetype e data são obrigatórios" });
    }

    try {
      const safeFilename = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
      const r2Key = `uploads/${Date.now()}-${safeFilename}`;
      const buf = Buffer.from(data, "base64");
      await r2Put(r2Key, buf, mimetype);
      const url = `${publicUrl.replace(/\/$/, "")}/${r2Key}`;
      return res.status(200).json({ ok: true, url });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── GET ──────────────────────────────────────────────────────────
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  try {
    if (type === "chats") {
      const r = await r2Get("chats.json");
      if (!r) return res.status(200).json([]);
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json(JSON.parse(r.buf.toString("utf8")));
    }

    if (type === "msgs" && chatId) {
      const r = await r2Get(chatKey(chatId));
      if (!r) return res.status(200).json([]);
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json(JSON.parse(r.buf.toString("utf8")));
    }

    return res.status(400).json({ error: "type inválido" });
  } catch (e) {
    console.error("[r2-data]", e.message);
    return res.status(500).json({ error: e.message });
  }
}
