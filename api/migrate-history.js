// api/migrate-history.js
// Migra histórico de mensagens do WAHA → R2 (roda no servidor)
// GET  /api/migrate-history           → lista chatIds disponíveis no WAHA
// POST /api/migrate-history           → processa batch { chatIds: [...] }

import { r2Get, r2Put } from "./_r2.js";

const MAX_MSGS = 200;
const BATCH_SIZE = 10; // chats por chamada (limite de tempo da função serverless)

function chatKey(chatId) {
  return "msgs/" + chatId.replace(/[^a-zA-Z0-9_-]/g, "_") + ".json";
}

async function r2Json(key, def) {
  try {
    const r = await r2Get(key);
    if (!r) return def;
    return JSON.parse(r.buf.toString("utf8"));
  } catch { return def; }
}

async function r2WriteJson(key, data) {
  await r2Put(key, Buffer.from(JSON.stringify(data), "utf8"), "application/json");
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Internal-Key");
  if (req.method === "OPTIONS") return res.status(200).end();

  const key = req.headers["x-internal-key"];
  if (key !== process.env.INTERNAL_API_KEY) return res.status(401).json({ error: "Unauthorized" });

  const wahaUrl = process.env.WAHA_URL;
  const wahaKey = process.env.WAHA_API_KEY;
  const session = process.env.WAHA_SESSION || "default";
  if (!wahaUrl) return res.status(500).json({ error: "WAHA_URL não configurado" });

  const wahaHeaders = {
    "Content-Type": "application/json",
    ...(wahaKey ? { "X-Api-Key": wahaKey } : {}),
  };

  // ── GET → retorna lista completa de chatIds do WAHA ──────────────
  if (req.method === "GET") {
    try {
      const r = await fetch(`${wahaUrl}/api/${session}/chats?limit=500`, {
        headers: wahaHeaders,
        signal: AbortSignal.timeout(15000),
      });
      if (!r.ok) return res.status(r.status).json({ error: `WAHA ${r.status}` });
      const chats = await r.json();
      if (!Array.isArray(chats)) return res.status(200).json({ chatIds: [], total: 0 });
      const chatIds = chats
        .map(c => (c.id || "").replace(/:\d+(@\S+)?$/, ""))
        .filter(id => id && !id.endsWith("@s.whatsapp.net") && !id.endsWith("@lid"));
      return res.status(200).json({ chatIds, total: chatIds.length });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── POST { chatIds: [...] } → processa um batch ───────────────────
  if (req.method === "POST") {
    let body;
    try {
      const raw = await new Promise((resolve, reject) => {
        let data = "";
        req.on("data", chunk => data += chunk);
        req.on("end", () => resolve(data));
        req.on("error", reject);
      });
      body = JSON.parse(raw);
    } catch {
      return res.status(400).json({ error: "JSON inválido" });
    }

    const chatIds = Array.isArray(body?.chatIds) ? body.chatIds.slice(0, BATCH_SIZE) : [];
    if (!chatIds.length) return res.status(200).json({ ok: true, processed: 0, saved: 0 });

    let processed = 0;
    let saved = 0;
    const errors = [];

    // Lê chats.json uma vez para atualizar em batch no final
    const chatsIndex = await r2Json("chats.json", []);
    const chatsMap = {};
    for (const c of chatsIndex) if (c.id) chatsMap[c.id] = c;
    let chatsChanged = false;

    for (const chatId of chatIds) {
      try {
        const id = encodeURIComponent(chatId);
        const r = await fetch(
          `${wahaUrl}/api/${session}/chats/${id}/messages?limit=200&downloadMedia=false`,
          { headers: wahaHeaders, signal: AbortSignal.timeout(10000) }
        );
        if (!r.ok) { errors.push(chatId); processed++; continue; }
        const raw = await r.json();
        if (!Array.isArray(raw) || !raw.length) { processed++; continue; }

        // Normaliza para formato R2 (igual ao webhook)
        const msgs = raw.map(m => {
          const tsRaw = m.timestamp || m._data?.t || 0;
          const tsMs  = tsRaw ? (tsRaw > 1e12 ? tsRaw : tsRaw * 1000) : 0;
          const id    = m.id?._serialized || (typeof m.id === "string" ? m.id : null) || `msg-${tsMs}`;
          return {
            id,
            chatId,
            ts:      tsMs,
            fromMe:  m.fromMe ?? m._data?.fromMe ?? false,
            body:    m.body  || m._data?.body || m.caption || m._data?.caption || "",
            type:    m.type  || m._data?.type || "chat",
            pushname: m.notifyName || m._data?.notifyName || "",
          };
        }).filter(m => m.id && m.ts > 0);

        if (!msgs.length) { processed++; continue; }
        msgs.sort((a, b) => a.ts - b.ts);

        // Mescla com R2 existente (dedup por id)
        const rKey   = chatKey(chatId);
        const exist  = await r2Json(rKey, []);
        const existIds = new Set(exist.map(m => m.id));
        const novas    = msgs.filter(m => !existIds.has(m.id));

        if (novas.length > 0) {
          const merged = [...exist, ...novas].sort((a, b) => (a.ts||0) - (b.ts||0));
          if (merged.length > MAX_MSGS) merged.splice(0, merged.length - MAX_MSGS);
          await r2WriteJson(rKey, merged);
          saved += novas.length;
        }

        // Atualiza entrada do chat no índice
        const lastMsg = msgs[msgs.length - 1];
        const entry = {
          id:      chatId,
          lastMsg: lastMsg.body || "",
          lastTs:  lastMsg.ts,
          fromMe:  lastMsg.fromMe,
          pushname: lastMsg.pushname || chatsMap[chatId]?.pushname || "",
          lastPatientTs: chatsMap[chatId]?.lastPatientTs ?? null,
          unread:  chatsMap[chatId]?.unread ?? 0,
        };
        if (chatsMap[chatId]) {
          const prev = chatsMap[chatId];
          if (!prev.lastTs || lastMsg.ts > prev.lastTs) {
            chatsMap[chatId] = { ...prev, ...entry };
            chatsChanged = true;
          }
        } else {
          chatsMap[chatId] = entry;
          chatsChanged = true;
        }

        processed++;
      } catch (e) {
        errors.push(chatId);
        processed++;
      }
    }

    // Salva chats.json atualizado
    if (chatsChanged) {
      const updated = Object.values(chatsMap);
      if (updated.length > 1000) updated.splice(1000);
      await r2WriteJson("chats.json", updated);
    }

    return res.status(200).json({ ok: true, processed, saved, errors });
  }

  return res.status(405).end();
}
