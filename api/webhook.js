// api/webhook.js
// WAHA → Vercel /api/webhook → R2 (persistência) + PartyKit (tempo real) → browsers

import { r2Get, r2Put } from "./_r2.js";

const RELEVANT = new Set(["message", "message.any", "chat.new", "message.revoked"]);
const MAX_MSGS_PER_CHAT = 200; // máximo de mensagens guardadas por conversa no R2

// Chave R2 segura para um chatId (ex: "556198...@c.us" → "msgs/556198___c_us.json")
function chatKey(chatId) {
  return "msgs/" + chatId.replace(/[^a-zA-Z0-9_-]/g, "_") + ".json";
}

// ── isFarewell / computeLastPatientTs (espelhado do frontend) ────
const FAREWELL_PATTERNS = [
  /^(ok|okay|oks|okey)[\s!.,]*$/i,
  /^obrigad/i, /^agradeç/i, /^igualmente[\s!.]*$/i,
  /^disponha/i, /^excelente dia/i,
  /^(até logo|até mais|até amanhã|até breve)[\s!.]*$/i,
  /^(tchau|xau|xao|bi|bye)[\s!]*$/i,
  /^(flw|vlw|falou)[\s!]*$/i,
  /^(boa noite|boa tarde|bom dia)[!.\s]*$/i,
];
const REQUEST_WORDS = /avise|avisa|lembre|confirme|gostaria|quero|preciso|pode(ria)?|consegue|horário|agenda|consulta|compromisso|tenho |posso |não (posso|consigo|vou)/i;
function isFarewell(text) {
  if (!text) return false;
  const t = text.trim();
  if (t.length > 80) return false;
  if (/\?/.test(t)) return false;
  if (REQUEST_WORDS.test(t)) return false;
  return FAREWELL_PATTERNS.some(p => p.test(t));
}
function computeLastPatientTs(msgs) {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (!m.fromMe) { // fromMe=false → paciente
      return isFarewell(m.body) ? null : m.ts;
    }
    if (m.fromMe) return null; // operador respondeu — sem timer
  }
  return null;
}
function computeUnread(msgs) {
  let count = 0;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].fromMe) break;
    count++;
  }
  return count;
}

// Normaliza payload WAHA para objeto enxuto
function normalizeMsg(payload) {
  const tsRaw = payload.timestamp || payload._data?.t || 0;
  const tsMs  = tsRaw ? (tsRaw > 1e12 ? tsRaw : tsRaw * 1000) : Date.now();
  const chatId = (payload.from || payload.chatId || payload.key?.remoteJid || "")
    .replace(/:.*@/, "@"); // remove device suffix
  const id     = payload.id || payload.key?.id || `msg-${tsMs}`;
  const fromMe = payload.fromMe ?? payload._data?.fromMe ?? false;
  const body   = payload.body || payload._data?.body
    || payload.caption || payload._data?.caption || "";
  const type   = payload.type || payload._data?.type || "chat";
  const pushname = payload.notifyName || payload._data?.notifyName || "";

  return { id, chatId, ts: tsMs, fromMe, body, type, pushname };
}

// Lê JSON do R2 ou retorna default
async function r2Json(key, def) {
  try {
    const r = await r2Get(key);
    if (!r) return def;
    return JSON.parse(r.buf.toString("utf8"));
  } catch { return def; }
}

// Escreve JSON no R2
async function r2WriteJson(key, data) {
  await r2Put(key, Buffer.from(JSON.stringify(data), "utf8"), "application/json");
}

// Atualiza chats.json com última msg + lastPatientTs + unread pré-computados
async function updateChatsIndex(msg, msgs) {
  const chats = await r2Json("chats.json", []);
  const idx   = chats.findIndex(c => c.id === msg.chatId);
  const lpt   = computeLastPatientTs(msgs);
  const unread = computeUnread(msgs);
  const entry = {
    id:            msg.chatId,
    lastMsg:       msg.body,
    lastTs:        msg.ts,
    fromMe:        msg.fromMe,
    pushname:      msg.pushname || (idx >= 0 ? chats[idx].pushname : ""),
    lastPatientTs: lpt,
    unread,
  };
  if (idx >= 0) {
    chats[idx] = { ...chats[idx], ...entry };
  } else {
    chats.unshift(entry);
    if (chats.length > 1000) chats.splice(1000);
  }
  await r2WriteJson("chats.json", chats);
}

// Salva mensagem no histórico e retorna lista atualizada
async function saveMessage(msg) {
  const key  = chatKey(msg.chatId);
  const msgs = await r2Json(key, []);
  if (msgs.find(m => m.id === msg.id)) return msgs; // duplicata
  msgs.push(msg);
  msgs.sort((a, b) => a.ts - b.ts);
  if (msgs.length > MAX_MSGS_PER_CHAT) msgs.splice(0, msgs.length - MAX_MSGS_PER_CHAT);
  await r2WriteJson(key, msgs);
  return msgs;
}

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

    // ── Persiste no R2 (fire-and-forget — não bloqueia resposta) ──────────
    const r2Enabled = !!(process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID && process.env.R2_BUCKET_NAME);
    if (r2Enabled) {
      if (event === "message" || event === "message.any") {
        const msg = normalizeMsg(payload);
        if (msg.chatId) {
          // Salva mensagem primeiro, depois atualiza índice com msgs atualizadas
          saveMessage(msg)
            .then(msgs => updateChatsIndex(msg, msgs))
            .catch(e => console.warn("[r2] save/updateChats:", e.message));
        }
      } else if (event === "chat.new") {
        // Garante que o chat existe no índice mesmo sem mensagem ainda
        const chatId = (payload.id || payload.chatId || "").replace(/:.*@/, "@");
        if (chatId) {
          r2Json("chats.json", []).then(chats => {
            if (!chats.find(c => c.id === chatId)) {
              chats.unshift({ id: chatId, lastMsg: "", lastTs: Date.now(), fromMe: false });
              return r2WriteJson("chats.json", chats);
            }
          }).catch(() => {});
        }
      }
    }

    // ── Encaminha ao PartyKit ─────────────────────────────────────────────
    const partyHost = process.env.PARTYKIT_HOST;
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
