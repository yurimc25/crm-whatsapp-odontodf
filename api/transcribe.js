// api/transcribe.js — Transcrição de áudio via Groq Whisper
// Requer GROQ_API_KEY nas variáveis de ambiente.
// Limite Groq: 25MB por arquivo. Arquivos maiores retornam erro orientando split.

import { formidable } from "formidable";
import fs from "fs";
import Groq from "groq-sdk";

export const config = { api: { bodyParser: false } };

const MAX_BYTES = 25 * 1024 * 1024; // 25MB
const MODEL     = "whisper-large-v3-turbo"; // ou "whisper-large-v3"

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Internal-Key");
  if (req.method === "OPTIONS") return res.status(200).end();

  const key = req.headers["x-internal-key"];
  if (key !== process.env.INTERNAL_API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  if (!process.env.GROQ_API_KEY) {
    return res.status(501).json({ error: "GROQ_API_KEY não configurada" });
  }

  if (req.method !== "POST") return res.status(405).end();

  let filepath;
  try {
    const form = formidable({ maxFileSize: MAX_BYTES });
    const [, files] = await form.parse(req);
    const file = Array.isArray(files.file) ? files.file[0] : files.file;
    if (!file) return res.status(400).json({ error: "Arquivo de áudio não enviado" });

    filepath = file.filepath;
    const sizeBytes = file.size || fs.statSync(filepath).size;

    if (sizeBytes > MAX_BYTES) {
      return res.status(413).json({
        error: `Arquivo muito grande (${(sizeBytes / 1024 / 1024).toFixed(1)}MB). Limite Groq: 25MB.`,
      });
    }

    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

    // Groq precisa do nome com extensão correta para identificar o tipo
    const rawMime = (file.mimetype || "audio/ogg").split(";")[0].trim();
    const ext     = rawMime.split("/")[1] || "ogg";
    const buf     = fs.readFileSync(filepath);
    const audioFile = new File([buf], `audio.${ext}`, { type: rawMime });

    const transcription = await groq.audio.transcriptions.create({
      file:            audioFile,
      model:           MODEL,
      language:        "pt",
      response_format: "json",
    });

    return res.status(200).json({ text: transcription.text || "" });
  } catch (e) {
    console.error("[transcribe/groq]", e.message);
    return res.status(500).json({ error: e.message });
  } finally {
    if (filepath) try { fs.unlinkSync(filepath); } catch {}
  }
}
