// api/webhook.js
// Recebe eventos do WAHA e encaminha ao PartyKit (hub de tempo real)
// WAHA → Vercel /api/webhook → PartyKit room → browsers via WebSocket

const RELEVANT = new Set(["message", "message.any", "chat.new", "message.revoked"]);

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Api-Key, Authorization");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).end();

  // Valida chave do WAHA
  const wahaKey = process.env.WAHA_API_KEY;
  if (wahaKey) {
    const incoming = req.headers["x-api-key"] || (req.headers["authorization"] || "").replace("Bearer ", "");
    if (incoming !== wahaKey) return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const { event, payload, session } = req.body || {};

    if (!event || !payload || !RELEVANT.has(event)) {
      return res.status(200).json({ ok: true, skipped: event || "empty" });
    }

    // Encaminha ao PartyKit
    const partyHost = process.env.PARTYKIT_HOST; // ex: crm-whatsapp.seuuser.partykit.dev
    if (!partyHost) {
      console.warn("[webhook] PARTYKIT_HOST não configurado");
      return res.status(200).json({ ok: true, warn: "no partykit host" });
    }

    const partyUrl = `https://${partyHost}/parties/main/clinic`;
    const r = await fetch(partyUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-key": process.env.INTERNAL_API_KEY || "@Deuse10",
      },
      body: JSON.stringify({ event, payload, session: session || "default" }),
    });

    if (!r.ok) {
      console.error("[webhook] PartyKit error:", r.status, await r.text());
    }

    res.status(200).json({ ok: true });
  } catch (e) {
    console.error("[webhook]", e.message);
    res.status(500).json({ error: e.message });
  }
}
