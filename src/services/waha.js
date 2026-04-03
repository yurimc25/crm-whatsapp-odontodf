// src/services/waha.js
const WAHA_URL = import.meta.env.VITE_WAHA_URL || "https://n8n-waha8.vxjlst.easypanel.host";
const WAHA_KEY = import.meta.env.VITE_WAHA_API_KEY || "";
const SESSION  = import.meta.env.VITE_WAHA_SESSION || "default";

const headers = () => ({
  "Content-Type": "application/json",
  "X-Api-Key": WAHA_KEY,
});

// ── REST ─────────────────────────────────────────────────────────

export async function getChats() {
  const r = await fetch(`${WAHA_URL}/api/${SESSION}/chats?limit=50`, { headers: headers() });
  if (!r.ok) throw new Error(`WAHA getChats: ${r.status}`);
  return r.json();
}

export async function getMessages(chatId, limit = 40) {
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
// Cobre NOWEB, WEBJS e GOWS que retornam campos diferentes

export function normalizeChat(wahaChat) {
  // lastMessage varia por engine
  const lm = wahaChat.lastMessage
    || wahaChat.messages?.[0]
    || wahaChat.msgs?.[0]
    || null;

  const lastBody = lm?.body
    || lm?.text
    || lm?.content
    || lm?._data?.body
    || "";

  const lastTs = lm?.timestamp || lm?.t || lm?._data?.t || null;

  // ID pode vir como @c.us ou @s.whatsapp.net
  const cleanId = wahaChat.id.replace(/@.*$/, "");

  return {
    id:          wahaChat.id,
    name:        wahaChat.name || cleanId,
    phone:       "+" + cleanId,
    lastMsg:     lastBody,
    lastTime:    lastTs
      ? new Date(lastTs * 1000).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })
      : "",
    unread:      wahaChat.unreadCount ?? wahaChat.unread ?? 0,
    status:      "open",
    assignedTo:  null,
    tags:        [],
    avatar:      (wahaChat.name || cleanId || "??").slice(0, 2).toUpperCase(),
    avatarColor: stringToColor(wahaChat.id),
  };
}

export function normalizeMessage(wahaMsg) {
  // body pode estar em lugares diferentes
  const body = wahaMsg.body
    || wahaMsg.text
    || wahaMsg.content
    || wahaMsg._data?.body
    || "";

  const ts = wahaMsg.timestamp || wahaMsg.t || wahaMsg._data?.t || Date.now() / 1000;

  return {
    id:       wahaMsg.id || String(Date.now()),
    from:     wahaMsg.fromMe ? "operator" : "patient",
    text:     body,
    time:     new Date(ts * 1000).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }),
    type:     wahaMsg.type || "text",
    operator: wahaMsg.fromMe ? "Você" : null,
    chatId:   wahaMsg.chatId || wahaMsg.from || null,
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
  const url = `${wsUrl}/ws?session=${SESSION}&events=message&x-api-key=${WAHA_KEY}`;

  let ws, reconnectTimer;
  let dead = false;

  function connect() {
    if (dead) return;
    ws = new WebSocket(url);

    ws.onopen = () => { onStatus?.("connected"); };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.event === "message" && data.payload) {
          onMessage?.(normalizeMessage(data.payload));
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
