import { useState } from "react";
import ChatList from "./ChatList";
import ChatWindow from "./ChatWindow";
import PatientPanel from "./PatientPanel";
import { useWAHA } from "../hooks/useWAHA";
import { ROLE_PERMISSIONS } from "../data/mock";

export default function CRMLayout({ operator, onLogout }) {
  const [activeChat, setActiveChat] = useState(null);
  const [filter, setFilter]         = useState("all");
  const [search, setSearch]         = useState("");

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
      c.name.toLowerCase().includes(search.toLowerCase()) ||
      c.phone?.includes(search));

  function handleSelectChat(chat) {
    setActiveChat(chat);
    loadMessages(chat.id);
  }

  const WS_COLOR = { connected: "#0d7d62", reconnecting: "#b56a00", disconnected: "#888" };
  const WS_LABEL = { connected: "ao vivo", reconnecting: "reconectando...", disconnected: "offline" };

  return (
    <div style={{
      height: "100vh", display: "flex", flexDirection: "column",
      background: "#0a0f0d", fontFamily: "'DM Sans', sans-serif", overflow: "hidden",
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600&family=DM+Mono:wght@400;500&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: #1e3028; border-radius: 2px; }
        .crm-col { display: flex; flex-direction: column; overflow: hidden; }
      `}</style>

      {/* Top bar */}
      <div style={{
        height: 52, background: "#0d1610", borderBottom: "1px solid #1a2e22",
        display: "flex", alignItems: "center", padding: "0 16px", gap: 12, flexShrink: 0,
      }}>
        <span style={{ fontSize: 18 }}>🦷</span>
        <span style={{ color: "#e8f5ee", fontWeight: 600, fontSize: 14 }}>Clínica CRM</span>

        <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <div style={{ width: 7, height: 7, borderRadius: "50%", background: WS_COLOR[wsStatus] || "#888" }} />
          <span style={{ color: "#3a7055", fontSize: 10 }}>{WS_LABEL[wsStatus] || wsStatus}</span>
        </div>

        <div style={{ flex: 1 }} />

        {["all","open","waiting","resolved"].map(f => (
          <button key={f} onClick={() => setFilter(f)} style={{
            background: filter === f ? "#0d7d62" : "transparent",
            border: "1px solid " + (filter === f ? "#0d7d62" : "#1a2e22"),
            borderRadius: 6, padding: "4px 10px", color: filter === f ? "#fff" : "#3a7055",
            fontSize: 11, fontWeight: 600, cursor: "pointer", transition: "all .15s",
          }}>
            {f === "all" ? "Todos" : f === "open" ? "Aberto" : f === "waiting" ? "Aguard." : "Resolvido"}
          </button>
        ))}

        <div style={{ width: 1, height: 24, background: "#1a2e22" }} />

        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{
            width: 30, height: 30, borderRadius: 8,
            background: operator.color + "33", color: operator.color,
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 11, fontWeight: 700,
          }}>{operator.avatar}</div>
          <div>
            <div style={{ color: "#e8f5ee", fontSize: 12, fontWeight: 600 }}>{operator.name}</div>
            <div style={{ color: "#3a7055", fontSize: 10 }}>{operator.role}</div>
          </div>
          <button onClick={onLogout} style={{
            background: "transparent", border: "1px solid #1a2e22",
            borderRadius: 6, padding: "4px 8px", color: "#3a7055",
            fontSize: 10, cursor: "pointer",
          }}>Sair</button>
        </div>
      </div>

      {/* Banner de erro de sessão */}
      {error && (
        <div style={{
          background: "#2a1010", borderBottom: "1px solid #5a2020",
          padding: "8px 16px", color: "#e88", fontSize: 12,
          display: "flex", alignItems: "center", gap: 8,
        }}>
          ⚠️ {error}
          <a href={`${import.meta.env.VITE_WAHA_URL || "https://n8n-waha8.vxjlst.easypanel.host"}/dashboard`}
            target="_blank" rel="noreferrer" style={{ color: "#f8a", marginLeft: 8 }}>
            Abrir dashboard WAHA →
          </a>
        </div>
      )}

      {/* Corpo */}
      <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
        <div className="crm-col" style={{ width: 300, borderRight: "1px solid #1a2e22", flexShrink: 0 }}>
          <ChatList
            chats={visibleChats}
            activeId={activeChat?.id}
            search={search}
            onSearch={setSearch}
            onSelect={handleSelectChat}
            loading={loading}
            operator={operator}
          />
        </div>

        <div className="crm-col" style={{ flex: 1, minWidth: 0 }}>
          {activeChat ? (
            <ChatWindow
              chat={activeChat}
              messages={messages[activeChat.id] || []}
              operator={operator}
              onSend={(text) => send(activeChat.id, text, operator.name)}
              onForward={(toRole) => forwardChat(activeChat.id, toRole)}
              onResolve={() => resolveChat(activeChat.id)}
              canForwardToAdmin={perms.verAdmin}
            />
          ) : (
            <div style={{
              flex: 1, display: "flex", alignItems: "center", justifyContent: "center",
              flexDirection: "column", gap: 12, height: "100%",
            }}>
              <div style={{ fontSize: 48 }}>💬</div>
              <div style={{ fontSize: 14, color: "#2a4a36" }}>Selecione um chat para começar</div>
            </div>
          )}
        </div>

        {activeChat && (
          <div className="crm-col" style={{ width: 320, borderLeft: "1px solid #1a2e22", flexShrink: 0 }}>
            <PatientPanel chat={activeChat} operator={operator} />
          </div>
        )}
      </div>
    </div>
  );
}
