import { useState, useEffect, useRef, useLayoutEffect } from "react";
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
  const [patientTab, setPatientTab]   = useState("perfil");
  const PATIENT_TABS = ["perfil", "agendamentos", "evolucoes", "notas"];

  // Carousel refs (direct DOM to keep 60fps without React re-renders)
  const chatPanelRef    = useRef(null);
  const patientPanelRef = useRef(null);
  const tabRowRef       = useRef(null);
  const patientTabRef   = useRef("perfil");
  const activeChatRef   = useRef(null);
  const dragStateRef    = useRef({ x0: 0, y0: 0, target: null });
  const contentRef      = useRef(null);
  const goToRef         = useRef(null);

  const { displayName, lidPhoneMap } = useContactsCtx();
  const {
    chats, messages, loadMessages, loadOlderMessages, send,
    deleteMsg, editMsg, reactMsg, deleteChat, searchMessages,
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
      if (screenRef.current === "patient") { goToRef.current?.("chat", patientTabRef.current, true); window.history.pushState({ crm: 2 }, "", window.location.href); return; }
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

  // Sync refs
  useEffect(() => { patientTabRef.current = patientTab; }, [patientTab]);
  useEffect(() => { activeChatRef.current = activeChat; }, [activeChat]);

  // goTo: commit position change, animating panels via direct DOM
  function goTo(newScreen, newTab, animated) {
    const trans = animated ? "transform 0.28s cubic-bezier(.4,0,.2,1)" : "none";
    const outerI = newScreen === "patient" ? 1 : 0;
    const tabI = PATIENT_TABS.indexOf(newTab);
    if (chatPanelRef.current) {
      chatPanelRef.current.style.transition = trans;
      chatPanelRef.current.style.transform = `translateX(calc(${-outerI * 100}vw))`;
    }
    if (patientPanelRef.current) {
      patientPanelRef.current.style.transition = trans;
      patientPanelRef.current.style.transform = `translateX(calc(${(1 - outerI) * 100}vw))`;
    }
    if (tabRowRef.current && tabI >= 0) {
      tabRowRef.current.style.transition = trans;
      tabRowRef.current.style.transform = `translateX(calc(${-tabI * 100}vw))`;
    }
    setScreen(newScreen);
    setPatientTab(newTab);
  }
  goToRef.current = goTo;

  // Reset panels when active chat changes
  useLayoutEffect(() => {
    if (chatPanelRef.current) {
      chatPanelRef.current.style.transition = "none";
      chatPanelRef.current.style.transform = "translateX(0)";
    }
    if (patientPanelRef.current) {
      patientPanelRef.current.style.transition = "none";
      patientPanelRef.current.style.transform = "translateX(100vw)";
    }
    if (tabRowRef.current) {
      tabRowRef.current.style.transition = "none";
      tabRowRef.current.style.transform = "translateX(0)";
    }
    setScreen("chat");
    setPatientTab("perfil");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeChat?.id]);

  // Non-passive touch handler for live swipe tracking
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const ds = dragStateRef.current;
    const TABS = ["perfil","agendamentos","evolucoes","notas"];

    function onStart(e) {
      ds.x0 = e.touches[0].clientX;
      ds.y0 = e.touches[0].clientY;
      ds.target = null;
      [chatPanelRef, patientPanelRef, tabRowRef].forEach(r => {
        if (r.current) r.current.style.transition = "none";
      });
    }

    function onMove(e) {
      const dx = e.touches[0].clientX - ds.x0;
      const dy = e.touches[0].clientY - ds.y0;
      if (!ds.target) {
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
        if (Math.abs(dy) > Math.abs(dx)) { ds.target = "vertical"; return; }
        const currScreen = screenRef.current;
        const currTabI = TABS.indexOf(patientTabRef.current);
        if (currScreen === "chat") {
          ds.target = (dx < 0 && activeChatRef.current) ? "outer" : "drawer";
        } else {
          ds.target = (dx > 0 && currTabI === 0) ? "outer" : "inner";
        }
      }
      if (ds.target === "vertical" || ds.target === "drawer") return;
      e.preventDefault();
      const currScreen = screenRef.current;
      const currTabI = TABS.indexOf(patientTabRef.current);
      const outerI = currScreen === "patient" ? 1 : 0;
      if (ds.target === "outer") {
        if (chatPanelRef.current)
          chatPanelRef.current.style.transform = `translateX(calc(${-outerI * 100}vw + ${dx}px))`;
        if (patientPanelRef.current)
          patientPanelRef.current.style.transform = `translateX(calc(${(1 - outerI) * 100}vw + ${dx}px))`;
      } else if (ds.target === "inner") {
        const atEdge = (dx > 0 && currTabI === 0) || (dx < 0 && currTabI === TABS.length - 1);
        const clampedDx = atEdge ? dx / 3 : dx;
        if (tabRowRef.current)
          tabRowRef.current.style.transform = `translateX(calc(${-currTabI * 100}vw + ${clampedDx}px))`;
      }
    }

    function onEnd(e) {
      const dx = e.changedTouches[0].clientX - ds.x0;
      const target = ds.target;
      ds.target = null;
      if (target === "drawer") { setDrawerOpen(true); return; }
      if (!target || target === "vertical") return;
      const currScreen = screenRef.current;
      const currTab = patientTabRef.current;
      const currTabI = TABS.indexOf(currTab);
      const THRESHOLD = 55;
      if (target === "outer") {
        if (dx < -THRESHOLD && currScreen === "chat") goToRef.current("patient", "perfil", true);
        else if (dx > THRESHOLD && currScreen === "patient") goToRef.current("chat", currTab, true);
        else goToRef.current(currScreen, currTab, true);
      } else if (target === "inner") {
        if (dx < -THRESHOLD && currTabI < TABS.length - 1) goToRef.current("patient", TABS[currTabI + 1], true);
        else if (dx > THRESHOLD && currTabI > 0) goToRef.current("patient", TABS[currTabI - 1], true);
        else goToRef.current("patient", currTab, true);
      }
    }

    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd, { passive: true });
    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
    };
  }, []);

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
    setDrawerOpen(false);
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
          <button onClick={() => goTo("chat", patientTab, true)}
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
          {screen === "patient" ? "Paciente" : "Clínica CRM"}
        </span>

        {/* Status WS */}
        <div style={{ width:7, height:7, borderRadius:"50%", flexShrink:0,
          background: WS_COLOR[wsStatus] || "#666",
          boxShadow: wsStatus==="connected" ? `0 0 0 2px ${T.green}33` : "none" }} />

        {/* Botão Perfil (só quando há chat ativo na tela de chat) */}
        {screen === "chat" && activeChat && (
          <button onClick={() => goTo("patient", "perfil", true)}
            style={{ background:T.accent+"22", border:`1px solid ${T.accent}44`,
              borderRadius:5, color:T.accent, fontSize:10, cursor:"pointer",
              padding:"3px 10px", fontWeight:600, flexShrink:0 }}>
            Perfil
          </button>
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

      {/* ── Conteúdo principal (carousel) ──────────────────────────── */}
      <div ref={contentRef} style={{ flex:1, overflow:"hidden", position:"relative" }}>

        {/* Painel Chat */}
        <div ref={chatPanelRef} style={{ position:"absolute", inset:0, willChange:"transform", display:"flex", flexDirection:"column" }}>
          {activeChat ? (
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
              onSyncMedia={operator.role === "admin" ? syncMediaToR2 : undefined}
              onDeleteMsg={(msgId, forEveryone) => deleteMsg?.(activeChat.id, msgId, forEveryone)}
              onEditMsg={(msgId, newText) => editMsg?.(activeChat.id, msgId, newText)}
              onReactMsg={(msgId, emoji) => reactMsg?.(activeChat.id, msgId, emoji)}
              onOpenPatient={() => goTo("patient", "perfil", true)}
            />
          ) : (
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
        </div>

        {/* Painel Paciente */}
        {activeChat && (
          <div ref={patientPanelRef} style={{ position:"absolute", inset:0, willChange:"transform", display:"flex", flexDirection:"column" }}>
            <PatientPanel
              chat={activeChat}
              operator={operator}
              activeTab={patientTab}
              onTabChange={t => goTo("patient", t, true)}
              tabRowRef={tabRowRef}
            />
          </div>
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
