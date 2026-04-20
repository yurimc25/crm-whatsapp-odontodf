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
  sidebar: "#171717",
  border:  "#2d2d2d",
  text:    "#ececec",
  sub:     "#8e8e8e",
  accent:  "#d4956a",
  green:   "#4caf87",
  red:     "#e57373",
};

function SyncDBButton({ onSync }) {
  const [syncing, setSyncing] = useState(false);
  const [lastSync, setLastSync] = useState(null);
  return (
    <button
      title="Salvar lista na base de dados"
      disabled={syncing}
      onClick={async () => {
        setSyncing(true);
        try { await onSync(); setLastSync(new Date().toLocaleTimeString("pt-BR", { hour:"2-digit", minute:"2-digit" })); }
        finally { setSyncing(false); }
      }}
      style={{ background:"transparent", border:`1px solid #333`, borderRadius:6,
        padding:"3px 7px", color: syncing ? "#888" : lastSync ? T.green : "#888",
        fontSize:10, cursor: syncing ? "wait" : "pointer", whiteSpace:"nowrap" }}>
      {syncing ? "⏳" : lastSync ? `✓ ${lastSync}` : "⬆ DB"}
    </button>
  );
}

export default function CRMLayoutMobile({ operator, onLogout }) {
  const [screen, setScreen]           = useState("chat"); // "chat" | "patient"
  const [drawerOpen, setDrawerOpen]   = useState(true);   // drawer aberto por padrão (sem chat)
  const [activeChat, setActiveChat]   = useState(null);
  const [filter, setFilter]           = useState("all");
  const [search, setSearch]           = useState("");
  const [showNewChat, setShowNewChat] = useState(false);
  const [newChatPhone, setNewChatPhone] = useState(null);
  const [agendaOpen, setAgendaOpen]   = useState(false);

  const { displayName, lidPhoneMap } = useContactsCtx();
  const {
    chats, messages, loadMessages, loadOlderMessages, send,
    deleteMsg, editMsg, deleteChat, searchMessages,
    forwardChat, resolveChat, markRead, markUnread,
    resyncChats, syncChatsToR2, syncMediaToR2, mutedChats, muteChat, unmuteChat,
    loading, error, wsStatus, myJid,
  } = useWAHA(operator);

  const perms = ROLE_PERMISSIONS[operator.role] || {};

  // Fecha drawer ao pressionar voltar do sistema quando está aberto e há chat ativo
  const drawerRef  = useRef(drawerOpen);
  const screenRef  = useRef(screen);
  useEffect(() => { drawerRef.current  = drawerOpen; }, [drawerOpen]);
  useEffect(() => { screenRef.current  = screen; }, [screen]);

  useEffect(() => {
    window.history.pushState({ crm: 1 }, "", window.location.href);
    window.history.pushState({ crm: 2 }, "", window.location.href);
    function handlePopState() {
      if (screenRef.current === "patient") { setScreen("chat"); window.history.pushState({ crm: 2 }, "", window.location.href); return; }
      if (!drawerRef.current && activeChat)  { setDrawerOpen(true); window.history.pushState({ crm: 2 }, "", window.location.href); }
      else { window.history.pushState({ crm: 1 }, "", window.location.href); }
    }
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [activeChat]);

  // Abre chat via notificação push
  useEffect(() => {
    function handleOpenChat(e) {
      const { chatId } = e.detail || {};
      if (!chatId) return;
      const chat = chats.find(c => c.id === chatId);
      if (chat) handleSelectChat(chat);
    }
    window.addEventListener("crm:open-chat", handleOpenChat);
    return () => window.removeEventListener("crm:open-chat", handleOpenChat);
  }, [chats]);

  function canSeeChat(chat) {
    if (perms.verTodos) return true;
    if (operator.role === "recepcao") return !chat.assignedTo || chat.assignedTo === "recepcao";
    if (operator.role === "dentista") return chat.assignedTo === operator.login;
    return false;
  }

  const enrichedChats = chats
    .filter(c => !myJid || c.id !== myJid)
    .filter(canSeeChat)
    .filter(c => filter === "all" || c.status === filter)
    .filter(c => !search ||
      displayName(c.id, c.name || c.pushname, c.pushname).toLowerCase().includes(search.toLowerCase()) ||
      c.phone?.includes(search))
    .map(c => ({
      ...c,
      name:  displayName(c.id, c.name || c.pushname, c.pushname),
      phone: formatPhone(wahaIdToPhone(c.id)),
    }));

  function handleSelectChat(rawChat) {
    const enriched = {
      ...rawChat,
      name:  displayName(rawChat.id, rawChat.name || rawChat.pushname, rawChat.pushname),
      phone: formatPhone(wahaIdToPhone(rawChat.id)),
    };
    setActiveChat(enriched);
    loadMessages(rawChat.id);
    markRead(rawChat.id);
    setScreen("chat");
    setDrawerOpen(false); // fecha o drawer ao selecionar um chat
  }

  const activeRaw  = activeChat ? chats.find(c => c.id === activeChat.id) : null;
  const isResolved = activeRaw?.status === "resolved";

  const WS_COLOR = { connected: T.green, reconnecting: "#c9a84c", disconnected: "#666" };

  const FILTERS = [
    { id:"all",      label:"Todos"     },
    { id:"open",     label:"Aberto"    },
    { id:"waiting",  label:"Aguard."   },
    { id:"resolved", label:"Resolvido" },
  ];

  const showSyncDB = operator.role === "gerente" || operator.role === "admin";

  return (
    <div style={{
      height:"100dvh", display:"flex", flexDirection:"column",
      background:T.bg, fontFamily:"'DM Sans', sans-serif", overflow:"hidden", position:"relative",
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600&family=DM+Mono:wght@400;500&display=swap');
        *{box-sizing:border-box;margin:0;padding:0}
        ::-webkit-scrollbar{width:3px}
        ::-webkit-scrollbar-thumb{background:#404040;border-radius:2px}
        input,textarea,button{font-family:'DM Sans',sans-serif}
        .mob-drawer{
          position:fixed; top:0; left:0; height:100dvh;
          width:min(88vw,360px); z-index:50;
          background:${T.sidebar};
          border-right:1px solid ${T.border};
          display:flex; flex-direction:column;
          transition:transform .25s cubic-bezier(.4,0,.2,1);
          will-change:transform;
        }
        .mob-drawer.open { transform:translateX(0); }
        .mob-drawer.closed { transform:translateX(-100%); }
        .mob-backdrop{
          position:fixed; inset:0; z-index:49;
          background:rgba(0,0,0,.55);
          backdrop-filter:blur(1px);
          transition:opacity .25s;
        }
        .mob-backdrop.open  { opacity:1; pointer-events:all; }
        .mob-backdrop.closed{ opacity:0; pointer-events:none; }
      `}</style>

      {/* ── Top bar ────────────────────────────────────────────────── */}
      <div style={{
        height:52, background:T.header, borderBottom:`1px solid ${T.border}`,
        display:"flex", alignItems:"center", padding:"0 12px", gap:8, flexShrink:0,
        boxShadow:"0 1px 4px rgba(0,0,0,.3)", zIndex:10,
      }}>
        {/* Hamburger / voltar */}
        {screen === "patient" ? (
          <button onClick={() => setScreen("chat")}
            style={{ background:"none", border:"none", color:T.accent,
              fontSize:24, cursor:"pointer", padding:"0 4px", lineHeight:1, flexShrink:0 }}>
            ‹
          </button>
        ) : (
          <button onClick={() => setDrawerOpen(v => !v)}
            title={drawerOpen ? "Fechar lista" : "Abrir lista de conversas"}
            style={{ background:"none", border:"none", color:T.sub, cursor:"pointer",
              padding:"0 4px", lineHeight:1, flexShrink:0, fontSize:20 }}>
            ☰
          </button>
        )}

        <span style={{ fontSize:15, flexShrink:0 }}>🦷</span>
        <span style={{ color:T.text, fontWeight:600, fontSize:14, flex:1,
          overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
          {screen === "patient" ? "Paciente"
            : activeChat
              ? displayName(activeChat.id, activeChat.name || activeChat.pushname, activeChat.pushname)
              : "Clínica CRM"}
        </span>

        {/* Status WS + Resync */}
        <div style={{ display:"flex", alignItems:"center", gap:5, flexShrink:0 }}>
          <div style={{ width:7, height:7, borderRadius:"50%",
            background: WS_COLOR[wsStatus] || "#666",
            boxShadow: wsStatus==="connected" ? `0 0 0 2px ${T.green}33` : "none" }} />
          <button onClick={resyncChats} disabled={loading} title="Ressincronizar"
            style={{ background:"none", border:"none", cursor: loading ? "wait" : "pointer",
              color:T.sub, fontSize:16, padding:"0 2px", opacity: loading ? 0.4 : 1, lineHeight:1 }}>
            ⟳
          </button>
        </div>

        {/* Ações no chat */}
        {screen === "chat" && activeChat && (
          <div style={{ display:"flex", alignItems:"center", gap:5 }}>
            <button
              onClick={() => activeRaw?.unread > 0 ? markRead(activeChat.id) : markUnread(activeChat.id)}
              title={activeRaw?.unread > 0 ? "Marcar como lido" : "Marcar como não lido"}
              style={{ background:"none", border:`1px solid ${T.border}`, borderRadius:5,
                color:T.sub, fontSize:10, cursor:"pointer", padding:"3px 6px" }}>
              {activeRaw?.unread > 0 ? "✓" : "◉"}
            </button>
            <button onClick={() => resolveChat(activeChat.id)}
              style={{
                background: isResolved ? "transparent" : T.green+"22",
                border:`1px solid ${isResolved ? T.border : T.green}`,
                borderRadius:5, color: isResolved ? T.sub : T.green,
                fontSize:10, cursor:"pointer", padding:"3px 6px", fontWeight:600,
              }}>
              {isResolved ? "Reabrir" : "✓"}
            </button>
            <button onClick={() => setScreen("patient")}
              style={{ background:"none", border:`1px solid ${T.border}`, borderRadius:5,
                color:T.sub, fontSize:10, cursor:"pointer", padding:"3px 6px" }}>
              👤
            </button>
          </div>
        )}

        {/* Notificação + usuário + sair (sem chat ativo) */}
        {screen === "chat" && !activeChat && (
          <div style={{ display:"flex", alignItems:"center", gap:6 }}>
            <NotificationBell operator={operator} />
            <div style={{ width:26, height:26, borderRadius:"50%",
              background:operator.color+"33", color:operator.color,
              display:"flex", alignItems:"center", justifyContent:"center",
              fontSize:10, fontWeight:700, border:`2px solid ${operator.color}44` }}>
              {(operator.name||"?").slice(0,2).toUpperCase()}
            </div>
            <button onClick={onLogout} style={{
              background:"transparent", border:`1px solid ${T.border}`,
              borderRadius:5, padding:"3px 7px", color:T.sub, fontSize:10, cursor:"pointer" }}>
              Sair
            </button>
          </div>
        )}
      </div>

      {/* ── Backdrop ────────────────────────────────────────────────── */}
      <div
        className={`mob-backdrop ${drawerOpen ? "open" : "closed"}`}
        onClick={() => { if (activeChat) setDrawerOpen(false); }}
      />

      {/* ── Drawer (ChatList) ────────────────────────────────────────── */}
      <div className={`mob-drawer ${drawerOpen ? "open" : "closed"}`}>
        {/* Cabeçalho do drawer */}
        <div style={{ padding:"10px 12px 6px", borderBottom:`1px solid ${T.border}`,
          display:"flex", alignItems:"center", gap:8, flexShrink:0 }}>
          <NotificationBell operator={operator} />
          <div style={{ width:26, height:26, borderRadius:"50%",
            background:operator.color+"33", color:operator.color,
            display:"flex", alignItems:"center", justifyContent:"center",
            fontSize:10, fontWeight:700, border:`2px solid ${operator.color}44`, flexShrink:0 }}>
            {(operator.name||"?").slice(0,2).toUpperCase()}
          </div>
          <span style={{ color:T.sub, fontSize:11, flex:1,
            overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
            {operator.name}
          </span>
          {showSyncDB && <SyncDBButton onSync={syncChatsToR2} />}
          <button onClick={onLogout} style={{
            background:"transparent", border:`1px solid ${T.border}`,
            borderRadius:5, padding:"3px 7px", color:T.sub, fontSize:10, cursor:"pointer", flexShrink:0 }}>
            Sair
          </button>
        </div>

        {/* Filtros */}
        <div style={{ display:"flex", gap:4, padding:"7px 10px",
          borderBottom:`1px solid ${T.border}`, overflowX:"auto", flexShrink:0 }}>
          {FILTERS.map(f => (
            <button key={f.id} onClick={() => setFilter(f.id)} style={{
              background: filter===f.id ? T.accent+"33" : "transparent",
              border: `1px solid ${filter===f.id ? T.accent : T.border}`,
              borderRadius:6, padding:"3px 10px",
              color: filter===f.id ? T.accent : T.sub,
              fontSize:11, fontWeight:600, cursor:"pointer",
              whiteSpace:"nowrap", flexShrink:0,
            }}>
              {f.label}
            </button>
          ))}
        </div>

        {/* Erro */}
        {error && (
          <div style={{ background:"#2a1a1a", padding:"5px 12px", color:T.red, fontSize:11, flexShrink:0 }}>
            ⚠️ {error}
          </div>
        )}

        {/* Nova conversa */}
        <div style={{ padding:"8px 10px 0", flexShrink:0 }}>
          <button onClick={() => setShowNewChat(true)} style={{
            width:"100%", background:"#3a2a1e", border:"1px solid #d4956a44",
            borderRadius:8, padding:"6px 12px", color:"#d4956a",
            fontSize:12, fontWeight:600, cursor:"pointer",
            display:"flex", alignItems:"center", justifyContent:"center", gap:6,
          }}>
            ✏️ Nova conversa
          </button>
        </div>

        {/* Lista de chats */}
        <div style={{ flex:1, overflow:"hidden", display:"flex", flexDirection:"column" }}>
          <ChatList
            chats={enrichedChats}
            activeId={activeChat?.id}
            search={search}
            onSearch={setSearch}
            onSelect={c => handleSelectChat(chats.find(x => x.id === c.id) || c)}
            onForward={(chatId, toRole) => forwardChat(chatId, toRole)}
            onMarkRead={markRead}
            onMarkUnread={markUnread}
            onDelete={deleteChat}
            loading={loading}
            operator={operator}
            searchMessages={searchMessages}
            mutedChats={mutedChats}
            onMute={muteChat}
            onUnmute={unmuteChat}
            agendaOpen={agendaOpen}
            onAgendaToggle={() => setAgendaOpen(v => !v)}
            onStartNewChat={phone => {
              const digits = phone.replace(/\D/g, "");
              const chatId = digits.startsWith("55") ? `${digits}@c.us` : `55${digits}@c.us`;
              const existing = chats.find(c => c.id === chatId || c.id.replace(/\D/g,"").slice(-8) === digits.slice(-8));
              if (existing) handleSelectChat(existing);
              else { setNewChatPhone(digits); setShowNewChat(true); }
            }}
          />
        </div>
      </div>

      {/* ── Conteúdo principal ───────────────────────────────────────── */}
      <div style={{ flex:1, overflow:"hidden", display:"flex", flexDirection:"column" }}>

        {screen === "chat" && activeChat && (
          <ChatWindow
            chat={{
              ...activeChat,
              name:  displayName(activeChat.id, activeChat.name || activeChat.pushname, activeChat.pushname),
              phone: formatPhone(wahaIdToPhone(activeChat.id)),
            }}
            messages={messages[activeChat.id] || []}
            operator={operator}
            onSend={(text, replyToId) => send(activeChat.id, text, operator.name, replyToId)}
            onForward={toRole => forwardChat(activeChat.id, toRole)}
            onResolve={() => resolveChat(activeChat.id)}
            canForwardToAdmin={perms.verAdmin}
            onLoadOlder={loadOlderMessages}
            onSyncMedia={syncMediaToR2}
            onDeleteMsg={(msgId, forEveryone) => deleteMsg?.(activeChat.id, msgId, forEveryone)}
            onEditMsg={(msgId, newText) => editMsg?.(activeChat.id, msgId, newText)}
          />
        )}

        {screen === "chat" && !activeChat && (
          <div style={{ flex:1, display:"flex", flexDirection:"column",
            alignItems:"center", justifyContent:"center", gap:12, color:T.sub }}>
            <span style={{ fontSize:36 }}>🦷</span>
            <span style={{ fontSize:13 }}>Selecione uma conversa</span>
            <button onClick={() => setDrawerOpen(true)}
              style={{ background:T.accent+"22", border:`1px solid ${T.accent}44`,
                borderRadius:8, padding:"8px 18px", color:T.accent,
                fontSize:12, fontWeight:600, cursor:"pointer" }}>
              ☰ Abrir conversas
            </button>
          </div>
        )}

        {screen === "patient" && activeChat && (
          <PatientPanel chat={activeChat} operator={operator} />
        )}
      </div>

      {/* ── Modal Nova Conversa ──────────────────────────────────────── */}
      {showNewChat && (
        <NewChatModal
          operator={operator}
          initialPhone={newChatPhone}
          onClose={() => { setShowNewChat(false); setNewChatPhone(null); }}
          onStartChat={chatId => {
            setShowNewChat(false);
            const existing = chats.find(c => c.id === chatId);
            if (existing) { handleSelectChat(existing); }
            else {
              const tmp = {
                id: chatId, name: chatId, pushname: null,
                phone: chatId.replace(/@.*$/, ""),
                isValidPhone: true, lastMsg: "", lastTime: "", lastTs: null,
                unread: 0, status: "open", assignedTo: null, tags: [], avatar: "??",
                avatarColor: "#555", photoUrl: null,
              };
              handleSelectChat(tmp);
            }
          }}
        />
      )}
    </div>
  );
}
