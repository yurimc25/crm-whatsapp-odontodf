// api/r2-data.js
// Expõe dados persistidos no R2 para o browser
// GET /api/r2-data?type=chats              → chats.json
// GET /api/r2-data?type=msgs&chatId=...    → msgs/{chatId}.json

import { r2Get } from "./_r2.js";

function chatKey(chatId) {
  return "msgs/" + chatId.replace(/[^a-zA-Z0-9_-]/g, "_") + ".json";
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Internal-Key");
  if (req.method === "OPTIONS") return res.status(200).end();

  const key = req.headers["x-internal-key"];
  if (key !== process.env.INTERNAL_API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { type, chatId } = req.query;

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
