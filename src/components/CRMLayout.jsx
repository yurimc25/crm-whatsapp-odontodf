import { useState } from "react";
import ChatList from "./ChatList";
import ChatWindow from "./ChatWindow";
import PatientPanel from "./PatientPanel";
import { useWAHA } from "../hooks/useWAHA";
import { ROLE_PERMISSIONS } from "../data/mock";
import { useContactsCtx } from "../App";
import { wahaIdToPhone, formatPhone } from "../hooks/useContacts";

// Tema escuro estilo Claude
const T = {
  bg:        "#1e1e1e",   // fundo geral
  sidebar:   "#171717",   // sidebar esquerda
  panel:     "#212121",   // painel direito
  header:    "#1a1a1a",   // top bar
  border:    "#333333",   // bordas
  text:      "#ececec",   // texto principal
  sub:       "#8e8e8e",   // texto secundário
  accent:    "#d4956a",   // laranja Claude (destaques, ativo)
  accentBg:  "#3a2a1e",   // fundo do acento
  green:     "#4caf87",   // verde para status/badges
  greenBg:   "#1a2e24",   // fundo verde
  red:       "#e57373",   // erros
  inputBg:   "#2d2d2d",   // fundo de inputs
  hover:     "#2a2a2a",   // hover
  active:    "#2d2d2d",   // item ativo na lista
  bubble:    "#2d2d2d",   // bolha mensagem paciente
  bubbleMe:  "#1e3a2a",   // bolha minha mensagem
};

