// api/webhook.js
// WAHA → Vercel /api/webhook → R2 (persistência) + PartyKit (tempo real) → browsers

import { r2Get, r2Put } from "./_r2.js";

const RELEVANT = new Set(["message", "message.any", "chat.new", "message.revoked", "message.reaction"]);
const MAX_MSGS_PER_CHAT = 200;

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
    if (!m.fromMe) return isFarewell(m.body) ? null : m.ts;
    if (m.fromMe) return null;
  }
  return null;
}
function computeUnread(msgs) {
  if (computeLastPatientTs(msgs) === null) return 0;
  let count = 0;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].fromMe) break;
    count++;
  }
  return count;
}

// Normaliza payload WAHA para objeto enxuto.
// Retorna null se não for possível extrair chatId válido (não @s.whatsapp.net).
function normalizeMsg(payload) {
  const tsRaw = payload.timestamp || payload._data?.t || 0;
  const tsMs  = tsRaw ? (tsRaw > 1e12 ? tsRaw : tsRaw * 1000) : Date.now();

  // Coleta candidatos e remove sufixo de dispositivo (":3@...")
  const candidates = [payload.chatId, payload.from, payload.key?.remoteJid]
    .filter(Boolean)
    .map(s => s.replace(/:\d+(@\S+)?$/, ""));

  // Prefere @c.us/@g.us; aceita @lid; descarta @s.whatsapp.net
  const chatId = candidates.find(s => s.endsWith("@c.us") || s.endsWith("@g.us"))
    || candidates.find(s => !s.endsWith("@s.whatsapp.net"))
    || candidates[0]
    || "";

  // Se chatId ainda é @s.whatsapp.net ou vazio → retorna null para evitar descarte silencioso
  if (!chatId || chatId.endsWith("@s.whatsapp.net")) return null;

  const id       = payload.id || payload.key?.id || `msg-${tsMs}`;
  const fromMe   = payload.fromMe ?? payload._data?.fromMe ?? false;
  const body     = payload.body || payload._data?.body
    || payload.caption || payload._data?.caption || "";
  const pushname = payload.notifyName || payload._data?.notifyName || "";

  // Detecta tipo real de mídia
  const rawType  = payload.type || payload._data?.type || "chat";
  const msgData  = payload._data?.message || {};
  const mimetype = payload.media?.mimetype
    || msgData.imageMessage?.mimetype
    || msgData.videoMessage?.mimetype
    || msgData.audioMessage?.mimetype
    || msgData.documentMessage?.mimetype
    || msgData.stickerMessage?.mimetype
    || null;
  const type = mimetype
    ? (mimetype.startsWith("video/")       ? "video"
     : mimetype.startsWith("audio/")       ? "audio"
     : mimetype === "image/webp"           ? "sticker"
     : mimetype.startsWith("image/")       ? "image"
     : mimetype === "application/pdf" || mimetype.startsWith("application/") || mimetype.startsWith("text/") ? "document"
     : rawType)
    : rawType;

  const MEDIA_TYPES = new Set(["image","video","audio","voice","document","sticker","ptt"]);
  const hasMedia = payload.hasMedia === true || MEDIA_TYPES.has(type);
  const rawId    = payload.id || null;
  const wahaShortId = (hasMedia && rawId && typeof rawId === "string" && rawId.includes("_"))
    ? ([...rawId.split("_")].reverse().find(p => !p.includes("@")) || null)
    : null;

  // Mensagem citada (reply)
  const rt = payload.replyTo || null;
  const replyTo = rt ? {
    id:       rt.id || null,
    body:     rt.body || "",
    hasMedia: rt.hasMedia || false,
    media:    rt.media ? {
      mimetype: rt.media.mimetype || null,
      url:      rt.media.url || null,
    } : null,
  } : null;

  return { id, chatId, ts: tsMs, fromMe, body, type, pushname,
           ...(wahaShortId ? { wahaShortId } : {}),
           ...(mimetype ? { mimetype } : {}),
           ...(replyTo ? { replyTo } : {}) };
}

