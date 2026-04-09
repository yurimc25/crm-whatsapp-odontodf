// api/upload.js — Upload de arquivos para o R2 e retorna URL pública
// POST /api/upload
//   Headers: X-Internal-Key, Content-Type: application/json
//   Body: { filename, mimetype, data }  (data = base64 sem prefixo)
// Resposta: { ok: true, url: "https://..." }
//
// Variáveis de ambiente necessárias (já configuradas no Vercel):
//   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME
//   R2_PUBLIC_URL  — domínio público do bucket (ex: https://pub-xxx.r2.dev)

import { r2Put } from "./_r2.js";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Internal-Key");
  if (req.method === "OPTIONS") return res.status(200).end();

  const key = req.headers["x-internal-key"];
  if (key !== process.env.INTERNAL_API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

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

  // Gera chave única: uploads/{timestamp}-{filename}
  const safeFilename = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
  const r2Key = `uploads/${Date.now()}-${safeFilename}`;

  try {
    const buf = Buffer.from(data, "base64");
    await r2Put(r2Key, buf, mimetype);
    const url = `${publicUrl.replace(/\/$/, "")}/${r2Key}`;
    return res.status(200).json({ ok: true, url });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
