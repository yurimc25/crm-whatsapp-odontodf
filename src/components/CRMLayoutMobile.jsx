import { useState, useEffect, useRef } from "react";
import ChatList from "./ChatList";
import ChatWindow from "./ChatWindow";
import PatientPanel from "./PatientPanel";
import { useWAHA } from "../hooks/useWAHA";
import { ROLE_PERMISSIONS } from "../data/mock";
import { useContactsCtx } from "../App";
import { wahaIdToPhone, formatPhone } from "../hooks/useContacts";

const T = {
  bg:      "#1e1e1e",
  header:  "#1a1a1a",
  border:  "#2d2d2d",
  text:    "#ececec",
  sub:     "#8e8e8e",
  accent:  "#d4956a",
  green:   "#4caf87",
};

export default function CRMLayoutMobile({ operator, onLogout }) {
  const [screen, setScreen]         = useState("list"); // list | chat | patient
  const [activeChat, setActiveChat] = useState(null);
  const [filter, setFilter]         = useState("all");
  const [search, setSearch]         = useState("");

  const { displayName } = useContactsCtx();
  const {
    chats, messages, loadMessages, loadMoreMessages, send,
    forwardChat, resolveChat, setChats,
    loading, error, wsStatus,
  } = useWAHA(operator);

  const perms = ROLE_PERMISSIONS[operator.role] || {};

  // Intercepta botão voltar do browser → volta para a lista em vez de sair
  useEffect(() => {
    function handlePopState(e) {
      if (screen === "patient") {
        e.preventDefault();
        setScreen("chat");
        window.history.pushState(null, "", window.location.href);
      } else if (screen === "chat") {
        e.preventDefault();
        setScreen("list");
        window.history.pushState(null, "", window.location.href);
      }
    }
    // Empurra estado extra ao entrar em sub-telas
    if (screen !== "list") {
      window.history.pushState(null, "", window.location.href);
    }
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [screen]);

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
      displayName(c.id, c.name).toLowerCase().includes(search.toLowerCase()) ||
      c.phone?.includes(search))
    .map(c => ({
      ...c,
      name:  displayName(c.id, c.name),
      phone: formatPhone(wahaIdToPhone(c.id)),
    }));

  function handleSelectChat(rawChat) {
    const enriched = {
      ...rawChat,
      name:  displayName(rawChat.id, rawChat.name),
      phone: formatPhone(wahaIdToPhone(rawChat.id)),
    };
    setActiveChat(enriched);
    loadMessages(rawChat.id);
    setScreen("chat");
  }

  function markRead(chatId) {
    setChats(prev => prev.map(c => c.id !== chatId ? c : { ...c, unread: 0 }));
  }
  function markUnread(chatId) {
    setChats(prev => prev.map(c => c.id !== chatId ? c : { ...c, unread: 1 }));
  }
  function handleForwardFromList(chatId, toRole) {
    forwardChat(chatId, toRole);
  }

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

      {/* Top bar */}
      <div style={{
        height:52, background:T.header, borderBottom:`1px solid ${T.border}`,
        display:"flex", alignItems:"center", padding:"0 14px", gap:10, flexShrink:0,
        boxShadow:"0 1px 4px rgba(0,0,0,.3)",
      }}>
        {/* Botão voltar — interceptado pelo popstate acima */}
        {screen !== "list" && (
          <button
            onClick={() => setScreen(screen === "patient" ? "chat" : "list")}
            style={{ background:"none", border:"none", color:T.accent,
              fontSize:24, cursor:"pointer", padding:"0 4px", lineHeight:1 }}>
            ‹
          </button>
        )}

        <span style={{ fontSize:16 }}>🦷</span>
        <span style={{ color:T.text, fontWeight:600, fontSize:14, flex:1,
          overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
          {screen === "list"    ? "Clínica CRM"
           : screen === "chat"  ? (activeChat ? displayName(activeChat.id, activeChat.name) : "Chat")
           : "Paciente"}
        </span>

        {/* Status WS */}
        <div style={{ width:8, height:8, borderRadius:"50%",
          background: WS_COLOR[wsStatus] || "#666",
          boxShadow: wsStatus==="connected" ? `0 0 0 2px ${T.green}33` : "none" }} />

        {/* Botão perfil no chat */}
        {screen === "chat" && activeChat && (
          <button onClick={() => setScreen("patient")}
            style={{ background:"none", border:`1px solid ${T.border}`, borderRadius:6,
              color:T.sub, fontSize:11, cursor:"pointer", padding:"4px 8px" }}>
            👤 Perfil
          </button>
        )}

        {/* Sair na lista */}
        {screen === "list" && (
          <div style={{ display:"flex", alignItems:"center", gap:6 }}>
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
          color:"#e57373", fontSize:11 }}>
          ⚠️ {error}
        </div>
      )}

      {/* Conteúdo */}
      <div style={{ flex:1, overflow:"hidden", display:"flex", flexDirection:"column" }}>

        {screen === "list" && (
          <ChatList
            chats={enrichedChats}
            activeId={activeChat?.id}
            search={search}
            onSearch={setSearch}
            onSelect={c => handleSelectChat(chats.find(x => x.id === c.id) || c)}
            onForward={handleForwardFromList}
            onMarkRead={markRead}
            onMarkUnread={markUnread}
            loading={loading}
            operator={operator}
          />
        )}

        {screen === "chat" && activeChat && (
          <ChatWindow
            chat={{
              ...activeChat,
              name:  displayName(activeChat.id, activeChat.name),
              phone: formatPhone(wahaIdToPhone(activeChat.id)),
            }}
            messages={messages[activeChat.id] || []}
            operator={operator}
            onSend={text => send(activeChat.id, text, operator.name)}
            onForward={toRole => forwardChat(activeChat.id, toRole)}
            onResolve={() => resolveChat(activeChat.id)}
            canForwardToAdmin={perms.verAdmin}
            onLoadMore={loadMoreMessages}
          />
        )}

        {screen === "patient" && activeChat && (
          <PatientPanel chat={activeChat} operator={operator} />
        )}
      </div>
    </div>
  );
}