// Resolve @lid → JID @c.us real via API de contatos do WAHA (server-side).
async function resolveLidToJid(lid, session) {
  const wahaUrl = process.env.WAHA_URL;
  if (!wahaUrl) return null;
  try {
    const encodedLid = encodeURIComponent(lid);
    const r = await fetch(
      `${wahaUrl}/api/${session}/contacts?contactId=${encodedLid}`,
      {
        headers: {
          "X-Api-Key": process.env.WAHA_API_KEY || "",
          "Content-Type": "application/json",
        },
        signal: AbortSignal.timeout(3000),
      }
    );
    if (!r.ok) return null;
    const data = await r.json();
    const contact = Array.isArray(data) ? data[0] : data;
    const jid = contact?.id || contact?.phone || null;
    if (jid && !jid.endsWith("@lid") && !jid.endsWith("@s.whatsapp.net")) {
      console.log(`[webhook/lid] resolvido: ${lid} → ${jid}`);
      return jid;
    }
  } catch (e) {
    console.warn("[webhook/lid] erro ao resolver:", lid, e?.message);
  }
  return null;
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
  if (msgs.find(m => m.id === msg.id)) return msgs; // duplicata por ID
  msgs.push(msg);
  msgs.sort((a, b) => a.ts - b.ts);
  if (msgs.length > MAX_MSGS_PER_CHAT) msgs.splice(0, msgs.length - MAX_MSGS_PER_CHAT);
  await r2WriteJson(key, msgs);
  return msgs;
}

// Marca mensagem como revogada no histórico do R2
async function revokeMessage(chatId, msgId) {
  if (!chatId || !msgId) return;
  const key  = chatKey(chatId);
  const msgs = await r2Json(key, []);
  const idx  = msgs.findIndex(m => m.id === msgId);
  if (idx < 0) return;
  msgs[idx] = { ...msgs[idx], revoked: true };
  await r2WriteJson(key, msgs);
}

