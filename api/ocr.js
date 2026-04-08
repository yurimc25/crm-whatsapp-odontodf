// api/ocr.js — extrai texto de imagem via OpenAI Vision
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const ikey = process.env.VITE_INTERNAL_API_KEY || "@Deuse10";
  if (req.headers["x-internal-key"] !== ikey) return res.status(401).json({ error: "Unauthorized" });

  const { base64, mime } = req.body || {};
  if (!base64) return res.status(400).json({ error: "base64 required" });

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return res.status(503).json({ error: "OPENAI_API_KEY not configured" });

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{
          role: "user",
          content: [
            {
              type: "text",
              text: "Extraia todos os dados desta imagem que podem ser de um paciente odontológico ou carteirinha de plano de saúde: nome completo, CPF, data de nascimento, convênio/plano, número da carteirinha, telefone, e-mail. Retorne apenas os dados encontrados, um por linha no formato 'Campo: Valor'. Se não encontrar dados relevantes, responda 'Nenhum dado de paciente detectado'.",
            },
            {
              type: "image_url",
              image_url: { url: `data:${mime || "image/jpeg"};base64,${base64}`, detail: "high" },
            },
          ],
        }],
        max_tokens: 500,
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      return res.status(response.status).json({ error: err.error?.message || "OpenAI error" });
    }

    const data = await response.json();
    const text = data.choices?.[0]?.message?.content || "";
    return res.status(200).json({ text });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
