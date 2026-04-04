// api/waha.js — Proxy para o WAHA rodando no EasyPanel
// O browser não pode chamar o WAHA diretamente por causa de CORS.
// Este endpoint recebe as requisições do frontend e repassa ao WAHA.

const WAHA_URL = process.env.VITE_WAHA_URL || "";
const WAHA_KEY = process.env.VITE_WAHA_API_KEY || "";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Internal-Key");
  if (req.method === "OPTIONS") return res.status(200).end();

  const key = req.headers["x-internal-key"];
  if (key !== process.env.INTERNAL_API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { path, ...rest } = req.query;
  if (!path) return res.status(400).json({ error: "path obrigatório" });

  const params = new URLSearchParams(rest);
  // Adiciona timestamp para garantir que o WAHA nunca use cache/ETag
  params.set("_t", Date.now().toString());
  const qs = params.toString() ? `?${params.toString()}` : "";
  const url = `${WAHA_URL}${path}${qs}`;

  try {
    const wahaRes = await fetch(url, {
      method: req.method,
      headers: {
        "Content-Type": "application/json",
        "X-Api-Key": WAHA_KEY,
        // Nunca repassa If-None-Match/If-Modified-Since — queremos dados frescos sempre
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
      },
      ...(req.method !== "GET" && req.body
        ? { body: JSON.stringify(req.body) } : {}),
    });

    // 304 = sem mudança — retorna null para o frontend manter estado anterior
    if (wahaRes.status === 304) {
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json(null);
    }

    const ct = wahaRes.headers.get("content-type") || "";
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");

    // Sempre tenta JSON primeiro (chats, mensagens, contatos)
    if (ct.includes("application/json") || ct === "") {
      try {
        const data = await wahaRes.json();
        return res.status(200).json(data);
      } catch {
        // Se falhou o parse de JSON, cai no texto
      }
    }

    // Mídia binária (imagens, áudios, vídeos, documentos)
    if (ct.startsWith("image/") || ct.startsWith("video/") ||
        ct.startsWith("audio/") || ct.includes("octet-stream") ||
        ct.includes("pdf")) {
      try {
        const buf = await wahaRes.arrayBuffer();
        res.setHeader("Content-Type", ct);
        return res.status(200).end(Buffer.from(buf));
      } catch (e) {
        console.error("[waha-proxy] binary error:", e.message);
        return res.status(502).json({ error: "Erro ao baixar mídia" });
      }
    }

    // Texto genérico
    const text = await wahaRes.text();
    return res.status(wahaRes.status).send(text);
  } catch (e) {
    console.error("[waha-proxy]", e.message);
    return res.status(500).json({ error: e.message });
  }
}