// Aplica/remove reação de um emoji a uma mensagem no R2
// emoji="" significa remoção de reação anterior
async function applyReaction(chatId, msgId, emoji, reactorId, fromMe) {
  if (!chatId || !msgId) return;
  const key  = chatKey(chatId);
  const msgs = await r2Json(key, []);
  const idx  = msgs.findIndex(m => m.id === msgId);
  if (idx < 0) return; // mensagem não está no R2 (muito antiga) — ignora
  const reactions = { ...(msgs[idx].reactions || {}) };
  // Remove qualquer reação anterior deste usuário
  for (const e of Object.keys(reactions)) {
    reactions[e] = reactions[e].filter(u => u.id !== reactorId);
    if (reactions[e].length === 0) delete reactions[e];
  }
  // Adiciona nova reação (se não for remoção)
  if (emoji) {
    if (!reactions[emoji]) reactions[emoji] = [];
    reactions[emoji].push({ id: reactorId, fromMe: !!fromMe });
  }
  msgs[idx] = { ...msgs[idx], reactions };
  await r2WriteJson(key, msgs);
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

    const r2Enabled = !!(process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID && process.env.R2_BUCKET_NAME);

    // ── message / message.any ─────────────────────────────────────────────
    if (event === "message" || event === "message.any") {
      const rawMsg = normalizeMsg(payload);

      if (!rawMsg) {
        // chatId era @s.whatsapp.net ou vazio — ignorar (são mensagens do servidor WA)
        console.log(`[webhook] ${event} descartado: chatId inválido (payload.chatId=${payload.chatId || "?"} from=${payload.from || "?"})`);
        // Ainda encaminha ao PartyKit para debug em tempo real
      } else {
        console.log(`[webhook] ${event} chatId=${rawMsg.chatId} fromMe=${rawMsg.fromMe} type=${rawMsg.type}`);

        // Tenta resolver @lid → @c.us antes de persistir
        let finalMsg = rawMsg;
        if (rawMsg.chatId.endsWith("@lid")) {
          const lid    = rawMsg.chatId;
          const lidKey = lid.replace(/@lid$/, "");
          const jid    = await resolveLidToJid(lid, session || "default");
          if (jid) {
            finalMsg = { ...rawMsg, chatId: jid };
            console.log(`[webhook] @lid resolvido: ${lid} → ${jid}`);
            // Salva mapeamento lid_map.json no R2 para dedup server-side
            if (r2Enabled) {
              r2Json("lid_map.json", {}).then(map => {
                if (map[lidKey] === jid) return; // já salvo
                map[lidKey] = jid;
                return r2WriteJson("lid_map.json", map);
              }).catch(() => {});
            }
          } else {
            console.warn(`[webhook] @lid não resolvido: ${lid} — mantendo @lid no R2`);
            // Registra LID como pendente (null) para que msgs-list saiba que existe
            if (r2Enabled) {
              r2Json("lid_map.json", {}).then(map => {
                if (lidKey in map) return; // não sobrescreve mapeamento já resolvido
                map[lidKey] = null;
                return r2WriteJson("lid_map.json", map);
              }).catch(() => {});
            }
          }
        }

        // Persiste no R2 — sempre, independente de @lid ou formato
        if (r2Enabled) {
          saveMessage(finalMsg)
            .then(msgs => updateChatsIndex(finalMsg, msgs))
            .catch(e => console.warn("[r2] save/updateChats:", e.message));
        }
      }
    }

    // ── message.revoked ───────────────────────────────────────────────────
    if (event === "message.revoked") {
      // payload pode ter antes/depois ou direto o id e chatId
      const msgId  = payload.before?.id || payload.id || payload.key?.id;
      const rawId  = (payload.before?.chatId || payload.chatId || payload.key?.remoteJid || "")
        .replace(/:\d+(@\S+)?$/, "");
      const chatId = rawId.endsWith("@s.whatsapp.net") ? null : rawId;
      console.log(`[webhook] message.revoked chatId=${chatId} msgId=${msgId}`);
      if (r2Enabled && chatId && msgId) {
        revokeMessage(chatId, msgId).catch(e => console.warn("[r2] revoke:", e.message));
      }
    }

    // ── message.reaction ─────────────────────────────────────────────────
    if (event === "message.reaction") {
      // WAHA pode enviar em formatos diferentes dependendo do engine (NOWEB / Baileys)
      const emoji     = payload.reaction?.emoji ?? payload.reactionMessage?.text ?? payload.body ?? null;
      const targetId  = payload.reaction?.targetMessageId
        ?? payload.reactionMessage?.key?.id
        ?? payload.reactedMessageId ?? null;
      const rawChatId = (payload.chatId || payload.from || payload.reactionMessage?.key?.remoteJid || "")
        .replace(/:\d+(@\S+)?$/, "");
      const chatId    = rawChatId.endsWith("@s.whatsapp.net") ? null : rawChatId;
      const fromMe    = payload.fromMe ?? false;
      const reactorId = payload.from?.replace(/:\d+(@\S+)?$/, "") || (fromMe ? "me" : "unknown");
      console.log(`[webhook] message.reaction chatId=${chatId} targetId=${targetId} emoji=${emoji} from=${reactorId}`);
      if (r2Enabled && chatId && targetId !== null) {
        applyReaction(chatId, targetId, emoji || "", reactorId, fromMe)
          .catch(e => console.warn("[r2] reaction:", e.message));
      }
    }

    // ── chat.new ──────────────────────────────────────────────────────────
    if (event === "chat.new") {
      const rawId  = (payload.id || payload.chatId || "").replace(/:\d+(@\S+)?$/, "");
      const chatId = rawId.endsWith("@s.whatsapp.net") ? null : rawId;
      console.log(`[webhook] chat.new chatId=${chatId}`);
      if (r2Enabled && chatId) {
        r2Json("chats.json", []).then(chats => {
          if (!chats.find(c => c.id === chatId)) {
            chats.unshift({ id: chatId, lastMsg: "", lastTs: Date.now(), fromMe: false });
            return r2WriteJson("chats.json", chats);
          }
        }).catch(e => console.warn("[r2] chat.new:", e.message));
      }
    }

    // ── Encaminha ao PartyKit (sempre, para tempo real) ───────────────────
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