export default function CRMLayout({ operator, onLogout }) {
  const [activeChat, setActiveChat] = useState(null);
  const [filter, setFilter]         = useState("all");
  const [search, setSearch]         = useState("");

  const { displayName, loading: contactsLoading } = useContactsCtx();

  const {
    chats, messages, loadMessages, loadMoreMessages, send,
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

  const enrichedChats = chats
    .filter(canSeeChat)
    .filter(c => filter === "all" || c.status === filter)
    .map(c => ({
      ...c,
      name:  displayName(c.id, c.name),
      phone: formatPhone(wahaIdToPhone(c.id)),
    }));

  function handleSelectChat(rawChat) {
    setActiveChat({
      ...rawChat,
      name:  displayName(rawChat.id, rawChat.name),
      phone: formatPhone(wahaIdToPhone(rawChat.id)),
    });
    loadMessages(rawChat.id);
  }

  const WS_COLOR = { connected: T.green, reconnecting: "#c9a84c", disconnected: "#666" };
  const WS_LABEL = { connected: "ao vivo", reconnecting: "reconectando...", disconnected: "offline" };

  const FILTERS = [
    { id:"all",      label:"Todos"     },
    { id:"open",     label:"Aberto"    },
    { id:"waiting",  label:"Aguard."   },
    { id:"resolved", label:"Resolvido" },
  ];

  return (
    <div style={{
      height:"100vh", display:"flex", flexDirection:"column",
      background: T.bg, fontFamily:"'DM Sans', sans-serif", overflow:"hidden",
      color: T.text,
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:ital,wght@0,300;0,400;0,500;0,600;1,400&family=DM+Mono:wght@400;500&display=swap');
        *{box-sizing:border-box;margin:0;padding:0}
        ::-webkit-scrollbar{width:5px;height:5px}
        ::-webkit-scrollbar-track{background:transparent}
        ::-webkit-scrollbar-thumb{background:#404040;border-radius:3px}
        ::-webkit-scrollbar-thumb:hover{background:#555}
        input,textarea,button{font-family:'DM Sans',sans-serif}
        input::placeholder,textarea::placeholder{color:#666}
      `}</style>

      {/* ── Top bar ─────────────────────────────────────────────── */}
      <div style={{
        height:52, background: T.header, borderBottom:`1px solid ${T.border}`,
        display:"flex", alignItems:"center", padding:"0 16px", gap:12, flexShrink:0,
        boxShadow:"0 1px 4px rgba(0,0,0,.3)",
      }}>
        {/* Logo */}
        <div style={{ display:"flex", alignItems:"center", gap:8 }}>
          <span style={{ fontSize:20 }}>🦷</span>
          <span style={{ color:T.text, fontWeight:700, fontSize:15, letterSpacing:-.3 }}>
            Clínica CRM
          </span>
        </div>

        {/* Status WS */}
        <div style={{ display:"flex", alignItems:"center", gap:5,
          background:"#252525", borderRadius:20, padding:"3px 10px",
          border:`1px solid ${T.border}` }}>
          <div style={{
            width:7, height:7, borderRadius:"50%",
            background: WS_COLOR[wsStatus] || "#666",
            boxShadow: wsStatus==="connected" ? `0 0 0 2px ${T.greenBg}` : "none",
          }} />
          <span style={{ color:T.sub, fontSize:11 }}>{WS_LABEL[wsStatus] || wsStatus}</span>
        </div>

        {contactsLoading && (
          <span style={{ color:T.sub, fontSize:11, fontStyle:"italic" }}>
            sincronizando contatos...
          </span>
        )}

        <div style={{ flex:1 }} />

        {/* Filtros */}
        <div style={{ display:"flex", gap:3, background:"#252525",
          borderRadius:8, padding:3, border:`1px solid ${T.border}` }}>
          {FILTERS.map(f => (
            <button key={f.id} onClick={() => setFilter(f.id)} style={{
              background: filter===f.id ? T.active : "transparent",
              border:"none", borderRadius:6, padding:"4px 12px",
              color: filter===f.id ? T.text : T.sub,
              fontSize:12, fontWeight: filter===f.id ? 600 : 400,
              cursor:"pointer", transition:"all .15s",
              boxShadow: filter===f.id ? "0 1px 3px rgba(0,0,0,.4)" : "none",
            }}>
              {f.label}
            </button>
          ))}
        </div>

        <div style={{ width:1, height:28, background:T.border, margin:"0 4px" }} />

        {/* Operador */}
        <div style={{ display:"flex", alignItems:"center", gap:8 }}>
          <div style={{
            width:32, height:32, borderRadius:"50%",
            background: operator.color+"33", color: operator.color,
            display:"flex", alignItems:"center", justifyContent:"center",
            fontSize:12, fontWeight:700, border:`2px solid ${operator.color}55`,
          }}>
            {(operator.name||"?").slice(0,2).toUpperCase()}
          </div>
          <div>
            <div style={{ color:T.text, fontSize:13, fontWeight:600, lineHeight:1.2 }}>
              {operator.name}
            </div>
            <div style={{ color:T.sub, fontSize:10, textTransform:"capitalize" }}>
              {operator.role}
            </div>
          </div>
          <button onClick={onLogout} style={{
            background:"transparent", border:`1px solid ${T.border}`,
            borderRadius:6, padding:"4px 10px", color:T.sub,
            fontSize:11, cursor:"pointer", transition:"all .15s",
          }}
          onMouseEnter={e => { e.currentTarget.style.background=T.hover; e.currentTarget.style.color=T.text; }}
          onMouseLeave={e => { e.currentTarget.style.background="transparent"; e.currentTarget.style.color=T.sub; }}>
            Sair
          </button>
        </div>
      </div>

      {/* ── Erro ────────────────────────────────────────────────── */}
      {error && (
        <div style={{
          background:"#2a1a1a", borderBottom:`1px solid #5a2a2a`,
          padding:"8px 16px", color:T.red, fontSize:12,
          display:"flex", alignItems:"center", gap:8,
        }}>
          ⚠️ {error}
          <a href={`${import.meta.env.VITE_WAHA_URL||""}/dashboard`}
            target="_blank" rel="noreferrer"
            style={{ color:T.red, marginLeft:8, fontWeight:600 }}>
            Abrir dashboard WAHA →
          </a>
        </div>
      )}

      {/* ── Corpo ────────────────────────────────────────────────── */}
      <div style={{ flex:1, display:"flex", overflow:"hidden" }}>

        {/* Lista de chats */}
        <div style={{
          width:300, flexShrink:0, borderRight:`1px solid ${T.border}`,
          display:"flex", flexDirection:"column", overflow:"hidden",
          background: T.sidebar,
        }}>
          <ChatList
            chats={enrichedChats}
            activeId={activeChat?.id}
            search={search}
            onSearch={setSearch}
            onSelect={c => handleSelectChat(chats.find(x => x.id === c.id) || c)}
            loading={loading}
            operator={operator}
          />
        </div>

        {/* Janela de chat */}
        <div style={{
          flex:1, minWidth:0, display:"flex", flexDirection:"column",
          overflow:"hidden", background: T.bg,
        }}>
          {activeChat ? (
            <ChatWindow
              chat={activeChat}
              messages={messages[activeChat.id] || []}
              operator={operator}
              onSend={text => send(activeChat.id, text, operator.name)}
              onForward={toRole => forwardChat(activeChat.id, toRole)}
              onResolve={() => resolveChat(activeChat.id)}
              canForwardToAdmin={perms.verAdmin}
              onLoadMore={loadMoreMessages}
            />
          ) : (
            <div style={{
              flex:1, display:"flex", alignItems:"center", justifyContent:"center",
              flexDirection:"column", gap:16, height:"100%", userSelect:"none",
            }}>
              <div style={{ fontSize:56, opacity:.15 }}>💬</div>
              <div style={{ fontSize:14, color:T.sub, fontWeight:500 }}>
                Selecione uma conversa para começar
              </div>
              <div style={{ fontSize:12, color:T.sub, opacity:.5 }}>
                {enrichedChats.length} conversa{enrichedChats.length!==1?"s":""} disponível{enrichedChats.length!==1?"s":""}
              </div>
            </div>
          )}
        </div>

        {/* Painel do paciente */}
        {activeChat && (
          <div style={{
            width:320, flexShrink:0, borderLeft:`1px solid ${T.border}`,
            display:"flex", flexDirection:"column", overflow:"hidden",
            background: T.panel,
          }}>
            <PatientPanel chat={activeChat} operator={operator} />
          </div>
        )}
      </div>
    </div>
  );
}
