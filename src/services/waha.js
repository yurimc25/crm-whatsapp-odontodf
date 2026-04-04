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

  return {
    id:          wahaChat.id,
    name:        wahaChat.name || cleanId,
    // Mostra número formatado só se válido, senão usa o nome/id
    phone:       phone ? ("+" + phone) : (wahaChat.name || cleanId),
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
    avatar:      (wahaChat.name || cleanId || "??").slice(0, 2).toUpperCase(),
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

  // Timestamp SEMPRE do WhatsApp (segundos Unix), nunca do servidor
  const tsRaw = wahaMsg.timestamp || wahaMsg.t || wahaMsg._data?.t || null;
  const tsMs  = tsRaw ? tsRaw * 1000 : Date.now();
  const ts    = new Date(tsMs).toISOString();

  // chatId: pode vir em vários campos
  const chatId = wahaMsg.chatId
    || wahaMsg.from?.replace(/:.*@/, "@") // normaliza @c.us
    || null;

  return {
    id:       wahaMsg.id || `tmp-${tsMs}`,
    from:     wahaMsg.fromMe ? "operator" : "patient",
    text:     body,
    // Hora formatada a partir do timestamp do WhatsApp
    time:     new Date(tsMs).toLocaleTimeString("pt-BR", { hour:"2-digit", minute:"2-digit" }),
    ts,       // ISO string para ordenação e separadores de dia
    chatId,
    type:     wahaMsg.type || "text",
    operator: wahaMsg.fromMe ? (wahaMsg.senderName || "Você") : null,
    hasPatientCard: detectPatientCard(body),
  };
}

function detectPatientCard(text) {
  const t = (text || "").toLowerCase();
  return t.includes("nome completo") && t.includes("cpf");
}

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