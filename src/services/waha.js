// src/services/waha.js
// Cliente completo para a WAHA API
// URL e Key vêm de variáveis de ambiente do Vercel

const WAHA_URL = import.meta.env.VITE_WAHA_URL || "https://n8n-waha8.vxjlst.easypanel.host";
const WAHA_KEY = import.meta.env.VITE_WAHA_API_KEY || "";
const SESSION  = import.meta.env.VITE_WAHA_SESSION || "default";

const headers = () => ({
  "Content-Type": "application/json",
  "X-Api-Key": WAHA_KEY,
});

// ── REST ────────────────────────────────────────────────────────

export async function getChats() {
  const r = await fetch(`${WAHA_URL}/api/${SESSION}/chats?limit=50`, { headers: headers() });
  if (!r.ok) throw new Error(`WAHA getChats: ${r.status}`);
  return r.json(); // [{ id, name, unreadCount, lastMessage, ... }]
}

export async function getMessages(chatId, limit = 40) {
  const id = encodeURIComponent(chatId);
  const r = await fetch(
    `${WAHA_URL}/api/${SESSION}/chats/${id}/messages?limit=${limit}&downloadMedia=false`,
    { headers: headers() }
  );
  if (!r.ok) throw new Error(`WAHA getMessages: ${r.status}`);
  return r.json(); // [{ id, body, from, timestamp, ... }]
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
  return r.json(); // { status: "WORKING" | "SCAN_QR_CODE" | ... }
}

// ── Normalização ────────────────────────────────────────────────
// WAHA retorna formatos ligeiramente diferentes dependendo do engine.
// Essas funções normalizam para o formato que o CRM usa.

export function normalizeChat(wahaChat) {
  return {
    id:          wahaChat.id,
    name:        wahaChat.name || wahaChat.id.replace("@c.us", ""),
    phone:       "+" + wahaChat.id.replace("@c.us", ""),
    lastMsg:     wahaChat.lastMessage?.body || "",
    lastTime:    wahaChat.lastMessage
      ? new Date(wahaChat.lastMessage.timestamp * 1000)
          .toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })
      : "",
    unread:      wahaChat.unreadCount || 0,
    status:      "open",
    assignedTo:  null,
    tags:        [],
    avatar:      (wahaChat.name || "??").slice(0, 2).toUpperCase(),
    avatarColor: stringToColor(wahaChat.id),
  };
}

export function normalizeMessage(wahaMsg) {
  return {
    id:       wahaMsg.id,
    from:     wahaMsg.fromMe ? "operator" : "patient",
    text:     wahaMsg.body || "",
    time:     new Date(wahaMsg.timestamp * 1000)
                .toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }),
    type:     wahaMsg.type || "text",
    operator: wahaMsg.fromMe ? "Você" : null,
    hasPatientCard: detectPatientCard(wahaMsg.body || ""),
  };
}

function detectPatientCard(text) {
  return (
    text.toLowerCase().includes("nome completo") &&
    text.toLowerCase().includes("cpf")
  );
}

function stringToColor(str) {
  const colors = ["#0d7d62","#1a5fa8","#b56a00","#c0412c","#5b3db8","#2d7d8c"];
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
  return colors[Math.abs(hash) % colors.length];
}

// ── WebSocket ───────────────────────────────────────────────────

export function createWAHASocket({ onMessage, onStatus, onError }) {
  const wsUrl = WAHA_URL.replace(/^http/, "ws");
  const url = `${wsUrl}/ws?session=${SESSION}&events=message&x-api-key=${WAHA_KEY}`;

  let ws;
  let reconnectTimer;
  let dead = false;

  function connect() {
    if (dead) return;
    ws = new WebSocket(url);

    ws.onopen = () => {
      console.log("[WAHA WS] conectado");
      onStatus?.("connected");
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        // WAHA envia { event: "message", payload: { ... } }
        if (data.event === "message" && data.payload) {
          onMessage?.(normalizeMessage(data.payload));
        }
      } catch (e) {
        console.warn("[WAHA WS] parse error", e);
      }
    };

    ws.onerror = (e) => {
      console.warn("[WAHA WS] erro", e);
      onError?.(e);
    };

    ws.onclose = () => {
      if (dead) return;
      console.log("[WAHA WS] desconectado, reconectando em 3s...");
      onStatus?.("reconnecting");
      reconnectTimer = setTimeout(connect, 3000);
    };
  }

  connect();

  return {
    send: (data) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify(data)),
    close: () => {
      dead = true;
      clearTimeout(reconnectTimer);
      ws?.close();
    },
  };
}
