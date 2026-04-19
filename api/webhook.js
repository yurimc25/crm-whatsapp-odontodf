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
  // Se não há timer pendente, não há não-lidos
  if (computeLastPatientTs(msgs) === null) return 0;
  let count = 0;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].fromMe) break;
    count++;
  }
  return count;
}

// Normaliza payload WAHA para objeto enxuto.
// Prefere @c.us em vez de @lid — @lid é ID interno do WhatsApp, não é número de telefone.
function normalizeMsg(payload) {
  const tsRaw = payload.timestamp || payload._data?.t || 0;
  const tsMs  = tsRaw ? (tsRaw > 1e12 ? tsRaw : tsRaw * 1000) : Date.now();

  // Coleta candidatos e remove sufixo de dispositivo (":3@...")
  const candidates = [payload.chatId, payload.from, payload.key?.remoteJid]
    .filter(Boolean)
    .map(s => s.replace(/:\d+(@\S+)?$/, ""));

  // Prefere candidato @c.us; fallback para o primeiro disponível (pode ser @lid)
  const chatId = candidates.find(s => s.endsWith("@c.us") || s.endsWith("@g.us"))
    || candidates.find(s => !s.endsWith("@s.whatsapp.net"))
    || candidates[0]
    || "";

  const id       = payload.id || payload.key?.id || `msg-${tsMs}`;
  const fromMe   = payload.fromMe ?? payload._data?.fromMe ?? false;
  const body     = payload.body || payload._data?.body
    || payload.caption || payload._data?.caption || "";
  const type     = payload.type || payload._data?.type || "chat";
  const pushname = payload.notifyName || payload._data?.notifyName || "";

  return { id, chatId, ts: tsMs, fromMe, body, type, pushname };
}

// Resolve @lid → JID @c.us real via API de contatos do WAHA (server-side).
// Necessário para contas WhatsApp totalmente migradas para LID (Linked ID).
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

function mediaLabel(type) {
  const t = (type || "").toLowerCase();
  if (t === "ptt" || t === "voice" || t.includes("audio")) return "🎵 Áudio";
  if (t.includes("image") || t === "sticker") return "📷 Imagem";
  if (t.includes("video")) return "🎥 Vídeo";
  if (t.includes("document")) return "📎 Arquivo";
  return "📎 Mídia";
}

// Atualiza chats.json com última msg + lastPatientTs + unread pré-computados
async function updateChatsIndex(msg, msgs, altIds = []) {
  const chats = await r2Json("chats.json", []);
  const lpt     = computeLastPatientTs(msgs);
  const unread  = computeUnread(msgs);
  const lastMsg = msg.body || (msg.type && msg.type !== "chat" ? mediaLabel(msg.type) : "");

  // Coleta todos os IDs relacionados a esta mensagem (canonical + alternates)
  const allIds = [msg.chatId, ...altIds].filter(Boolean);

  // Encontra índice existente para qualquer um dos IDs (canonical ou alias)
  let idx = chats.findIndex(c => c.id === msg.chatId);
  if (idx < 0) {
    for (const altId of altIds) {
      idx = chats.findIndex(c => c.id === altId);
      if (idx >= 0) break;
    }
  }

  // aliasIds: todos os IDs exceto o canonical do entry resultante
  const canonicalId = idx >= 0 ? chats[idx].id : msg.chatId;
  const aliasIds = [...new Set(allIds.filter(id => id !== canonicalId && id))];

  const entry = {
    id:            canonicalId,
    lastMsg,
    lastTs:        msg.ts,
    fromMe:        msg.fromMe,
    pushname:      msg.pushname || (idx >= 0 ? chats[idx].pushname : ""),
    lastPatientTs: lpt,
    unread,
    aliasIds:      aliasIds.length ? aliasIds : undefined,
  };

  if (idx >= 0) {
    const existing = chats[idx];
    const mergedAliases = [...new Set([...(existing.aliasIds || []), ...aliasIds])];
    chats[idx] = { ...existing, ...entry, aliasIds: mergedAliases.length ? mergedAliases : undefined };
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

    // ── Resolve @lid → @c.us (se necessário) ─────────────────────────────
    // @lid (Linked ID) é um ID interno do WhatsApp — não é número de telefone.
    // Contas migradas enviam mensagens com @lid em vez de @c.us.
    // Precisamos resolver antes de persistir no R2 e encaminhar ao PartyKit,
    // para que o frontend roteie a mensagem para o chat @c.us correto.
    let resolvedPayload = payload;
    if (event === "message" || event === "message.any") {
      const rawMsg = normalizeMsg(payload);
      if (rawMsg.chatId && rawMsg.chatId.endsWith("@lid")) {
        const jid = await resolveLidToJid(rawMsg.chatId, session || "default");
        if (jid) {
          // Injeta chatId resolvido no payload para R2 e PartyKit receberem @c.us
          resolvedPayload = { ...payload, chatId: jid, from: jid };
          console.log(`[webhook] @lid resolvido no payload: ${rawMsg.chatId} → ${jid}`);
        }
      }
    }

    // ── Persiste no R2 (fire-and-forget — não bloqueia resposta) ──────────
    const r2Enabled = !!(process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID && process.env.R2_BUCKET_NAME);
    if (r2Enabled) {
      if (event === "message" || event === "message.any") {
        const msg = normalizeMsg(resolvedPayload);
        if (msg.chatId && !msg.chatId.endsWith("@s.whatsapp.net")) {
          // Coleta todos os IDs candidatos do payload original (antes de qualquer resolução)
          // para salvar a mensagem em TODOS os arquivos R2 relevantes (@lid e @c.us)
          const rawCandidates = [
            payload.chatId, payload.from, payload.key?.remoteJid,
            resolvedPayload.chatId, resolvedPayload.from,
          ]
            .filter(Boolean)
            .map(s => s.replace(/:\d+(@\S+)?$/, ""))
            .filter(s => s && !s.endsWith("@s.whatsapp.net") && s !== msg.chatId);
          const extraIds = [...new Set(rawCandidates)];

          // Salva no chatId principal (preferência: @c.us via normalizeMsg)
          saveMessage(msg)
            .then(msgs => updateChatsIndex(msg, msgs, extraIds))
            .catch(e => console.warn("[r2] save/updateChats:", e.message));

          // Salva também em cada ID alternativo válido encontrado no payload
          // (garante que @lid e @c.us do mesmo contato ficam no mesmo arquivo R2)
          for (const altId of extraIds) {
            const altMsg = { ...msg, chatId: altId };
            saveMessage(altMsg)
              .then(msgs => updateChatsIndex(altMsg, msgs))
              .catch(() => {});
          }
        }
      } else if (event === "chat.new") {
        // Garante que o chat existe no índice mesmo sem mensagem ainda
        const rawId = (payload.id || payload.chatId || "").replace(/:\d+(@\S+)?$/, "");
        const chatId = rawId.endsWith("@lid") ? null : rawId; // ignora @lid
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
      // Encaminha payload com @lid já resolvido (se aplicável)
      body: JSON.stringify({ event, payload: resolvedPayload, session: session || "default" }),
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
