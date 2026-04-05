// src/services/waha.js
const WAHA_URL = import.meta.env.VITE_WAHA_URL || "https://n8n-waha8.vxjlst.easypanel.host";
const WAHA_KEY = import.meta.env.VITE_WAHA_API_KEY || "";
const SESSION  = import.meta.env.VITE_WAHA_SESSION || "default";

const headers = () => ({
  "Content-Type": "application/json",
  "X-Api-Key": WAHA_KEY,
});

// ── Cache de fotos de perfil ──────────────────────────────────────
const PHOTO_KEY = "waha_photos";
const PHOTO_TTL = 24 * 60 * 60 * 1000; // 24h

function getPhotoCache() {
  try {
    const raw = localStorage.getItem(PHOTO_KEY);
    if (!raw) return {};
    const p = JSON.parse(raw);
    if (Date.now() > p.expires) { localStorage.removeItem(PHOTO_KEY); return {}; }
    return p.value || {};
  } catch { return {}; }
}

function setPhotoCache(map) {
  try {
    localStorage.setItem(PHOTO_KEY, JSON.stringify({
      value: map, expires: Date.now() + PHOTO_TTL,
    }));
  } catch {}
}

// Busca foto de perfil de um contato (com cache 24h)
export async function getProfilePicture(chatId) {
  const cache = getPhotoCache();
  if (chatId in cache) return cache[chatId]; // null = sem foto (também cacheado)

  try {
    const id = encodeURIComponent(chatId);
    const r = await fetch(
      `${WAHA_URL}/api/contacts/profile-picture?contactId=${id}&session=${SESSION}`,
      { headers: headers() }
    );
    if (!r.ok) {
      const updated = { ...cache, [chatId]: null };
      setPhotoCache(updated);
      return null;
    }
    const data = await r.json();
    const url = data?.profilePictureURL || data?.pictureUrl || data?.url || null;
    const updated = { ...cache, [chatId]: url };
    setPhotoCache(updated);
    return url;
  } catch {
    const updated = { ...cache, [chatId]: null };
    setPhotoCache(updated);
    return null;
  }
}

// ── REST ──────────────────────────────────────────────────────────

// Carrega TODOS os chats paginando até não ter mais
export async function getChats() {
  const allChats = [];
  let limit = 100;
  let offset = 0;

  while (true) {
    const r = await fetch(
      `${WAHA_URL}/api/${SESSION}/chats?limit=${limit}&offset=${offset}`,
      { headers: headers() }
    );
    if (!r.ok) throw new Error(`WAHA getChats: ${r.status}`);
    const batch = await r.json();
    if (!Array.isArray(batch) || batch.length === 0) break;
    allChats.push(...batch);
    if (batch.length < limit) break; // última página
    offset += limit;
    if (allChats.length > 1000) break; // safety
  }

  return allChats;
}

export async function getMessages(chatId, limit = 20) {
  const id = encodeURIComponent(chatId);
  const r = await fetch(
    `${WAHA_URL}/api/${SESSION}/chats/${id}/messages?limit=${limit}&downloadMedia=false`,
    { headers: headers() }
  );
  if (!r.ok) throw new Error(`WAHA getMessages: ${r.status}`);
  return r.json();
}

export async function sendText(chatId, text) {
  const r = await fetch(`${WAHA_URL}/api/sendText`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ chatId, text, session: SESSION }),
  });
  if (!r.ok) throw new Error(`WAHA sendText: ${r.status}`);
  return r.json();
}

export async function getSessionStatus() {
  const r = await fetch(`${WAHA_URL}/api/sessions/${SESSION}`, { headers: headers() });
  if (!r.ok) throw new Error(`WAHA status: ${r.status}`);
  return r.json();
}

// ── Normalização ──────────────────────────────────────────────────

// Detecta se um ID é um número de telefone válido BR ou internacional
// IDs longos sem padrão de telefone são grupos/broadcasts/status
function isValidPhoneId(id) {
  const digits = id.replace(/@.*$/, "").replace(/\D/g, "");
  // Telefone BR: 12-13 dígitos (55 + DDD + número)
  // Internacional: 7-15 dígitos (E.164)
  // IDs inválidos: >15 dígitos ou padrões estranhos
  if (digits.length > 15) return false;
  if (digits.length < 7)  return false;
  return true;
}

// Tenta extrair número BR válido de IDs malformados
// Ex: "5561999611055@c.us" → "5561999611055" (ok)
// Ex: "276016157200564@c.us" → provavelmente grupo, retorna null
function extractPhone(rawId) {
  const cleanId = rawId.replace(/@.*$/, "").replace(/\D/g, "");
  if (!isValidPhoneId(cleanId)) return null;
  return cleanId;
}

