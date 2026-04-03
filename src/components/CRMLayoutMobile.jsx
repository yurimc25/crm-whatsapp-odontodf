// src/components/CRMLayoutMobile.jsx
// Layout mobile: uma tela por vez (lista → chat → painel paciente)
import { useState } from "react";
import ChatList from "./ChatList";
import ChatWindow from "./ChatWindow";
import PatientPanel from "./PatientPanel";
import { useWAHA } from "../hooks/useWAHA";
import { ROLE_PERMISSIONS } from "../data/mock";
import { useContactsCtx } from "../App";
import { wahaIdToPhone, formatPhone } from "../hooks/useContacts";

export default function CRMLayoutMobile({ operator, onLogout }) {
  const [screen, setScreen]     = useState("list"); // list | chat | patient
  const [activeChat, setActiveChat] = useState(null);
  const [filter, setFilter]     = useState("all");
  const [search, setSearch]     = useState("");
  const { loadMoreMessages } = useWAHA(operator); // já está no hook

  const { displayName } = useContactsCtx();
  const {
    chats, messages, loadMessages, send,
    forwardChat, resolveChat,
    loading, error, wsStatus,
  } = useWAHA(operator);

  const perms = ROLE_PERMISSIONS[operator.role] || {};

  function canSeeChat(chat) {
    if (perms.verTodos) return true;
    if (operator.role === "recepcao") return !chat.assignedTo || chat.assignedTo === "recepcao";
    if (operator.role === "dentista") return chat.assignedTo === operator.login;
    return false;
  }

  const visibleChats = chats
    .filter(canSeeChat)
    .filter(c => filter === "all" || c.status === filter)
    .filter(c => !search ||
      displayName(c.id, c.name).toLowerCase().includes(search.toLowerCase()) ||
      c.phone?.includes(search));

  function handleSelectChat(chat) {
    setActiveChat(chat);
    loadMessages(chat.id);
    setScreen("chat");
  }

  const WS_DOT = { connected: "#0d7d62", reconnecting: "#b56a00", disconnected: "#888" };

  // Enriquece chats com nome do Google Contacts
  const enrichedChats = visibleChats.map(c => ({
    ...c,
    name: displayName(c.id, c.name),
    phone: formatPhone(wahaIdToPhone(c.id)),
  }));

  return (
    <div style={{
      height: "100dvh", display: "flex", flexDirection: "column",
      background: "#0a0f0d", fontFamily: "'DM Sans', sans-serif", overflow: "hidden",
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600&family=DM+Mono:wght@400;500&display=swap');
        *{box-sizing:border-box;margin:0;padding:0}
        ::-webkit-scrollbar{width:3px}
        ::-webkit-scrollbar-thumb{background:#1e3028;border-radius:2px}
      `}</style>

      {/* Top bar */}
      <div style={{
        height: 52, background: "#0d1610", borderBottom: "1px solid #1a2e22",
        display: "flex", alignItems: "center", padding: "0 14px", gap: 10, flexShrink: 0,
      }}>
        {screen !== "list" && (
          <button onClick={() => setScreen(screen === "patient" ? "chat" : "list")}
            style={{ background:"none",border:"none",color:"#0d7d62",fontSize:22,cursor:"pointer",padding:"0 4px" }}>
            ‹
          </button>
        )}

        <span style={{ fontSize:16 }}>🦷</span>
        <span style={{ color:"#e8f5ee",fontWeight:600,fontSize:14,flex:1 }}>
          {screen === "list" ? "Clínica CRM"
            : screen === "chat" ? (activeChat ? displayName(activeChat.id, activeChat.name) : "Chat")
            : "Paciente"}
        </span>

        <div style={{ display:"flex",alignItems:"center",gap:5 }}>
          <div style={{ width:7,height:7,borderRadius:"50%",background:WS_DOT[wsStatus]||"#888" }} />
        </div>

        {screen === "chat" && activeChat && (
          <button onClick={() => setScreen("patient")}
            style={{ background:"none",border:"none",color:"#3a7055",fontSize:20,cursor:"pointer",padding:"0 4px" }}>
            👤
          </button>
        )}

        {screen === "list" && (
          <div style={{ display:"flex",alignItems:"center",gap:6 }}>
            <div style={{ width:26,height:26,borderRadius:7,background:operator.color+"33",color:operator.color,
              display:"flex",alignItems:"center",justifyContent:"center",fontSize:10,fontWeight:700 }}>
              {operator.avatar}
            </div>
            <button onClick={onLogout} style={{ background:"none",border:"1px solid #1a2e22",
              borderRadius:5,padding:"3px 7px",color:"#3a7055",fontSize:10,cursor:"pointer" }}>
              Sair
            </button>
          </div>
        )}
      </div>

      {/* Filtros — só na lista */}
      {screen === "list" && (
        <div style={{ display:"flex",gap:6,padding:"8px 12px",borderBottom:"1px solid #1a2e22",
          background:"#0d1610",overflowX:"auto",flexShrink:0 }}>
          {["all","open","waiting","resolved"].map(f => (
            <button key={f} onClick={() => setFilter(f)} style={{
              background: filter===f ? "#0d7d62" : "transparent",
              border: `1px solid ${filter===f ? "#0d7d62" : "#1a2e22"}`,
              borderRadius:6,padding:"4px 10px",color:filter===f?"#fff":"#3a7055",
              fontSize:11,fontWeight:600,cursor:"pointer",whiteSpace:"nowrap",flexShrink:0,
            }}>
              {f==="all"?"Todos":f==="open"?"Aberto":f==="waiting"?"Aguard.":"Resolvido"}
            </button>
          ))}
        </div>
      )}

      {/* Erro */}
      {error && screen === "list" && (
        <div style={{ background:"#2a1010",padding:"6px 14px",color:"#e88",fontSize:11 }}>
          ⚠️ {error}
        </div>
      )}

      {/* Conteúdo */}
      <div style={{ flex:1,overflow:"hidden",display:"flex",flexDirection:"column" }}>
        {screen === "list" && (
          <ChatList
            chats={enrichedChats}
            activeId={activeChat?.id}
            search={search}
            onSearch={setSearch}
            onSelect={handleSelectChat}
            loading={loading}
            operator={operator}
          />
        )}

        {screen === "chat" && activeChat && (
          <ChatWindow
            chat={{ ...activeChat,
              name: displayName(activeChat.id, activeChat.name),
              phone: formatPhone(wahaIdToPhone(activeChat.id)),
            }}
            messages={messages[activeChat.id] || []}
            operator={operator}
            onSend={(text) => send(activeChat.id, text, operator.name)}
            onForward={(toRole) => { forwardChat(activeChat.id, toRole); }}
            onResolve={() => { resolveChat(activeChat.id); }}
            onLoadMore={loadMoreMessages}
            canForwardToAdmin={perms.verAdmin}
          />
        )}

        {screen === "patient" && activeChat && (
          <PatientPanel chat={activeChat} operator={operator} />
        )}
      </div>
    </div>
  );
}
