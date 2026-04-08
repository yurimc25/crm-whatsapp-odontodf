// api/transcribe.js — Transcrição de áudio via OpenAI Whisper
// Recebe um arquivo de áudio via multipart/form-data e retorna o texto transcrito.
// Requer OPENAI_API_KEY nas variáveis de ambiente.

import formidable from "formidable";
import fs from "fs";
import FormData from "form-data";
import fetch from "node-fetch";

export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Internal-Key");
  if (req.method === "OPTIONS") return res.status(200).end();

  const key = req.headers["x-internal-key"];
  if (key !== process.env.INTERNAL_API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) {
    return res.status(501).json({ error: "OPENAI_API_KEY não configurada" });
  }

  if (req.method !== "POST") return res.status(405).end();

  try {
    const form = formidable({ maxFileSize: 25 * 1024 * 1024 }); // 25MB
    const [, files] = await form.parse(req);
    const file = Array.isArray(files.file) ? files.file[0] : files.file;
    if (!file) return res.status(400).json({ error: "Arquivo de áudio não enviado" });

    const fd = new FormData();
    fd.append("file", fs.createReadStream(file.filepath), {
      filename: file.originalFilename || "audio.ogg",
      contentType: file.mimetype || "audio/ogg",
    });
    fd.append("model", "whisper-1");
    fd.append("language", "pt");
    fd.append("response_format", "json");

    const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${openaiKey}`, ...fd.getHeaders() },
      body: fd,
    });

    if (!r.ok) {
      const err = await r.text();
      console.error("[transcribe] Whisper error:", err);
      return res.status(r.status).json({ error: "Erro Whisper: " + err.slice(0, 200) });
    }

    const data = await r.json();
    return res.status(200).json({ text: data.text || "" });
  } catch (e) {
    console.error("[transcribe]", e.message);
    return res.status(500).json({ error: e.message });
  } finally {
    // Limpa arquivo temporário
    try { /* formidable handles cleanup */ } catch {}
  }
}
