import { useState, useEffect, useRef } from "react";
import ChatList from "./ChatList";
import ChatWindow from "./ChatWindow";
import PatientPanel from "./PatientPanel";
import NewChatModal from "./NewChatModal";
import { useWAHA } from "../hooks/useWAHA";
import { ROLE_PERMISSIONS } from "../data/mock";
import { useContactsCtx } from "../App";
import { wahaIdToPhone, formatPhone } from "../hooks/useContacts";
import { NotificationBell } from "./NotificationBell";

const T = {
  bg:      "#1e1e1e",
  header:  "#1a1a1a",
  border:  "#2d2d2d",
  text:    "#ececec",
  sub:     "#8e8e8e",
  accent:  "#d4956a",
  green:   "#4caf87",
  red:     "#e57373",
};

export default function CRMLayoutMobile({ operator, onLogout, notificationBell }) {
  const [screen, setScreen]         = useState("list");
  const [activeChat, setActiveChat] = useState(null);
  const [filter, setFilter]         = useState("all");
  const [search, setSearch]         = useState("");
  const [showNewChat, setShowNewChat] = useState(false);
  const [newChatPhone, setNewChatPhone] = useState(null);

  const { displayName } = useContactsCtx();
  const {
    chats, messages, loadMessages, loadOlderMessages, send,
    deleteMsg, editMsg, searchMessages,
    forwardChat, resolveChat, markRead, markUnread,
    resyncChats, loading, error, wsStatus,
  } = useWAHA(operator);

  const perms = ROLE_PERMISSIONS[operator.role] || {};

  const screenRef = useRef(screen);
  useEffect(() => { screenRef.current = screen; }, [screen]);

  useEffect(() => {
    window.history.pushState({ crm: "list" },    "", window.location.href);
    window.history.pushState({ crm: "chat" },    "", window.location.href);
    window.history.pushState({ crm: "patient" }, "", window.location.href);

    function handlePopState() {
      const cur = screenRef.current;
      if (cur === "patient") {
        setScreen("chat");
        window.history.pushState({ crm: "patient" }, "", window.location.href);
      } else if (cur === "chat") {
        setScreen("list");
        window.history.pushState({ crm: "chat" }, "", window.location.href);
      } else {
        window.history.pushState({ crm: "list" }, "", window.location.href);
      }
    }
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  // Abre chat via notificação push (evento do Service Worker)
  useEffect(() => {
    function handleOpenChat(e) {
      const { chatId } = e.detail || {};
      if (!chatId) return;
      const chat = chats.find(c => c.id === chatId);
      if (chat) handleSelectChat(chat);
    }
    window.addEventListener('crm:open-chat', handleOpenChat);
    return () => window.removeEventListener('crm:open-chat', handleOpenChat);
  }, [chats]);

  function canSeeChat(chat) {
    if (perms.verTodos) return true;
    if (operator.role === "recepcao") return !chat.assignedTo || chat.assignedTo === "recepcao";
    if (operator.role === "dentista") return chat.assignedTo === operator.login;
    return false;
  }

  const enrichedChats = chats
    .filter(canSeeChat)
    .filter(c => filter === "all" || c.status === filter)
    .filter(c => !search ||
      displayName(c.id, c.pushname, c.pushname).toLowerCase().includes(search.toLowerCase()) ||
      c.phone?.includes(search))
    .map(c => ({
      ...c,
      name:  displayName(c.id, c.pushname, c.pushname),
      phone: formatPhone(wahaIdToPhone(c.id)),
    }));

  function handleSelectChat(rawChat) {
    const enriched = {
      ...rawChat,
      name:  displayName(rawChat.id, rawChat.pushname, rawChat.pushname),
      phone: formatPhone(wahaIdToPhone(rawChat.id)),
    };
    setActiveChat(enriched);
    loadMessages(rawChat.id);
    markRead(rawChat.id);
    setScreen("chat");
  }

  const activeRaw = activeChat ? chats.find(c => c.id === activeChat.id) : null;
  const isResolved = activeRaw?.status === "resolved";

  const WS_COLOR = { connected: T.green, reconnecting: "#c9a84c", disconnected: "#666" };

  const FILTERS = [
    { id:"all",      label:"Todos"     },
    { id:"open",     label:"Aberto"    },
    { id:"waiting",  label:"Aguard."   },
    { id:"resolved", label:"Resolvido" },
  ];

  return (
    <div style={{
      height:"100dvh", display:"flex", flexDirection:"column",
      background:T.bg, fontFamily:"'DM Sans', sans-serif", overflow:"hidden",
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600&family=DM+Mono:wght@400;500&display=swap');
        *{box-sizing:border-box;margin:0;padding:0}
        ::-webkit-scrollbar{width:3px}
        ::-webkit-scrollbar-thumb{background:#404040;border-radius:2px}
        input,textarea,button{font-family:'DM Sans',sans-serif}
      `}</style>

      {/* ── Top bar ────────────────────────────────────────────────── */}
      <div style={{
        height:52, background:T.header, borderBottom:`1px solid ${T.border}`,
        display:"flex", alignItems:"center", padding:"0 14px", gap:8, flexShrink:0,
        boxShadow:"0 1px 4px rgba(0,0,0,.3)",
      }}>
        {/* Botão voltar */}
        {screen !== "list" && (
          <button onClick={() => setScreen(screen === "patient" ? "chat" : "list")}
            style={{ background:"none", border:"none", color:T.accent,
              fontSize:24, cursor:"pointer", padding:"0 4px", lineHeight:1, flexShrink:0 }}>
            ‹
          </button>
        )}

        <span style={{ fontSize:16, flexShrink:0 }}>🦷</span>
        <span style={{ color:T.text, fontWeight:600, fontSize:14, flex:1,
          overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
          {screen === "list"
            ? "Clínica CRM"
            : screen === "chat"
              ? (activeChat ? displayName(activeChat.id, activeChat.pushname, activeChat.pushname) : "Chat")
              : "Paciente"}
        </span>

        {/* Status WS + Resync */}
        <div style={{ display:"flex", alignItems:"center", gap:5, flexShrink:0 }}>
          <div style={{ width:7, height:7, borderRadius:"50%",
            background: WS_COLOR[wsStatus] || "#666",
            boxShadow: wsStatus==="connected" ? `0 0 0 2px ${T.green}33` : "none" }} />
          <button
            onClick={resyncChats} disabled={loading}
            title="Ressincronizar chats"
            style={{ background:"none", border:"none", cursor: loading ? "wait" : "pointer",
              color:T.sub, fontSize:16, padding:"0 2px", opacity: loading ? 0.4 : 1, lineHeight:1 }}>
            ⟳
          </button>
        </div>

        {/* Ações no chat */}
        {screen === "chat" && activeChat && (
          <div style={{ display:"flex", alignItems:"center", gap:6 }}>
            {/* Marcar lido/não lido */}
            <button
              onClick={() => activeRaw?.unread > 0 ? markRead(activeChat.id) : markUnread(activeChat.id)}
              title={activeRaw?.unread > 0 ? "Marcar como lido" : "Marcar como não lido"}
              style={{ background:"none", border:`1px solid ${T.border}`, borderRadius:5,
                color:T.sub, fontSize:10, cursor:"pointer", padding:"3px 7px" }}>
              {activeRaw?.unread > 0 ? "✓ Lido" : "◉ N/lido"}
            </button>

            {/* Resolver/Reabrir */}
            <button
              onClick={() => resolveChat(activeChat.id)}
              style={{
                background: isResolved ? "transparent" : T.green+"22",
                border:`1px solid ${isResolved ? T.border : T.green}`,
                borderRadius:5, color: isResolved ? T.sub : T.green,
                fontSize:10, cursor:"pointer", padding:"3px 7px", fontWeight:600,
              }}>
              {isResolved ? "Reabrir" : "✓ Resolver"}
            </button>

            {/* Perfil */}
            <button onClick={() => setScreen("patient")}
              style={{ background:"none", border:`1px solid ${T.border}`, borderRadius:5,
                color:T.sub, fontSize:10, cursor:"pointer", padding:"3px 7px" }}>
              👤
            </button>
          </div>
        )}

        {/* Lista — operador + sino + sair */}
        {screen === "list" && (
          <div style={{ display:"flex", alignItems:"center", gap:6 }}>
            <NotificationBell operator={operator} />
            <div style={{ width:28, height:28, borderRadius:"50%",
              background:operator.color+"33", color:operator.color,
              display:"flex", alignItems:"center", justifyContent:"center",
              fontSize:11, fontWeight:700, border:`2px solid ${operator.color}44` }}>
              {(operator.name||"?").slice(0,2).toUpperCase()}
            </div>
            <button onClick={onLogout} style={{
              background:"transparent", border:`1px solid ${T.border}`,
              borderRadius:5, padding:"3px 8px", color:T.sub, fontSize:10, cursor:"pointer" }}>
              Sair
            </button>
          </div>
        )}
      </div>

      {/* Filtros — só na lista */}
      {screen === "list" && (
        <div style={{ display:"flex", gap:4, padding:"8px 10px",
          borderBottom:`1px solid ${T.border}`, background:"#141414",
          overflowX:"auto", flexShrink:0 }}>
          {FILTERS.map(f => (
            <button key={f.id} onClick={() => setFilter(f.id)} style={{
              background: filter===f.id ? T.accent+"33" : "transparent",
              border: `1px solid ${filter===f.id ? T.accent : T.border}`,
              borderRadius:6, padding:"4px 10px",
              color: filter===f.id ? T.accent : T.sub,
              fontSize:11, fontWeight:600, cursor:"pointer",
              whiteSpace:"nowrap", flexShrink:0,
            }}>
              {f.label}
            </button>
          ))}
        </div>
      )}

      {/* Erro */}
      {error && screen === "list" && (
        <div style={{ background:"#2a1a1a", padding:"6px 14px",
          color:T.red, fontSize:11 }}>
          ⚠️ {error}
        </div>
      )}

      {/* Conteúdo */}
      <div style={{ flex:1, overflow:"hidden", display:"flex", flexDirection:"column" }}>

        {screen === "list" && (
          <>
            {/* Botão Nova Conversa */}
            <div style={{ padding:"8px 10px 0", flexShrink:0 }}>
              <button onClick={() => setShowNewChat(true)} style={{
                width:"100%", background:"#3a2a1e", border:"1px solid #d4956a44",
                borderRadius:8, padding:"7px 12px", color:"#d4956a",
                fontSize:12, fontWeight:600, cursor:"pointer",
                display:"flex", alignItems:"center", justifyContent:"center", gap:6,
              }}>
                ✏️ Nova conversa
              </button>
            </div>
            <ChatList
              chats={enrichedChats}
              activeId={activeChat?.id}
              search={search}
              onSearch={setSearch}
              onSelect={c => handleSelectChat(chats.find(x => x.id === c.id) || c)}
              onForward={(chatId, toRole) => forwardChat(chatId, toRole)}
              onMarkRead={markRead}
              onMarkUnread={markUnread}
              loading={loading}
              operator={operator}
              searchMessages={searchMessages}
              onStartNewChat={phone => {
                const digits = phone.replace(/\D/g, "");
                const chatId = digits.startsWith("55") ? `${digits}@c.us` : `55${digits}@c.us`;
                const existing = chats.find(c => c.id === chatId || c.id.replace(/\D/g,"").slice(-8) === digits.slice(-8));
                if (existing) handleSelectChat(existing);
                else { setNewChatPhone(digits); setShowNewChat(true); }
              }}
            />
          </>
        )}

        {screen === "chat" && activeChat && (
          <ChatWindow
            chat={{
              ...activeChat,
              name:  displayName(activeChat.id, activeChat.pushname, activeChat.pushname),
              phone: formatPhone(wahaIdToPhone(activeChat.id)),
            }}
            messages={messages[activeChat.id] || []}
            operator={operator}
            onSend={text => send(activeChat.id, text, operator.name)}
            onForward={toRole => forwardChat(activeChat.id, toRole)}
            onResolve={() => resolveChat(activeChat.id)}
            canForwardToAdmin={perms.verAdmin}
            onLoadOlder={loadOlderMessages}
            onDeleteMsg={(msgId) => deleteMsg?.(activeChat.id, msgId)}
            onEditMsg={(msgId, newText) => editMsg?.(activeChat.id, msgId, newText)}
          />
        )}

        {screen === "patient" && activeChat && (
          <PatientPanel chat={activeChat} operator={operator} />
        )}
      </div>

      {/* Modal Nova Conversa */}
      {showNewChat && (
        <NewChatModal
          operator={operator}
          initialPhone={newChatPhone}
          onClose={() => { setShowNewChat(false); setNewChatPhone(null); }}
          onStartChat={chatId => {
            setShowNewChat(false);
            const existing = chats.find(c => c.id === chatId);
            if (existing) {
              handleSelectChat(existing);
            } else {
              const tmp = {
                id: chatId, name: chatId, pushname: null,
                phone: chatId.replace(/@.*$/, ""),
                isValidPhone: true, lastMsg: "", lastTime: "", lastTs: null,
                unread: 0, status: "open", assignedTo: null, tags: [],
                avatar: "??", avatarColor: "#555", photoUrl: null,
              };
              handleSelectChat(tmp);
            }
          }}
        />
      )}

      {/* Backup Drive — admin/gerente, acessível via botão na topbar da lista */}
    </div>
  );
}