// api/waha.js — Proxy para o WAHA rodando no EasyPanel
// O browser não pode chamar o WAHA diretamente por causa de CORS.
// Este endpoint recebe as requisições do frontend e repassa ao WAHA.

const WAHA_URL = process.env.VITE_WAHA_URL || "";
const WAHA_KEY = process.env.VITE_WAHA_API_KEY || "";
const SESSION  = process.env.VITE_WAHA_SESSION || "default";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Internal-Key");
  if (req.method === "OPTIONS") return res.status(200).end();

  const key = req.headers["x-internal-key"];
  if (key !== process.env.INTERNAL_API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { path } = req.query;
  if (!path) return res.status(400).json({ error: "path obrigatório" });

  // Monta a query string repassando todos os params exceto "path"
  const params = new URLSearchParams(req.query);
  params.delete("path");
  const qs = params.toString() ? `?${params.toString()}` : "";

  const url = `${WAHA_URL}${path}${qs}`;

  try {
    const wahaRes = await fetch(url, {
      method: req.method === "GET" ? "GET" : req.method,
      headers: {
        "Content-Type": "application/json",
        "X-Api-Key": WAHA_KEY,
      },
      ...(req.method !== "GET" && req.body
        ? { body: JSON.stringify(req.body) }
        : {}),
    });

    const ct = wahaRes.headers.get("content-type") || "";
    if (ct.includes("application/json")) {
      const data = await wahaRes.json();
      return res.status(wahaRes.status).json(data);
    }
    const text = await wahaRes.text();
    return res.status(wahaRes.status).send(text);
  } catch (e) {
    console.error("[waha-proxy]", e.message);
    return res.status(500).json({ error: e.message });
  }
}