export function normalizeChat(wahaChat) {
  const lm = wahaChat.lastMessage
    || wahaChat.messages?.[0]
    || wahaChat.msgs?.[0]
    || null;

  const lastBody = lm?.body || lm?.text || lm?.content || lm?._data?.body || "";
  const lastTs   = lm?.timestamp || lm?.t || lm?._data?.t || null;
  const cleanId  = wahaChat.id.replace(/@.*$/, "");
  const phone    = extractPhone(wahaChat.id);

  // pushname = nome público que o contato definiu no WhatsApp
  const pushname = wahaChat.name || wahaChat.pushname || wahaChat._data?.pushname || null;

  return {
    id:          wahaChat.id,
    name:        pushname || cleanId,
    pushname:    pushname,
    phone:       phone ? ("+" + phone) : (pushname || cleanId),
    isValidPhone: !!phone,
    lastMsg:     lastBody,
    lastTime:    lastTs
      ? new Date(lastTs * 1000).toLocaleTimeString("pt-BR", { hour:"2-digit", minute:"2-digit" })
      : "",
    lastTs:      lastTs ? new Date(lastTs * 1000).toISOString() : null,
    unread:      wahaChat.unreadCount ?? wahaChat.unread ?? 0,
    status:      "open",
    assignedTo:  null,
    tags:        [],
    avatar:      (pushname || cleanId || "??").slice(0, 2).toUpperCase(),
    avatarColor: stringToColor(wahaChat.id),
    photoUrl:    null,
  };
}

export function normalizeMessage(wahaMsg) {
  const body = wahaMsg.body
    || wahaMsg.text
    || wahaMsg.content
    || wahaMsg._data?.body
    || "";

  const tsRaw = wahaMsg.timestamp || wahaMsg._data?.messageTimestamp || wahaMsg.t || null;
  const tsMs  = tsRaw ? tsRaw * 1000 : Date.now();
  const ts    = new Date(tsMs).toISOString();

  const chatId = wahaMsg.chatId
    || wahaMsg.from?.replace(/:.*@/, "@")
    || null;

  // ── Detecção de mídia (NOWEB engine) ────────────────────────────
  // NOWEB: hasMedia=true, media=null, type="image", _data.message.imageMessage={...}
  const type     = wahaMsg.type || "text";
  const hasMedia = wahaMsg.hasMedia === true ||
                   ["image","video","audio","voice","document","sticker"].includes(type);

  let media = null;
  if (hasMedia) {
    // Tenta extrair de _data.message.* (NOWEB)
    const msgData = wahaMsg._data?.message || {};
    const imgMsg  = msgData.imageMessage  || {};
    const vidMsg  = msgData.videoMessage  || {};
    const audMsg  = msgData.audioMessage  || {};
    const docMsg  = msgData.documentMessage || {};
    const sticMsg = msgData.stickerMessage || {};

    // Pega o objeto certo dependendo do tipo
    const mediaData = imgMsg.mimetype  ? imgMsg
                    : vidMsg.mimetype  ? vidMsg
                    : audMsg.mimetype  ? audMsg
                    : docMsg.mimetype  ? docMsg
                    : sticMsg.mimetype ? sticMsg
                    : {};

    // Mimetype real
    const mimetype = wahaMsg.media?.mimetype
                  || mediaData.mimetype
                  || wahaMsg._data?.mimetype
                  || null;

    // Thumbnail em base64 (NOWEB retorna jpegThumbnail como Buffer)
    const thumbBuf  = mediaData.jpegThumbnail?.data || mediaData.jpegThumbnail || null;
    const thumbB64  = thumbBuf
      ? (typeof thumbBuf === "string" ? thumbBuf : btoa(String.fromCharCode(...new Uint8Array(thumbBuf))))
      : null;
    const thumbUrl  = thumbB64 ? `data:image/jpeg;base64,${thumbB64}` : null;

    // Detecta o tipo real a partir do mimetype
    const realType = mimetype?.startsWith("image/") ? "image"
                   : mimetype?.startsWith("video/") ? "video"
                   : mimetype?.startsWith("audio/") ? "audio"
                   : type;

    media = {
      type:      realType,
      mimetype:  mimetype,
      filename:  wahaMsg.media?.filename || mediaData.fileName || mediaData.title || null,
      thumbUrl,              // miniatura base64 para exibir antes do download
      url:       wahaMsg.media?.url || null, // URL direta (raro no NOWEB)
      msgId:     wahaMsg.id || null,         // ID para usar no endpoint de download
      hasMedia:  true,
    };
  }

  return {
    id:       wahaMsg.id || `tmp-${tsMs}`,
    from:     wahaMsg.fromMe ? "operator" : "patient",
    text:     body,
    time:     new Date(tsMs).toLocaleTimeString("pt-BR", { hour:"2-digit", minute:"2-digit" }),
    ts,
    chatId,
    type,
    media,
    operator: wahaMsg.fromMe ? (wahaMsg.senderName || wahaMsg._data?.pushName || "Você") : null,
    hasPatientCard: !hasMedia && detectPatientCard(body),
  };
}

