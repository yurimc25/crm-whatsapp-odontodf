// api/ocr.js — Extrai dados de paciente de imagem via Groq Vision
// Requer GROQ_API_KEY nas variáveis de ambiente.

import Groq from "groq-sdk";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Internal-Key");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const key     = req.headers["x-internal-key"];
  const validKey = process.env.INTERNAL_API_KEY || process.env.VITE_INTERNAL_API_KEY;
  if (key !== validKey) return res.status(401).json({ error: "Unauthorized" });

  const { base64, mime } = req.body || {};
  if (!base64) return res.status(400).json({ error: "base64 required" });

  if (!process.env.GROQ_API_KEY) return res.status(503).json({ error: "GROQ_API_KEY não configurada" });

  try {
    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

    const response = await groq.chat.completions.create({
      model: "meta-llama/llama-4-scout-17b-16e-instruct",
      messages: [{
        role: "user",
        content: [
          {
            type: "text",
            text: "Extraia todos os dados desta imagem que podem ser de um paciente odontológico ou carteirinha de plano de saúde: nome completo, CPF, data de nascimento, convênio/plano, número da carteirinha, telefone, e-mail. Retorne apenas os dados encontrados, um por linha no formato 'Campo: Valor'. Se não encontrar dados relevantes, responda 'Nenhum dado de paciente detectado'.",
          },
          {
            type: "image_url",
            image_url: { url: `data:${mime || "image/jpeg"};base64,${base64}` },
          },
        ],
      }],
      max_tokens: 500,
    });

    const text = response.choices?.[0]?.message?.content || "";
    return res.status(200).json({ text });
  } catch (e) {
    console.error("[ocr/groq]", e.message);
    return res.status(500).json({ error: e.message });
  }
}