function detectPatientCard(text) {
  if (!text) return false;

  // NUNCA detecta se é mensagem do operador/bot (começa com prefixo "Nome: texto")
  // Heurística: se a PRIMEIRA linha tem ":" com conteúdo substantivo (>20 chars), é operador
  const firstLine = text.split("\n")[0] || "";
  const firstColon = firstLine.indexOf(":");
  if (firstColon > 0 && firstColon < 30) {
    const afterColon = firstLine.slice(firstColon + 1).trim();
    // Se tem conteúdo depois dos dois pontos na primeira linha e não parece dado de paciente
    if (afterColon.length > 20 && !RE_CPF_SIMPLE.test(afterColon) && !RE_EMAIL.test(afterColon)) {
      return false; // ex: "Recepcionista: Para agendamento..."
    }
  }

  const t = text.toLowerCase();

  // Formato estruturado: template de formulário com labels
  const temLabels = (t.includes("nome") || t.includes("cpf")) &&
    (t.includes("email") || t.includes("telefone") || t.includes("nascimento") ||
     t.includes("convênio") || t.includes("convenio"));

  if (temLabels) {
    // Só dispara se NÃO for template vazio
    if (isTemplateVazio(text)) return false;
    return true;
  }

  // Formato livre: texto corrido com dados misturados
  const temEmail    = RE_EMAIL.test(text);
  const temCpf      = RE_CPF_SIMPLE.test(text);
  const temData     = /\b\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}\b/.test(text);
  const temTelefone = /(?:\(?\d{2}\)?\s?)(?:9\s?\d{4}|\d{4})[\s\-]?\d{4}/.test(text);
  const temNome     = /[A-ZÀ-Ú][a-zà-ú]+ [A-ZÀ-Ú][a-zà-ú]+/.test(text);

  // Precisa de nome + pelo menos 2 outros dados
  const score = [temEmail, temCpf, temData, temTelefone].filter(Boolean).length;
  return temNome && score >= 2;
}

function isTemplateVazio(text) {
  const labels = ["Nome completo:","CPF:","E-mail:","Convênio","Número da carteirinha:","Telefone:","Data de nascimento:"];
  const temLabels = labels.filter(l => text.includes(l)).length >= 3;
  if (!temLabels) return false;
  const linhas = text.split("\n").map(l => l.trim()).filter(Boolean);
  const labelsFormulario = linhas.filter(l => {
    const k = (l.split(":")[0] || "").toLowerCase();
    return k.includes("nome") || k.includes("cpf") || k.includes("e-mail") ||
           k.includes("email") || k.includes("telefone") || k.includes("convênio") ||
           k.includes("nascimento") || k.includes("cartão") || k.includes("carteirinha");
  });
  if (labelsFormulario.length < 3) return false;
  const comValor = labelsFormulario.filter(l => {
    const idx = l.indexOf(":");
    if (idx === -1) return false;
    return l.slice(idx+1).trim().length > 0;
  });
  return comValor.length === 0;
}

const RE_CPF_SIMPLE = /\b\d{3}[\s.]?\d{3}[\s.]?\d{3}[-\s.]?\d{2}\b/;
const RE_EMAIL      = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/;

function stringToColor(str) {
  const colors = ["#0d7d62","#1a5fa8","#b56a00","#c0412c","#5b3db8","#2d7d8c"];
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
  return colors[Math.abs(hash) % colors.length];
}

// ── WebSocket ─────────────────────────────────────────────────────

export function createWAHASocket({ onMessage, onStatus, onError }) {
  const wsUrl = WAHA_URL.replace(/^http/, "ws");
  // Escuta message e message.any (enviadas por mim também)
  const url = `${wsUrl}/ws?session=${SESSION}&events=message,message.any&x-api-key=${WAHA_KEY}`;

  let ws, reconnectTimer;
  let dead = false;

  function connect() {
    if (dead) return;
    ws = new WebSocket(url);
    ws.onopen  = () => { onStatus?.("connected"); };
    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (
          (data.event === "message" || data.event === "message.any") &&
          data.payload
        ) {
          const msg = normalizeMessage(data.payload);
          // Injeta chatId se vier em data.payload.from ou data.payload.chatId
          if (!msg.chatId && data.payload.from) {
            msg.chatId = data.payload.from.replace(/:.*@/, "@");
          }
          onMessage?.(msg);
        }
      } catch (e) {
        console.warn("[WAHA WS] parse error", e);
      }
    };
    ws.onerror  = (e) => { onError?.(e); };
    ws.onclose  = () => {
      if (dead) return;
      onStatus?.("reconnecting");
      reconnectTimer = setTimeout(connect, 3000);
    };
  }

  connect();

  return {
    send:  (data) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify(data)),
    close: () => { dead = true; clearTimeout(reconnectTimer); ws?.close(); },
  };
}